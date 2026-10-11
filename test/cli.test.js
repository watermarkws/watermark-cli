import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseOperation } from '../src/cli.js';

// A fetch that answers from a list and records what it was sent.
function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
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
  assert.equal(calls[2].url, 'https://api.test/v1/requests/5');
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
  assert.match(usage.err, /public http/);
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
