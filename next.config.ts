import type { NextConfig } from "next";

// ---------------------------------------------------------------------------
// cinatra#1506 — pin `sonner` to a single resolved module instance under
// Turbopack.
//
// `sonner` keeps its live toast store in a module-level singleton that BOTH the
// `toast()` emitter and the mounted <Toaster> subscriber must share. `sonner`
// is a peerDependency of @cinatra-ai/sdk-ui, so pnpm materialises a
// package-local peer symlink (packages/sdk-ui/node_modules/sonner) beside the
// host's root node_modules/sonner. On dev machines that run several git
// worktrees off one pnpm parent, those two symlinks can resolve to DIFFERENT
// physical copies of sonner. Turbopack keys module identity by resolved path,
// so it then instantiates TWO sonner modules: the sdk-ui `toast()` pushes to
// one store while the host <Toaster> subscribes to the other, and no toast ever
// paints — every SearchParamToast flash→toast island (host + connectors) is
// invisible in local dev.
//
// Aliasing every bare `sonner` request to the single host-resolved package
// directory collapses both import sites onto one module instance, restoring the
// shared store. Both files that may import sonner directly (the sdk-ui toast
// wrapper and src/components/ui/sonner.tsx) import it as the bare specifier, so
// a single alias covers them.
//
// Production impact: Next 16.2 `next build` also uses Turbopack, so this alias
// applies there too — by design. On the clean, single-worktree install that CI
// and production images build from, both import sites already resolve to the one
// canonical sonner copy, so the alias resolves to that same module and build
// resolution + runtime behaviour are unchanged; it only ever diverts a request
// that would otherwise land on a stray peer copy. So the production build path
// is unaffected in the case that matters (clean install) and strictly hardened
// otherwise.
//
// The alias value is a STATIC root-relative request (resolved against
// turbopack.root === process.cwd()). It deliberately does NO filesystem work at
// config-eval time (no require.resolve / path.*) so the `output: "standalone"`
// file tracer doesn't flag next.config.ts as dynamically touching the fs. sonner
// is a direct dependency of the host, so `./node_modules/sonner` always exists
// (a pnpm symlink to the single .pnpm copy), and Turbopack resolves the package
// from there via its exports map.
// ---------------------------------------------------------------------------
const SONNER_ALIAS = "./node_modules/sonner";

// ---------------------------------------------------------------------------
// Required environment variables — fail fast at server startup.
// ---------------------------------------------------------------------------
const REQUIRED_ENV: string[] = [
  // NOTE: OPENAI_API_KEY is intentionally NOT required here. The Next.js app
  // never reads it as a provider credential (provider config is in-app via
  // /setup/ai). Since cinatra#2582 the Graphiti knowledge-graph container is
  // handed the key resolved from that stored configuration at bring-up
  // (scripts/gen-graphiti-env.mjs), with this env var as the fallback source;
  // a keyless install is a REPORTED state ("knowledge-graph indexing OFF"), and
  // object save/list degrade gracefully to Postgres. Requiring it at app boot
  // crashed fresh `make setup && make dev` (the copied .env.example ships it
  // empty) for no functional reason. See .env.example for when to set it.
  //
  // Required at build time too: `next build` page-data collection imports
  // DB-backed modules. The Dockerfile / CI build step supplies a placeholder
  // value; runtime supplies the real connection string. Asserting it here gives
  // a clear, immediate error instead of a deep "Failed to collect page data".
  "SUPABASE_DB_URL",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(
      `Missing required environment variable: ${key}\n` +
        `Set it in .env.local (for the Next.js dev server) and in .env (for Docker Compose / Graphiti).`,
    );
  }
}

