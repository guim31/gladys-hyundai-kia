// -----------------------------------------------------------------------------
// A fetch stand-in for the client tests: routes (method + URL pattern) answer
// canned responses, every request is recorded. Nothing reaches the network.
// -----------------------------------------------------------------------------

/**
 * @param {Array<{ method?: string, url: RegExp, reply: (request: object) => object }>} routes
 *   `reply` returns { status?, json?, text?, headers? } (or an array of them,
 *   used in turn, the last one repeating)
 */
export function createFakeFetch(routes) {
  const requests = [];
  const counters = new Map();
  async function fetchImpl(url, init = {}) {
    const method = init.method ?? 'GET';
    const request = {
      url: String(url),
      method,
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : String(init.body),
    };
    requests.push(request);
    const index = routes.findIndex(
      (r) => (r.method ?? method) === method && r.url.test(request.url),
    );
    if (index < 0) throw new TypeError(`fetch failed: no route for ${method} ${request.url}`);
    const count = counters.get(index) ?? 0;
    counters.set(index, count + 1);
    let answer = routes[index].reply(request, count);
    if (Array.isArray(answer)) answer = answer[Math.min(count, answer.length - 1)];
    const headers = new Headers();
    for (const [name, value] of Object.entries(answer.headers ?? {})) {
      for (const v of [].concat(value)) headers.append(name, v);
    }
    const body = answer.json !== undefined ? JSON.stringify(answer.json) : (answer.text ?? '');
    return new Response(answer.status === 204 ? null : body, {
      status: answer.status ?? 200,
      headers,
    });
  }
  return { fetchImpl, requests };
}

export const ok = (resMsg = {}, extra = {}) => ({
  json: { retCode: 'S', resCode: '0000', resMsg, ...extra },
});
export const fail = (resCode, resMsg = 'error') => ({
  json: { retCode: 'F', resCode: String(resCode), resMsg },
});
