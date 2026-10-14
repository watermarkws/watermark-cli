// Holds the CLI to the API's OpenAPI spec, so a CLI that is behind the API
// fails here instead of in someone's terminal.
//
// The spec comes from WATERMARK_API_SPEC (a path or a URL), else the API
// checkout next to this one, else spec/openapi.json: the copy this CLI was
// last checked against, whose sha256 is in spec.sha.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SIBLING = join(ROOT, '..', 'watermark-api', 'resources', 'docs', 'build', 'openapi.json');
const SOURCE = process.env.WATERMARK_API_SPEC || (existsSync(SIBLING) ? SIBLING : join(ROOT, 'spec', 'openapi.json'));
const BYTES = /^https?:\/\//.test(SOURCE)
  ? Buffer.from(await (await fetch(SOURCE)).arrayBuffer())
  : readFileSync(SOURCE);
const SPEC = JSON.parse(BYTES.toString('utf8'));

const URL_SOURCE = 'https://example.com/a.jpg';
const FILE_ID = 'file_2kqV7PzM1aT4hQ0bR9sX3c';
const UPLOAD_ID = 'upl_2kqV7PzM1aT4hQ0bR9sX3c';
const COMMON = ['--webhook', 'https://example.com/hook', '--event', 'request.progress', '--customer', 'c1', '--metadata', 'k=v', '--idempotency-key', 'k1', '--json'];
const OUTPUTS = ['--outputs-json', '[{"name":"large"}]'];
const NO_WAIT = [...COMMON, '--no-wait'];
const WAIT = 'The CLI waits by polling GET /v1/requests/{id}?wait=…, which also covers requests that run longer than the 25 seconds the wait parameter allows.';
const LINK = 'link';

// Every operation in the spec and the commands that call it. Each run's
// request is recorded; together the runs must send every body property and
// query parameter the spec lists, unless "allow" names it with the reason it
// is left out.
const COVERAGE = {
  'POST /v1/images/process': { runs: [['image', 'process', URL_SOURCE, '--op', 'grayscale', '--format', 'webp', ...NO_WAIT], ['image', 'process', URL_SOURCE, '--op', 'grayscale', ...OUTPUTS, ...NO_WAIT]], allow: { wait: WAIT } },
  'POST /v1/images/read': { runs: [['image', 'read', URL_SOURCE, '--level', ...NO_WAIT]], allow: { wait: WAIT } },
  'POST /v1/images/create': { runs: [['image', 'create', '--width', '10', '--height', '10', '--background', '#ffffff', '--op', 'text:text=Hi', '--format', 'png', ...NO_WAIT], ['image', 'create', '--width', '10', '--height', '10', '--op', 'text:text=Hi', ...OUTPUTS, ...NO_WAIT]], allow: { wait: WAIT } },
  'POST /v1/videos/process': { runs: [['video', 'process', URL_SOURCE, '--op', 'grayscale', '--max-duration', '5', '--format', 'mp4', ...NO_WAIT], ['video', 'process', URL_SOURCE, '--op', 'grayscale', ...OUTPUTS, ...NO_WAIT]], allow: { wait: WAIT } },
  'POST /v1/videos/read': { runs: [['video', 'read', URL_SOURCE, ...NO_WAIT]], allow: { wait: WAIT } },
  'POST /v1/videos/screenshot': { runs: [['video', 'screenshot', URL_SOURCE, '--seconds', '1', '--format', 'png', ...NO_WAIT], ['video', 'screenshot', URL_SOURCE, '--seconds', '1', ...OUTPUTS, ...NO_WAIT]], allow: { wait: WAIT } },
  'POST /v1/documents/process': { runs: [['document', 'process', URL_SOURCE, '--op', 'grayscale', '--max-pages', '2', ...OUTPUTS, ...NO_WAIT]], allow: { wait: WAIT } },
  'POST /v1/documents/read': { runs: [['document', 'read', URL_SOURCE, ...NO_WAIT]], allow: { wait: WAIT } },
  'POST /v1/documents/snapshot': { runs: [['document', 'snapshot', URL_SOURCE, '--page', '1', '--format', 'png', ...NO_WAIT], ['document', 'snapshot', URL_SOURCE, ...OUTPUTS, ...NO_WAIT]], allow: { wait: WAIT } },
  'GET /v1/requests': { runs: [['requests', '--limit', '5', '--before', '10', '--json']] },
  'GET /v1/requests/{id}': { runs: [['request', 'get', '1234', '--json'], ['image', 'process', URL_SOURCE, '--op', 'grayscale', '--json']] },
  'POST /v1/requests/{id}/abort': { runs: [['request', 'abort', '1234', '--json']] },
  'GET /v1/results/{id}': { [LINK]: 'A signed link the API returns in result.files[].url; --out opens it as given, the CLI never builds it.' },
  'GET /v1/files/{id}': { runs: [['file', 'get', FILE_ID, '--json']] },
  'DELETE /v1/files/{id}': { runs: [['file', 'delete', FILE_ID, '--json']] },
  'GET /v1/files/{id}/content': { [LINK]: 'A signed link the API returns as a file\'s url, which watermark file get prints; opened as given, never built by the CLI.' },
  'POST /v1/uploads': { runs: [['upload', fileURLToPath(import.meta.url), '--json']] },
  'GET /v1/uploads/{id}': { runs: [['upload', 'get', UPLOAD_ID, '--json']] },
  'DELETE /v1/uploads/{id}': { runs: [['upload', 'delete', UPLOAD_ID, '--json']] },
  'GET /v1/storage': { runs: [['storage', 'list', '--json']] },
  'POST /v1/storage': { runs: [['storage', 'connect', '--bucket', 'b', '--region', 'us-east-1', '--role-arn', 'arn:aws:iam::1:role/r', '--prefix', 'in/', '--read', 'true', '--write', 'false', '--json']] },
  'GET /v1/storage/{id}': { runs: [['storage', 'get', 'stg_7a', '--json']] },
  'PATCH /v1/storage/{id}': { runs: [['storage', 'update', 'stg_7a', '--prefix', 'in/', '--read', 'true', '--write', 'false', '--json']] },
  'DELETE /v1/storage/{id}': { runs: [['storage', 'disconnect', 'stg_7a', '--json']] },
  'POST /v1/storage/{id}/verify': { runs: [['storage', 'verify', 'stg_7a', '--json']] },
  'GET /v1/events': { runs: [['events', '--since', '2026-10-13T15:00:00Z', '--limit', '5', '--json']] },
  'GET /v1/account': { runs: [['account', '--json']] },
  'GET /v1/usage': { runs: [['usage', '--from', '2026-10-01', '--to', '2026-10-31', '--group-by', 'day', '--customer', 'c1', '--json']] },
  'GET /v1/fonts': { runs: [['fonts', '--json']] },
  'GET /v1/operations': { runs: [['operations', '--json']] },
};

