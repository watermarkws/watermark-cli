import { readFile, stat, writeFile } from 'node:fs/promises';
import { Api, ApiError, VERSION } from './api.js';

const HELP = `watermark: the Watermark API from the command line (https://api.watermark.ws/docs)

Usage:
  watermark image process <source> --op <operation> [--op ...] [--format webp] [--out file]
  watermark image read <source> [--level]
  watermark image create --width 1200 --height 300 [--background "#ffffff"] --op <operation> [--out file]
  watermark video process <source> --op <operation> [--max-duration 30] [--out file]
  watermark video read <source>
  watermark video screenshot <source> --seconds 5 [--format png] [--out file]
  watermark document process <source> --op <operation> [--max-pages 10] [--out file]
  watermark document read <source>
  watermark document snapshot <source> [--page 1] [--format png] [--out file]
  watermark request get <id> | watermark request abort <id>
  watermark requests [--limit 20] [--before <id>]
  watermark upload <file> | watermark upload get|delete <upl_id>
  watermark file get|delete <file_id>
  watermark storage list | get|verify|disconnect <stg_id>
  watermark storage connect --bucket <name> --region <region> --role-arn <arn> --prefix in/ [--prefix ...] [--read true|false] [--write true|false]
  watermark storage update <stg_id> [--prefix in/ ...] [--read true|false] [--write true|false]
  watermark events --since 2026-10-13T15:00:00Z [--limit 100]
  watermark fonts
  watermark account
  watermark usage [--from 2026-10-01] [--to 2026-10-31] [--group-by day|endpoint|customer|status] [--customer <id>]
  watermark operations [image|video|document]

A source is a public http(s) URL, a local file (uploaded first), an upload
(upl_…), a file an earlier request kept (file_…), or an object in a
connected bucket (stg_7a:path/to/key).

Operations (repeat --op; they run in order):
  --op resize:width=800,height=600
  --op grayscale
  --op watermark:image_url=https://example.com/logo.png,x=40,y=40
  --ops-json '[{"type":"resize","width":800,"height":600}]'
  See: watermark operations image

  More than one file from a request, each with its own operations and format:
  --outputs-json '[{"name":"large","format":"webp"},{"name":"thumb","operations":[{"type":"resize","width":200,"height":200}]}]'

Options:
  --out <file>            Wait, then download the result to this file.
  --no-wait               Return as soon as the request is queued.
  --timeout <seconds>     How long to wait (default 300).
  --webhook <url>         Post the finished request here.
  --event <type>          The webhook events to send (repeatable), such as request.progress.
  --customer <id>         Your own reference for who the request is for.
  --metadata key=value    Repeatable.
  --idempotency-key <k>   Make a retry of this command safe.
  --json                  Print JSON only (for scripts and AI agents).
  --api-key <key>         Or set WATERMARK_API_KEY.
  --base-url <url>        Or set WATERMARK_API_URL (default https://api.watermark.ws).
  --version               Print the version.
`;

const MEDIA = { image: 'images', images: 'images', video: 'videos', videos: 'videos', document: 'documents', documents: 'documents', pdf: 'documents' };
const ACTIONS = {
  images: ['process', 'read', 'create'],
  videos: ['process', 'read', 'screenshot'],
  documents: ['process', 'read', 'snapshot'],
};
const REPEATABLE = new Set(['op', 'metadata', 'prefix', 'event']);
const FLAGS = new Set(['json', 'no-wait', 'help', 'version', 'level']);

