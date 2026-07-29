#!/usr/bin/env node
/**
 * Archive adversarial acceptance coverage-completeness gate — cinatra#1943
 * (A0 — Decision 1).
 *
 * WHY THIS EXISTS. #1943's job is to prove the whole archive/organization-
 * lifecycle program is safe under adversarial contention. A prose checklist
 * in the issue body rots silently (nobody re-verifies an already-checked
 * box) — this program has already learned that lesson twice
 * (org-write-table-sweep, the writer manifest). This gate makes "#1943 is
 * green" a MECHANICAL, re-verified-every-run claim instead of a one-time
 * assertion: a machine-checked manifest of the 15 literal criteria in
 * #1943's issue body, each pointing at either a #1943-owned test or a named
 * SIBLING slice's own test (never re-authored/duplicated — see Decision 0 in
 * .claude/scratch/a-1943/DESIGN.md for why re-deriving every sibling's
 * acceptance test from scratch would be the wrong shape for this suite).
 *
 * NOT a scanned-surface manifest (contrast system-writer-manifest-gate.mjs's
 * scanSource matcher) — the 15 rows are enumerated criteria from a fixed
 * issue body, not code the gate discovers by walking the tree. So this is a
 * simpler TOTAL-TABLE check: is the table well-formed, and does every claimed
 * proof actually exist where it says it does.
 *
 * TWO MODES:
 *   - `audit` (default) — the HONESTY check, runs on every PR touching the
 *     manifest: exactly 15 rows, one per literal criterion (no duplicates, no
 *     drift from the canonical set below), every row shaped correctly (a row
 *     with a `kernelProof`/`e2eProof` key present must have it FULLY
 *     populated — presence implies populated, by construction), every row
 *     missing a trackingIssue while red is a violation, and every referenced
 *     {file, testName} pair is grep-findable in the real tree (catches a
 *     stale reference: a renamed test, a deleted file). Does NOT prove a
 *     referenced test currently PASSES or runs in CI — that is strict mode's
 *     job.
 *   - `--strict` — the actual V6-precondition check (v-1942 Decision 10):
 *     re-runs full shape validation (a malformed manifest cannot slip past
 *     strict mode just because nothing happens to be green yet), THEN
 *     requires EVERY one of the 15 rows to be "green" AND, for each, that
 *     re-verifying audit's proof-existence checks passes, the row's
 *     ciDependency job exists in its named workflow file, AND the
 *     coverage-gate's OWN job (SELF_WORKFLOW/SELF_JOB below) structurally
 *     `needs:` that job — a parsed GitHub Actions job-graph edge, not a
 *     hand-maintained "last-known-good" marker. A sibling renaming or
 *     skipping their referenced test breaks #1943's own required check
 *     immediately. IMPORTANT: strict mode's pass condition is "all 15 rows
 *     green and verified" — NOT merely "no green claim was found false." A
 *     manifest where every row is honestly red (this PR's own state) is
 *     correctly reported NOT READY, never "clean" — conflating those two
 *     would let an all-red, zero-progress manifest silently satisfy a check
 *     whose entire purpose is proving #1943 is DONE.
 *
 * HONEST DISCLOSURE (read before trusting a `--strict` run today): as of
 * this PR (#1943 A0), the coverage gate itself is NOT wired into ANY CI job
 * — that wiring is `.github/workflows/**`, which is ALWAYS its own
 * always-human-gated follow-up PR per the design's Decision 6, never bundled
 * into a content PR. Every row therefore reports NOT READY under `--strict`
 * right now — that is the CORRECT, expected state, not a bug in this
 * script. Two further findings surfaced while grounding this gate,
 * left here for whoever wires the follow-up:
 *   1. `src/lib/__tests__/integration/org-write-archive-race.integration.test.ts`
 *      — including the ALREADY-LANDED sibling two-connection-race test
 *      (#1939, merged with #2133) — is not invoked by ANY workflow today
 *      (verified: `grep -rl "org-write-archive-race" .github/workflows/`
 *      finds nothing). Its own header comment says it runs in the
 *      `extension-lifecycle-db-tests` job of `build-image.yml`; that job
 *      exists but does not yet have a step running this file. Several rows
 *      here (ticket replay, delete-vs-completion, platform-admin,
 *      bounded-contention, and the sibling two-connection row) all point at
 *      this file and cannot reach `--strict` green until that step is added.
 *   2. GitHub Actions `needs:` is an INTRA-workflow-file edge only — it
 *      cannot express "job X in workflow A must complete before job Y in
 *      workflow B". Several rows here (the two above under
 *      `extension-lifecycle-db-tests`, plus the root-vitest-suite rows under
 *      `perpetual-loops-invariants`/`test`) name jobs that live in
 *      `build-image.yml`, a DIFFERENT file from where Decision 1 originally
 *      proposed wiring the gate step (`org-write-boundary-gate.yml`). If the
 *      gate step is wired there, EVERY row pointing at a `build-image.yml`
 *      job will be structurally unable to satisfy `--strict` no matter how
 *      green the underlying test is. The likely correct fix (left for the
 *      P1-CI follow-up, a `.github/workflows` edit, out of scope here): add
 *      the coverage-gate step as a job INSIDE `build-image.yml` itself
 *      (alongside the jobs it depends on), not `org-write-boundary-gate.yml`.
 *      `--strict` mode below reports this exact mismatch per-row rather than
 *      silently mis-reporting a false pass or an uninformative fail.
 *
 * Usage:
 *   node scripts/audit/archive-acceptance-gate.mjs            # audit mode (default)
 *   node scripts/audit/archive-acceptance-gate.mjs --strict   # strict mode
 *
 * Exit 0 -> clean; exit 1 -> at least one violation; exit 2 -> script error.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");

const LABEL = "archive-acceptance-gate";
export const MANIFEST_PATH = join(__dirname, "archive-acceptance-manifest.json");

/**
 * Where Decision 1 designates the gate's OWN CI job to live, for `--strict`
 * mode's `needs:` check. See the header's "HONEST DISCLOSURE" #2 above: this
 * is provisional until the P1-CI follow-up actually wires a job — recorded
 * here (not invented per-call) so a future wiring PR changes exactly one
 * place, and so `--strict` mode has a concrete target to check against even
 * before that PR exists (reporting "not wired yet" rather than silently
 * no-op'ing).
 */
