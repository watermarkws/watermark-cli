import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Api, ApiError, BATCH_FINISHED, REQUEST_FINISHED, VERSION } from './api.js';

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
  watermark preview <source> [--media image|video|document] [--at 5] [--page 0] [--width 1024] [--design <dsn_id>] [--op ...] [--out preview.webp]
  watermark batch create <source> [<source> ...] [--media image|video|document] [--design <dsn_id>] [--op ...] [--format webp] [--zip|--no-zip] [--destination stg_7a:done/] [--max-duration 30] [--max-pages 10] [--out dir]
  watermark batch get <id> [--wait] | watermark batch retry <id> | watermark batch abort <id>
  watermark batch requests <id> [--status failed] [--after <position>] [--limit 50]
  watermark batches [--limit 20] [--before <id>] [--status failed]
  watermark design create --name <name> [--media image|video|document|any] --op <operation> [--op ...]
  watermark design update <dsn_id> [--name <name>] [--media <media>] [--op ...]
  watermark design get|delete <dsn_id>
  watermark designs [--limit 20] [--before <dsn_id>]
  watermark request get <id> [--wait] | watermark request abort <id>
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
connected bucket (stg_7a:path/to/key). A batch also takes a local folder
(every file in it, uploaded four at a time) and stg_7a:folder/ (every object
under that prefix; note the trailing slash).

Operations (repeat --op; they run in order):
  --op resize:width=800,height=600
  --op grayscale
  --op watermark:image_url=https://example.com/logo.png,x=40,y=40
  --op watermark:image_url=https://example.com/logo.png,anchor=bottom_right,margin=3%,size=18%,opacity=60
  --ops-json '[{"type":"resize","width":800,"height":600}]'
  See: watermark operations image

  More than one file from a request, each with its own operations and format:
  --outputs-json '[{"name":"large","format":"webp"},{"name":"thumb","operations":[{"type":"resize","width":200,"height":200}]}]'

