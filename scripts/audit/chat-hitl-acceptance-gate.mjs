#!/usr/bin/env node
/**
 * CHAT-HITL PROGRAM ACCEPTANCE GATE — the one entrypoint (cinatra#2573, epic
 * #2564 S7).
 *
 * WHAT THIS IS. S7's job is to prove the whole lifecycle-HITL program, and its
 * issue body is a list of SIXTEEN literal acceptance criteria. A prose checklist
 * rots silently — nobody re-verifies an already-ticked box — and this program
 * has learned that twice already (the org-write table sweep, the writer
 * manifest, and most recently the #1943 archive acceptance gate this file is
 * modelled on). So "#2573 is green" is a MECHANICAL claim: a manifest with one
 * row per literal criterion, each row pointing at a proof that exists where it
 * says it does.
 *
 * WHY IT MAPS RATHER THAN RE-AUTHORS. Twelve slices landed before this one and
 * each carries its own suite. Re-deriving those proofs here would double the
 * surface a future change must keep green, and a duplicate proof is worse than
 * no proof: when the two drift, neither is authoritative. So every row declares
 * a `disposition`:
 *
 *   MAPPED   the criterion is ALREADY fully proven by a landed slice's own test.
 *            The row names {file, testName} and this gate verifies that pair is
 *            grep-findable in the real tree — so a renamed or deleted test
 *            breaks S7's own check immediately.
 *   BUILT    the criterion had NO owner before S7. The proof is one of this
 *            slice's own artifacts and is named the same way.
 *   MISSING  the criterion is NOT proven, and the row says WHY in `gap`, with a
 *            `trackingIssue` where one exists. A MISSING row is an honest red —
 *            it is never a "covered by inspection" and never a silent pass.
 *
 * TWO MODES:
 *   `audit` (default) — the HONESTY check. Exactly 16 rows, one per literal
 *       criterion, pinned against CANONICAL_CRITERIA so a row can never drift
 *       from the issue's own wording; every row well-shaped for its disposition;
 *       every referenced {file, testName} pair actually present in the tree;
 *       every MISSING row carrying a `gap`; every non-MISSING row carrying at
 *       least one proof. Does NOT execute anything.
 *   `--strict` — the DONE check. Re-runs the whole shape validation, then
 *       requires every row to be MAPPED or BUILT. An all-red manifest is
 *       correctly reported NOT READY, never "clean" — conflating "no false green
 *       claim" with "done" would let a zero-progress manifest satisfy the one
 *       check whose entire purpose is proving the program finished.
 *
 * THE HONEST LIMIT, stated because a gate that overclaims is worse than none:
 * this verifies that a named proof EXISTS as a live declaration in the tree. It
 * does not execute it, and it cannot see whether CI runs the file it lives in.
 * The referenced suites are inside the root vitest include (or a pinned CI job),
 * so a deleted test shows up as a failure in that job's own run rather than
 * here; what THIS gate catches is the silent rename, the quiet deletion, and the
 * green claim with nothing behind it.
 *
 * Usage:
 *   node scripts/audit/chat-hitl-acceptance-gate.mjs            # audit
 *   node scripts/audit/chat-hitl-acceptance-gate.mjs --strict   # done-check
 *
 * Exit 0 -> clean; exit 1 -> at least one violation; exit 2 -> script error.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");
const LABEL = "chat-hitl-acceptance";

export const MANIFEST_PATH = join(__dirname, "chat-hitl-acceptance-manifest.json");

/** The valid dispositions. See the header for what each one claims. */
export const DISPOSITIONS = ["MAPPED", "BUILT", "MISSING"];

/**
 * The SIXTEEN literal criteria from cinatra#2573's issue body, in order and
 * verbatim (trimmed of the checkbox marker only). This is the canonical set the
 * manifest is pinned against, so a row can never silently drift from the issue's
 * own wording — a typo, an accidental duplicate, or a criterion quietly dropped
 * all fail `audit`.
 */
