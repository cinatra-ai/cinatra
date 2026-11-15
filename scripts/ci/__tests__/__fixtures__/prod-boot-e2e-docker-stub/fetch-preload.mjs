// Preload for the docker stand-in (docker.mjs): the prod-boot e2e's own `probe` code
// runs under node with this `fetch`. STUB_RESPONSE is null when nothing serves the
// probed URL, or { request, status, url, body }. The fetch answers only a GET of
// exactly `request`, the URL the stand-in modelled; any other URL or method fails as
// a network error does.
const r = JSON.parse(process.env.STUB_RESPONSE ?? "null");
globalThis.fetch = async (input, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  if (r === null || String(input) !== r.request || method !== "GET") throw new TypeError("fetch failed");
  return { status: r.status, url: r.url, text: async () => r.body };
};