// ---------------------------------------------------------------------------
// cinatra#2607 — constrained-host build knob (env-selectable; unset = today).
//
// `next build` on a small builder hits a NATIVE (non-V8) memory wall. cinatra
// #2606's `ARG NODE_OPTIONS` binds only V8's old space, and cinatra-cli#210
// measured a build failure that survived 4 GB → 14 GB of Docker VM RAM and
// 14 → 6 CPUs, so the Node heap lever alone cannot clear it.
//
//   CINATRA_BUILD_CPUS → experimental.cpus
//       The build's worker count (next/dist/build/index.js reads it directly
//       whenever it differs from the default). Each worker is a whole extra
//       Node process with its own heap, so on a small builder this is the
//       difference between one page-data collector and several.
//
// The other knob, CINATRA_BUILD_BUNDLER, is an ARGV flag Next resolves before
// this file is ever read (`next/dist/lib/bundler.js`), so it lives in
// scripts/next-build.mjs, not here.
//
// DELIBERATELY ABSENT: `experimental.turbopackMemoryLimit`. It looks like the
// obvious native lever and it is not one — on 16.2.10 it is measurably INERT
// for `next build`. Wiring it would hand an operator a knob that changes
// nothing while looking like the remedy. The measurements are in the doc below.
//
// UNSET MEANS UNSET. The knob is spread in only when its env var carries a
// value, so an untouched build produces the byte-identical resolved config it
// produced before this block existed. A docker `ARG X=` forwards an EMPTY
// string rather than an absent variable, so "" is treated as unset too.
//
// Fail-closed: a malformed value throws here, at config load — seconds into the
// build, long before any compile work — rather than being silently ignored and
// leaving an operator to conclude the knob does not work.
//
// Accepted values and the full measured matrix (including what does NOT work):
// docs/internals/workflows/constrained-host-builds.md
// ---------------------------------------------------------------------------
function readBuildKnobInt(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${name}="${raw}" is not a whole number. Set it to an integer between ${min} and ${max}, or leave it unset.`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(
      `${name}="${raw}" is out of range. Set it to an integer between ${min} and ${max}, or leave it unset.`,
    );
  }
  return value;
}

// A band, not an opinion: the floor is one worker, the ceiling is well past any
// real builder. The knob does not pick a "good" number — the operator's host does.
const buildCpus = readBuildKnobInt("CINATRA_BUILD_CPUS", 1, 256);

const nextConfig: NextConfig = {
  // Emit a self-contained .next/standalone/ at build time so the runtime
  // Docker image only needs the modules actually traced from the app
  // (vs. the full node_modules tree). https://nextjs.org/docs/app/api-reference/config/next-config-js/output
  output: "standalone",
  // Skip `next build`'s redundant in-build TypeScript check IN CI ONLY. Types are
  // gated by the separate REQUIRED "Typecheck and unit tests" job, which runs
  // `next typegen` before `tsgo --noEmit` so generated route types
  // (.next/types/routes.d.ts) are covered without a full build. This removes the
  // "Running TypeScript ..." phase from all three CI `next build`s (the docker
  // build job + both e2e jobs). Local / ad-hoc production builds (CI unset) keep
  // the full in-build tsc as a safety net. The Dockerfile forwards CI=true as a
  // build-arg in CI so its build benefits too; a local `docker build` without
  // that arg keeps the check.
  typescript: {
    ignoreBuildErrors: process.env.CI === "true",
  },
  devIndicators: {
    position: "bottom-right",
  },
  turbopack: {
    root: process.cwd(),
    // cinatra#1506: force a single `sonner` module instance (see the block above).
    resolveAlias: { sonner: SONNER_ALIAS },
  },
  // Next.js 16 blocks cross-origin access to `_next/*` dev resources by default.
  // The dev server self-identifies as `localhost`, so requests from `127.0.0.1`
  // (which Playwright uses because `localhost` resolves to `::1` and the IPv4
  // listener is what the suite targets) carry an `Origin: http://127.0.0.1:3000`
  // header that Next sees as cross-origin → it refuses the
  // `/_next/webpack-hmr?id=...` WebSocket upgrade with a non-101 response, which
  // Chromium logs as `ERR_INVALID_HTTP_RESPONSE`. A raw curl probe to the HMR
  // endpoint succeeded with `HTTP/1.1 101` only because curl omits the `Origin`
  // header and side-steps the same-origin check.
  //
  // Including `127.0.0.1` here lets the IPv4 dev access path work end-to-end in
  // headless Playwright. The dev server still binds the same socket; this only
  // affects how Next's cross-origin guard classifies incoming requests.
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // Decouple App Router client hydration from the dev-mode React debug
    // channel.
    //
    // Default (`config-shared.js:247`): `experimental.reactDebugChannel = true`,
    // compiled via `build/define-env.js:195` into the client bundle as
    // `process.env.__NEXT_REACT_DEBUG_CHANNEL`. In `client/app-index.js:153`,
    // when the env is truthy the client creates a `debugChannel` and passes it
    // into `createFromReadableStream`. React's RSC client then only resolves
    // `initialServerResponse` when BOTH the inline Flight stream AND the
    // HMR-delivered React debug stream close
    // (`react-server-dom-turbopack-client.browser.development.js:5190`).
    // `hydrateRoot` is awaited on that promise (`app-index.js:241`).
    //
    // Empirically: even after fixing the cross-origin block above and confirming
    // HMR connects (`[HMR] connected`, bidirectional frames, server sends
    // `isrManifest`/`turbopack-connected`/`sync`), the React debug close-chunk
    // never reaches the client in headless Chromium, so
    // `initialServerResponse` never resolves, `hydrateRoot` never runs, and the
    // entire `/desk` page stays as inert SSR markup with `bellFiber: NO-FIBER`,
    // `self.__next_f.push` patched to `nextServerDataCallback` but unused,
    // `document.readyState` stuck at `"interactive"`. This blocked
    // notifications-flyout e2e coverage downstream of the separately-fixed
    // `OPENAI_API_LOG_DIRECTORY` TDZ.
    //
    // Setting this to `false` substitutes a falsy literal into the client
    // bundle, which keeps `debugChannel` as `undefined` → React closes the RSC
    // root on the Flight stream alone → `hydrateRoot` runs → the page is
    // interactive. The dev React debug feature is only used by React DevTools
    // for component-level debug events; disabling it has no production impact
    // (production builds never set this) and no functional impact on the app.
    //
    // The gating env variable was verified via
    // `next/dist/build/define-env.js:195`.
    reactDebugChannel: false,
    // ---------------------------------------------------------------------
    // Turbopack DEV filesystem cache — opt-OUT for constrained CI hosts.
    //
    // Next 16 defaults `turbopackFileSystemCacheForDev` to true: the dev server
    // persists its compilation graph to `.next/cache` and periodically compacts
    // that database. On a developer machine that is a pure win (warm restarts).
    // On a 4-vCPU / 16-GB hosted CI runner that is ALSO hosting the docker
    // WordPress + Drupal + nango + wayflow stack, Postgres/Redis service
    // containers and a Playwright Chromium, the cache write + compaction cycle
    // is the marginal workload that pushes the box over its memory/IO cliff.
    //
    // Observed failure mode (WP/Drupal UAT gate): compaction time escalates
    // 11.8s → 14.0s → 21.3s → 31.7s → 49s → 98s → 2.1min → 8.7min inside one
    // run, after which the whole VM stops making progress — no Playwright
    // per-test timeout ever fires (the test runner process is wedged too) and
    // the job dies silently when the runner is torn down. The suite is
    // COLD-cached on every CI run anyway (a fresh runner has no `.next/cache`),
    // so persisting it buys nothing there and only costs the write + compaction.
    //
    // Env-gated rather than unconditional so local `pnpm dev` keeps its warm
    // restarts; only the UAT config's webServer command sets the flag (see
    // tests/e2e/config/wp-drupal-uat.config.ts).
    // ---------------------------------------------------------------------
    ...(process.env.CINATRA_TURBOPACK_DEV_FS_CACHE === "0"
      ? { turbopackFileSystemCacheForDev: false }
      : {}),
    // cinatra#2607 constrained-host build knob — see the block above this
    // config object. Spread in ONLY when set, so an untouched build's resolved
    // config is unchanged.
    ...(buildCpus !== undefined ? { cpus: buildCpus } : {}),
  },
  serverExternalPackages: [
    // Crawlee packages use native binaries and must stay external.
    "@crawlee/cheerio",
    "@crawlee/http",
    "@crawlee/core",
    "@crawlee/utils",
    "@crawlee/basic",
    // LLM provider SDKs are server-only and large (openai: 13 MB, @google/genai: 14 MB,
    // @anthropic-ai/sdk: 5 MB). Turbopack does not need to bundle these — keeping them
    // external prevents a 32 MB ESM parse spike when any route that imports
    // @/lib/mcp-server (or @cinatra-ai/llm) is compiled for the first time.
    "openai",
    "@anthropic-ai/sdk",
    "@google/genai",
    // @modelcontextprotocol/* packages ship chunked dist bundles with their own
    // transitive deps (server@2.0.0 exact-pins @modelcontextprotocol/core). Keeping them
    // external lets Node.js resolve them from node_modules at runtime instead of
    // Turbopack pulling the whole chunk graph into the module graph. cinatra#2218 L1
    // retired the vendored copies; the -node / -express shims were never imported.
    // cinatra#2218 L2a added the client package for the graphiti outbound surface;
    // it exact-pins @modelcontextprotocol/core@2.0.0 the same way server does.
    // cinatra#2218 L2z dropped the v1 @modelcontextprotocol/sdk entry with the root
    // dependency: no cinatra source reaches it from the Next module graph any more,
    // so there is nothing left on that specifier to externalize.
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/core",
    // BullMQ and IORedis are server-only Redis/queue runtimes (bullmq: 5 MB). External
    // keeps them out of the Turbopack module graph entirely.
    "bullmq",
    "ioredis",
    // Octokit (GitHub SDK) is imported by @cinatra-ai/skills/github.ts for repo cloning.
    // It resolves to 27 sub-packages (@octokit/*). Externalizing it prevents Turbopack
    // from walking the full @octokit/* tree when compiling any route that imports skills.
    "octokit",
    "@octokit/core",
    "@octokit/app",
    // fflate is used by @cinatra-ai/skills/github.ts to unzip downloaded archives.
    // It contains compiled WASM and large binary blobs that Turbopack should never bundle.
    "fflate",
    // libnpmpublish and pacote are used by @cinatra-ai/agents to publish/fetch
    // packages from Verdaccio. They pull in node-gyp (native .cs files) and other
    // Node.js-only internals that Turbopack cannot bundle.
    "diff",
    "libnpmpublish",
    "pacote",
    "semver",
    "npm-registry-fetch",
    "node-gyp",
    "tar",
    // Transitive deps of pacote that also pull in native binaries or Node.js internals.
    "@npmcli/run-script",
    "@npmcli/config",
    "@npmcli/package-json",
    "nopt",
    "minipass",
    "minipass-pipeline",
    "minizlib",
    // @a2a-js/sdk is a dependency of @cinatra-ai/a2a (which is in transpilePackages).
    // pnpm does not hoist it to root node_modules — keeping it external lets Node.js
    // resolve it at runtime via pnpm's virtual store (.pnpm/) instead of Turbopack
    // trying (and failing) to bundle it from the transpiled @cinatra-ai/a2a source.
    "@a2a-js/sdk",
    // bpmn-moddle + its moddle / moddle-xml deps are ESM-only XML parsers used
    // server-side at workflow-extension install time (and the BPMN CI gate).
    // Keep external; never bundle into the client/edge graph.
    "bpmn-moddle",
    "moddle",
    "moddle-xml",
    // typescript is the parser behind the runtime-extension host-peer
    // value-import scanner (src/lib/extension-package-store-core.ts, imported by
    // the server-only materializer). It is a large (~9 MB) Node-only library;
    // keep it external so Turbopack/the standalone build never tries to bundle
    // the compiler into a route chunk — Node resolves it at runtime.
    "typescript",
    // node-pg-migrate (the core migration runner, cinatra#116) loads
    // migration modules at runtime via `await import(\`file://...\`)` over
    // migrations/core/ — that dynamic import must stay native Node, never
    // bundled. Output tracing still copies the package into the standalone
    // image (it is statically imported via @cinatra-ai/migrations, which the
    // host pulls in through src/lib/core-migrations.ts).
    "node-pg-migrate",
  ],
  transpilePackages: [
    // NOTE on connector entries (cinatra#7): a connector needs an entry here
    // only when it is node_modules-RESOLVED somewhere in the build graph
    // (workspace deps of packages/llm / packages/agents, or the root nango
    // dep). Connectors resolved purely via tsconfig path aliases compile as
    // sources and need no entry; entries for packages outside the declared
    // bootable set (cinatra.extensions) were pruned with the shrink.
    "@cinatra-ai/extension-types",
    "@cinatra-ai/extensions",
    "@cinatra-ai/agents",
    "@cinatra-ai/notifications",
    "@cinatra-ai/webhooks",
    "@cinatra-ai/errors",
    "@cinatra-ai/connectors",
    "@cinatra-ai/connectors-catalog",
    "@cinatra-ai/anthropic-connector",
    "@cinatra-ai/dashboards",
    "@cinatra-ai/design",
    "@cinatra-ai/marketplace-mcp-client",
    "@cinatra-ai/marketplace-sync",
    "@cinatra-ai/marketplace-application-reconcile",
    "@cinatra-ai/sdk-dashboard",
    "@cinatra-ai/sdk-extensions",
    "@cinatra-ai/gemini-connector",
    "@cinatra-ai/gmail-connector",
    "@cinatra-ai/google-calendar-connector",
    "@cinatra-ai/nango-connector",
    "@cinatra-ai/google-oauth-connection",
    "@cinatra-ai/mcp-server",
    "@cinatra-ai/openai-connector",
    "@cinatra-ai/wordpress-mcp-connector",
    "@cinatra-ai/crm-connector",
    "@cinatra-ai/a2a",
    "@cinatra-ai/agent-ui-protocol",
    "@cinatra-ai/chat",
    "@cinatra-ai/registries",
  ],
  async headers() {
    return [
      {
        // cinatra#221: the Connect consent screen issues an authorization code
        // appended to a cross-origin 302 to the CMS callback. Set
        // Referrer-Policy: no-referrer so the short-lived code is never leaked
        // via the Referer header on that hop (belt-and-suspenders on top of the
        // browser's default cross-origin stripping; covers the dev loopback
        // same-origin case too). The page carries no other sensitive content.
        source: "/connect/authorize",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        // cinatra#2631 (codex rework round 7): the hosted widget login carries a
        // single-use SCREEN NONCE in its own query string — the only carrier a
        // server-component GET has, since it may not set a cookie. Same class of
        // short-lived URL-borne secret as the Connect authorization code above,
        // so it gets the same treatment: `no-referrer` so no navigation off this
        // page can put it in a Referer header (the browser default already
        // strips the query cross-origin; this covers the same-origin and
        // dev-loopback hops too), and `no-store` so no shared cache holds a
        // response minted for one arrival at an authenticated surface.
        source: "/widget-auth",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // cinatra#2566 (epic #2564 S2): the review-target ISLAND is embedded in
        // a review card as a same-origin iframe, so its response has to say
        // something about framing for itself.
        //
        // THE FRAMING HEADERS ARE NO LONGER HERE (cinatra#2577). They used to
        // be the fixed pair `Content-Security-Policy: frame-ancestors 'self'` +
        // `X-Frame-Options: SAMEORIGIN`, on the stated ground that "the island
        // is a first-party fragment and has no legitimate cross-origin
        // embedder". S8d made that false: the widget draws the SAME card, so
        // the island is nested inside `/embed/assistant`, which the registered
        // site frames — two ancestors, one of them cross-origin. A `'self'`-only
        // wall refuses to render there, which is what made the island blank on
        // the widget while it drew perfectly first-party. The wall is now
        // computed PER REQUEST in `applyReviewIslandFraming`
        // (src/lib/auth-route-guard.ts), because the answer now varies with the
        // request; a config header set HERE would also merge with the
        // per-request one and two CSP headers INTERSECT — re-blocking the very
        // frame the fix admits. Everything below stays fixed because it does not
        // vary.
        //
        // `Cache-Control: no-store` — the document is reader-scoped. A shared
        // cache holding it would be a way for the next reader on the same proxy
        // to see a target their own access check would have refused. That
        // MECHANISM — not this exact route — is verified: a minimal
        // reproduction using this same headers() configuration on
        // next@16.2.10 shows the production Next.js server (`next build &&
        // next start`) serves a next.config.ts-configured Cache-Control
        // header unmodified for a force-dynamic App Router page. This route
        // was not independently curled in production, and a released
        // image's own proxy/deployment layer was not checked either.
        // `next dev` is NOT a faithful witness for this header on ANY App
        // Router page: it forces `Cache-Control: no-cache, must-revalidate`
        // unconditionally in dev, with no config able to opt out (see the
        // longer note in src/app/lifecycle/review-island/page.tsx).
        source: "/lifecycle/review-island",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // cinatra#1880 W5 (AC#4): the assistants admin surface is the SINGULAR
      // /configuration/assistants; bridge the plural bookmark to it so an
      // /configurations/... link is never a dead 404.
      {
        source: "/configurations/assistants",
        destination: "/configuration/assistants",
        permanent: false,
      },
      // The native /workflows browse/list/overview page was removed
      // (cinatra#609) — workflow overview/tracking now lives in Plane. Old
      // index bookmarks land on the projects surface (the neutral, always-
      // available PM destination) instead of a dead 404. EXACT match only: the
      // per-workflow detail/run + approvals route (`/workflows/:workflowId`)
      // is KEPT and must stay reachable, so it is intentionally NOT matched.
      {
        source: "/workflows",
        destination: "/projects",
        permanent: false,
      },
      // cinatra#1007: /agents/run was removed (not redirected, by design) —
      // these legacy /campaign-types bookmarks now land on /agents, the new
      // home of the run-agent picker (the "All Agents" tab).
      {
        source: "/campaign-types",
        destination: "/agents",
        permanent: false,
      },
      {
        source: "/campaign-types/:path*",
        destination: "/agents",
        permanent: false,
      },
      {
        source: "/accounts",
        destination: "/account",
        permanent: false,
      },
      {
        source: "/accounts/settings",
        destination: "/account",
        permanent: false,
      },
      {
        source: "/accounts/security",
        destination: "/account/security",
        permanent: false,
      },
      {
        source: "/accounts/organizations",
        destination: "/account",
        permanent: false,
      },
      {
        source: "/accounts/:path+",
        destination: "/account",
        permanent: false,
      },
      {
        source: "/login",
        destination: "/sign-in",
        permanent: false,
      },
      {
        source: "/permissions/sign-in",
        destination: "/sign-in",
        permanent: false,
      },
      {
        source: "/permissions/sign-up",
        destination: "/sign-up",
        permanent: false,
      },
      {
        source: "/auth",
        destination: "/sign-in",
        permanent: false,
      },
      {
        source: "/auth/sign-in",
        destination: "/sign-in",
        permanent: false,
      },
      {
        source: "/auth/sign-up",
        destination: "/sign-up",
        permanent: false,
      },
      {
        source: "/auth/:path*",
        destination: "/permissions/:path*",
        permanent: false,
      },
      {
        source: "/metrics/metrics-costs",
        destination: "/metrics/metric-cost-api",
        permanent: false,
      },
      {
        source: "/metrics/metrics-cost",
        destination: "/metrics/metric-cost-api",
        permanent: false,
      },
      {
        source: "/metrics/metrics-cost/:path*",
        destination: "/metrics/metric-cost-api/:path*",
        permanent: false,
      },
      // analytics-routes-retire-allowlist-start
      // Analytics routes renamed. Permanent 308s
      // preserve external bookmarks and `?runId=` query strings via Next's
      // default query preservation. More-specific rules first so they win
      // before the catch-all `:path*` variants that follow.
      {
        source: "/analytics/metric-cost-api/pricing",
        destination: "/analytics/llm/pricing",
        permanent: true,
      },
      {
        source: "/analytics/metric-cost-api",
        destination: "/analytics/llm",
        permanent: true,
      },
      {
        source: "/analytics/metric-cost-api/:path*",
        destination: "/analytics/llm/:path*",
        permanent: true,
      },
      {
        source: "/analytics/metric-usage-api",
        destination: "/analytics/llm-usage",
        permanent: true,
      },
      {
        source: "/analytics/metric-usage-api/:path*",
        destination: "/analytics/llm-usage/:path*",
        permanent: true,
      },
      {
        source: "/analytics/traces",
        destination: "/analytics/api",
        permanent: true,
      },
      {
        source: "/analytics/traces/:path*",
        destination: "/analytics/api/:path*",
        permanent: true,
      },
      // analytics-routes-retire-allowlist-end
      // — Approvals consolidation (E8 cutover, cinatra#1558). Approvals were
      // unified into the /notifications surface; the standalone
      // /configuration/approvals page (+ its ?tab= / ?direction= machinery), the
      // legacy /approvals page, and the /configuration/agents/approvals INDEX
      // are all retired → /notifications. The per-approval detail page
      // /configuration/agents/approvals/[id] SURVIVES unchanged.
      {
        source: "/approvals",
        destination: "/notifications",
        permanent: true,
      },
      // The agent-approvals INDEX (exact) → the unified feed. Exact source, so
      // it never swallows the surviving /configuration/agents/approvals/[id].
      {
        source: "/configuration/agents/approvals",
        destination: "/notifications",
        permanent: true,
      },
      // Reciprocal old detail shape → the canonical (surviving) detail page.
      // MUST precede the /configuration/approvals/:path* wildcard below so the
      // detail redirect is not swallowed by the page retirement (specific
      // detail route before the wildcard).
      {
        source: "/configuration/approvals/agents/:id",
        destination: "/configuration/agents/approvals/:id",
        permanent: true,
      },
      // The retired inbox page (direct load) → the unified feed.
      {
        source: "/configuration/approvals",
        destination: "/notifications",
        permanent: true,
      },
      // Any legacy deep link UNDER the retired page (incl. ?tab= / ?direction=,
      // which fall through harmlessly) → the unified feed.
      {
        source: "/configuration/approvals/:path*",
        destination: "/notifications",
        permanent: true,
      },
      // /desk renamed to /personal.
      {
        source: "/desk",
        destination: "/personal",
        permanent: true,
      },
      // The standalone /agents/status agent-list table is retired — /agents
      // (the dashboard) is the single installed-agents surface.
      // scripts/audit/agents-status-route-banned.mjs guards in-tree
      // references; these permanent 308s preserve external bookmarks and
      // browser history. Old /agents/status/<runId> run pages have no
      // per-run mapping in the new [vendor]/[packageName]/[instanceId]
      // scheme, so the catch-all also lands at /agents. Bare rule first per
      // the table's convention.
      {
        source: "/agents/status",
        destination: "/agents",
        permanent: true,
      },
      {
        source: "/agents/status/:path*",
        destination: "/agents",
        permanent: true,
      },
      // mcp-machine-flow-allowlist-start
      // MCP OAuth handshake pages moved from the admin namespace to /api/mcp/*.
      // These specific rules run BEFORE the broad /administration/* catch-all so
      // an external MCP client that cached either era's URL lands at the new
      // machine-flow path in one logical hop. Includes the historical
      // bare-suffix /sign-in /sign-up shapes the server previously advertised.
      {
        source: "/administration/mcp/auth/:path*",
        destination: "/api/mcp/auth/:path*",
        permanent: true,
      },
      {
        source: "/administration/mcp/account/:path*",
        destination: "/api/mcp/account/:path*",
        permanent: true,
      },
      {
        source: "/administration/mcp/consent",
        destination: "/api/mcp/consent",
        permanent: true,
      },
      {
        source: "/administration/mcp/sign-in",
        destination: "/api/mcp/auth/sign-in",
        permanent: true,
      },
      {
        source: "/administration/mcp/sign-up",
        destination: "/api/mcp/auth/sign-up",
        permanent: true,
      },
      {
        source: "/admin/mcp/auth/:path*",
        destination: "/api/mcp/auth/:path*",
        permanent: true,
      },
      {
        source: "/admin/mcp/account/:path*",
        destination: "/api/mcp/account/:path*",
        permanent: true,
      },
      {
        source: "/admin/mcp/consent",
        destination: "/api/mcp/consent",
        permanent: true,
      },
      {
        source: "/admin/mcp/sign-in",
        destination: "/api/mcp/auth/sign-in",
        permanent: true,
      },
      {
        source: "/admin/mcp/sign-up",
        destination: "/api/mcp/auth/sign-up",
        permanent: true,
      },
      // mcp-machine-flow-allowlist-end
      // admin-route-allowlist-start
      // Admin UI rename: `/admin/*` → `/configuration/*`. Placed
      // AFTER the more-specific `/admin/mcp/*` machine-flow rules above
      // (which carry their own destinations into `/api/mcp/*`) and BEFORE
      // the legacy `/administration/*` block so any older external bookmark
      // of the intermediate `/administration/*` still lands at the
      // current `/configuration/*` home in one logical hop.
      {
        source: "/admin/:path*",
        destination: "/configuration/:path*",
        permanent: true,
      },
      // admin-route-allowlist-end
      // administration-route-allowlist-start
      {
        source: "/administration/:path*",
        destination: "/configuration/:path*",
        permanent: true,
      },
      {
        source: "/api/administration/:path*",
        destination: "/api/admin/:path*",
        permanent: true,
      },
      // administration-route-allowlist-end
      // entity-skills-retire-allowlist-start
      // The personal-skill CRUD surface moved from /entity/skills/* into the
      // unified /skills tree. Ordering: the more-specific suffix rules MUST
      // run before the catch-all so the path semantics carry through (new →
      // /skills/new, edit → /skills/<id>/edit, list → /skills?scope=personal).
      {
        source: "/entity/skills/new",
        destination: "/skills/new",
        permanent: true,
      },
      {
        source: "/entity/skills/:skillId",
        destination: "/skills/:skillId/edit",
        permanent: true,
      },
      {
        source: "/entity/skills",
        destination: "/skills?scope=personal",
        permanent: true,
      },
      {
        source: "/entity/skills/:path*",
        destination: "/skills",
        permanent: true,
      },
      {
        source: "/entity",
        destination: "/connectors",
        permanent: true,
      },
      // The legacy /profile/skills path was an even earlier name for the
      // same personal-skill surface; redirect it to the new canonical home.
      {
        source: "/profile/skills/:skillId",
        destination: "/skills/:skillId",
        permanent: true,
      },
      {
        source: "/profile/skills",
        destination: "/skills?scope=personal",
        permanent: true,
      },
      {
        source: "/profile/skills/:path*",
        destination: "/skills",
        permanent: true,
      },
      // entity-skills-retire-allowlist-end
      // connector-mcp-rename-allowlist-start
      // The connectors-catalog descriptor slug change
      // (`wordpress-connector` → `wordpress-mcp-connector`, same for
      // drupal) means the dynamic-catch-all URL under the OLD slug 404s.
      // Permanent 308 redirects preserve external bookmarks. Placed BEFORE
      // any broader catch-all so the exact-prefix match wins.
      {
        source: "/connectors/cinatra-ai/wordpress-connector/:path*",
        destination: "/connectors/cinatra-ai/wordpress-mcp-connector/:path*",
        permanent: true,
      },
      {
        source: "/connectors/cinatra-ai/drupal-connector/:path*",
        destination: "/connectors/cinatra-ai/drupal-mcp-connector/:path*",
        permanent: true,
      },
      // connector-mcp-rename-allowlist-end
      // cinatra#2502: the setup wizard's credential step was renamed
      // "Connections" → "Secrets" (the old label reused an established, distinct
      // Cinatra concept) and its route moved with the label, because a route
      // that spells a step differently from its own name gives one step two
      // names. A permanent 308 keeps any bookmark, in-flight redirect or
      // operator note pointing at /setup/connections landing on the step rather
      // than on a 404.
      {
        source: "/setup/connections",
        destination: "/setup/secrets",
        permanent: true,
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Sentry source-map upload (build-time only).
//
// withSentryConfig only does meaningful work when SENTRY_AUTH_TOKEN is set
// at BUILD time (CI). At runtime / dev it is a no-op wrapper, so leaving the
// import unconditional is safe and zero-cost.
//
// SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT are NEVER runtime envs —
// the .env.example marks them BUILD-TIME ONLY. Source-map upload happens
// only when all three are present.
// ---------------------------------------------------------------------------
import { withSentryConfig } from "@sentry/nextjs";

const SENTRY_BUILD_READY = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT,
);

export default SENTRY_BUILD_READY
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      widenClientFileUpload: true,
      tunnelRoute: "/monitoring",
      disableLogger: true,
      sourcemaps: { deleteSourcemapsAfterUpload: true },
    })
  : nextConfig;