function resolve(node) {
  while (node && node.$ref) {
    node = node.$ref.slice(2).split('/').reduce((target, part) => target[part], SPEC);
  }
  return node || {};
}

function operations() {
  const found = {};
  for (const [path, item] of Object.entries(SPEC.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (!item[method]) continue;
      const operation = item[method];
      const parameters = [...(item.parameters || []), ...(operation.parameters || [])].map(resolve);
      const schema = resolve(resolve(operation.requestBody).content?.['application/json']?.schema);
      found[`${method.toUpperCase()} ${path}`] = {
        body: Object.keys(schema.properties || {}),
        query: parameters.filter((param) => param.in === 'query').map((param) => param.name),
        headers: parameters.filter((param) => param.in === 'header').map((param) => param.name),
      };
    }
  }
  return found;
}

function sample(schema) {
  schema = resolve(schema);
  if ('example' in schema) return schema.example;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf || schema.anyOf) return sample((schema.oneOf || schema.anyOf)[0]);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return true;
  if (type === 'array') return [sample(schema.items)];
  if (type === 'object') return { key: 'value' };
  return 'value';
}

// Run the CLI against a fetch that answers every call with `answer` and
// records what it was sent.
async function run(argv, answer = { status: 200, body: { id: 1234, object: 'request', endpoint: 'images/process', status: 'succeeded', upload: { url: 'https://uploads.test/put' }, data: [] } }) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: new URL(String(url)), method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: { WATERMARK_API_KEY: 'wm_test_key', WATERMARK_API_URL: 'https://api.test' },
    stdout: { write: (text) => { out += text; } },
    stderr: { write: (text) => { err += text; } },
    fetch,
    sleep: async () => {},
  });
  return { code, out, err, calls };
}

test('the spec is the one this CLI was last checked against', () => {
  const recorded = existsSync(join(ROOT, 'spec.sha')) ? readFileSync(join(ROOT, 'spec.sha'), 'utf8').trim() : '';
  const copy = createHash('sha256').update(readFileSync(join(ROOT, 'spec', 'openapi.json'))).digest('hex');
  assert.equal(copy, recorded, 'spec.sha does not match spec/openapi.json. Run npm run spec:refresh, which writes both.');

  const actual = createHash('sha256').update(BYTES).digest('hex');
  assert.equal(actual, recorded, [
    `The API spec at ${SOURCE} (sha256 ${actual}) is not the one this CLI was last checked against (spec.sha ${recorded}).`,
    `1. Review what changed: diff spec/openapi.json against ${SOURCE}.`,
    '2. Update the CLI for it: new endpoints, parameters and errors, with tests and the README.',
    '3. Then run npm run spec:refresh to record the spec as checked.',
  ].join('\n'));
});

