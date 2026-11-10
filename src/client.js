/**
 * Minimal GitHub REST client: token auth, JSON, pagination, and errors that are
 * useful to a model instead of raw HTTP noise.
 */
import { resolveToken } from './token.js';

export const DEFAULT_BASE_URL = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 30_000;

/** A GitHub request that failed, with a message written for the model. */
export class GitHubError extends Error {
  /**
   * @param {string} message model-facing explanation
   * @param {{ status?: number, code?: string, detail?: string }} [meta]
   */
  constructor(message, { status = 0, code = 'GITHUB_ERROR', detail = '' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** One authenticated (or anonymous) GitHub API client. */
export class GitHubClient {
  /**
   * @param {{ token?: string | null, tokenSource?: string, baseUrl?: string, userAgent?: string, timeoutMs?: number }} [options]
   */
  constructor(options = {}) {
    this.token = options.token ?? null;
    this.tokenSource = options.tokenSource ?? 'none';
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? 'dsh-plugin-github';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** @returns {boolean} whether requests carry a credential. */
  get authenticated() {
    return typeof this.token === 'string' && this.token !== '';
  }

  /**
   * Build a client from plugin config, resolving the credential lazily.
   * @param {{ token?: string, baseUrl?: string, timeoutMs?: number }} config
   * @returns {GitHubClient}
   */
  static from(config = {}) {
    const { token, source } = resolveToken(config);
    return new GitHubClient({
      token,
      tokenSource: source,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    });
  }

  /**
   * Absolute URL for a request.
   * @param {string} path API path such as `/user/repos`.
   * @param {Record<string, string | number | boolean | undefined>} [query]
   * @returns {string}
   */
  url(path, query) {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Perform one request and return the decoded body.
   * @param {string} path API path.
   * @param {{ method?: string, query?: Record<string, string | number | boolean | undefined>, body?: unknown, accept?: string, signal?: AbortSignal, headers?: Record<string, string>, redirect?: 'follow' | 'manual' | 'error' }} [options]
   * @returns {Promise<{ data: unknown, headers: Headers, status: number, url: string }>}
   */
  async request(path, options = {}) {
    const { method = 'GET', query, body, accept = 'application/vnd.github+json', signal, headers = {}, redirect = 'follow' } = options;
    const url = this.url(path, query);
    const requestHeaders = this.buildHeaders(accept, headers);
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect,
      signal: withTimeout(signal, this.timeoutMs),
    });

    const text = await response.text();
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) throw toError(response, data, { path, url, authenticated: this.authenticated, tokenSource: this.tokenSource });
    return { data, headers: response.headers, status: response.status, url };
  }

  /**
   * One request whose body must be JSON.
   * @param {string} path
   * @param {Parameters<GitHubClient['request']>[1]} [options]
   * @returns {Promise<{ data: unknown, headers: Headers }>}
   */
  async json(path, options = {}) {
    const { data, headers } = await this.request(path, options);
    return { data, headers };
  }

  /**
   * Read one page of a list endpoint, asking only for what the caller needs.
   * GitHub caps `per_page` at 100, and every tool here is bounded by that.
   * @param {string} path
   * @param {{ query?: Record<string, string | number | boolean | undefined>, limit?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<unknown[]>}
   */
  async list(path, options = {}) {
    const { query = {}, limit = 30, signal } = options;
    const perPage = Math.max(1, Math.min(100, limit));
    const { data } = await this.request(path, { query: { ...query, per_page: perPage }, signal });
    if (!Array.isArray(data)) {
      throw new GitHubError(`Expected a list from ${path} but GitHub returned ${describeType(data)}.`, {
        code: 'UNEXPECTED_RESPONSE',
      });
    }
    return data.slice(0, limit);
  }

  /**
   * Download a binary body such as a repository archive.
   *
   * GitHub answers archive requests with a redirect to codeload, which does not
   * accept the Authorization header; the token rides along as a query parameter
   * for that host only.
   * @param {string} path API path that redirects to an archive.
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<Buffer>}
   */
  async download(path, options = {}) {
    const { signal, timeoutMs = this.timeoutMs } = options;
    const url = this.url(path);
    const first = await fetch(url, {
      headers: this.buildHeaders('application/vnd.github+json'),
      redirect: 'manual',
      signal: withTimeout(signal, timeoutMs),
    });

    const location = first.headers.get('location');
    if (first.status >= 300 && first.status < 400 && location !== null) {
      const target = new URL(location, url);
      if (this.authenticated && target.hostname === 'codeload.github.com' && !target.searchParams.has('token')) {
        target.searchParams.set('token', this.token);
      }
      const second = await fetch(target, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': this.userAgent },
        signal: withTimeout(signal, timeoutMs),
      });
      if (!second.ok) throw toError(second, await safeText(second), { path, url: target.toString(), authenticated: this.authenticated, tokenSource: this.tokenSource });
      return Buffer.from(await second.arrayBuffer());
    }

    if (!first.ok) throw toError(first, await safeText(first), { path, url, authenticated: this.authenticated, tokenSource: this.tokenSource });
    return Buffer.from(await first.arrayBuffer());
  }

  /**
   * @param {string} accept
   * @param {Record<string, string>} [extra]
   * @returns {Record<string, string>}
   */
  buildHeaders(accept, extra = {}) {
    const headers = {
      accept,
      'x-github-api-version': API_VERSION,
      'user-agent': this.userAgent,
      ...extra,
    };
    if (this.authenticated) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  /**
   * Read rate-limit headers from a previous response.
   * @param {Headers} headers
   * @returns {{ limit: number, remaining: number, resetAt: string }}
   */
  static rateLimit(headers) {
    const limit = Number(headers.get('x-ratelimit-limit') ?? '0');
    const remaining = Number(headers.get('x-ratelimit-remaining') ?? '0');
    const reset = Number(headers.get('x-ratelimit-reset') ?? '0');
    return {
      limit: Number.isFinite(limit) ? limit : 0,
      remaining: Number.isFinite(remaining) ? remaining : 0,
      resetAt: reset > 0 ? new Date(reset * 1000).toISOString() : '',
    };
  }
}

/**
 * Combine a caller signal with the client timeout.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Translate a failed response into a model-actionable error.
 * @param {Response} response
 * @param {unknown} data decoded body
 * @param {{ path: string, url: string, authenticated: boolean, tokenSource?: string }} context
 * @returns {GitHubError}
 */
function toError(response, data, context) {
  const status = response.status;
  const message = typeof data === 'object' && data !== null && typeof data.message === 'string' ? data.message : '';
  const detail = message === '' ? '' : message;

  if (status === 401) {
    const origin = typeof context.tokenSource === 'string' && context.tokenSource !== 'none' && context.tokenSource !== ''
      ? ` from ${context.tokenSource}`
      : '';
    return new GitHubError(
      `GitHub rejected the credentials${origin} (401 Unauthorized). The token is missing, expired, revoked, or still the `
        + 'placeholder text: replace it with a real token (it starts with ghp_, github_pat_), or write it to ~/.dsh/github-token.',
      { status, code: 'UNAUTHORIZED', detail },
    );
  }

  if (status === 403) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? '0');
    if (remaining === '0' || /rate limit/i.test(message)) {
      const resetAt = reset > 0 ? new Date(reset * 1000).toISOString() : 'shortly';
      const scope = context.authenticated ? 'this token' : 'anonymous access';
      return new GitHubError(
        `GitHub rate limit exhausted for ${scope}; it resets at ${resetAt}. `
          + (context.authenticated ? 'Wait for the reset or use a token with a higher limit.' : 'Set a token to raise the limit from 60 to 5000 requests per hour.'),
        { status, code: 'RATE_LIMITED', detail },
      );
    }
    return new GitHubError(
      `GitHub refused the request (403 Forbidden) for ${context.path}. The token probably lacks a required scope `
        + '(classic tokens need `repo`; fine-grained tokens need repository access and the matching permission).',
      { status, code: 'FORBIDDEN', detail },
    );
  }

