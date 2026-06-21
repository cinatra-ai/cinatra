import type { NextConfig } from "next";

// ---------------------------------------------------------------------------
// Required environment variables — fail fast at server startup.
// ---------------------------------------------------------------------------
const REQUIRED_ENV: string[] = [
  // NOTE: OPENAI_API_KEY is intentionally NOT required here. The Next.js app
  // never reads it (provider config is in-app via /setup/ai; the var only powers
  // the Graphiti objects container, which gets it from docker-compose's
  // `${OPENAI_API_KEY:-}` and tolerates it being unset). Requiring it at app
  // boot crashed fresh `make setup && make dev` (the copied .env.example ships
  // it empty) for no functional reason. See .env.example for when to set it.
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
    // @modelcontextprotocol/* packages are ESM-only with vendored sub-chunks and transitive
    // deps (@cfworker/json-schema etc.) that are not in root node_modules. Keeping them
    // external lets Node.js resolve them from packages/mcp-server/node_modules at runtime
    // instead of Turbopack trying (and failing) to bundle the vendored dist files.
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/node",
    "@modelcontextprotocol/express",
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
    ];
  },
  async redirects() {
    return [
      {
        source: "/campaign-types",
        destination: "/agents/run",
        permanent: false,
      },
      {
        source: "/campaign-types/:path*",
        destination: "/agents/run",
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
      // — Approvals consolidation. The standalone /approvals page
      // and /configuration/agents/approvals index are retired in favor of
      // the unified /configuration/approvals tabbed page. Detail pages at
      // /configuration/agents/approvals/[id] keep their path unchanged.
      {
        source: "/approvals",
        destination: "/configuration/approvals?tab=workflows",
        permanent: true,
      },
      {
        source: "/configuration/agents/approvals",
        destination: "/configuration/approvals?tab=agents",
        permanent: true,
      },
      // Reciprocal: the alternative new-location detail path. We kept the
      // existing path, so anyone arriving via the new-shape URL gets routed
      // to the canonical detail page.
      {
        source: "/configuration/approvals/agents/:id",
        destination: "/configuration/agents/approvals/:id",
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
