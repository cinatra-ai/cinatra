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
 *     with a `kernelProof`/`e2eProof`/`negativeControl` key present must have
 *     it FULLY populated — presence implies populated, by construction), every
 *     row missing a trackingIssue while red is a violation, every GREEN row
 *     carries a `negativeControl` (the RED half of its red-then-green pair —
 *     see below), and every referenced {file, testName} pair is grep-findable
 *     in the real tree (catches a stale reference: a renamed test, a deleted
 *     file). Does NOT prove a referenced test currently PASSES or runs in CI —
 *     that is strict mode's job.
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
 * HONEST DISCLOSURE — WHAT `--strict` DOES AND DOES NOT PROVE. Both findings
 * this header was originally written to disclose are now RESOLVED, and are
 * kept (resolved, dated) because they are the reason the constants below are
 * what they are:
 *   1. RESOLVED (#2209): `src/lib/__tests__/integration/
 *      org-write-archive-race.integration.test.ts` was invoked by NO workflow
 *      at all when this gate was authored — including the already-landed
 *      sibling two-connection-race test (#1939, merged with #2133). Its own
 *      header claimed it ran in `extension-lifecycle-db-tests`; that job
 *      existed but had no step running the file. #2209 added the step. Every
 *      row pointing at this file (ticket replay, delete-vs-completion,
 *      platform-admin, bounded-contention, and the sibling two-connection
 *      row) was structurally unable to go green until then.
 *   2. RESOLVED (#2209/#2211): GitHub Actions `needs:` is an INTRA-workflow-
 *      file edge only — it cannot express "job X in workflow A must complete
 *      before job Y in workflow B". Every row's ciDependency therefore has to
 *      name a job in the SAME file as this gate's own job, which is why
 *      SELF_WORKFLOW/SELF_JOB below are `build-image.yml` /
 *      `archive-acceptance-gate` and not `org-write-boundary-gate.yml` — a
 *      same-named-sounding but UNRELATED workflow (it enforces #1938's
 *      kernel-boundary / table-sweep / writer-manifest checks and has no
 *      `archive-acceptance-gate` job at all; the constants briefly pointed
 *      there by mistake after #2207 merged).
 *
 * STILL TRUE, and the honest limit of this gate: `--strict` proves that a
 * green row's referenced tests EXIST as live declarations, that the CI job it
 * names EXISTS, and that this gate's own job structurally `needs:` that job.
 * It does NOT execute those tests, and it cannot see whether the job actually
 * RUNS the file they live in — a step could be deleted from a job this gate
 * needs and every row would still verify. That residual is covered the only
 * way it can be: the referenced tests run in jobs whose failure is itself
 * blocking, so a deleted step shows up as a coverage drop in those jobs'
 * own logs rather than here.
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
 * Where the gate's OWN CI job lives, for `--strict` mode's `needs:` check.
 * See the header's "HONEST DISCLOSURE" #2 above: this is the real P1-CI
 * wiring target (cinatra#1943 P1-CI, #2209) — recorded here (not invented
 * per-call) so a future rename changes exactly one place, and so `--strict`
 * mode has a concrete target to check against even before that job exists in
 * `build-image.yml` (reporting "not wired yet" rather than silently
 * no-op'ing). NOT `org-write-boundary-gate.yml` / `org-write-boundary-gate`
 * — that is a same-named-sounding but unrelated workflow (#1938's
 * kernel-boundary gates); these constants briefly pointed there by mistake
 * after #2207 merged.
 */
export const SELF_WORKFLOW = "build-image.yml";
export const SELF_JOB = "archive-acceptance-gate";

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

/**
 * The RED half of each row's red-then-green pair (cinatra#1943's issue body:
 * "each its own RED-THEN-GREEN test").
 *
 * WHY THE GATE ENFORCES THIS AND NOT ONLY THE PROOF. Most rows of this
 * manifest assert that an attack LOSES. An assertion of that shape is silently
 * worthless when the attack could never have won: a purpose nothing grants, a
 * payload some OTHER layer already made unreachable, a lifecycle check
 * standing in front of a foreign key that was doing the work all along. Such
 * a test passes forever — including after the guard it claims to cover is
 * deleted. A green `kernelProof`/`e2eProof` therefore proves only half of what
 * the issue asks for.
 *
 * WHAT A CONTROL MUST BE: the counterpart run in which the OUTCOME INVERTS,
 * reached by removing the one guard under test rather than by changing the
 * attack. Two shapes, because the rows come in two shapes:
 *   - a row whose proof is a REFUSAL claim ("the forged authority is denied")
 *     pairs with a control where the SAME payload LANDS — issued outside the
 *     seam, evaluated by the shape-only check the brand replaced, or run in
 *     the lifecycle state where the guard's own predicate is false (for an
 *     archive-conditioned guard, an ACTIVE org);
 *   - a row whose proof is a SUCCESS claim ("the expired lease settles";
 *     "archive eventually succeeds under bounded contention") pairs with a
 *     control where the same operation is REFUSED — no held lease, a planted
 *     row the fence re-derives away, a continuously held fence — so the
 *     success is demonstrably conditional rather than unconditional.
 * What a control is NOT: a second refusal test of a different attack. Two
 * refusals do not falsify each other.
 *
 * Recorded per row (not in PR prose) for the same reason the proofs are: prose
 * rots and nobody re-verifies an already-checked box, while a manifest
 * reference is re-grep-verified on every CI run — so renaming, disabling or
 * deleting a control breaks this gate immediately instead of quietly leaving a
 * green row resting on an unfalsifiable claim.
 *
 * Required on GREEN rows only: a red row has no claim to falsify yet.
 */
const CONTROL_KIND = "negativeControl";

/** Everything whose {file, testName} must resolve to a live test declaration
 *  in the real tree — proofs AND the red-half controls. */
const REFERENCE_KINDS = [...PROOF_KINDS, CONTROL_KIND];

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

/**
 * Normalize a reference field to a list. A criterion that names TWO things
 * ("Direct BA-DML-vs-archive, BOTH lock interleavings") needs two proofs, and
 * a criterion naming a two-phase behaviour ("lease expiry → CANCEL-THEN-
 * SETTLE") needs a proof per phase — sometimes in different CI jobs. A single
 * scalar slot silently under-claims those rows: the manifest reads green while
 * half the criterion has no named proof at all. So every reference field (and
 * ciDependency) accepts either one object or an array of them; scalars stay
 * valid, so nothing already written has to change.
 */
export function asList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function validateProofShape(proof, label, errors) {
  if (proof === undefined) return;
  if (Array.isArray(proof)) {
    if (proof.length === 0) {
      errors.push(`${label}: an array form must name at least one {file, testName}`);
      return;
    }
    proof.forEach((entry, i) => validateProofShape(entry, `${label}[${i}]`, errors));
    // The array form exists so a two-part criterion can cite BOTH parts. The
    // same reference twice cites one part and looks like two — padding a row
    // to appear better-proven than it is, which is the exact dishonesty this
    // manifest is built to prevent.
    const seen = new Set();
    for (const entry of proof) {
      if (!entry || typeof entry !== "object") continue;
      const key = `${String(entry.file)}::${String(entry.testName)}`;
      if (seen.has(key)) errors.push(`${label}: duplicate reference (cited twice): ${key}`);
      seen.add(key);
    }
    return;
  }
  if (typeof proof !== "object" || proof === null) {
    errors.push(`${label}: must be an object (or an array of objects) when present`);
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
    const deps = asList(row?.ciDependency);
    if (typeof row?.ciDependency !== "object" || row.ciDependency === null || deps.length === 0) {
      errors.push(`${label}: "ciDependency" is required`);
    } else {
      const seenDeps = new Set();
      deps.forEach((dep, di) => {
        const dl = deps.length > 1 ? `${label}: ciDependency[${di}]` : `${label}: ciDependency`;
        if (typeof dep !== "object" || dep === null) {
          errors.push(`${dl} must be an object`);
          return;
        }
        if (!isNonEmptyString(dep.workflow)) errors.push(`${dl}.workflow must be a non-empty string`);
        if (!isNonEmptyString(dep.job)) errors.push(`${dl}.job must be a non-empty string`);
        // Same rule as duplicate proofs: citing one job twice makes a row look
        // like it spans two CI tiers when it spans one.
        const key = `${String(dep.workflow)}::${String(dep.job)}`;
        if (seenDeps.has(key)) errors.push(`${label}: duplicate ciDependency (cited twice): ${key}`);
        seenDeps.add(key);
      });
    }
    validateProofShape(row?.kernelProof, `${label}.kernelProof`, errors);
    validateProofShape(row?.e2eProof, `${label}.e2eProof`, errors);
    validateProofShape(row?.[CONTROL_KIND], `${label}.${CONTROL_KIND}`, errors);

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

    // The red-then-green rule (see CONTROL_KIND above): a row may not claim
    // green on a refusal proof alone. It must also name the control that
    // shows the same attack LANDS against the unprotected path — otherwise
    // the green claim is unfalsifiable and survives deletion of the guard.
    if (row?.status === "green" && !row?.[CONTROL_KIND]) {
      errors.push(
        `${label}: a green row must declare a ${CONTROL_KIND} — the RED half of its red-then-green pair ` +
          `(the test proving the same attack LANDS against the unprotected/mutated path)`,
      );
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
 * LIVE vitest test declaration (`it(`, `it.only(`, `it.each(`, `test(`, …)
 * and that line is not itself commented out — not merely mentioned in a
 * comment or unrelated string.
 *
 * Checks EVERY occurrence of the needle in the file (not just the first): a
 * real test declaration elsewhere in the file must not be missed just
 * because the needle happens to also appear earlier in an unrelated comment.
 * Excludes a line whose test-declaration token is itself commented out
 * (`// it("...")`).
 *
 * REJECTS `.skip`, `.todo` and `.fails`. A disabled test is not a proof:
 * `it.skip(...)` keeps the exact string this gate greps for while the
 * assertion never runs, which would let any row stay structurally green with
 * its proof — or its red-half control — quietly switched off. `it.fails(...)`
 * is worse still: it inverts the contract, so the row would stay green while
 * the suite asserted the OPPOSITE of the manifest's claim. All three are the
 * "green claim, no honest execution" class this gate exists to catch, each
 * reachable in one keystroke, so all three are refused.
 *
 * RESIDUAL, stated rather than papered over: this is a LINE scan, so an
 * ENCLOSING `describe.skip(...)` several lines above is invisible to it — the
 * declaration itself still reads live. A blanket "no describe.skip anywhere
 * in the file" rule would be wrong here (this suite's DB tier legitimately
 * uses `describe.skipIf(!enabled)` to self-skip without a database, which is
 * how the same file runs on a laptop and in the DB-backed CI job). Closing
 * the residual properly needs the runner's own collected-test report, not a
 * regex; until then the backstop is that these proofs live in jobs whose
 * failure blocks, so a wholesale skip shows up as a test-count drop there.
 */
export function isProofGrepFindable(fileContent, testName) {
  const needle = `"${testName}"`;
  let fromIndex = 0;
  for (;;) {
    const idx = fileContent.indexOf(needle, fromIndex);
    if (idx === -1) return false;
    const lineStart = fileContent.lastIndexOf("\n", idx) + 1;
    const beforeNeedleOnLine = fileContent.slice(lineStart, idx + needle.length);
    // `.skip`, `.todo` and `.fails` are deliberately ABSENT from this
    // alternation. `.skip`/`.todo` never run. `.fails` is worse than not
    // running: it INVERTS the contract — the test passes when its body
    // throws — so a proof or control switched to `it.fails("<the exact
    // manifest title>")` would keep this gate green while asserting the
    // opposite of what the manifest claims. All three are refused.
    const declRe = /\b(it|test)(?:\.only|\.concurrent|\.each|\.sequential)?\s*\(/;
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
  const entries = asList(proof);
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return; // shape validation already reported it
    const entryLabel = entries.length > 1 ? `${label}[${i}]` : label;
    let content;
    try {
      content = readFileImpl(join(repoRoot, entry.file));
    } catch {
      errors.push(`${entryLabel}: file not found: ${entry.file}`);
      return;
    }
    if (!isProofGrepFindable(content, entry.testName)) {
      errors.push(
        `${entryLabel}: testName not grep-findable as a LIVE test declaration in ${entry.file} ` +
          `(a .skip/.todo/.fails declaration is deliberately not accepted): ${JSON.stringify(entry.testName)}`,
      );
    }
  });
}

/**
 * Full audit-mode check: shape validation PLUS grep-findability of every
 * present proof reference against the real tree. Dependency-injected IO so
 * a test can drive a synthetic tree.
 */
export function auditManifest(manifest, { repoRoot = DEFAULT_REPO_ROOT, readFileImpl = (p) => readFileSync(p, "utf8") } = {}) {
  const errors = validateManifestShape(manifest);
  for (const row of manifest?.rows ?? []) {
    for (const kind of REFERENCE_KINDS) {
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
 * row must: re-pass every audit-mode reference check (both proof kinds AND
 * the red-half `negativeControl`), have its ciDependency job
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
  for (const kind of REFERENCE_KINDS) {
    checkProof(row[kind], kind, repoRoot, readFileImpl, reasons);
  }
  // EVERY named CI dependency must check out — a row whose proofs span two
  // jobs (cancel-then-settle: a unit-tier ordering proof plus a DB-tier settle
  // proof) is only as verified as its weakest edge.
  for (const dep of asList(row.ciDependency)) {
    if (!dep || typeof dep !== "object") continue; // shape validation reported it
    let targetWorkflowText;
    try {
      targetWorkflowText = readFileImpl(join(repoRoot, ".github", "workflows", dep.workflow));
    } catch {
      reasons.push(`ciDependency workflow not found: ${dep.workflow}`);
      continue;
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
      continue;
    }
    let selfWorkflowText;
    try {
      selfWorkflowText = readFileImpl(join(repoRoot, ".github", "workflows", SELF_WORKFLOW));
    } catch {
      reasons.push(`self workflow not found: ${SELF_WORKFLOW} (the coverage gate is not wired into CI yet)`);
      continue;
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