export const SELF_WORKFLOW = "org-write-boundary-gate.yml";
export const SELF_JOB = "org-write-boundary-gate";

/**
 * The 15 literal criteria from #1943's issue body (GROUNDING.md §4 /
 * DESIGN.md Table A) — the canonical reference set `audit` mode pins the
 * manifest against, so a row can never silently drift from the issue's own
 * wording (typo, accidental duplicate, or a criterion quietly dropped).
 */
export const CANONICAL_CRITERIA = [
  "Forged/ambient run identity refused",
  "Stale-attempt lease reuse denied",
  "Ticket replay + unarchive/re-archive epoch invalidation",
  "Delete-vs-completion race",
  "Platform-admin denial",
  "Unclassified job fails closed",
  "Two-connection post-predicate-check archive race (write loses)",
  "Cross-job capability misuse",
  "Pre-archive parent spawning post-archive child denied",
  "Lease expiry mid-completion → cancel-then-settle",
  "Archive-vs-terminal-CAS race",
  "Direct BA-DML-vs-archive, both lock interleavings",
  "Dual-transport coverage",
  "BOUNDED, deterministic eventual-successful-archive under contention (a fixed retry ceiling, not an unbounded spin)",
  "3-role live Playwright proof (owner archives/unarchives; admin/member read-only; non-member 404) on a production-equivalent build",
];

/** The one criterion whose issue-body language implies BOTH a kernel-level
 *  and a live/product-level proof (Decision 1's D5 AND-rule): a kernel
 *  stand-in alone may never claim this row fully green. Every other row
 *  needs only whichever proof kind it has. */
const REQUIRES_BOTH_PROOF_KINDS =
  "BOUNDED, deterministic eventual-successful-archive under contention (a fixed retry ceiling, not an unbounded spin)";

const PROOF_KINDS = ["kernelProof", "e2eProof"];

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

export function loadManifest(repoRoot = DEFAULT_REPO_ROOT, readFileImpl = (p) => readFileSync(p, "utf8")) {
  const path = repoRoot === DEFAULT_REPO_ROOT ? MANIFEST_PATH : join(repoRoot, "scripts", "audit", "archive-acceptance-manifest.json");
  return JSON.parse(readFileImpl(path));
}

