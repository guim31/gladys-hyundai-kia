// -----------------------------------------------------------------------------
// A small HTTP layer over the global fetch: timeouts, JSON and form bodies,
// network errors as BluelinkError, and an optional cookie jar.
//
// The login walks through HTML pages that set cookies and redirect: fetch has
// no cookie store, so a request given a `jar` follows its redirects by hand and
// carries the cookies of each host, like a browser session would.
// -----------------------------------------------------------------------------

import { BluelinkError, ERROR_KINDS } from './errors.js';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 10;

/** A cookie jar: host → (name → value). */
export function createCookieJar() {
  const hosts = new Map();
  return {
    store(url, response) {
      const host = new URL(url).host;
      const lines =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : [response.headers.get('set-cookie')].filter(Boolean);
      for (const line of lines) {
        const [pair] = line.split(';');
        const at = pair.indexOf('=');
        if (at <= 0) continue;
        const cookies = hosts.get(host) ?? new Map();
        cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
        hosts.set(host, cookies);
      }
    },
    header(url) {
      const cookies = hosts.get(new URL(url).host);
      if (!cookies || cookies.size === 0) return undefined;
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
  };
}

/**
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export function createHttp({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function once(url, { method = 'GET', headers = {}, body, jar, redirect }) {
    const allHeaders = { ...headers };
    const cookie = jar?.header(url);
    if (cookie) allHeaders.Cookie = cookie;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: allHeaders,
        body,
        redirect,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err?.cause?.code ?? err?.name ?? 'error';
      throw new BluelinkError(ERROR_KINDS.NETWORK, `${new URL(url).host} unreachable (${reason})`);
    }
    jar?.store(url, response);
    return response;
  }

  /**
   * One request.
   * @param {string} url
   * @param {object} [options]
   * @param {string} [options.method]
   * @param {Record<string,string>} [options.headers]
   * @param {object} [options.json] JSON body
   * @param {Record<string,string>} [options.form] form-urlencoded body
   * @param {ReturnType<typeof createCookieJar>} [options.jar] cookie jar
   * @param {boolean} [options.followRedirects] follow 3xx (default true)
   * @returns {Promise<{ status: number, url: string, headers: Headers, text: string, json: () => any }>}
   */
  async function request(url, options = {}) {
    const { json, form, followRedirects = true, jar } = options;
    const headers = { ...(options.headers ?? {}) };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] ??= 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    let method = options.method ?? (body !== undefined ? 'POST' : 'GET');
    let current = url;
    // With a jar, redirects are followed by hand to carry the cookies.
    const manual = Boolean(jar) || !followRedirects;
    for (let hop = 0; ; hop += 1) {
      const response = await once(current, {
        method,
        headers,
        body,
        jar,
        redirect: manual ? 'manual' : 'follow',
      });
      const location = response.headers.get('location');
      if (
        followRedirects &&
        manual &&
        response.status >= 300 &&
        response.status < 400 &&
        location
      ) {
        if (hop >= MAX_REDIRECTS) {
          throw new BluelinkError(ERROR_KINDS.API, `Too many redirects from ${new URL(url).host}`);
        }
        current = new URL(location, current).toString();
        // Like a browser: a redirect becomes a GET without a body.
        method = 'GET';
        body = undefined;
        delete headers['Content-Type'];
        continue;
      }
      const text = await response.text();
      return {
        status: response.status,
        url: current,
        headers: response.headers,
        text,
        json() {
          try {
            return JSON.parse(text);
          } catch {
            throw new BluelinkError(
              response.status >= 500 ? ERROR_KINDS.SERVER : ERROR_KINDS.API,
              `Not a JSON answer from ${new URL(current).host} (HTTP ${response.status})`,
              { status: response.status },
            );
          }
        },
      };
    }
  }

  return { request };
}