export const CANONICAL_CRITERIA = [
  // --- In-app (production-equivalent Playwright + unit) ---
  "Chat-dispatch → typed chip-row hold → confirm → artifact → review card renders island + capture pair → focused-composer comment → `changes_requested` → repair successor in the same chat → verification chip → approve → effects release.",
  "Path-2: background gate pulled into a chat → decided there; the review page gate region renders the same card component.",
  "Propose → Confirm → scheduled fire; no-fire-without-confirm; token replay + concurrent double-Confirm return the original run; drain crash/retry idempotence incl. arm-before-expose and due-during-drain.",
  "Late stream subscription + reload re-render (decided gate shows resolved state); multiple concurrent gates require explicit composer focus.",
  "Island renders build-map, runtime, and floor renderer classes; refuses cross-origin framing.",
  "Multi-target Comment semantics match the page exactly; same-fingerprint idempotent retry AND different-fingerprint conflict races (page vs card vs widget).",
  "Forged/replayed suggestion IDs rejected; persisted refusal payloads contain no lifecycle identifiers (assert on `assistant_turns.content`).",
  // --- Widget ---
  "A signed-in reviewer decides a CMS review end-to-end from a real WP/Drupal widget: captures load via signed same-origin URLs; the decision travels from the widget review card into the same decision module; fingerprint/audit identical to in-app.",
  "The widget renders and operates the full lifecycle card set identically to first-party chat — same components, same human decisions, and the same audit contract; the authenticated principal is derived from the validated widget session and cannot be selected or overridden by the embedding site.",
  "Revocation-after-emission matrix: link/site/membership/token revoked between DATA_PART emission and stream resume / card refetch / decision / capture GET — each fails closed (no DOM, refusal, 4xx).",
  "Wrong-audience and cross-gate/cross-site action capabilities are refused; copied/expired/revoked capture URLs fail.",
  "Carrier-run exclusion proven: a widget content-editor carrier run emits no recommendation hold and no trigger interaction; the surface-matrix conformance test fails if any lifecycle interaction kind appears on a broker surface outside the matrix.",
  "`/embed/assistant` renders captures with NO island and refuses a nested island by ancestry.",
  // --- Program-wide ---
  "EXACTLY ONE card implementation per interaction across /chat, embed/widget, run card, and the review gate region — the parallel renderers (redirect card, panel chip-row mount, review-page direct composition) are gone (grep-gated).",
  "Conformance vs the S0 spec matrix (per surface, per card, per state) on a production-equivalent build with recorded screenshots.",
  "Production-boundary retirement identity greps stay zero (exact-identity constructions); the stale trigger-agent fixtures are gone.",
];

/** Proof kinds a row may carry. A row needs at least one unless it is MISSING. */
export const PROOF_KINDS = ["unitProofs", "integrationProofs", "e2eProofs", "gateProofs"];

function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/**
 * Is `{file, testName}` findable in the tree? For a test file, the name must
 * appear as a literal inside it (the repo's tests name themselves in
 * `it("…")` / `describe("…")`). For a GATE proof the `testName` is the gate's
 * own success label or an exported symbol, which is the same lexical check.
 *
 * Deliberately a substring match rather than a parse: the repo's test titles
 * carry template pieces (`` `${name} is refused…` ``) that no regex over source
 * can reconstruct, and a stricter check would reject honest rows. What this
 * catches is the case that actually happens — the file was renamed, or the test
 * was deleted.
 */
export function proofExists(proof, repoRoot = DEFAULT_REPO_ROOT, readFileImpl = null) {
  const abs = resolve(repoRoot, proof.file);
  let source;
  try {
    source = readFileImpl ? readFileImpl(proof.file) : readFileSync(abs, "utf8");
  } catch {
    return { ok: false, reason: `file not found: ${proof.file}` };
  }
  if (!source.includes(proof.testName)) {
    return { ok: false, reason: `no "${proof.testName}" in ${proof.file}` };
  }
  return { ok: true };
}

/** Every proof a row declares, flattened with its kind. */
export function proofsOf(row) {
  const out = [];
  for (const kind of PROOF_KINDS) {
    for (const p of row[kind] ?? []) out.push({ kind, ...p });
  }
  return out;
}

/**
 * Validate the manifest's SHAPE and its references. Pure over injected IO so the
 * pinned tests drive the same validator CI runs.
 */
