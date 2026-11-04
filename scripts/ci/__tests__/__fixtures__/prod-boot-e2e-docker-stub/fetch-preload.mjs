// Preload for the docker stand-in (docker.mjs): the prod-boot e2e's own `probe` code
// runs under node with this `fetch`, which answers with the modelled response in
// STUB_RESPONSE ({ status, url, body }).
const r = JSON.parse(process.env.STUB_RESPONSE ?? "null");
globalThis.fetch = async () => {
  if (r === null) throw new Error("fetch failed");
  return { status: r.status, url: r.url, text: async () => r.body };
};
