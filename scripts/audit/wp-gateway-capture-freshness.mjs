#!/usr/bin/env node
// ---------------------------------------------------------------------------
// wp-gateway-capture-freshness — the anti-staleness gate for the committed
// WP-MCP-gateway captures (issue #2016, S1, design §3).
//
// A PURELY-OFFLINE check (no boot, no download). For every committed capture
// under tests/e2e/wp-mcp-gateway/captures/ that carries a `provenance` block, it
// RECOMPUTES the recorded hashes from the CURRENT tree and FAILS if any drifts:
//
//   pinsLockSha256      sha256(docker/wordpress/pins.lock)
//   fixturePluginSha256 tree-sha256(docker/wordpress/fixture-plugin/)
//   producerSha256      sha256(tests/e2e/wp-mcp-gateway/capture-annotations.mjs)
//   apiMapSha256        sha256(.../captures/adapter-0.5.0-api-map.json)
//   equivalenceSha256   sha256(.../equivalence.spec.ts)   [checked when present]
//
// Effect: touch the pins, the fixture plugin, a capture producer, or the api-map
// and the recomputed hash diverges from the committed transcript's — so a stale
// capture can no longer keep PR CI green; a fresh capture run must re-write the
// transcripts before merge. This is the merge-safety teeth dispatch-only capture
// lacked (codex MAJOR-1/MAJOR-2). The hashing is SHARED verbatim with the
// producer (tests/e2e/wp-mcp-gateway/provenance.mjs), so gate and producer can
// never disagree about what a hash means.
//
// SCOPE: it does NOT assert the captures are semantically correct (that is the
// offline vitest beside raw-mcp-exposure.test.ts) — only that they are FRESH vs
// the substrate they were captured against.
//
// WIRING: runs inside build-image.yml's required `perpetual-loops-invariants`
// audit job (inherits required-ness with no branch-protection change), right
// beside the pin-integrity gate. It no-ops cleanly (exit 0) when there are no
// provenanced captures yet (pre-C4) or on unrelated PRs, so nothing else slows.
//
// Zero runtime dependencies beyond node: builtins + the shared provenance helper
// — no `pnpm install`, like the sibling audit gates.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeProvenanceHashes,
  PROVENANCE_INPUTS,
  CANONICAL_PROVENANCE_KEYS,
} from "../../tests/e2e/wp-mcp-gateway/provenance.mjs";

const REPO_ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAPTURES_REL = "tests/e2e/wp-mcp-gateway/captures";
const HASH_KEYS = Object.keys(PROVENANCE_INPUTS); // the recognised provenance hash keys
const SHA256_RE = /^[0-9a-f]{64}$/;
// Captures that must additionally carry equivalenceSha256 (they are captured
// against the live equivalence suite, so an equivalence.spec.ts edit must force
// a fresh verdict capture rather than being silently droppable).
const EQUIVALENCE_REQUIRED = new Set(["verify-verdicts.json"]);
// The ONLY capture allowed to omit a provenance block: the upstream api-map is
// a captured third-party artifact, and ITS integrity is pinned by apiMapSha256
// inside every produced capture's provenance. Everything else MUST carry a
// block — a capture without one is otherwise INVISIBLE to this gate (the
// drop-the-block bypass).
const PROVENANCE_EXEMPT = new Set(["adapter-0.5.0-api-map.json"]);

/**
 * Recompute the provenance hashes from `root` and compare every provenanced
 * capture's recorded hashes to them. Returns { ok, errors, skipped, checked }.
 * Never throws for a content problem (only surfaces unreadable JSON as an error).
 *
 * @param {string} root Repo root.
 */