test('every operation in the spec has a command, and the map has nothing stale', () => {
  const inSpec = Object.keys(operations());
  const mapped = Object.keys(COVERAGE);
  assert.deepEqual(inSpec.filter((key) => !mapped.includes(key)), [], 'These operations have no command: add one, and map it in COVERAGE in test/spec-coverage.test.js.');
  assert.deepEqual(mapped.filter((key) => !inSpec.includes(key)), [], 'The spec no longer has these operations: remove their commands and their COVERAGE entries.');
});

test('every body property and query parameter is sent or allowed with a reason', async () => {
  const problems = [];

  for (const [key, operation] of Object.entries(operations())) {
    const entry = COVERAGE[key];
    if (!entry || entry[LINK]) continue;

    const [method, path] = key.split(' ');
    const pattern = new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^/]+?\}/g, '[^/]+')}$`);
    const sent = { body: new Set(), query: new Set(), headers: new Set() };

    for (const argv of entry.runs) {
      const { err, calls } = await run(argv);
      const call = calls.find((c) => c.method === method && c.url.host === 'api.test' && pattern.test(c.url.pathname));
      if (!call) {
        problems.push(`${key}: watermark ${argv.join(' ')} sent no ${method} to ${path}. ${err.trim()}`);
        continue;
      }
      Object.keys(call.body || {}).forEach((name) => sent.body.add(name));
      call.url.searchParams.forEach((_, name) => sent.query.add(name));
      Object.keys(call.headers).forEach((name) => sent.headers.add(name.toLowerCase()));
    }

    const allowed = Object.keys(entry.allow || {});
    const checks = [
      ['body property', operation.body, (name) => sent.body.has(name)],
      ['query parameter', operation.query, (name) => sent.query.has(name)],
      ['header', operation.headers, (name) => sent.headers.has(name.toLowerCase())],
    ];
    for (const [what, names, isSent] of checks) {
      for (const name of names) {
        if (!isSent(name) && !allowed.includes(name)) problems.push(`${key}: the ${what} ${name} is never sent. Send it, or allow it in COVERAGE with the reason.`);
        if (isSent(name) && allowed.includes(name)) problems.push(`${key}: ${name} is sent now; take it off the allow-list.`);
      }
    }
    for (const name of allowed) {
      if (![...operation.body, ...operation.query, ...operation.headers].includes(name)) problems.push(`${key}: the allow-list names ${name}, which the spec no longer has.`);
    }
  }

  assert.deepEqual(problems, []);
});

test('every field of an error reaches the user', async () => {
  const fields = resolve(resolve(SPEC.components.schemas.Error).properties.error).properties;
  const error = Object.fromEntries(Object.entries(fields).map(([name, schema]) => [name, sample(schema)]));
  error.type = 'invalid_request';

  const { code, out } = await run(['account', '--json'], { status: 422, body: { error } });

  assert.equal(code, 1);
  const printed = JSON.parse(out).error;
  for (const name of Object.keys(fields)) {
    assert.deepEqual(printed[name], error[name], `The error field ${name} is not printed with --json.`);
  }
});

test('the README covers every error code', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /^## Errors$/m, 'The README has no "## Errors" section.');
  const section = readme.split(/^## Errors$/m)[1].split(/^## /m)[0];
  if (/passes every error code through/i.test(section)) return;

  const missing = errorCodes().filter((code) => !section.includes(`\`${code}\``));
  assert.deepEqual(missing, [], 'The README\'s Errors section neither names these codes nor says the CLI passes every error code through.');
});

// The error codes the spec lists: an enum or x-error-codes on the error's
// code, and, when the spec is the API's own build, the tables of the errors
// guide built beside it.
function errorCodes() {
  const code = resolve(resolve(SPEC.components.schemas.Error).properties.error).properties.code || {};
  const codes = [...(code.enum || []), ...(code['x-error-codes'] || [])];
  const guide = join(dirname(SOURCE), 'pages', 'errors.md');

  if (!/^https?:\/\//.test(SOURCE) && existsSync(guide)) {
    let column = null;
    for (const line of readFileSync(guide, 'utf8').split('\n')) {
      if (!line.startsWith('|')) {
        column = null;
        continue;
      }
      const cells = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      if (column === null) {
        column = cells.findIndex((cell) => cell === 'Code' || cell === 'Codes');
        continue;
      }
      if (column >= 0) codes.push(...[...(cells[column] || '').matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map((match) => match[1]));
    }
  }

  return [...new Set(codes)];
}