// Parse argv into positionals and options; repeatable options collect arrays.
export function parseArgs(argv) {
  const positionals = [];
  const options = { op: [], metadata: [], prefix: [], event: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    let [name, value] = arg.slice(2).split(/=(.*)/s, 2);
    if (FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value.`);
    }
    if (REPEATABLE.has(name)) options[name].push(value);
    else options[name] = value;
  }

  return { positionals, options };
}

// "resize:width=800,height=600" -> {type: "resize", width: 800, height: 600}
export function parseOperation(text) {
  const [type, rest] = text.split(/:(.*)/s, 2);
  if (!/^[a-z_]+$/.test(type)) throw new UsageError(`"${text}" is not an operation: use type:param=value,...`);

  const operation = { type };
  for (const pair of (rest || '').split(',').filter(Boolean)) {
    const [key, value] = pair.split(/=(.*)/s, 2);
    if (value === undefined) throw new UsageError(`"${pair}" in --op ${type} needs a value: param=value.`);
    operation[key.trim()] = typedValue(value.trim());
  }
  return operation;
}

function typedValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

class UsageError extends Error {}

export async function main(argv, { env = {}, stdout, stderr, fetch, sleep } = {}) {
  const print = (text) => stdout.write(text + '\n');
  const fail = (text) => stderr.write(text + '\n');

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    fail(error.message);
    return 2;
  }
  const { positionals, options } = parsed;

  if (options.version) {
    print(`watermark ${VERSION}`);
    return 0;
  }

  if (options.help || positionals.length === 0) {
    print(HELP);
    return positionals.length === 0 && !options.help ? 2 : 0;
  }

  const json = Boolean(options.json);
  const output = (value, human) => print(json ? JSON.stringify(value, null, 2) : human(value));

  try {
    const api = new Api({
      apiKey: options['api-key'] || env.WATERMARK_API_KEY,
      baseUrl: options['base-url'] || env.WATERMARK_API_URL || 'https://api.watermark.ws',
      fetch,
      sleep,
    });

    const [command, ...rest] = positionals;

    if (MEDIA[command]) {
      return await runMedia(api, MEDIA[command], rest, options, { output, print, json, fetch: fetch || globalThis.fetch });
    }

    switch (command) {
      case 'request': {
        const [action, id] = rest;
        if (!['get', 'abort'].includes(action) || !/^\d+$/.test(id || '')) throw new UsageError('Usage: watermark request get|abort <id>');
        const request = await api.request(action === 'get' ? 'GET' : 'POST', `/v1/requests/${id}${action === 'abort' ? '/abort' : ''}`);
        output(request, describeRequest);
        return request.status === 'failed' ? 1 : 0;
      }
      case 'requests': {
        const list = await api.request('GET', '/v1/requests', { query: { limit: options.limit, before: options.before } });
        output(list, (value) => value.data.map((request) => `${request.id}\t${request.endpoint}\t${request.status}\t${request.created_at}`).join('\n') || 'No requests yet.');
        return 0;
      }
      case 'account': {
        const account = await api.request('GET', '/v1/account');
        output(account, (value) => [
          `${value.name} (${value.tier}${value.livemode === false ? ', test key' : ''})`,
          `Balance: $${value.balance.amount}`,
          value.limits ? `Limits: ${value.limits.requests_per_minute} requests a minute, sources up to ${Math.round(value.limits.max_source_bytes / 1048576)} MB` : '',
        ].filter(Boolean).join('\n'));
        return 0;
      }
      case 'usage': {
        const usage = await api.request('GET', '/v1/usage', { query: { from: options.from, to: options.to, group_by: options['group-by'], customer: options.customer } });
        output(usage, (value) => [`${value.group_by}\trequests\tfailed\tspent`, ...value.data.map((row) => `${row[value.group_by]}\t${row.requests}\t${row.failed}\t$${row.spent}`)].join('\n'));
        return 0;
      }
      case 'operations': {
        const catalog = await api.request('GET', '/v1/operations');
        const media = rest[0] ? { image: 'image', images: 'image', video: 'video', videos: 'video', document: 'document', documents: 'document' }[rest[0]] : null;
        const selected = media ? { [media]: catalog.data[media] } : catalog.data;
        output(selected, (value) => Object.entries(value).map(([name, entry]) => [
          `${name} (formats: ${entry.formats.join(', ')})`,
          ...Object.entries(entry.operations).map(([type, operation]) => `  ${type}: ${operation.description}\n${Object.entries(operation.params).map(([param, info]) => `      ${param}${info.required ? ' (required)' : ''}: ${info.description}`).join('\n')}`),
        ].join('\n')).join('\n\n'));
        return 0;
      }
      case 'upload': {
        const [action, id] = rest;
        if (['get', 'delete'].includes(action)) {
          if (!/^upl_[A-Za-z0-9]{22}$/.test(id || '')) throw new UsageError('Usage: watermark upload get|delete <upl_id>');
          output(await api.request(action === 'get' ? 'GET' : 'DELETE', `/v1/uploads/${id}`), describeUpload);
          return 0;
        }
        if (!action) throw new UsageError('Usage: watermark upload <file>');
        output(await api.upload(action, { readFile }), describeUpload);
        return 0;
      }
      case 'file': {
        const [action, id] = rest;
        if (!['get', 'delete'].includes(action) || !/^file_[A-Za-z0-9]{22}$/.test(id || '')) throw new UsageError('Usage: watermark file get|delete <file_id>');
        output(await api.request(action === 'get' ? 'GET' : 'DELETE', `/v1/files/${id}`), describeFile);
        return 0;
      }
      case 'storage': {
        const [action, id] = rest;
        if (action === 'list' || !action) {
          output(await api.request('GET', '/v1/storage'), (value) => value.data.map(describeStorage).join('\n\n') || 'No storage connections.');
          return 0;
        }
        if (action === 'connect') {
          if (!options.bucket || !options.region || !options['role-arn'] || !options.prefix.length) throw new UsageError('Usage: watermark storage connect --bucket <name> --region <region> --role-arn <arn> --prefix in/ [--prefix ...] [--read true|false] [--write true|false]');
          const body = { provider: 's3', bucket: options.bucket, region: options.region, role_arn: options['role-arn'], prefixes: options.prefix, ...storageSwitches(options) };
          output(await api.request('POST', '/v1/storage', { body }), describeStorage);
          return 0;
        }
        if (action === 'update') {
          const usage = 'Usage: watermark storage update <stg_id> [--prefix in/ ...] [--read true|false] [--write true|false]';
          if (!/^stg_[0-9a-z]{1,12}$/.test(id || '')) throw new UsageError(usage);
          const body = storageSwitches(options);
          if (options.prefix.length) body.prefixes = options.prefix;
          if (!Object.keys(body).length) throw new UsageError(usage);
          output(await api.request('PATCH', `/v1/storage/${id}`, { body }), describeStorage);
          return 0;
        }
        if (!['get', 'verify', 'disconnect'].includes(action) || !/^stg_[0-9a-z]{1,12}$/.test(id || '')) throw new UsageError('Usage: watermark storage list | get|verify|disconnect <stg_id> | connect ... | update ...');
        const method = { get: 'GET', verify: 'POST', disconnect: 'DELETE' }[action];
        const storage = await api.request(method, `/v1/storage/${id}${action === 'verify' ? '/verify' : ''}`);
        output(storage, describeStorage);
        return action === 'verify' && storage.status !== 'verified' ? 1 : 0;
      }
      case 'events': {
        if (!options.since) throw new UsageError('Usage: watermark events --since 2026-10-13T15:00:00Z [--limit 100]');
        const events = await api.request('GET', '/v1/events', { query: { since: options.since, limit: options.limit } });
        output(events, (value) => [
          ...value.data.map((event) => `${new Date(event.created * 1000).toISOString()}\t${event.type}\trequest ${event.data?.id}`),
          value.has_more ? `More: watermark events --since ${new Date(value.data.at(-1).created * 1000).toISOString()}` : '',
        ].filter(Boolean).join('\n') || 'No events since then.');
        return 0;
      }
      case 'fonts': {
        const fonts = await api.request('GET', '/v1/fonts');
        output(fonts, (value) => value.data.map((font) => `${font.name}\t${[font.family, font.style].filter(Boolean).join(' ')}`).join('\n'));
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${command}". Run watermark --help.`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message);
      return 2;
    }
    if (error instanceof ApiError) {
      if (json) print(JSON.stringify({ error: { ...error.error, status: error.status, type: error.type, code: error.code, message: error.message } }, null, 2));
      else fail(describeError(error));
      return 1;
    }
    fail(error.message);
    return 1;
  }
}