export function auditManifest({
  manifest = loadManifest(),
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = null,
} = {}) {
  const violations = [];
  const rows = manifest.rows ?? [];

  if (rows.length !== CANONICAL_CRITERIA.length) {
    violations.push(
      `the manifest has ${rows.length} rows; cinatra#2573's issue body has ${CANONICAL_CRITERIA.length} criteria`,
    );
  }

  const seen = new Set();
  rows.forEach((row, i) => {
    const where = `row ${i + 1}`;
    if (typeof row.criterion !== "string") {
      violations.push(`${where}: no criterion`);
      return;
    }
    if (seen.has(row.criterion)) violations.push(`${where}: duplicate criterion`);
    seen.add(row.criterion);
    if (!CANONICAL_CRITERIA.includes(row.criterion)) {
      violations.push(
        `${where}: criterion is not one of the issue's literal criteria — it reads\n      ${row.criterion}`,
      );
    }
    if (CANONICAL_CRITERIA[i] !== row.criterion) {
      violations.push(`${where}: out of order — expected\n      ${CANONICAL_CRITERIA[i]}`);
    }
    if (!DISPOSITIONS.includes(row.disposition)) {
      violations.push(`${where}: disposition "${row.disposition}" is not one of ${DISPOSITIONS.join("/")}`);
      return;
    }

    const proofs = proofsOf(row);
    if (row.disposition === "MISSING") {
      if (!row.gap || row.gap.length < 20) {
        violations.push(`${where}: MISSING rows must say WHY, in \`gap\` (a real sentence)`);
      }
    } else if (proofs.length === 0) {
      violations.push(`${where}: ${row.disposition} with no proof — name one`);
    }
    // EVERY declared proof is verified, on EVERY disposition. A MISSING row
    // routinely carries the proofs of the clauses that ARE met (a criterion is
    // often part-proven), and a stale reference inside one of those is exactly
    // as misleading as a stale reference on a green row.
    for (const p of proofs) {
      if (!p.file || !p.testName) {
        violations.push(`${where}: a ${p.kind} entry is missing file/testName`);
        continue;
      }
      const found = proofExists(p, repoRoot, readFileImpl);
      if (!found.ok) violations.push(`${where}: ${found.reason}`);
    }

    // A partially-proven criterion is a real and common state; it must be
    // declared rather than rounded up. `partial` carries what is NOT covered.
    if (row.partial && (!row.gap || row.gap.length < 20)) {
      violations.push(`${where}: \`partial\` set without a \`gap\` sentence saying what is uncovered`);
    }
  });

  return violations;
}

/** Strict mode: shape + every row proven. */
export function strictReport({ manifest = loadManifest(), ...rest } = {}) {
  const violations = auditManifest({ manifest, ...rest });
  const rows = manifest.rows ?? [];
  const unproven = rows.filter((r) => r.disposition === "MISSING");
  const partial = rows.filter((r) => r.disposition !== "MISSING" && r.partial);
  return { violations, unproven, partial, total: rows.length };
}

function summarise(rows) {
  const counts = { MAPPED: 0, BUILT: 0, MISSING: 0 };
  for (const r of rows) counts[r.disposition] = (counts[r.disposition] ?? 0) + 1;
  return counts;
}

function main(argv) {
  const strict = argv.includes("--strict");
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`[${LABEL}] manifest not found at ${MANIFEST_PATH}`);
    return 2;
  }
  const manifest = loadManifest();
  const rows = manifest.rows ?? [];
  const counts = summarise(rows);

  if (!strict) {
    const violations = auditManifest({ manifest });
    if (violations.length === 0) {
      console.log(
        `[${LABEL}] manifest honest — ${rows.length} rows ` +
          `(${counts.MAPPED} MAPPED, ${counts.BUILT} BUILT, ${counts.MISSING} MISSING); ` +
          "every named proof exists in the tree.",
      );
      return 0;
    }
    console.error(`[${LABEL}] ${violations.length} manifest violation(s):\n`);
    for (const v of violations) console.error(`  ${v}`);
    return 1;
  }

  const { violations, unproven, partial, total } = strictReport({ manifest });
  if (violations.length > 0) {
    console.error(`[${LABEL}] --strict: the manifest is malformed before it can be judged:\n`);
    for (const v of violations) console.error(`  ${v}`);
    return 1;
  }
  if (unproven.length > 0 || partial.length > 0) {
    console.error(
      `[${LABEL}] NOT READY — ${total - unproven.length}/${total} criteria proven, ` +
        `${unproven.length} MISSING, ${partial.length} partial:\n`,
    );
    for (const r of unproven) console.error(`  MISSING  ${r.criterion}\n           gap: ${r.gap}`);
    for (const r of partial) console.error(`  PARTIAL  ${r.criterion}\n           gap: ${r.gap}`);
    return 1;
  }
  console.log(`[${LABEL}] READY — ${total}/${total} criteria proven, none partial.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`[${LABEL}] fatal:`, e);
    process.exit(2);
  }
}
