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

  // Poll a request until it is succeeded, failed or aborted.
  async wait(id, { timeoutMs = 300_000, intervalMs = 1000, onProgress } = {}) {
    const started = Date.now();
    for (;;) {
      const request = await this.request('GET', `/v1/requests/${id}`);
      if (['succeeded', 'failed', 'aborted'].includes(request.status)) return request;
      if (onProgress) onProgress(request);
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Request ${id} was still ${request.status} after ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      await this.sleep(intervalMs);
      intervalMs = Math.min(5000, intervalMs * 1.5);
    }
  }
}