async function runMedia(api, media, [action, source], options, { output, print, json, fetch }) {
  if (!ACTIONS[media].includes(action)) throw new UsageError(`Usage: watermark ${media.replace(/s$/, '')} ${ACTIONS[media].join('|')} <source>`);

  const body = {};

  if (action === 'create') {
    if (!options.width || !options.height) throw new UsageError('watermark image create needs --width and --height.');
    body.width = Number(options.width);
    body.height = Number(options.height);
    if (options.background) body.background = options.background;
  } else {
    body.source = await resolveSource(api, source);
  }

  if (options.level) {
    if (media !== 'images' || action !== 'read') throw new UsageError('--level is for watermark image read.');
    body.level = true;
  }

  if (action === 'process' || action === 'create') {
    const operations = options['ops-json'] ? JSON.parse(options['ops-json']) : options.op.map(parseOperation);
    if (operations.length === 0) throw new UsageError('Give at least one --op (see: watermark operations).');
    body.operations = operations;
  }
  if (options['outputs-json']) body.outputs = JSON.parse(options['outputs-json']);
  if (options.format) body.output = { format: options.format };
  else if (action === 'create' && options.out) body.output = { format: options.out.split('.').pop().toLowerCase() };
  if (options.seconds !== undefined) body.seconds = Number(options.seconds);
  if (action === 'screenshot' && body.seconds === undefined) throw new UsageError('A screenshot needs --seconds.');
  if (options.page !== undefined) body.page = Number(options.page);
  if (options['max-duration'] !== undefined) body.max_duration = Number(options['max-duration']);
  if (options['max-pages'] !== undefined) body.max_pages = Number(options['max-pages']);
  if (options.webhook) body.webhook_url = options.webhook;
  if (options.event.length) body.events = options.event;
  if (options.customer) body.customer = options.customer;
  if (options.metadata.length) {
    body.metadata = Object.fromEntries(options.metadata.map((pair) => {
      const [key, value] = pair.split(/=(.*)/s, 2);
      if (value === undefined) throw new UsageError(`--metadata needs key=value, got "${pair}".`);
      return [key, value];
    }));
  }

  let request = await api.request('POST', `/v1/${media}/${action}`, { body, idempotencyKey: options['idempotency-key'] });

  if (!options['no-wait']) {
    request = await api.wait(request.id, {
      timeoutMs: Number(options.timeout || 300) * 1000,
      onProgress: json ? undefined : (current) => process.stderr.write(`Request ${current.id}: ${current.status}${current.progress !== undefined ? ` ${current.progress}%` : ''}\r`),
    });
  }

  if (options.out && request.status === 'succeeded') {
    const url = request.result?.files?.[0]?.url;
    if (!url) throw new Error(`Request ${request.id} made no file to download.`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Downloading the result failed: HTTP ${response.status}.`);
    await writeFile(options.out, Buffer.from(await response.arrayBuffer()));
    request = { ...request, saved_to: options.out };
  }

  output(request, describeRequest);

  return request.status === 'failed' || request.status === 'aborted' ? 1 : 0;
}

// A source as the API takes it: a URL, an id, a storage object, or a local
// file, which is uploaded first.
async function resolveSource(api, source) {
  if (!source) throw new UsageError('Give a source: a URL, a local file, upl_…, file_… or stg_…:key.');
  if (/^https?:\/\//.test(source) || /^(upl|file)_[A-Za-z0-9]{22}$/.test(source)) return source;

  const object = source.match(/^(stg_[0-9a-z]{1,12}):(.+)$/s);
  if (object) return { storage: object[1], key: object[2] };

  const local = await stat(source).catch(() => null);
  if (!local?.isFile()) throw new UsageError(`"${source}" is not a URL, an id, stg_…:key, or a file here.`);

  const upload = await api.upload(source, { readFile });
  return upload.id;
}

// --read and --write as the API takes them, for connecting or changing storage.
function storageSwitches(options) {
  const switches = {};
  for (const field of ['read', 'write']) {
    if (options[field] === undefined) continue;
    if (!['true', 'false'].includes(options[field])) throw new UsageError(`--${field} takes true or false.`);
    switches[field] = options[field] === 'true';
  }
  return switches;
}

// An API error for people: the code to branch on, every invalid field, and
// the permissions policy a storage change whose check failed needs.
function describeError(error) {
  const lines = [`Error ${error.status} ${error.code}: ${error.message}${error.param ? ` (${error.param})` : ''}`];
  for (const [field, messages] of Object.entries(error.errors || {})) {
    lines.push(`  ${field}: ${[].concat(messages).join(' ')}`);
  }
  if (error.error.permissions_policy) {
    lines.push(`The role needs this permissions policy:\n${JSON.stringify(error.error.permissions_policy, null, 2)}`);
  }
  return lines.join('\n');
}

function describeUpload(upload) {
  return `Upload ${upload.id} (${upload.filename}): ${upload.status}${upload.expires_at ? `, until ${upload.expires_at}` : ''}`;
}

function describeFile(file) {
  const lines = [`File ${file.id} (${file.name}, ${file.format}, ${file.size} bytes)`];
  if (file.url) lines.push(`Download: ${file.url} (until ${file.url_expires_at})`);
  if (file.destination) lines.push(`Written to: ${file.destination.storage ? `${file.destination.storage}:${file.destination.key}` : 'your URL'}`);
  if (file.deleted_at && !file.url) lines.push(`Deleted ${file.deleted_at}`);
  return lines.join('\n');
}

function describeStorage(storage) {
  const lines = [`${storage.id}: s3://${storage.bucket} (${storage.region}), ${storage.status}`];
  if (storage.prefixes?.length) lines.push(`Prefixes: ${storage.prefixes.join(', ')}`);
  if (storage.status !== 'verified' && storage.trust_policy) lines.push(`Create the role with the trust_policy and permissions_policy shown with --json (external id ${storage.external_id}), then run: watermark storage verify ${storage.id}`);
  if (storage.last_error) lines.push(`Problem: ${storage.last_error}`);
  return lines.join('\n');
}

function describeRequest(request) {
  const lines = [`Request ${request.id} (${request.endpoint}): ${request.status}`];
  if (request.status === 'failed' && request.error) lines.push(`Error ${request.error.code}: ${request.error.message}`);
  if (request.result?.data) lines.push(`Result: ${JSON.stringify(request.result.data)}`);
  for (const file of request.result?.files || []) {
    if (file.destination) lines.push(`File: written to ${file.destination.storage ? `${file.destination.storage}:${file.destination.key}` : 'your URL'}`);
    else lines.push(file.url ? `File: ${file.url} (link valid until ${file.url_expires_at})` : 'File: made, but no download link is available right now; fetch the request again.');
  }
  if (request.saved_to) lines.push(`Saved to ${request.saved_to}`);
  if (request.price) lines.push(`Price: $${request.price.amount}`);
  return lines.join('\n');
}
