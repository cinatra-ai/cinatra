// -----------------------------------------------------------------------------
// Lane-private marketplace STOREFRONT for the two-version install proof.
//
// The application reads its marketplace browse catalog from the storefront's
// anonymous REST endpoint (`GET /wp-json/cinatra/v1/extensions`), NOT from the
// package registry. Without a catalog entry the marketplace renders no card, so
// there is no real Install affordance to click. This server supplies exactly one
// catalog entry: the connector the tree already bundles at the OLDER version,
// listed at the NEWER version that the lane-private Verdaccio holds, signed.
//
// It is deliberately a SEPARATE process from the registry. The registry
// (Verdaccio, lane-private port) serves the packument, the signature and the
// tarball; this server serves only the storefront catalog. Keeping them apart
// means the install path that runs is the ordinary one: browse from the
// storefront, resolve and verify from the registry.
//
// This is a dependency-free sibling of the repo's own
// `tests/e2e/marketplace-install/fixture-server.mjs`, which 404s every registry
// path so its install fails closed. This one does the opposite: it names a REAL
// package that a REAL registry can actually serve, so the install SUCCEEDS.
//
// Wire it via env on the application under test:
//   MARKETPLACE_BASE_URL       = http://127.0.0.1:<this port>
//   CINATRA_AGENT_REGISTRY_URL = http://127.0.0.1:<verdaccio port>
// (`MARKETPLACE_BASE_URL` is honored only outside NODE_ENV=production — see
// `resolveMarketplaceBaseUrl`, in the marketplace client package's HTTP client.
// That is why this proof runs on the dev runtime.)
// -----------------------------------------------------------------------------

import { createServer } from "node:http";

const PORT = Number(process.env.LANE_STOREFRONT_PORT ?? 4881);
const HOST = "127.0.0.1";

// The version this catalog advertises. It is the NEWER of the two versions in
// play; the static bundle in the image carries the older one.
const LISTED_VERSION = process.env.LANE_LISTED_VERSION ?? "0.1.2";

const CARD = {
  package_name: "@cinatra-ai/google-appointment-schedules-connector",
  scope: "cinatra-ai",
  extension_name: "google-appointment-schedules-connector",
  version: LISTED_VERSION,
  // `connector` on purpose: a connector routes through the in-card install
  // ACCESS-TARGET panel, which is the real operator install path for this kind.
  kind_slug: "connector",
  kind_label: "Connector",
  display_name: "Google Appointment Schedules",
  description:
    "Manage the Google Calendar appointment-schedule booking links the assistant can share.",
  badge: { text: "Open source", variant: "oss", license: "Apache-2.0" },
  freshness_at: "2026-08-01T00:00:00Z",
  rating: { average: 0, count: 0 },
  install_count: 0,
  icon_url: null,
  vendor_logo_url: null,
  sdk_abi_range: "^2",
  permalink: "http://127.0.0.1/product/google-appointment-schedules-connector",
};

const PUBLIC_LIST_ROUTE = "/wp-json/cinatra/v1/extensions";

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

// Every request the application makes is recorded, so the evidence can show the
// catalog read actually happened rather than inferring it from a rendered card.
const requests = [];

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  } catch {
    // fall through with "/"
  }

  if (pathname === "/-/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/__requests") {
    if (method === "DELETE") {
      requests.length = 0;
      sendJson(res, 200, { ok: true, requests: [] });
      return;
    }
    sendJson(res, 200, { requests });
    return;
  }

  requests.push({ method, path: pathname, at: new Date().toISOString() });

  // The anonymous catalog LIST — the browse source.
  if (pathname === PUBLIC_LIST_ROUTE) {
    sendJson(res, 200, { items: [CARD], total: 1 });
    return;
  }

  // The anonymous catalog DETAIL — `/wp-json/cinatra/v1/extensions/<scope>/<name>`.
  if (pathname.startsWith(`${PUBLIC_LIST_ROUTE}/`)) {
    const tail = pathname.slice(PUBLIC_LIST_ROUTE.length + 1);
    if (tail === `${CARD.scope}/${CARD.extension_name}`) {
      sendJson(res, 200, CARD);
      return;
    }
  }

  // Anything else is not this server's job. The registry is a different process
  // on a different port; a request arriving here for a registry path is a
  // wiring mistake and says so, instead of being quietly absorbed.
  sendJson(res, 404, {
    error: "not_found",
    message: "lane storefront: this server serves only the public catalog",
    path: pathname,
  });
});

server.on("error", (err) => {
  console.error("[lane-storefront] server error:", err);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`[lane-storefront] listening on http://${HOST}:${PORT} (version ${LISTED_VERSION})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
