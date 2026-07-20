#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Render-parity conformance runner (cinatra#1222, epic #1216 S6).
//
// One entry point for the render-parity gate's legs so a contributor (and the CI
// job) runs the exact same commands locally. NO paid-runner assumptions: every
// leg runs on a stock runner / a local checkout; the CMS-iframe leg is the only
// one needing the docker CMS+wayflow profile and is invoked separately (and only
// when host port 3010 is free — the wp-drupal-uat suite owns that stack).
//
// Usage:
//   node scripts/render-parity/run.mjs static      # deterministic per-PR leg (default)
//   node scripts/render-parity/run.mjs live        # gated live legs (needs the app)
//   node scripts/render-parity/run.mjs all
//
//   STATIC leg  — the DOM-normalized corpus compare + the three-target divergence
//                 ENGINE conformance + the AG-UI schema locks. Headless browser
//                 DOM only, no app server. This is the hard per-PR gate; it rides
//                 design-visual-verify.yml via the tests/e2e/design/conformance
//                 path (no .github edit).
//   LIVE leg    — the live `/chat` (target 1) + generic embedded view (target 2)
//                 render-parity, driven against a running app
//                 (E2E_AGENTS_RUN_BASE_URL, default http://localhost:3000). The
//                 embedded-view leg SELF-SKIPS with a documented reason until the
//                 /embed/assistant route lands. Gated (not per-PR).
//
// The CMS iframe leg (target 3) + the #1214 no-direct-egress assertion live in
// the wp-drupal-uat suite; run it with the docker profile up:
//   pnpm exec playwright test -c tests/e2e/config/wp-drupal-uat.config.ts
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "static";
const VALID = new Set(["static", "live", "all"]);
if (!VALID.has(mode)) {
  console.error(`render-parity: unknown mode "${mode}" — use one of: ${[...VALID].join(", ")}`);
  process.exit(2);
}

/** Run a playwright leg; returns its exit code. */
function pw(args, env = {}) {
  console.log(`\n▶ pnpm exec playwright test ${args.join(" ")}`);
  const res = spawnSync("pnpm", ["exec", "playwright", "test", ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return res.status ?? 1;
}

const legs = [];

if (mode === "static" || mode === "all") {
  // Deterministic corpus compare + three-target engine conformance + AG-UI
  // schema locks. E2E_REUSE_SERVER=1: these specs never navigate the app, so the
  // design config skips its web-server boot (nothing to serve).
  legs.push(() =>
    pw(
      [
        // The path filter must PRECEDE --project: playwright's --project greedily
        // consumes following positionals as additional project names.
        "tests/e2e/design/conformance/render-parity",
        "-c",
        "tests/e2e/config/design.config.ts",
        "--project",
        "design-conformance-functional",
      ],
      { E2E_REUSE_SERVER: "1" },
    ),
  );
}

if (mode === "live" || mode === "all") {
  // Live `/chat` (target 1) + embedded view (target 2). Needs the running app;
  // the embedded leg self-skips until /embed/assistant lands.
  legs.push(() =>
    pw([
      "-c",
      "tests/e2e/config/agents-run.config.ts",
      "--project",
      "chat-render-parity",
      "--project",
      "render-parity-cross-target",
    ]),
  );
}

let failed = 0;
for (const leg of legs) {
  const code = leg();
  if (code !== 0) failed = code;
}

if (failed !== 0) {
  console.error(`\n✗ render-parity (${mode}) FAILED (exit ${failed})`);
  process.exit(failed);
}
console.log(`\n✓ render-parity (${mode}) passed`);
