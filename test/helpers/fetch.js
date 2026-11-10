/**
 * Replace `globalThis.fetch` with a scripted stub for one test file.
 *
 * The handler receives `{ url, method, headers, body }` and returns either a
 * `Response` or `{ status, body, headers }`.
 */

/**
 * @param {(call: { url: string, method: string, headers: Record<string, string>, body: string | undefined }, index: number) => unknown} handler
 * @returns {{ calls: { url: string, method: string, headers: Record<string, string>, body: string | undefined }[], restore(): void }}
 */
export function installFetch(handler) {
  /** @type {{ url: string, method: string, headers: Record<string, string>, body: string | undefined }[]} */
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = /** @type {typeof fetch} */ (async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    /** @type {{ url: string, method: string, headers: Record<string, string>, body: string | undefined }} */
    const call = {
      url,
      method: init.method ?? 'GET',
      headers: /** @type {Record<string, string>} */ (init.headers ?? {}),
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const result = await handler(call, calls.length - 1);
    if (result instanceof Response) return result;
    return respond(/** @type {{ status?: number, body?: unknown, headers?: Record<string, string> }} */ (result));
  });

  return { calls, restore: () => { globalThis.fetch = original; } };
}

/**
 * @param {{ status?: number, body?: unknown, headers?: Record<string, string> }} [options]
 * @returns {Response}
 */
export function respond({ status = 200, body = {}, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * @param {string} name
 * @param {number} status
 * @param {unknown} [body]
 * @returns {Response}
 */
export function errorResponse(name, status, body = { message: name }) {
  return respond({ status, body });
}
