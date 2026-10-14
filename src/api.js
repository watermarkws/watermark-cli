// A small client for the Watermark API: the key, JSON, typed errors, and
// retries for 429 (after Retry-After), 5xx and dropped connections, with an
// Idempotency-Key on every POST so a retried POST never runs twice.

export const VERSION = '0.1.0';

export class ApiError extends Error {
  constructor(status, error = {}) {
    super(error.message || `The API answered ${status}.`);
    this.status = status;
    this.type = error.type || 'server_error';
    this.code = error.code || 'unknown';
    this.param = error.param;
    this.requestId = error.request_id;
    this.errors = error.errors;
  }
}

export class Api {
  constructor({ apiKey, baseUrl = 'https://api.watermark.ws', fetch = globalThis.fetch, sleep, maxRetries = 2 }) {
    if (!apiKey) {
      throw new Error('Set WATERMARK_API_KEY or pass --api-key. Get a key at https://watermark.ws/developers');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetch;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = maxRetries;
  }

  async request(method, path, { body, query, idempotencyKey } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `watermark-cli/${VERSION} node/${process.versions.node}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method === 'POST') headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();

    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (error) {
        if (attempt >= this.maxRetries) throw error;
        await this.sleep(500 * 2 ** attempt);
        continue;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 500 * 2 ** attempt);
        continue;
      }

      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (response.status >= 400) throw new ApiError(response.status, json.error);
      return json;
    }
  }

  // Wait for a request to be succeeded, failed or aborted. Each call asks the
  // API to hold the response until the request finishes (up to 25 seconds),
  // so the result comes back as soon as it is ready.
  async wait(id, { timeoutMs = 300_000, intervalMs = 1000, onProgress } = {}) {
    const started = Date.now();
    for (;;) {
      const hold = Math.max(0, Math.min(25, Math.floor((timeoutMs - (Date.now() - started)) / 1000)));
      const before = Date.now();
      const request = await this.request('GET', `/v1/requests/${id}`, { query: { wait: hold || undefined } });
      if (['succeeded', 'failed', 'aborted'].includes(request.status)) return request;
      if (onProgress) onProgress(request);
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Request ${id} was still ${request.status} after ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      if (hold > 0 && Date.now() - before >= (hold - 1) * 1000) continue;
      await this.sleep(intervalMs);
      intervalMs = Math.min(5000, intervalMs * 1.5);
    }
  }

  // Make an upload for a local file and PUT the file to its URL. Its id is
  // then a request's source.
  async upload(path, { readFile, contentType } = {}) {
    const bytes = await readFile(path);
    const filename = path.split(/[\\/]/).pop();
    const type = contentType || contentTypeOf(filename);
    const upload = await this.request('POST', '/v1/uploads', { body: { filename, size: bytes.length, content_type: type } });

    const response = await this.fetch(upload.upload.url, {
      method: 'PUT',
      headers: upload.upload.headers || { 'Content-Type': type },
      body: bytes,
    });
    if (!response.ok) throw new Error(`Sending ${filename} failed: HTTP ${response.status}.`);

    return upload;
  }
}

const CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  bmp: 'image/bmp', svg: 'image/svg+xml', psd: 'image/vnd.adobe.photoshop',
  cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw',
  dng: 'image/x-adobe-dng', raf: 'image/x-fuji-raf', orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', flv: 'video/x-flv', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function contentTypeOf(filename) {
  return CONTENT_TYPES[(filename.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
}
