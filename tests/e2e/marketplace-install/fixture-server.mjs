// -----------------------------------------------------------------------------
// Hermetic marketplace fixture for the `marketplace-install` e2e suite (#836).
//
// A tiny, dependency-free HTTP server that stands in for BOTH the marketplace
// storefront's anonymous public catalog AND the package registry (Verdaccio),
// so the `/configuration/marketplace` Install-click path can be exercised end to
// end in CI with NO real bearer, NO published artifact, and NO external network.
//
// It serves exactly enough to make the UI render a live (enabled) Install CTA:
//   * GET /wp-json/cinatra/v1/extensions            → one listable SKILL card.
//     (`fetchPublicMarketplaceExtensionList` reads this anonymously; the card's
//      identity is a valid scoped npm name + strict semver so it renders.)
// …and then makes the install DELIBERATELY fail-closed so we assert the
// graceful-degradation contract (#356 no-crash / #685 non-technical toast):
//   * every registry / packument / tarball / detail path → 404 after a short
//     delay (the delay keeps the "Installing…" pending label observable).
//
// The SKILL kind is chosen on purpose: connector/artifact/workflow route through
// the #805 pre-install access-selector DIALOG, whereas agent/skill/unknown use
// the direct one-click <MarketplaceInstallForm> — the simplest deterministic
// click→toast path.
//
// Wire it via env on the app under test:
//   MARKETPLACE_BASE_URL         = http://127.0.0.1:<port>   (catalog source)
//   CINATRA_AGENT_REGISTRY_URL   = http://127.0.0.1:<port>   (→ registryConnected)
//   CINATRA_AGENT_REGISTRY_TOKEN = <any non-empty>           (→ registryConnected)
// (MARKETPLACE_BASE_URL is honored only outside NODE_ENV=production, i.e. the
// `pnpm dev` server the suite boots — never a real production instance.)
// -----------------------------------------------------------------------------

import { createServer } from "node:http";

const PORT = Number(process.env.E2E_MP_FIXTURE_PORT ?? 4599);
const HOST = "127.0.0.1";

// The single listable extension. A valid scoped npm name + strict semver so
// `catalogEntryToCardData` keeps it (a malformed identity is dropped), and
// kind_slug "skill" so the card renders the direct one-click Install CTA.
export const FIXTURE_CARD = {
  package_name: "@cinatra-ai/e2e-install-probe",
  scope: "cinatra-ai",
  extension_name: "e2e-install-probe",
  version: "1.0.0",
  kind_slug: "skill",
  kind_label: "Skill",
  display_name: "E2E Install Probe",
  description: "Hermetic fixture extension used by the marketplace Install-click e2e.",
  badge: { text: "Open source", variant: "oss", license: "Apache-2.0" },
  freshness_at: "2026-06-01T00:00:00Z",
  rating: { average: 0, count: 0 },
  install_count: 0,
  icon_url: null,
  vendor_logo_url: null,
  sdk_abi_range: null,
  permalink: "http://127.0.0.1/product/e2e-install-probe",
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Request ledger — records every non-infrastructure request the app makes to
// this fixture. The spec resets it after page load, clicks Install, then asserts
// the ledger captured a registry/packument request for the probe package. This
// is the anti-false-green guard: without it, the graceful toast could be
// produced by an auth/config failure that never actually reached the registry
// (so the "install path works, it just fails closed" claim would be unproven).
const requests = [];

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  } catch {
    // fall through with "/"
  }

  // Health probe — Playwright's webServer waits on this before the app boots.
  // Not recorded (infrastructure, not app behavior).
  if (pathname === "/-/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Ledger inspection + reset (test-control plane; not recorded).
  if (pathname === "/__requests") {
    if (method === "DELETE") {
      requests.length = 0;
      sendJson(res, 200, { ok: true, requests: [] });
      return;
    }
    sendJson(res, 200, { requests });
    return;
  }

  // Record every real app→fixture request (catalog reads + registry reads).
  requests.push({ method, path: pathname, at: new Date().toISOString() });

  // Anonymous public catalog LIST — the ONLY success path. Served immediately so
  // the marketplace page paints fast. Returns exactly one listable card.
  if (pathname === PUBLIC_LIST_ROUTE) {
    sendJson(res, 200, { items: [FIXTURE_CARD], total: 1 });
    return;
  }

  // Everything else — the public DETAIL endpoint, and every registry packument /
  // tarball / install-broker path — fails closed. The short delay keeps the
  // "Installing…" pending state observable while the install server action is in
  // flight, and the 404 drives the install into its graceful failure branch
  // (returns {ok:false,category} → non-technical toast, never a page crash).
  await delay(350);
  sendJson(res, 404, {
    error: "not_found",
    message: "marketplace-install e2e fixture: path intentionally unavailable",
    path: pathname,
  });
});

server.on("error", (err) => {
  console.error("[mp-install-fixture] server error:", err);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`[mp-install-fixture] listening on http://${HOST}:${PORT}`);
});

// Clean shutdown so Playwright's webServer teardown doesn't leak the port.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
