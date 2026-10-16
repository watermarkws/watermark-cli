import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseOperation } from '../src/cli.js';
import { contentTypeOf } from '../src/api.js';

// A fetch that answers from a list and records what it was sent.
function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected call to ${url}`);
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return new Response(body, { status: next.status ?? 200, headers: next.headers ?? {} });
  };
  return { fetch, calls };
}

function run(argv, responses) {
  const { fetch, calls } = fakeFetch(responses);
  let out = '';
  let err = '';
  const stdout = { write: (text) => { out += text; } };
  const stderr = { write: (text) => { err += text; } };
  return main(argv, { env: { WATERMARK_API_KEY: 'wm_test_key', WATERMARK_API_URL: 'https://api.test' }, stdout, stderr, fetch, sleep: async () => {} })
    .then((code) => ({ code, out, err, calls }));
}

test('an operation is parsed with typed values', () => {
  assert.deepEqual(parseOperation('resize:width=800,height=600,crop_center=true'), { type: 'resize', width: 800, height: 600, crop_center: true });
  assert.deepEqual(parseOperation('watermark:image_url=https://example.com/logo.png,x=-10,y=40'), { type: 'watermark', image_url: 'https://example.com/logo.png', x: -10, y: 40 });
  assert.deepEqual(parseOperation('grayscale'), { type: 'grayscale' });
  assert.throws(() => parseOperation('resize:width'), /needs a value/);
});

test('process posts the operations, waits, and prints JSON for agents', async () => {
  const { code, out, calls } = await run(
    ['image', 'process', 'https://example.com/a.jpg', '--op', 'resize:width=800,height=600', '--op', 'grayscale', '--format', 'webp', '--metadata', 'order=7', '--json'],
    [
      { status: 202, body: { id: 5, status: 'queued', endpoint: 'images/process' } },
      { body: { id: 5, status: 'processing', endpoint: 'images/process' } },
      { body: { id: 5, status: 'succeeded', endpoint: 'images/process', result: { data: { width: 800 } } } },
    ],
  );

  assert.equal(code, 0);
  assert.equal(JSON.parse(out).status, 'succeeded');
  assert.equal(calls[0].url, 'https://api.test/v1/images/process');
  assert.equal(calls[0].headers.Authorization, 'Bearer wm_test_key');
  assert.ok(calls[0].headers['Idempotency-Key']);
  assert.deepEqual(calls[0].body, {
    source: 'https://example.com/a.jpg',
    operations: [{ type: 'resize', width: 800, height: 600 }, { type: 'grayscale' }],
    output: { format: 'webp' },
    metadata: { order: '7' },
  });
  assert.equal(calls[2].url, 'https://api.test/v1/requests/5?wait=25');
});

test('--out downloads the result file', async () => {
  const path = join(tmpdir(), `watermark-cli-${process.pid}.png`);
  const { code, out, calls } = await run(
    ['document', 'snapshot', 'https://example.com/a.pdf', '--page', '2', '--format', 'png', '--out', path],
    [
      { status: 202, body: { id: 6, status: 'queued' } },
      { body: { id: 6, status: 'succeeded', endpoint: 'documents/snapshot', result: { files: [{ url: 'https://results.test/6.png', url_expires_at: 'soon' }] } } },
      { body: 'PNGBYTES' },
    ],
  );

  assert.equal(code, 0);
  assert.equal(await readFile(path, 'utf8'), 'PNGBYTES');
  assert.match(out, /Saved to/);
  assert.deepEqual(calls[0].body, { source: 'https://example.com/a.pdf', output: { format: 'png' }, page: 2 });
  await rm(path);
});

test('a failed request exits 1 and says why', async () => {
  const { code, out } = await run(
    ['image', 'read', 'https://example.com/a.jpg'],
    [
      { status: 202, body: { id: 7, status: 'queued' } },
      { body: { id: 7, status: 'failed', endpoint: 'images/read', error: { code: 'unsupported_media', message: 'The file is not a supported image.' } } },
    ],
  );

  assert.equal(code, 1);
  assert.match(out, /unsupported_media/);
});

test('an API error exits 1 with its code, and a usage error exits 2', async () => {
  const api = await run(['account'], [{ status: 402, body: { error: { type: 'payment_required', code: 'insufficient_credits', message: 'No credit.' } } }]);
  assert.equal(api.code, 1);
  assert.match(api.err, /402 insufficient_credits/);

  const usage = await run(['image', 'process', 'not-a-url', '--op', 'grayscale'], []);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /is not a URL, an id/);
});

test('a 429 is retried after Retry-After with the same idempotency key', async () => {
  const { code, calls } = await run(
    ['video', 'read', 'https://example.com/a.mp4', '--no-wait'],
    [
      { status: 429, headers: { 'Retry-After': '1' }, body: { error: { type: 'rate_limited', code: 'rate_limited', message: 'Slow down.' } } },
      { status: 202, body: { id: 8, status: 'queued', endpoint: 'videos/read' } },
    ],
  );

  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
});

test('--version prints the version without a key', async () => {
  let out = '';
  const code = await main(['--version'], { env: {}, stdout: { write: (text) => { out += text; } }, stderr: { write: () => {} } });
  assert.equal(code, 0);
  assert.match(out, /^watermark \d+\.\d+\.\d+/);
});

test('a local file is uploaded first and its upload is the source', async () => {
  const path = join(tmpdir(), `wm-cli-${process.pid}.png`);
  await writeFile(path, 'not really a png');
  try {
    const { code, calls } = await run(['image', 'process', path, '--op', 'grayscale', '--no-wait', '--json'], [
      { status: 201, body: { id: 'upl_aaaaaaaaaaaaaaaaaaaaaa', status: 'pending', upload: { method: 'PUT', url: 'https://bucket.test/u?sig=1', headers: { 'Content-Type': 'image/png' } } } },
      { status: 200, body: '' },
      { status: 202, body: { id: 9, status: 'queued', endpoint: 'images/process' } },
    ]);

    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { filename: path.split('/').pop(), size: 16, content_type: 'image/png' });
    assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[1].url, 'https://bucket.test/u?sig=1');
    assert.equal(calls[1].headers.Authorization, undefined);
    assert.equal(Buffer.from(calls[1].body).toString(), 'not really a png');
    assert.equal(calls[2].body.source, 'upl_aaaaaaaaaaaaaaaaaaaaaa');
  } finally {
    await rm(path, { force: true });
  }
});

test('a storage object and image create are sent in the API form', async () => {
  const { calls } = await run(['video', 'process', 'stg_7a:in/clip.mov', '--op', 'grayscale', '--no-wait', '--json'], [{ status: 202, body: { id: 1, status: 'queued' } }]);
  assert.deepEqual(calls[0].body.source, { storage: 'stg_7a', key: 'in/clip.mov' });

  const created = await run(['image', 'create', '--width', '1200', '--height', '300', '--op', 'text:text=Hi,font=inter-bold,size=96', '--op', 'trim', '--no-wait', '--json'], [{ status: 202, body: { id: 2, status: 'queued' } }]);
  assert.equal(created.calls[0].url, 'https://api.test/v1/images/create');
  assert.deepEqual(created.calls[0].body, { width: 1200, height: 300, operations: [{ type: 'text', text: 'Hi', font: 'inter-bold', size: 96 }, { type: 'trim' }] });
});

test('files, uploads, storage, events and fonts reach their endpoints', async () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaa';
  const cases = [
    [['file', 'get', `file_${id}`], 'GET /v1/files/file_' + id],
    [['file', 'delete', `file_${id}`], 'DELETE /v1/files/file_' + id],
    [['upload', 'get', `upl_${id}`], 'GET /v1/uploads/upl_' + id],
    [['storage', 'list'], 'GET /v1/storage'],
    [['storage', 'verify', 'stg_7a'], 'POST /v1/storage/stg_7a/verify'],
    [['storage', 'disconnect', 'stg_7a'], 'DELETE /v1/storage/stg_7a'],
    [['storage', 'connect', '--bucket', 'b', '--region', 'us-east-1', '--role-arn', 'arn:aws:iam::1:role/r', '--prefix', 'in/', '--prefix', 'out/'], 'POST /v1/storage'],
    [['storage', 'update', 'stg_7a', '--prefix', 'in/', '--prefix', 'archive/', '--write', 'false'], 'PATCH /v1/storage/stg_7a'],
    [['events', '--since', '2026-10-13T15:00:00Z'], 'GET /v1/events?since=2026-10-13T15%3A00%3A00Z'],
    [['fonts'], 'GET /v1/fonts'],
  ];

  for (const [argv, expected] of cases) {
    const { calls } = await run([...argv, '--json'], [{ body: { data: [], status: 'verified' } }]);
    const url = new URL(calls[0].url);
    assert.equal(`${calls[0].method} ${url.pathname}${url.search}`, expected);
    if (argv[1] === 'connect') assert.deepEqual(calls[0].body, { provider: 's3', bucket: 'b', region: 'us-east-1', role_arn: 'arn:aws:iam::1:role/r', prefixes: ['in/', 'out/'] });
    if (argv[1] === 'update') assert.deepEqual(calls[0].body, { prefixes: ['in/', 'archive/'], write: false });
  }
});

test('an SVG, a camera RAW file or a WMV is uploaded with its own type', () => {
  assert.equal(contentTypeOf('logo.svg'), 'image/svg+xml');
  assert.equal(contentTypeOf('DSC_0042.NEF'), 'image/x-nikon-nef');
  assert.equal(contentTypeOf('clip.wmv'), 'video/x-ms-wmv');
  assert.equal(contentTypeOf('notes.xyz'), 'application/octet-stream');
});

test('storage update needs something to change and takes only true or false for read and write', async () => {
  const empty = await run(['storage', 'update', 'stg_7a'], []);
  assert.notEqual(empty.code, 0);
  assert.match(empty.err, /storage update <stg_id>/);
  assert.equal(empty.calls.length, 0);

  const wrong = await run(['storage', 'update', 'stg_7a', '--read', 'yes'], []);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.err, /--read takes true or false/);
  assert.equal(wrong.calls.length, 0);
});

test('storage connect needs a prefix and sends the provider, read and write', async () => {
  const missing = await run(['storage', 'connect', '--bucket', 'b', '--region', 'us-east-1', '--role-arn', 'arn:aws:iam::1:role/r'], []);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /--prefix in\//);
  assert.equal(missing.calls.length, 0);

  const { code, calls } = await run(['storage', 'connect', '--bucket', 'b', '--region', 'us-east-1', '--role-arn', 'arn:aws:iam::1:role/r', '--prefix', 'out/', '--read', 'false', '--json'], [{ body: { id: 'stg_7a', status: 'unverified' } }]);
  assert.equal(code, 0);
  assert.deepEqual(calls[0].body, { provider: 's3', bucket: 'b', region: 'us-east-1', role_arn: 'arn:aws:iam::1:role/r', prefixes: ['out/'], read: false });
});

test('image read can find the level angle, and --level is refused elsewhere', async () => {
  const { calls } = await run(['image', 'read', 'https://example.com/a.jpg', '--level', '--no-wait', '--json'], [{ status: 202, body: { id: 5, status: 'queued' } }]);
  assert.deepEqual(calls[0].body, { source: 'https://example.com/a.jpg', level: true });

  const wrong = await run(['video', 'read', 'https://example.com/a.mp4', '--level'], []);
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /--level is for watermark image read/);
});

test('webhook events and several outputs are sent', async () => {
  const outputs = [{ name: 'large', format: 'webp' }, { name: 'thumb', operations: [{ type: 'resize', width: 200, height: 200 }] }];
  const { calls } = await run(['image', 'process', 'https://example.com/a.jpg', '--op', 'grayscale', '--outputs-json', JSON.stringify(outputs), '--event', 'request.progress', '--event', 'request.succeeded', '--no-wait', '--json'], [{ status: 202, body: { id: 5, status: 'queued' } }]);
  assert.deepEqual(calls[0].body.outputs, outputs);
  assert.deepEqual(calls[0].body.events, ['request.progress', 'request.succeeded']);
});

test('an error shows every invalid field and the permissions policy a storage change needs', async () => {
  const policy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::b/archive/*'] }] };
  const error = { type: 'invalid_request', code: 'destination_rejected', message: 'The connection was not changed.', request_id: 'ref_1', permissions_policy: policy };

  const human = await run(['storage', 'update', 'stg_7a', '--prefix', 'archive/'], [{ status: 422, body: { error } }]);
  assert.equal(human.code, 1);
  assert.match(human.err, /Error 422 destination_rejected/);
  assert.match(human.err, /permissions policy:\n\{/);
  assert.match(human.err, /arn:aws:s3:::b\/archive\/\*/);

  const machine = await run(['storage', 'update', 'stg_7a', '--prefix', 'archive/', '--json'], [{ status: 422, body: { error } }]);
  assert.deepEqual(JSON.parse(machine.out).error, { ...error, status: 422 });

  const invalid = await run(['image', 'process', 'https://example.com/a.jpg', '--op', 'resize:width=0'], [{ status: 422, body: { error: { type: 'invalid_request', code: 'validation_failed', message: 'Invalid.', errors: { 'operations.0.width': ['Must be at least 1.'] } } } }]);
  assert.match(invalid.err, /operations\.0\.width: Must be at least 1\./);
});

test('batch create uploads local files, sends a storage prefix, waits until partial and saves the zips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-cli-batch-'));
  const photo = join(dir, 'IMG_4471.jpg');
  await writeFile(photo, 'jpeg bytes');
  const out = join(dir, 'out');
  try {
    const counts = (succeeded, failed, running, waiting) => ({ total: 3, succeeded, failed, aborted: 0, running, waiting });
    const zips = [
      { id: 'file_aaaaaaaaaaaaaaaaaaaaaa', object: 'file', name: 'batch-42-1', format: 'zip', size: 12, files: 2, url: 'https://results.test/42-1.zip?sig=1', url_expires_at: 'soon' },
      { id: 'file_bbbbbbbbbbbbbbbbbbbbbb', object: 'file', name: 'batch-42-2', format: 'zip', size: 12, files: 1, url: 'https://results.test/42-2.zip?sig=2', url_expires_at: 'soon' },
    ];
    const { code, out: printed, err, calls } = await run(
      ['batch', 'create', photo, 'https://example.com/b.jpg', 'stg_7a:photos/', '--design', 'dsn_4hT9kLm2PqR7sV1wX3yZ5a', '--op', 'resize:width=1600,height=1600', '--format', 'webp', '--out', out],
      [
        { status: 201, body: { id: 'upl_aaaaaaaaaaaaaaaaaaaaaa', status: 'pending', upload: { method: 'PUT', url: 'https://bucket.test/u?sig=1', headers: { 'Content-Type': 'image/jpeg' } } } },
        { status: 200, body: '' },
        { status: 202, body: { id: 42, object: 'batch', status: 'queued', media: 'image', counts: counts(0, 0, 0, 3), progress: 0 } },
        { body: { id: 42, object: 'batch', status: 'processing', media: 'image', counts: counts(1, 0, 2, 0), progress: 33 } },
        { body: { id: 42, object: 'batch', status: 'partial', media: 'image', counts: counts(2, 1, 0, 0), progress: 100, zips, price: { amount: '0.004000', currency: 'usd' } } },
        { body: 'ZIP ONE BYTES' },
        { body: 'ZIP TWO BYTES' },
      ],
    );

    assert.equal(code, 1, 'a partial batch exits 1');
    assert.deepEqual(calls[0].body, { filename: 'IMG_4471.jpg', size: 10, content_type: 'image/jpeg' });
    assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[2].url, 'https://api.test/v1/batches');
    assert.deepEqual(calls[2].body, {
      sources: ['upl_aaaaaaaaaaaaaaaaaaaaaa', 'https://example.com/b.jpg', { storage: 'stg_7a', prefix: 'photos/' }],
      design: 'dsn_4hT9kLm2PqR7sV1wX3yZ5a',
      operations: [{ type: 'resize', width: 1600, height: 1600 }],
      output: { format: 'webp' },
      zip: true,
    });
    assert.equal(calls[3].url, 'https://api.test/v1/batches/42?wait=25');
    assert.equal(calls[4].url, 'https://api.test/v1/batches/42?wait=25');
    assert.match(err, /Batch 42: processing 33% \(3 in all, 1 succeeded, 0 failed, 0 aborted, 2 running, 0 waiting\)/);
    assert.equal(calls[5].url, 'https://results.test/42-1.zip?sig=1');
    assert.equal(calls[5].headers.Authorization, undefined, 'a signed zip link is fetched without the key');
    assert.equal(await readFile(join(out, 'batch-42-1.zip'), 'utf8'), 'ZIP ONE BYTES');
    assert.equal(await readFile(join(out, 'batch-42-2.zip'), 'utf8'), 'ZIP TWO BYTES');
    assert.match(err, /Downloading batch-42-2.zip \(2 of 2/);
    assert.match(printed, /^Batch 42 \(image\): partial\nFiles: 3 in all, 2 succeeded, 1 failed/);
    assert.match(printed, /Saved to .*batch-42-1\.zip, .*batch-42-2\.zip/);
    assert.match(printed, /Failed files: watermark batch requests 42 --status failed, then watermark batch retry 42/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('batch create expands a folder in order, uploading four files at a time, and --no-wait prints the accepted batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-cli-folder-'));
  const names = ['e.jpg', 'a.jpg', 'c.jpg', 'b.jpg', 'd.jpg', 'f.jpg'];
  await Promise.all([...names.map((name) => writeFile(join(dir, name), name)), writeFile(join(dir, '.DS_Store'), 'junk')]);
  try {
    // Uploads overlap, so answer each call by what it is rather than from a queue.
    let inFlight = 0;
    let mostInFlight = 0;
    let uploads = 0;
    const calls = [];
    const gated = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
      if (init.method === 'PUT') {
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return new Response('', { status: 200 });
      }
      if (String(url).endsWith('/v1/uploads')) {
        return Response.json({ id: `upl_${String(uploads++).padStart(22, '0')}`, status: 'pending', upload: { url: `https://bucket.test/${uploads}`, headers: {} } }, { status: 201 });
      }
      return Response.json({ id: 43, object: 'batch', status: 'queued', media: 'image', counts: { total: 6, waiting: 6, running: 0, succeeded: 0, failed: 0, aborted: 0 }, progress: 0, price: { amount: '0.000000', currency: 'usd', estimate_micro_usd: 12000 } }, { status: 202 });
    };

    let out = '';
    let err = '';
    const code = await main(['batch', 'create', dir, '--op', 'grayscale', '--no-wait'], {
      env: { WATERMARK_API_KEY: 'wm_test_key', WATERMARK_API_URL: 'https://api.test' },
      stdout: { write: (text) => { out += text; } },
      stderr: { write: (text) => { err += text; } },
      fetch: gated,
      sleep: async () => {},
    });

    assert.equal(code, 0, err);
    const created = calls.filter((call) => call.url.endsWith('/v1/uploads')).map((call) => call.body.filename);
    assert.deepEqual(created.slice().sort(), names.slice().sort());
    assert.ok(!created.includes('.DS_Store'));
    assert.ok(mostInFlight <= 4 && mostInFlight >= 2, `${mostInFlight} uploads at once`);
    assert.match(err, /Uploaded 6 of 6 files/);
    const batch = calls.at(-1);
    assert.equal(batch.url, 'https://api.test/v1/batches');
    // Sources keep the folder's sorted order whatever order the uploads finished in.
    const order = batch.body.sources.map((id) => created[Number(id.slice(4))]);
    assert.deepEqual(order, ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg']);
    assert.deepEqual(batch.body.operations, [{ type: 'grayscale' }]);
    assert.equal(batch.body.zip, undefined);
    assert.match(out, /^Batch 43 \(image\): queued 0%\n/);
    assert.match(out, /Follow it: watermark batch get 43 --wait/);
    assert.match(out, /Price: \$0\.000000 \(estimate \$0\.012000\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('batch get, requests, retry, abort and batches reach their endpoints, and get --wait long-polls', async () => {
  const batch = { id: 42, object: 'batch', status: 'succeeded', media: 'image', counts: { total: 2, waiting: 0, running: 0, succeeded: 2, failed: 0, aborted: 0 }, progress: 100 };
  const cases = [
    [['batch', 'get', '42'], 'GET /v1/batches/42'],
    [['batch', 'get', '42', '--wait'], 'GET /v1/batches/42?wait=25'],
    [['batch', 'requests', '42', '--status', 'failed', '--after', '10', '--limit', '5'], 'GET /v1/batches/42/requests?status=failed&after=10&limit=5'],
    [['batch', 'retry', '42'], 'POST /v1/batches/42/retry'],
    [['batch', 'abort', '42'], 'POST /v1/batches/42/abort'],
    [['batches', '--status', 'partial', '--limit', '5'], 'GET /v1/batches?limit=5&status=partial'],
  ];

  for (const [argv, expected] of cases) {
    const { code, calls } = await run([...argv, '--json'], [{ body: { ...batch, data: [] } }]);
    const url = new URL(calls[0].url);
    assert.equal(`${calls[0].method} ${url.pathname}${url.search}`, expected);
    assert.equal(code, 0, argv.join(' '));
  }

  const failed = await run(['batch', 'requests', '42', '--status', 'failed'], [{ body: { data: [{ id: 7, position: 3, status: 'failed', error: { code: 'unsupported_media', message: 'Not an image.' } }], has_more: true } }]);
  assert.match(failed.out, /^3\t7\tfailed\tunsupported_media: Not an image\.\nMore: watermark batch requests 42 --after 3 --status failed/);

  const wrong = await run(['batch', 'get', 'dsn_x'], []);
  assert.equal(wrong.code, 2);
  assert.equal(wrong.calls.length, 0);

  const request = await run(['request', 'get', '1234', '--wait', '--json'], [{ body: { id: 1234, status: 'processing' } }, { body: { id: 1234, status: 'succeeded' } }]);
  assert.equal(request.calls.length, 2);
  assert.equal(request.calls[1].url, 'https://api.test/v1/requests/1234?wait=25');
  assert.equal(JSON.parse(request.out).status, 'succeeded');
});

test('preview posts the media, frame, page and width, waits only when needed, and saves the picture', async () => {
  const path = join(tmpdir(), `wm-cli-preview-${process.pid}.webp`);
  const { code, out, calls } = await run(
    ['preview', 'https://example.com/talk.mp4', '--media', 'video', '--at', '5', '--width', '800', '--op', 'watermark:image_url=https://example.com/logo.png,anchor=top_left,margin=2%,size=12%', '--out', path],
    [
      { body: { id: 9, object: 'request', endpoint: 'previews', status: 'succeeded', result: { data: { width: 800, height: 450, scale: 0.41, layout: [{ type: 'watermark', x: 16, y: 16, width: 96, height: 40 }] }, files: [{ url: 'https://results.test/9.webp', url_expires_at: 'tomorrow' }] } } },
      { body: 'WEBP BYTES' },
    ],
  );

  assert.equal(code, 0);
  assert.equal(calls.length, 2, 'a preview that came back finished is not polled');
  assert.equal(calls[0].url, 'https://api.test/v1/previews');
  assert.deepEqual(calls[0].body, {
    source: 'https://example.com/talk.mp4',
    media: 'video',
    operations: [{ type: 'watermark', image_url: 'https://example.com/logo.png', anchor: 'top_left', margin: '2%', size: '12%' }],
    width: 800,
    at: 5,
  });
  assert.equal(await readFile(path, 'utf8'), 'WEBP BYTES');
  assert.match(out, /Request 9 \(previews\): succeeded\nResult: .*"layout"/);
  await rm(path);

  const queued = await run(['preview', 'https://example.com/a.pdf', '--media', 'document', '--page', '2', '--design', 'dsn_4hT9kLm2PqR7sV1wX3yZ5a', '--json'], [
    { status: 202, body: { id: 10, status: 'queued', endpoint: 'previews' } },
    { body: { id: 10, status: 'succeeded', endpoint: 'previews' } },
  ]);
  assert.deepEqual(queued.calls[0].body, { source: 'https://example.com/a.pdf', media: 'document', design: 'dsn_4hT9kLm2PqR7sV1wX3yZ5a', page: 2 });
  assert.equal(queued.calls[1].url, 'https://api.test/v1/requests/10?wait=25');
});

test('a design is created, listed, changed and deleted, and --design makes --op optional', async () => {
  const design = { id: 'dsn_4hT9kLm2PqR7sV1wX3yZ5a', object: 'design', name: 'Corner logo', media: 'any', operations: [{ type: 'watermark', image: 'file_6dM3nP8qR1sT4uV7wX0yZ2', anchor: 'bottom_right', margin: '3%', size: '18%', opacity: 60 }], assets: [{ id: 'file_6dM3nP8qR1sT4uV7wX0yZ2', format: 'png', size: 48213 }] };

  const created = await run(['design', 'create', '--name', 'Corner logo', '--op', 'watermark:image=upl_9f3Tq1LmA2bC4dE6fG8hJ0,anchor=bottom_right,margin=3%,size=18%,opacity=60'], [{ status: 201, body: design }]);
  assert.equal(created.code, 0);
  assert.equal(created.calls[0].url, 'https://api.test/v1/designs');
  assert.deepEqual(created.calls[0].body, { name: 'Corner logo', operations: [{ type: 'watermark', image: 'upl_9f3Tq1LmA2bC4dE6fG8hJ0', anchor: 'bottom_right', margin: '3%', size: '18%', opacity: 60 }] });
  assert.match(created.out, /^Design dsn_4hT9kLm2PqR7sV1wX3yZ5a: Corner logo \(any\)\nOperations: \[.*"anchor":"bottom_right".*\]\nAsset: file_6dM3nP8qR1sT4uV7wX0yZ2 \(png, 48213 bytes\)/);

  const listed = await run(['designs', '--limit', '5', '--json'], [{ body: { object: 'list', data: [design], has_more: false } }]);
  assert.equal(listed.calls[0].url, 'https://api.test/v1/designs?limit=5');
  assert.equal(JSON.parse(listed.out).data[0].id, design.id);

  const updated = await run(['design', 'update', design.id, '--name', 'Lighter', '--media', 'image', '--json'], [{ body: design }]);
  assert.equal(updated.calls[0].method, 'PATCH');
  assert.deepEqual(updated.calls[0].body, { name: 'Lighter', media: 'image' });

  const deleted = await run(['design', 'delete', design.id], [{ body: { ...design, deleted_at: '2026-10-16T09:00:00Z' } }]);
  assert.equal(deleted.calls[0].method, 'DELETE');
  assert.match(deleted.out, /Deleted 2026-10-16T09:00:00Z/);

  const empty = await run(['design', 'update', design.id], []);
  assert.equal(empty.code, 2);
  assert.match(empty.err, /needs something to change/);

  const used = await run(['image', 'process', 'https://example.com/a.jpg', '--design', design.id, '--format', 'webp', '--no-wait', '--json'], [{ status: 202, body: { id: 11, status: 'queued' } }]);
  assert.deepEqual(used.calls[0].body, { source: 'https://example.com/a.jpg', design: design.id, output: { format: 'webp' } });

  const neither = await run(['image', 'process', 'https://example.com/a.jpg'], []);
  assert.equal(neither.code, 2);
  assert.match(neither.err, /at least one --op .*or a --design/);

  const bad = await run(['video', 'process', 'https://example.com/a.mp4', '--design', 'dsn_short'], []);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--design takes a design id/);
});

test('batch get --out fetches the zips of a finished batch, and a broken download leaves no file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-cli-batch-get-'));
  try {
    const zips = [
      { id: 'file_aaaaaaaaaaaaaaaaaaaaaa', object: 'file', name: 'batch-42-1', format: 'zip', size: 12, files: 2, url: 'https://results.test/42-1.zip?sig=1', url_expires_at: 'soon' },
      { id: 'file_bbbbbbbbbbbbbbbbbbbbbb', object: 'file', name: 'batch-42-2', format: 'zip', size: 12, files: 1, url: 'https://results.test/42-2.zip?sig=2', url_expires_at: 'soon' },
    ];
    const finished = { id: 42, object: 'batch', status: 'succeeded', media: 'image', counts: { total: 3, waiting: 0, running: 0, succeeded: 3, failed: 0, aborted: 0 }, progress: 100, zips };

    const { code, out: printed, calls } = await run(['batch', 'get', '42', '--out', dir], [
      { body: finished },
      { body: 'ZIP ONE BYTES' },
      { body: 'ZIP TWO BYTES' },
    ]);

    assert.equal(code, 0);
    assert.equal(calls[0].url, 'https://api.test/v1/batches/42');
    assert.equal(calls[1].url, 'https://results.test/42-1.zip?sig=1');
    assert.equal(await readFile(join(dir, 'batch-42-1.zip'), 'utf8'), 'ZIP ONE BYTES');
    assert.equal(await readFile(join(dir, 'batch-42-2.zip'), 'utf8'), 'ZIP TWO BYTES');
    assert.match(printed, /Saved to .*batch-42-1\.zip, .*batch-42-2\.zip/);

    // A download that breaks part-way leaves neither the file nor its .part behind.
    const broken = await run(['batch', 'get', '42', '--out', join(dir, 'again')], [
      { body: finished },
      { status: 500, body: 'nope' },
    ]);

    assert.equal(broken.code, 1);
    assert.match(broken.err, /Downloading batch-42-1\.zip failed: HTTP 500/);
    await assert.rejects(stat(join(dir, 'again', 'batch-42-1.zip')));
    await assert.rejects(stat(join(dir, 'again', 'batch-42-1.zip.part')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
