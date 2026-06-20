#!/usr/bin/env node
/**
 * Require-signatures readiness preflight (eng#162 — the SDK-P0 trust-gate floor).
 *
 * The GO/NO-GO gate an operator runs BEFORE the owner arms
 * `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true` in production. It SIMULATES the
 * flip (`resolveSignatureVerdict(..., { required: true })`) over every LIVE
 * (active|locked) verdaccio install row, WITHOUT touching any env or any row, and
 * prints a `VERDICT: READY` / `VERDICT: NOT-READY` line — mirroring the ops
 * gatekept-install `scripts/cutover/gatekept-install/preflight.sh` ergonomics.
 *
 *   pnpm extensions:signature-readiness            # human-readable report + VERDICT
 *   pnpm extensions:signature-readiness --json     # machine-readable JSON result
 *
 * SAFE: read-only. NO writes, NO env mutation, NO secret-value I/O — it counts
 * trusted keys (presence only) and reads the public, already-persisted anchor
 * fields on each row. Requires SUPABASE_DB_URL + CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS
 * (read from .env.local via the package.json script's --env-file).
 *
 * EXIT: 0 = READY (every live install would still activate under require=true,
 * and ≥1 trusted key is configured); 1 = NOT-READY (one or more blockers, OR no
 * trusted keys); 2 = error (the assessment threw — treated as a hard NOT-READY,
 * fail-closed: we NEVER report READY on an incomplete scan).
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

// tsx is registered via the package.json script's --import flag so this .mjs can
// import the TS readiness module directly (it resolves @/ + @cinatra-ai/* aliases
// from tsconfig paths). The package.json script ALSO passes
// `--conditions=react-server` so the `server-only` marker (imported transitively
// by the readiness module + the canonical store) resolves to its empty no-op
// export instead of the Client-Component throw — without it this script fails at
// import time. Run via `pnpm extensions:signature-readiness`, never bare `node`.
const moduleUrl = pathToFileURL(resolve(process.cwd(), "src/lib/extension-signature-readiness.ts")).href;

let result;
try {
  const { assessSignatureReadiness } = await import(moduleUrl);
  result = await assessSignatureReadiness({
    // Stream NOT-READY rows to stderr as they are found (so a long scan shows
    // progress); the final report still lists them.
    log: (msg) => process.stderr.write(`${msg}\n`),
  });
} catch (e) {
  // Fail-closed: any throw (DB enumeration error, misconfig) is a hard NOT-READY.
  console.error(`[signature-readiness] assessment failed (treated as NOT-READY): ${e?.stack ?? e?.message ?? e}`);
  console.log("VERDICT: NOT-READY");
  process.exit(2);
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("");
  console.log("Require-signatures readiness preflight (eng#162)");
  console.log("------------------------------------------------");
  console.log(`trusted signing keys configured : ${result.trustedKeyCount}`);
  console.log(`live (active|locked) rows scanned: ${result.scanned}`);
  console.log(`  would still activate (READY)   : ${result.readyCount}`);
  console.log(`  would be DENIED (NOT-READY)    : ${result.notReadyCount}`);
  if (result.blockingReason === "no-trusted-keys") {
    console.log("");
    console.log("BLOCKER: no trusted signing keys configured");
    console.log("  Set CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS (base64 SPKI DER Ed25519,");
    console.log("  comma-separated) BEFORE arming require-signatures — with zero keys,");
    console.log("  every live install would be denied activation.");
  }
  const blockers = result.rows.filter((r) => !r.ready);
  if (blockers.length > 0) {
    console.log("");
    console.log("Blocking rows (re-sign / backfill / re-install before arming):");
    for (const r of blockers) {
      console.log(`  - ${r.packageName}@${r.version} [${r.verdict}] (${r.id})`);
      console.log(`      ${r.reason}`);
    }
  }
  console.log("");
  console.log(`VERDICT: ${result.ready ? "READY" : "NOT-READY"}`);
  if (result.ready) {
    console.log("  Every live install carries a verifying signature and ≥1 trusted key is");
    console.log("  configured. It is safe to arm CINATRA_EXTENSION_REQUIRE_SIGNATURES=true.");
  } else {
    console.log("  Do NOT arm CINATRA_EXTENSION_REQUIRE_SIGNATURES=true — resolve the blockers");
    console.log("  above (run the signature backfill at boot, or re-install the rows) and re-run.");
  }
}

process.exit(result.ready ? 0 : 1);