Options:
  --design <dsn_id>       A saved design whose operations run first; --op is then optional.
  --out <file|dir>        Wait, then download the result to this file (for a batch: its zips into this directory).
  --no-wait               Return as soon as the request or batch is queued.
  --wait                  With request get or batch get: wait until it finishes.
  --timeout <seconds>     How long to wait (default 300; 3600 for a batch).
  --webhook <url>         Post the finished request or batch here.
  --event <type>          The webhook events to send (repeatable), such as request.progress or batch.progress.
  --request-event <type>  For a batch: the request.* events to post for each of its files (repeatable).
  --customer <id>         Your own reference for who the request is for.
  --metadata key=value    Repeatable.
  --idempotency-key <k>   Make a retry of this command safe.
  --json                  Print JSON only (for scripts and AI agents).
  --api-key <key>         Or set WATERMARK_API_KEY.
  --base-url <url>        Or set WATERMARK_API_URL (default https://api.watermark.ws).
  --version               Print the version.
`;

const MEDIA = { image: 'images', images: 'images', video: 'videos', videos: 'videos', document: 'documents', documents: 'documents', pdf: 'documents' };
const MEDIA_NAMES = { image: 'image', images: 'image', video: 'video', videos: 'video', document: 'document', documents: 'document', pdf: 'document' };
const ACTIONS = {
  images: ['process', 'read', 'create'],
  videos: ['process', 'read', 'screenshot'],
  documents: ['process', 'read', 'snapshot'],
};
const REPEATABLE = new Set(['op', 'metadata', 'prefix', 'event', 'request-event']);
const FLAGS = new Set(['json', 'no-wait', 'wait', 'zip', 'no-zip', 'help', 'version', 'level']);
const UPLOADS_AT_ONCE = 4;
const DESIGN_ID = /^dsn_[A-Za-z0-9]{22}$/;
const BATCH_ID = /^\d+$/;
const STORAGE_OBJECT = /^(stg_[0-9a-z]{1,12}):(.+)$/s;

// Parse argv into positionals and options; repeatable options collect arrays.
export function parseArgs(argv) {
  const positionals = [];
  const options = { op: [], metadata: [], prefix: [], event: [], 'request-event': [] };

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

// Numbers and booleans are typed; everything else, a percentage such as
// "3%" included, stays text.
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
  // Progress lines go to stderr, and only when a person is reading.
  const progress = json ? () => {} : (text) => stderr.write(text);

  try {
    const api = new Api({
      apiKey: options['api-key'] || env.WATERMARK_API_KEY,
      baseUrl: options['base-url'] || env.WATERMARK_API_URL || 'https://api.watermark.ws',
      fetch,
      sleep,
    });

    const [command, ...rest] = positionals;
    const context = { output, print, progress, json, fetch: fetch || globalThis.fetch };

    if (MEDIA[command]) {
      return await runMedia(api, MEDIA[command], rest, options, context);
    }

    switch (command) {
      case 'preview':
        return await runPreview(api, rest[0], options, context);
      case 'batch': {
        const [action, ...arguments_] = rest;
        if (action === 'create') return await runBatchCreate(api, arguments_, options, context);
        return await runBatch(api, action, arguments_[0], options, context);
      }
      case 'batches': {
        const list = await api.request('GET', '/v1/batches', { query: { limit: options.limit, before: options.before, status: options.status } });
        output(list, (value) => value.data.map((batch) => `${batch.id}\t${batch.media}\t${batch.status}\t${batch.counts.succeeded}/${batch.counts.total} succeeded\t${batch.created_at}`).join('\n') || 'No batches yet.');
        return 0;
      }
      case 'design':
        return await runDesign(api, rest[0], rest[1], options, context);
      case 'designs': {
        const list = await api.request('GET', '/v1/designs', { query: { limit: options.limit, before: options.before } });
        output(list, (value) => value.data.map(describeDesign).join('\n\n') || 'No designs yet.');
        return 0;
      }
      case 'request': {
        const [action, id] = rest;
        if (!['get', 'abort'].includes(action) || !/^\d+$/.test(id || '')) throw new UsageError('Usage: watermark request get <id> [--wait] | watermark request abort <id>');
        let request;
        if (action === 'abort') request = await api.request('POST', `/v1/requests/${id}/abort`);
        else if (options.wait) request = await api.wait(id, { timeoutMs: Number(options.timeout || 300) * 1000, onProgress: json ? undefined : (current) => progress(`Request ${current.id}: ${current.status}${current.progress !== undefined ? ` ${current.progress}%` : ''}\r`) });
        else request = await api.request('GET', `/v1/requests/${id}`);
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
          value.limits ? `Limits: ${value.limits.requests_per_minute} requests a minute, sources up to ${Math.round(value.limits.max_source_bytes / 1048576)} MB${value.limits.batch_max_files ? `, batches of up to ${value.limits.batch_max_files} files` : ''}` : '',
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
        const media = rest[0] ? MEDIA_NAMES[rest[0]] : null;
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
          ...value.data.map((event) => `${new Date(event.created * 1000).toISOString()}\t${event.type}\t${event.data?.object === 'batch' ? 'batch' : 'request'} ${event.data?.id}`),
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

async function runMedia(api, media, [action, source], options, { output, progress, json, fetch }) {
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
    Object.assign(body, designAndOperations(options));
  } else if (options.design) {
    throw new UsageError('--design is for process, create, preview and batch create.');
  }
  if (options['outputs-json']) body.outputs = JSON.parse(options['outputs-json']);
  if (options.format) body.output = { format: options.format };
  else if (action === 'create' && options.out) body.output = { format: options.out.split('.').pop().toLowerCase() };
  if (options.seconds !== undefined) body.seconds = Number(options.seconds);
  if (action === 'screenshot' && body.seconds === undefined) throw new UsageError('A screenshot needs --seconds.');
  if (options.page !== undefined) body.page = Number(options.page);
  if (options['max-duration'] !== undefined) body.max_duration = Number(options['max-duration']);
  if (options['max-pages'] !== undefined) body.max_pages = Number(options['max-pages']);
  Object.assign(body, requestOptions(options));

  let request = await api.request('POST', `/v1/${media}/${action}`, { body, idempotencyKey: options['idempotency-key'] });

  return finishRequest(api, request, options, { output, progress, json, fetch });
}

// POST /v1/previews: a small picture of what the operations do to a file.
// The API holds the answer for up to 20 seconds and usually returns the
// finished preview within the call; the CLI waits on for one that takes longer.
async function runPreview(api, source, options, context) {
  const body = { source: await resolveSource(api, source) };
  if (options.media) body.media = mediaName(options.media);
  Object.assign(body, designAndOperations(options));
  if (options.width !== undefined) body.width = Number(options.width);
  if (options.at !== undefined) body.at = Number(options.at);
  if (options.page !== undefined) body.page = Number(options.page);
  Object.assign(body, requestOptions(options));

  const request = await api.request('POST', '/v1/previews', { body, idempotencyKey: options['idempotency-key'] });

  return finishRequest(api, request, options, context);
}

// Wait for a request unless told not to, download its first file with --out,
// and print it.
async function finishRequest(api, request, options, { output, progress, json, fetch }) {
  if (!options['no-wait'] && !REQUEST_FINISHED.includes(request.status)) {
    request = await api.wait(request.id, {
      timeoutMs: Number(options.timeout || 300) * 1000,
      onProgress: json ? undefined : (current) => progress(`Request ${current.id}: ${current.status}${current.progress !== undefined ? ` ${current.progress}%` : ''}\r`),
    });
  }

  if (options.out && request.status === 'succeeded') {
    const url = request.result?.files?.[0]?.url;
    if (!url) throw new Error(`Request ${request.id} made no file to download.`);
    await download(fetch, url, options.out);
    request = { ...request, saved_to: options.out };
  }

  output(request, describeRequest);

  return request.status === 'failed' || request.status === 'aborted' ? 1 : 0;
}

// POST /v1/batches: the same operations on many files. Local files and
// folders are uploaded first; then the CLI waits for the batch and, with
// --out, downloads its zips.
async function runBatchCreate(api, sources, options, { output, progress, json, fetch }) {
  if (!sources.length) throw new UsageError('Usage: watermark batch create <source> [<source> ...] [--design <dsn_id>] [--op ...] [--format webp] [--zip|--no-zip] [--destination stg_7a:done/] [--out dir]');
  if (options.zip && options['no-zip']) throw new UsageError('Give --zip or --no-zip, not both.');

  const body = {};
  if (options.media) body.media = mediaName(options.media);
  body.sources = await resolveBatchSources(api, sources, progress);
  Object.assign(body, designAndOperations(options));
  if (options['outputs-json']) body.outputs = JSON.parse(options['outputs-json']);
  if (options.format) body.output = { format: options.format };
  if (options.destination) {
    const prefix = options.destination.match(STORAGE_OBJECT);
    if (!prefix) throw new UsageError('--destination takes stg_…:folder/ in a connected bucket.');
    body.destination = { storage: prefix[1], prefix: prefix[2] };
  }
  // --out needs zips to download, so it asks for them unless told otherwise.
  if (options.zip || (options.out && !options['no-zip'] && !options.destination)) body.zip = true;
  if (options['max-duration'] !== undefined) body.max_duration = Number(options['max-duration']);
  if (options['max-pages'] !== undefined) body.max_pages = Number(options['max-pages']);
  Object.assign(body, requestOptions(options));
  if (options['request-event'].length) body.request_events = options['request-event'];

  let batch = await api.request('POST', '/v1/batches', { body, idempotencyKey: options['idempotency-key'] });

  if (!options['no-wait']) {
    batch = await waitBatch(api, batch.id, options, progress, json);
  }

  if (options.out && BATCH_FINISHED.includes(batch.status)) {
    if (batch.zips?.length) {
      const saved = await downloadAll(fetch, batch.zips, options.out, progress);
      batch = { ...batch, saved_to: saved };
    } else {
      progress(`Batch ${batch.id} made no zip to download${batch.input?.destination ? ': its files went to your storage' : ''}.\n`);
    }
  }

  output(batch, describeBatch);

  return batchExitCode(batch);
}

async function runBatch(api, action, id, options, { output, progress, json, fetch }) {
  if (!['get', 'requests', 'retry', 'abort'].includes(action) || !BATCH_ID.test(id || '')) {
    throw new UsageError('Usage: watermark batch create <source> ... | get <id> [--wait] | requests <id> [--status failed] | retry <id> | abort <id>');
  }

  if (action === 'requests') {
    const list = await api.request('GET', `/v1/batches/${id}/requests`, { query: { status: options.status, after: options.after, limit: options.limit } });
    output(list, (value) => [
      ...value.data.map((request) => `${request.position}\t${request.id}\t${request.status}${request.error ? `\t${request.error.code}: ${request.error.message}` : ''}`),
      value.has_more ? `More: watermark batch requests ${id} --after ${value.data.at(-1).position}${options.status ? ` --status ${options.status}` : ''}` : '',
    ].filter(Boolean).join('\n') || 'No files match.');
    return 0;
  }

  let batch;
  if (action === 'get' && options.wait) batch = await waitBatch(api, id, options, progress, json);
  else if (action === 'get') batch = await api.request('GET', `/v1/batches/${id}`);
  else batch = await api.request('POST', `/v1/batches/${id}/${action}`);

  // The zips of a finished batch can be fetched later, or again after a download broke.
  if (action === 'get' && options.out && BATCH_FINISHED.includes(batch.status) && batch.zips?.length) {
    const saved = await downloadAll(fetch, batch.zips, options.out, progress);
    batch = { ...batch, saved_to: saved };
  }

  output(batch, describeBatch);

  return batchExitCode(batch);
}

// Long-poll GET /v1/batches/{id} until the batch finishes, showing the counts
// as they move.
function waitBatch(api, id, options, progress, json) {
  return api.waitBatch(id, {
    timeoutMs: Number(options.timeout || 3600) * 1000,
    onProgress: json ? undefined : (current) => progress(`Batch ${current.id}: ${current.status} ${current.progress}% (${describeCounts(current.counts)})\r`),
  });
}

// A queued batch, and one that finished with every file succeeded, exit 0;
// one that failed, was aborted or finished partial (some files failed) exits 1.
function batchExitCode(batch) {
  return BATCH_FINISHED.includes(batch.status) && batch.status !== 'succeeded' ? 1 : 0;
}

async function runDesign(api, action, id, options, { output }) {
  if (action === 'create') {
    if (!options.name || !(options.op.length || options['ops-json'])) throw new UsageError('Usage: watermark design create --name <name> [--media image|video|document|any] --op <operation> [--op ...]');
    const body = { name: options.name };
    if (options.media) body.media = mediaName(options.media, { any: true });
    body.operations = parseOperations(options);
    output(await api.request('POST', '/v1/designs', { body, idempotencyKey: options['idempotency-key'] }), describeDesign);
    return 0;
  }

  if (!['get', 'update', 'delete'].includes(action) || !DESIGN_ID.test(id || '')) {
    throw new UsageError('Usage: watermark design create --name <name> --op ... | update <dsn_id> [--name <name>] [--media <media>] [--op ...] | get|delete <dsn_id>');
  }

  if (action === 'update') {
    const body = {};
    if (options.name) body.name = options.name;
    if (options.media) body.media = mediaName(options.media, { any: true });
    if (options.op.length || options['ops-json']) body.operations = parseOperations(options);
    if (!Object.keys(body).length) throw new UsageError('watermark design update needs something to change: --name, --media or --op.');
    output(await api.request('PATCH', `/v1/designs/${id}`, { body }), describeDesign);
    return 0;
  }

  output(await api.request(action === 'get' ? 'GET' : 'DELETE', `/v1/designs/${id}`), describeDesign);
  return 0;
}

// The design and operations fields of a processing call: a design, operations,
// or both; the design's operations run first.
function designAndOperations(options) {
  const body = {};
  if (options.design) {
    if (!DESIGN_ID.test(options.design)) throw new UsageError('--design takes a design id (dsn_…); see watermark designs.');
    body.design = options.design;
  }
  const operations = parseOperations(options);
  if (operations.length) body.operations = operations;
  else if (!body.design) throw new UsageError('Give at least one --op (see: watermark operations), or a --design.');
  return body;
}

function parseOperations(options) {
  return options['ops-json'] ? JSON.parse(options['ops-json']) : options.op.map(parseOperation);
}

// The webhook, customer and metadata fields every processing call takes.
function requestOptions(options) {
  const body = {};
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
  return body;
}

function mediaName(text, { any = false } = {}) {
  const media = MEDIA_NAMES[text] || (any && text === 'any' ? 'any' : null);
  if (!media) throw new UsageError(`--media takes image, video or document${any ? ' (or any)' : ''}, not "${text}".`);
  return media;
}

// A source as the API takes it: a URL, an id, a storage object, or a local
// file, which is uploaded first.
async function resolveSource(api, source) {
  if (!source) throw new UsageError('Give a source: a URL, a local file, upl_…, file_… or stg_…:key.');
  if (/^https?:\/\//.test(source) || /^(upl|file)_[A-Za-z0-9]{22}$/.test(source)) return source;

  const object = source.match(STORAGE_OBJECT);
  if (object) return { storage: object[1], key: object[2] };

  const local = await stat(source).catch(() => null);
  if (!local?.isFile()) throw new UsageError(`"${source}" is not a URL, an id, stg_…:key, or a file here.`);

  const upload = await api.upload(source, { readFile });
  return upload.id;
}

// A batch's sources as the API takes them. Besides what a single request
// takes, a folder stands for every file in it (sorted) and stg_…:folder/ for
// every object under a prefix. Local files are uploaded a few at a time, in
// the order given.
async function resolveBatchSources(api, sources, progress) {
  const resolved = [];

  for (const source of sources) {
    if (/^https?:\/\//.test(source) || /^(upl|file)_[A-Za-z0-9]{22}$/.test(source)) {
      resolved.push(source);
      continue;
    }
    const object = source.match(STORAGE_OBJECT);
    if (object) {
      resolved.push(object[2].endsWith('/') ? { storage: object[1], prefix: object[2] } : { storage: object[1], key: object[2] });
      continue;
    }
    const local = await stat(source).catch(() => null);
    if (local?.isFile()) {
      resolved.push({ path: source });
    } else if (local?.isDirectory()) {
      const entries = await readdir(source, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
      if (!files.length) throw new UsageError(`"${source}" has no files in it.`);
      resolved.push(...files.map((name) => ({ path: join(source, name) })));
    } else {
      throw new UsageError(`"${source}" is not a URL, an id, stg_…:key, stg_…:folder/, or a file or folder here.`);
    }
  }

  const uploads = resolved.filter((source) => source.path);
  let done = 0;
  await inParallel(uploads, UPLOADS_AT_ONCE, async (source) => {
    source.id = (await api.upload(source.path, { readFile })).id;
    progress(`Uploaded ${++done} of ${uploads.length} files\r`);
  });

  return resolved.map((source) => (source.path ? source.id : source));
}

// Run work on every item, at most `limit` at a time, in order.
async function inParallel(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Save a signed download link, which needs no key, to a file, streamed so a
// zip of several gigabytes never sits in memory.
async function download(fetch, url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${basename(path)} failed: HTTP ${response.status}.`);
  await mkdir(dirname(path) || '.', { recursive: true });

  // Written beside the final name and moved into place at the end, so a cut connection
  // never leaves a truncated file that looks complete.
  const part = `${path}.part`;
  try {
    await pipeline(response.body ? Readable.fromWeb(response.body) : Readable.from([]), createWriteStream(part));
    await rename(part, path);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

// Save every file (a batch's zips) into a directory, named as the API names
// them, and say how far along it is.
async function downloadAll(fetch, files, directory, progress) {
  const saved = [];
  for (const [index, file] of files.entries()) {
    const path = join(directory, `${file.name}.${file.format}`);
    progress(`Downloading ${basename(path)} (${index + 1} of ${files.length}${file.size ? `, ${Math.round(file.size / 1048576)} MB` : ''})\n`);
    await download(fetch, file.url, path);
    saved.push(path);
  }
  return saved;
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

function describeBatch(batch) {
  const finished = BATCH_FINISHED.includes(batch.status);
  const lines = [`Batch ${batch.id} (${batch.media}): ${batch.status}${!finished && batch.progress !== undefined ? ` ${batch.progress}%` : ''}`];
  if (batch.counts) lines.push(`Files: ${describeCounts(batch.counts)}`);
  if (batch.error) lines.push(`Error ${batch.error.code}: ${batch.error.message}`);
  if (batch.input?.destination) lines.push(`Written to: ${batch.input.destination.storage}:${batch.input.destination.prefix}`);
  for (const zip of batch.zips || []) {
    lines.push(`Zip ${zip.name}.${zip.format} (${zip.files} files, ${zip.size} bytes): ${zip.url} (link valid until ${zip.url_expires_at})`);
  }
  if (batch.saved_to) lines.push(`Saved to ${[].concat(batch.saved_to).join(', ')}`);
  if (finished && batch.counts?.failed) lines.push(`Failed files: watermark batch requests ${batch.id} --status failed${batch.status !== 'aborted' ? `, then watermark batch retry ${batch.id}` : ''}`);
  else if (!finished) lines.push(`Follow it: watermark batch get ${batch.id} --wait`);
  if (batch.price) {
    const estimate = !finished && batch.price.estimate_micro_usd !== undefined ? ` (estimate $${(batch.price.estimate_micro_usd / 1_000_000).toFixed(6)})` : '';
    lines.push(`Price: $${batch.price.amount}${estimate}`);
  }
  return lines.join('\n');
}

function describeCounts(counts = {}) {
  return `${counts.total} in all, ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.aborted} aborted, ${counts.running} running, ${counts.waiting} waiting`;
}

function describeDesign(design) {
  const lines = [`Design ${design.id}: ${design.name} (${design.media})`];
  lines.push(`Operations: ${JSON.stringify(design.operations)}`);
  for (const asset of design.assets || []) lines.push(`Asset: ${asset.id} (${asset.format}, ${asset.size} bytes)`);
  if (design.deleted_at) lines.push(`Deleted ${design.deleted_at}`);
  return lines.join('\n');
}