// ---------------------------------------------------------------------------
// Shape validation (audit mode's core) — a pure function over a manifest
// object, dependency-free (no IO) so it is trivial to unit test.
// ---------------------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function validateProofShape(proof, label, errors) {
  if (proof === undefined) return;
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) {
    errors.push(`${label}: must be an object when present`);
    return;
  }
  if (!isNonEmptyString(proof.file)) errors.push(`${label}: "file" must be a non-empty string`);
  if (!isNonEmptyString(proof.testName)) errors.push(`${label}: "testName" must be a non-empty string`);
}

/**
 * Pure structural validation: exactly 15 rows, one per CANONICAL_CRITERIA
 * entry (no duplicates, no drift), every row shaped correctly. Returns a
 * flat list of human-readable error strings (empty = valid). Takes no IO —
 * this never touches the filesystem, so a test can drive arbitrary
 * synthetic manifests without a real tree.
 */
export function validateManifestShape(manifest) {
  const errors = [];
  const rows = Array.isArray(manifest?.rows) ? manifest.rows : null;
  if (!rows) {
    errors.push('manifest must have a "rows" array');
    return errors;
  }

  if (rows.length !== CANONICAL_CRITERIA.length) {
    errors.push(`expected exactly ${CANONICAL_CRITERIA.length} rows, found ${rows.length}`);
  }

  const seenCriteria = new Map(); // criterion -> occurrence count
  for (const row of rows) {
    if (isNonEmptyString(row?.criterion)) {
      seenCriteria.set(row.criterion, (seenCriteria.get(row.criterion) ?? 0) + 1);
    }
  }
  for (const [criterion, count] of seenCriteria) {
    if (count > 1) errors.push(`duplicate criterion (x${count}): ${JSON.stringify(criterion)}`);
  }
  const canonicalSet = new Set(CANONICAL_CRITERIA);
  for (const criterion of seenCriteria.keys()) {
    if (!canonicalSet.has(criterion)) {
      errors.push(`criterion not in the canonical 15 (issue-body drift?): ${JSON.stringify(criterion)}`);
    }
  }
  for (const criterion of CANONICAL_CRITERIA) {
    if (!seenCriteria.has(criterion)) {
      errors.push(`missing a row for criterion: ${JSON.stringify(criterion)}`);
    }
  }

  rows.forEach((row, i) => {
    const label = `row[${i}] (${row?.criterion ?? "?"})`;
    if (!isNonEmptyString(row?.criterion)) errors.push(`${label}: "criterion" must be a non-empty string`);
    if (row?.owner !== "self" && row?.owner !== "sibling") {
      errors.push(`${label}: "owner" must be "self" or "sibling"`);
    }
    if (row?.status !== "red" && row?.status !== "green") {
      errors.push(`${label}: "status" must be "red" or "green"`);
    }
    if (typeof row?.ciDependency !== "object" || row.ciDependency === null) {
      errors.push(`${label}: "ciDependency" is required`);
    } else {
      if (!isNonEmptyString(row.ciDependency.workflow)) errors.push(`${label}: ciDependency.workflow must be a non-empty string`);
      if (!isNonEmptyString(row.ciDependency.job)) errors.push(`${label}: ciDependency.job must be a non-empty string`);
    }
    validateProofShape(row?.kernelProof, `${label}.kernelProof`, errors);
    validateProofShape(row?.e2eProof, `${label}.e2eProof`, errors);

    if (row?.status === "red" && row?.trackingIssue === undefined) {
      errors.push(`${label}: a red row must carry a trackingIssue (no unowned red row)`);
    }
    if (row?.trackingIssue !== undefined && !(Number.isInteger(row.trackingIssue) && row.trackingIssue > 0)) {
      errors.push(`${label}: trackingIssue must be a positive integer when present`);
    }

    // Decision 1's AND-rule (D5): the one row whose criterion implies BOTH
    // proof kinds may only read green once BOTH are populated.
    if (row?.criterion === REQUIRES_BOTH_PROOF_KINDS && row?.status === "green") {
      if (!row.kernelProof || !row.e2eProof) {
        errors.push(`${label}: requires BOTH kernelProof and e2eProof populated before status may be "green" (Decision 1 D5)`);
      }
    }

    // A green row must have AT LEAST ONE populated proof — a row with NO
    // kernelProof and NO e2eProof cannot legitimately be green (there would
    // be nothing to point at). validateProofShape only checks a proof's
    // INTERNAL shape when one is present; this catches the row entirely
    // missing one, a distinct violation from D5's "both required" rule above
    // (which only applies to the one bounded-contention row).
    if (row?.status === "green" && !row?.kernelProof && !row?.e2eProof) {
      errors.push(`${label}: a green row must have at least one of kernelProof/e2eProof populated`);
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Grep-findability — the "does the referenced proof still exist" honesty
// check. Deliberately a plain substring check (no comment-stripping lexer):
// this gate enumerates hand-authored criteria, not scanned code, so the
// false-positive surface a lexer guards against elsewhere doesn't apply the
// same way here — a long, specific, sentence-shaped test title colliding
// with unrelated prose is not a realistic risk.
// ---------------------------------------------------------------------------

/**
 * True when `testName` appears, double-quoted, on a line that ALSO opens a
 * vitest test declaration (`it(`, `it.only(`, `it.skip(`, `it.each(`,
 * `test(`, …) and that line is not itself commented out — not merely
 * mentioned in a comment or unrelated string.
 *
 * Checks EVERY occurrence of the needle in the file (not just the first): a
 * real test declaration elsewhere in the file must not be missed just
 * because the needle happens to also appear earlier in an unrelated
 * comment. Also
 * excludes a line whose test-declaration token is itself commented out
 * (`// it("...")`) — a disabled test must not count as a live proof, which
 * is exactly the "excluded from its CI job" staleness class this gate exists
 * to catch.
 */
export function isProofGrepFindable(fileContent, testName) {
  const needle = `"${testName}"`;
  let fromIndex = 0;
  for (;;) {
    const idx = fileContent.indexOf(needle, fromIndex);
    if (idx === -1) return false;
    const lineStart = fileContent.lastIndexOf("\n", idx) + 1;
    const beforeNeedleOnLine = fileContent.slice(lineStart, idx + needle.length);
    const declRe = /\b(it|test)(?:\.only|\.skip|\.concurrent|\.each)?\s*\(/;
    const declMatch = declRe.exec(beforeNeedleOnLine);
    if (declMatch) {
      // Reject if the declaration token itself sits after a `//` line-comment
      // marker (a disabled test) on this line.
      const commentIdx = beforeNeedleOnLine.indexOf("//");
      if (commentIdx === -1 || commentIdx > declMatch.index) {
        return true;
      }
    }
    fromIndex = idx + needle.length;
  }
}

function checkProof(proof, label, repoRoot, readFileImpl, errors) {
  if (!proof) return;
  let content;
  try {
    content = readFileImpl(join(repoRoot, proof.file));
  } catch {
    errors.push(`${label}: file not found: ${proof.file}`);
    return;
  }
  if (!isProofGrepFindable(content, proof.testName)) {
    errors.push(`${label}: testName not grep-findable as a test declaration in ${proof.file}: ${JSON.stringify(proof.testName)}`);
  }
}

/**
 * Full audit-mode check: shape validation PLUS grep-findability of every
 * present proof reference against the real tree. Dependency-injected IO so
 * a test can drive a synthetic tree.
 */
export function auditManifest(manifest, { repoRoot = DEFAULT_REPO_ROOT, readFileImpl = (p) => readFileSync(p, "utf8") } = {}) {
  const errors = validateManifestShape(manifest);
  for (const row of manifest?.rows ?? []) {
    for (const kind of PROOF_KINDS) {
      checkProof(row[kind], `${row.criterion} (${kind})`, repoRoot, readFileImpl, errors);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Strict mode — GitHub Actions workflow YAML parsing (hand-rolled, no YAML
// library; matches this repo's established convention for workflow-touching
// gates — see actions-pinned-gate.mjs, which for the same "keep a
// supply-chain-adjacent gate dependency-free" reason also hand-rolls a
// line-based parser rather than pulling in `yaml`/`js-yaml`). Handles the
// three `needs:` shapes GitHub Actions accepts: scalar, flow array, and
// block list.
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract job `<jobId>`'s YAML block (its header line through the line
 *  before the next top-level `  <otherJob>:` key, or EOF). `null` if the job
 *  doesn't exist. Assumes the conventional 2-space job-id indent this repo's
 *  workflows use throughout (verified against every workflow read while
 *  building this gate). */
export function extractJobBlock(workflowText, jobId) {
  const lines = workflowText.split("\n");
  const jobHeaderRe = new RegExp(`^  ${escapeRegExp(jobId)}:\\s*$`);
  const anyTopJobRe = /^  [A-Za-z0-9_.-]+:\s*$/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (jobHeaderRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyTopJobRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function stripYamlQuotes(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a job block's `needs:` array in any of the three GitHub Actions
 * shapes (scalar / flow array / block list). `[]` when absent.
 *
 * Only matches `needs:` at the job's OWN body indent — the block's first
 * line is the job header (`  <jobId>:`, 2 spaces); its direct fields (steps,
 * needs, runs-on, …) sit at exactly 2 spaces deeper (4 total). A `needs:`
 * appearing at any OTHER (deeper) indent is inside a step, a `run: |`
 * heredoc body, or similar — content, not the job-level field — and must
 * NOT be silently parsed as this job's dependency edge.
 */
export function extractNeeds(jobBlock) {
  if (!jobBlock) return [];
  const lines = jobBlock.split("\n");
  const headerIndentMatch = lines[0]?.match(/^(\s*)/);
  const jobBodyIndent = (headerIndentMatch?.[1].length ?? 0) + 2;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)needs:\s*(.*?)\s*(#.*)?$/);
    if (!m) continue;
    const indent = m[1].length;
    if (indent !== jobBodyIndent) continue;
    const rest = m[2];
    if (rest === "") {
      // Block-list form: subsequent, MORE-indented "- name" lines.
      const out = [];
      for (let j = i + 1; j < lines.length; j++) {
        const itemMatch = lines[j].match(/^(\s*)-\s*(.+?)\s*(#.*)?$/);
        if (!itemMatch || itemMatch[1].length <= indent) break;
        out.push(stripYamlQuotes(itemMatch[2]));
      }
      return out;
    }
    if (rest.startsWith("[")) {
      const inner = rest.replace(/^\[/, "").replace(/\]$/, "");
      return inner
        .split(",")
        .map((s) => stripYamlQuotes(s))
        .filter((s) => s.length > 0);
    }
    return [stripYamlQuotes(rest)];
  }
  return [];
}

/**
 * Strict-mode verdict for ONE row. A row not claimed "green" trivially
 * passes (nothing to verify yet — the honest red-baseline state). A "green"
 * row must: re-pass every audit-mode proof check, have its ciDependency job
 * actually exist in its named workflow, AND have the coverage-gate's OWN job
 * (SELF_WORKFLOW/SELF_JOB) `needs:` that job — cross-workflow references are
 * flagged explicitly rather than silently treated as satisfied (GitHub
 * Actions `needs:` cannot cross workflow files; see the header's "HONEST
 * DISCLOSURE" #2).
 */
export function strictCheckRow(row, { repoRoot = DEFAULT_REPO_ROOT, readFileImpl = (p) => readFileSync(p, "utf8") } = {}) {
  const reasons = [];
  if (row.status !== "green") {
    return { ok: true, reasons: [] };
  }
  for (const kind of PROOF_KINDS) {
    checkProof(row[kind], kind, repoRoot, readFileImpl, reasons);
  }
  const dep = row.ciDependency ?? {};
  let targetWorkflowText;
  try {
    targetWorkflowText = readFileImpl(join(repoRoot, ".github", "workflows", dep.workflow));
  } catch {
    reasons.push(`ciDependency workflow not found: ${dep.workflow}`);
    return { ok: false, reasons };
  }
  if (!extractJobBlock(targetWorkflowText, dep.job)) {
    reasons.push(`ciDependency job "${dep.job}" not found in ${dep.workflow}`);
  }
  if (dep.workflow !== SELF_WORKFLOW) {
    reasons.push(
      `cross-workflow: the coverage-gate's own job is expected in ${SELF_WORKFLOW}, but this row's proof is enforced in ${dep.workflow} — ` +
        `a needs: edge cannot cross workflow files in GitHub Actions, so this row is structurally unable to satisfy strict mode until the ` +
        `gate step is relocated into ${dep.workflow} (or an equivalent same-file job).`,
    );
  } else {
    let selfWorkflowText;
    try {
      selfWorkflowText = readFileImpl(join(repoRoot, ".github", "workflows", SELF_WORKFLOW));
    } catch {
      reasons.push(`self workflow not found: ${SELF_WORKFLOW} (the coverage gate is not wired into CI yet)`);
      return { ok: false, reasons };
    }
    const selfBlock = extractJobBlock(selfWorkflowText, SELF_JOB);
    if (!selfBlock) {
      reasons.push(`self job "${SELF_JOB}" not found in ${SELF_WORKFLOW} — the coverage gate is not wired into CI yet (expected pre-P1-CI)`);
    } else if (!extractNeeds(selfBlock).includes(dep.job)) {
      reasons.push(`the coverage-gate's own job "${SELF_JOB}" does not needs: "${dep.job}" yet`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function strictCheckManifest(manifest, opts = {}) {
  const results = [];
  for (const row of manifest?.rows ?? []) {
    results.push({ criterion: row.criterion, ...strictCheckRow(row, opts) });
  }
  return results;
}

/**
 * The FULL strict-mode verdict — this is what v-1942 Decision 10's V6
 * precondition actually means: not merely "no false green claim was found"
 * (which is trivially true when nothing is green yet), but "every one of the
 * 15 rows is green AND structurally verified." Re-runs shape validation too
 * (a malformed manifest must not slip past strict mode just because no row
 * happens to be marked green).
 */
export function strictVerdict(manifest, opts = {}) {
  const shapeErrors = validateManifestShape(manifest);
  const rowResults = strictCheckManifest(manifest, opts);
  const rowFailures = rowResults.filter((r) => !r.ok);
  const notYetGreen = (manifest?.rows ?? []).filter((r) => r.status !== "green").map((r) => r.criterion);
  const ready = shapeErrors.length === 0 && rowFailures.length === 0 && notYetGreen.length === 0;
  return { ready, shapeErrors, rowFailures, notYetGreen };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv = process.argv.slice(2)) {
  const strict = argv.includes("--strict");
  const manifest = loadManifest();

  if (!strict) {
    const errors = auditManifest(manifest);
    if (errors.length === 0) {
      console.log(`[${LABEL}] audit: clean — ${manifest.rows.length} row(s), all well-formed and grep-findable where a proof is claimed.`);
      return 0;
    }
    console.error(`[${LABEL}] audit: ${errors.length} violation(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  // Strict mode's TRUE pass condition is "all 15 rows green and verified" —
  // the literal V6 precondition (v-1942 Decision 10), never "0 rows claimed
  // green so there was nothing to falsify." Reporting this pre-condition
  // honestly (as red, with an explicit count) rather than a misleadingly
  // reassuring "clean" is the whole point of having two modes.
  const { ready, shapeErrors, rowFailures, notYetGreen } = strictVerdict(manifest);
  const greenCount = manifest.rows.length - notYetGreen.length;
  if (ready) {
    console.log(`[${LABEL}] strict: READY — all ${manifest.rows.length}/${manifest.rows.length} row(s) green and structurally verified. #1943 is the V6 precondition, satisfied.`);
    return 0;
  }
  console.error(`[${LABEL}] strict: NOT READY (${greenCount}/${manifest.rows.length} row(s) currently green):`);
  if (shapeErrors.length > 0) {
    console.error(`  ${shapeErrors.length} manifest shape violation(s):`);
    for (const e of shapeErrors) console.error(`    - ${e}`);
  }
  if (rowFailures.length > 0) {
    console.error(`  ${rowFailures.length} green row(s) failed structural verification:`);
    for (const r of rowFailures) {
      console.error(`    - ${r.criterion}:`);
      for (const reason of r.reasons) console.error(`        ${reason}`);
    }
  }
  if (notYetGreen.length > 0) {
    console.error(`  ${notYetGreen.length} row(s) not yet green (expected pre-V6 — see the manifest's own trackingIssue per row):`);
    for (const c of notYetGreen) console.error(`    - ${c}`);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`[${LABEL}] fatal:`, e);
    process.exit(2);
  }
}
