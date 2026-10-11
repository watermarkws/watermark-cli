import { writeFile } from 'node:fs/promises';
import { Api, ApiError, VERSION } from './api.js';

const HELP = `watermark: the Watermark API from the command line (https://api.watermark.ws/docs)

Usage:
  watermark image process <url> --op <operation> [--op ...] [--format webp] [--out file]
  watermark image read <url>
  watermark video process <url> --op <operation> [--max-duration 30] [--out file]
  watermark video read <url>
  watermark video screenshot <url> --seconds 5 [--format png] [--out file]
  watermark document process <url> --op <operation> [--max-pages 10] [--out file]
  watermark document read <url>
  watermark document snapshot <url> [--page 1] [--format png] [--out file]
  watermark request get <id> | watermark request abort <id>
  watermark requests [--limit 20]
  watermark account
  watermark usage [--from 2026-10-01] [--to 2026-10-31] [--group-by day|endpoint|customer|status]
  watermark operations [image|video|document]

Operations (repeat --op; they run in order):
  --op resize:width=800,height=600
  --op grayscale
  --op watermark:image_url=https://example.com/logo.png,x=40,y=40
  --ops-json '[{"type":"resize","width":800,"height":600}]'
  See: watermark operations image

Options:
  --out <file>            Wait, then download the result to this file.
  --no-wait               Return as soon as the request is queued.
  --timeout <seconds>     How long to wait (default 300).
  --webhook <url>         Post the finished request here.
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
  images: ['process', 'read'],
  videos: ['process', 'read', 'screenshot'],
  documents: ['process', 'read', 'snapshot'],
};
const REPEATABLE = new Set(['op', 'metadata']);
const FLAGS = new Set(['json', 'no-wait', 'help', 'version']);

// Parse argv into positionals and options; repeatable options collect arrays.
export function parseArgs(argv) {
  const positionals = [];
  const options = { op: [], metadata: [] };

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
      default:
        throw new UsageError(`Unknown command "${command}". Run watermark --help.`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message);
      return 2;
    }
    if (error instanceof ApiError) {
      if (json) print(JSON.stringify({ error: { status: error.status, type: error.type, code: error.code, message: error.message, param: error.param, request_id: error.requestId } }, null, 2));
      else fail(`Error ${error.status} ${error.code}: ${error.message}${error.param ? ` (${error.param})` : ''}`);
      return 1;
    }
    fail(error.message);
    return 1;
  }
}

async function runMedia(api, media, [action, source], options, { output, print, json, fetch }) {
  if (!ACTIONS[media].includes(action)) throw new UsageError(`Usage: watermark ${media.replace(/s$/, '')} ${ACTIONS[media].join('|')} <url>`);
  if (!source || !/^https?:\/\//.test(source)) throw new UsageError('The source must be a public http(s) URL.');

  const body = { source };

  if (action === 'process') {
    const operations = options['ops-json'] ? JSON.parse(options['ops-json']) : options.op.map(parseOperation);
    if (operations.length === 0) throw new UsageError('Give at least one --op (see: watermark operations).');
    body.operations = operations;
  }
  if (options.format) body.output = { format: options.format };
  if (options.seconds !== undefined) body.seconds = Number(options.seconds);
  if (action === 'screenshot' && body.seconds === undefined) throw new UsageError('A screenshot needs --seconds.');
  if (options.page !== undefined) body.page = Number(options.page);
  if (options['max-duration'] !== undefined) body.max_duration = Number(options['max-duration']);
  if (options['max-pages'] !== undefined) body.max_pages = Number(options['max-pages']);
  if (options.webhook) body.webhook_url = options.webhook;
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

function describeRequest(request) {
  const lines = [`Request ${request.id} (${request.endpoint}): ${request.status}`];
  if (request.status === 'failed' && request.error) lines.push(`Error ${request.error.code}: ${request.error.message}`);
  if (request.result?.data) lines.push(`Result: ${JSON.stringify(request.result.data)}`);
  for (const file of request.result?.files || []) {
    lines.push(file.url ? `File: ${file.url} (link valid until ${file.url_expires_at})` : 'File: made, but no download link is available right now; fetch the request again.');
  }
  if (request.saved_to) lines.push(`Saved to ${request.saved_to}`);
  if (request.price) lines.push(`Price: $${request.price.amount}`);
  return lines.join('\n');
}