  if (status === 404) {
    return new GitHubError(
      `GitHub returned 404 Not Found for ${context.path}. Check the owner/repository spelling; `
        + 'a private repository is also reported as 404 when the current credential cannot see it.',
      { status, code: 'NOT_FOUND', detail },
    );
  }

  if (status === 422) {
    const problems = Array.isArray(data) || typeof data !== 'object' || data === null
      ? ''
      : Array.isArray(/** @type {{ errors?: unknown[] }} */ (data).errors)
        ? /** @type {{ errors: { message?: string, field?: string }[] }} */ (data).errors
          .map((entry) => entry.field ? `${entry.field}: ${entry.message ?? ''}` : (entry.message ?? ''))
          .filter((line) => line !== '')
          .join('; ')
        : '';
    const suffix = problems === '' ? '' : ` Details: ${problems}.`;
    return new GitHubError(
      `GitHub rejected the request as invalid (422 Unprocessable Entity)${detail === '' ? '' : `: ${detail}`}.${suffix}`,
      { status, code: 'VALIDATION', detail },
    );
  }

  return new GitHubError(
    `GitHub request failed: ${status} ${message === '' ? response.statusText : message} (${context.path}).`,
    { status, code: 'HTTP_ERROR', detail },
  );
}

/**
 * Read a response body as text without throwing.
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function safeText(response) {
  try {
    const text = await response.text();
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return `an object (${typeof value})`;
}
