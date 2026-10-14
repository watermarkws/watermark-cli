import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
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
