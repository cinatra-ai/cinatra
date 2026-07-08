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
// published package); this just hands off to it. (Plus ONE image-owned
// pre-step: schema-mutating subcommands first apply the image's baked
// schema-bootstrap DDL bundle — see the block below.)
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

// ── Image-mode schema bootstrap (cinatra#1136, prod deploy surface) ─────────
// The published CLI applies the checkout's schema-bootstrap DDL before the
// versioned core migration chain on DEV checkouts (cinatra-cli#115), but a
// standalone runtime image ships no TS source / tsx, so that pass skips there
// — and the prod deploy runs `setup prod` BEFORE the new image ever boots, so
// the chain would execute against the previous release's schema without the
// baseline it assumes (observed: core migration `LOCK TABLE nango_connection`
// → relation does not exist → deploy aborts). This image therefore bakes the
// SAME DDL pass as a self-contained bundle (scripts/schema-bootstrap.bundle.mjs,
// built from src/lib/drizzle-store.ts `buildCreateStoreSchemaQueries` — the
// exact boot baseline), and this entry runs it BEFORE handing any
// schema-mutating subcommand to the published CLI. Idempotent (CREATE … IF
// NOT EXISTS under the boot-side advisory lock), so a double-apply — the
// bundle here, then a future published CLI applying it again — is harmless.
//
// Fail-closed: a present-but-failing bundle aborts BEFORE the chain can abort
// mid-flight (the cinatra-cli#115 policy). An absent bundle or an unset
// SUPABASE_DB_URL forwards unchanged — the published CLI then reports its own
// canonical error, and boot remains the bootstrap authority elsewhere.
//
// Matching is deliberately NARROW: exactly `setup prod` and forward
// `db migrate` — the only invocations external deploy tooling routes through
// this entry (deploy-instance.sh, setup-prod-server.sh, the staging/coolify
// one-shots; see the header). A rollback (`db migrate --down`) must NOT
// pre-apply current-shape DDL the operator is unwinding, and every other
// setup/db/recovery subcommand (`setup dev`, `setup nango`, `db status`, …)
// forwards untouched (codex round-1 finding 3, round-2 finding 1). The bundle
// itself additionally skips FRESH schemas (first installs) — see its header.
const argvTail = process.argv.slice(2);
const subcommand = argvTail[0] === "instance" ? argvTail.slice(1) : argvTail;
const isSchemaMutating =
  (subcommand[0] === "setup" && subcommand[1] === "prod") ||
  (subcommand[0] === "db" && subcommand[1] === "migrate" && !subcommand.includes("--down"));
if (isSchemaMutating && process.env.SUPABASE_DB_URL) {
  const bundleCandidates = [
    "/app/scripts/schema-bootstrap.bundle.mjs",
    path.resolve(here, "../../../scripts/schema-bootstrap.bundle.mjs"),
  ];
  const bundle = bundleCandidates.find((p) => existsSync(p));
  if (bundle) {
    const ddl = spawnSync(process.execPath, [bundle], {
      cwd: existsSync("/app") ? "/app" : process.cwd(),
      stdio: "inherit",
    });
    if (ddl.error || ddl.status !== 0) {
      console.error(
        "cinatra (deploy-compat forwarder): schema bootstrap DDL failed — the versioned core " +
          "migration chain assumes this baseline, so setup stops here instead of aborting mid-chain." +
          (ddl.error ? ` Underlying error: ${ddl.error.message}` : ""),
      );
      process.exit(ddl.status ?? 1);
    }
  }
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
