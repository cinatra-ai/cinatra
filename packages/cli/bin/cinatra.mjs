#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// DEPLOY-COMPAT TRANSITION FORWARDER (cinatra#402 P2) — NOT the cinatra CLI.
//
// The developer/operator CLI was extracted out of this monorepo and now ships
// as the published `@cinatra-ai/cinatra` package; the prod image carries it at
// `/app/node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs` (see the Dockerfile
// runtime stage). This file exists ONLY so that the LEGACY invocation path that
// external deploy tooling (cinatra-ai/ops: deploy-instance.sh, the staging /
// coolify docker-compose `setup prod` one-shots, setup-{prod,demo}-server.sh)
// still hardcodes —
//
//     node /app/packages/cli/bin/cinatra.mjs setup prod
//     node packages/cli/bin/cinatra.mjs db migrate            (cwd=/app)
//
// — keeps working unchanged after the image switches CLI source. It is a thin
// forwarder that re-execs the published CLI with the original argv, so this is
// NOT a second copy of the CLI: there is exactly one CLI implementation (the
// published package); this just hands off to it.
//
// Removing this edge would create a hard cross-repo ordering dependency (the
// next prod deploy would break the instant the new image shipped if ops still
// pointed at the old path). The forwarder removes that coupling; ops migrates
// to the published-CLI path on its own cadence (cinatra-ai/ops PR), and a later
// cinatra release drops this shim once every deploy site has moved over.
//
// spawnSync (not a bare `import`) is used deliberately: it gives the published
// CLI its real argv[1], preserves the child's exit status, and makes the
// handoff explicit. cwd=/app makes getRepoRoot()'s checkout sentinel resolve
// (pnpm-workspace.yaml via the standalone trace + packages/migrations) exactly
// as a direct invocation would.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Prefer the canonical baked-image location; fall back to resolving the package
// relative to this file's node_modules so the shim is not hard-bound to /app.
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  "/app/node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs",
  path.resolve(here, "../../../node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs"),
];
const target = candidates.find((p) => existsSync(p));

if (!target) {
  console.error(
    "cinatra (deploy-compat forwarder): could not locate the published " +
      "@cinatra-ai/cinatra CLI at node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs. " +
      "This image is built to ship it; the install/COPY may be broken.",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  cwd: existsSync("/app") ? "/app" : process.cwd(),
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