export function checkFreshness(root = REPO_ROOT_DEFAULT) {
  const errors = [];
  const capturesDir = path.join(root, CAPTURES_REL);
  if (!existsSync(capturesDir)) {
    return { ok: true, errors, skipped: true, checked: 0 };
  }

  // Discover committed capture JSONs that declare a `provenance` block.
  const provenanced = [];
  for (const name of readdirSync(capturesDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const abs = path.join(capturesDir, name);
    let json;
    try {
      json = JSON.parse(readFileSync(abs, "utf8"));
    } catch (e) {
      errors.push(`${CAPTURES_REL}/${name}: not valid JSON — ${e.message}`);
      continue;
    }
    if (json && typeof json === "object" && json.provenance && typeof json.provenance === "object") {
      provenanced.push({ name, provenance: json.provenance });
    } else if (!PROVENANCE_EXEMPT.has(name)) {
      errors.push(
        `${CAPTURES_REL}/${name}: missing provenance block — a committed capture without one is invisible to this gate. ` +
          `Every produced capture must carry provenance; only ${[...PROVENANCE_EXEMPT].join(", ")} (upstream artifact) is exempt.`,
      );
    }
  }

  if (provenanced.length === 0) {
    // No captures with provenance yet (pre-C4) — nothing to keep fresh.
    return { ok: errors.length === 0, errors, skipped: errors.length === 0, checked: 0 };
  }

  const current = computeProvenanceHashes(root);

  for (const { name, provenance } of provenanced) {
    // Every provenanced capture MUST carry the full canonical hash set (valid
    // 64-hex). The gate only COMPARES the keys a capture declares, so without
    // this presence check a stale capture could be hidden by simply deleting the
    // one key that drifted (e.g. edit pins.lock, then drop pinsLockSha256 from
    // every provenance block) — the gate would then have nothing to compare and
    // stay green. Requiring the canonical set closes that false-negative and
    // enforces the design §3 provenance shape (codex round-1 BLOCKER).
    const missingCanonical = CANONICAL_PROVENANCE_KEYS.filter(
      (k) => !(typeof provenance[k] === "string" && SHA256_RE.test(provenance[k])),
    );
    if (missingCanonical.length > 0) {
      errors.push(
        `${CAPTURES_REL}/${name}: provenance is missing or invalid for required canonical hash(es): ${missingCanonical.join(", ")}. ` +
          `Every committed capture must carry the full canonical provenance set (${CANONICAL_PROVENANCE_KEYS.join(", ")}) so drift cannot be hidden by dropping a key.`,
      );
    }
    if (
      EQUIVALENCE_REQUIRED.has(name) &&
      !(typeof provenance.equivalenceSha256 === "string" && SHA256_RE.test(provenance.equivalenceSha256))
    ) {
      errors.push(
        `${CAPTURES_REL}/${name}: must carry equivalenceSha256 (it is captured against equivalence.spec.ts) so an equivalence-suite edit forces a fresh verdict capture.`,
      );
    }

    const declared = HASH_KEYS.filter((k) => typeof provenance[k] === "string" && provenance[k].length > 0);
    if (declared.length === 0) {
      errors.push(
        `${CAPTURES_REL}/${name}: provenance block declares none of the recognised hash keys (${HASH_KEYS.join(", ")})`,
      );
      continue;
    }
    for (const key of declared) {
      const want = provenance[key];
      const got = current[key];
      if (got == null) {
        errors.push(
          `${CAPTURES_REL}/${name}: provenance.${key} recorded but its input (${PROVENANCE_INPUTS[key].rel}) is now MISSING — re-run the capture workflow.`,
        );
      } else if (got !== want) {
        errors.push(
          `${CAPTURES_REL}/${name}: STALE — provenance.${key} = ${want} but the current ${PROVENANCE_INPUTS[key].rel} hashes to ${got}. ` +
            `A pins/fixture/producer/api-map change was committed WITHOUT re-capturing. Re-run wp-mcp-gateway-capture.yml on this branch and commit the refreshed captures.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, skipped: false, checked: provenanced.length };
}

// CLI entry: run against WP_CAPTURE_FRESHNESS_ROOT (default repo root).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = process.env.WP_CAPTURE_FRESHNESS_ROOT || REPO_ROOT_DEFAULT;
  const { ok, errors, skipped, checked } = checkFreshness(root);
  if (skipped) {
    console.log(`wp-gateway-capture-freshness: no provenanced captures under ${CAPTURES_REL} — nothing to check (pre-capture / unrelated PR).`);
    process.exit(0);
  }
  if (ok) {
    console.log(`wp-gateway-capture-freshness: OK — ${checked} committed capture(s) are fresh vs the current pins / fixture plugin / producers / api-map.`);
    process.exit(0);
  }
  console.error("wp-gateway-capture-freshness: FAILED\n");
  for (const err of errors) console.error(`  - ${err}`);
  console.error(`\nFix: re-run .github/workflows/wp-mcp-gateway-capture.yml on this branch (it re-fires on any substrate change), download the captures artifact, and commit the refreshed transcripts.`);
  process.exit(1);
}
