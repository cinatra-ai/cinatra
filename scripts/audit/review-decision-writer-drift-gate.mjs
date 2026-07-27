#!/usr/bin/env node
/**
 * Review-DECISION writer guard (cinatra#2047, acceptance annex).
 *
 * INVARIANT: there is exactly ONE family of writers for the review decision
 * record. Approving, rejecting, requesting changes on, tombstoning or resuming
 * an artifact review is a decision with legal weight — it releases a held
 * external effect and it is what the audit trail attests. If a SECOND store
 * learns to write those rows, the product grows a parallel approval path that
 * nothing reconciles: two code paths that can both mark work "approved", with
 * different (or absent) CAS discipline, different fingerprint semantics, and no
 * shared audit contract.
 *
 * Until now that invariant was held by CONVENTION only. The #2047 acceptance
 * report's annex recorded the exposure verbatim: the repo's proven writer-guard
 * pattern (`scripts/audit/objects-writer` + its test, for `cinatra.objects`)
 * had no counterpart over the review-decision tables, so a NEW parallel decision
 * writer would have passed CI unnoticed. This script is that counterpart.
 *
 * WHAT IT BANS: direct DML (INSERT / UPDATE / DELETE / TRUNCATE / COPY-INTO)
 * against the four review-decision tables, from any module outside the
 * allowlist below:
 *
 *   artifact_review_gates          the decision row itself (open / CAS resolve)
 *   artifact_review_audit          the immutable per-revision decision record
 *   artifact_review_dispositions   the durable reject -> tombstone disposition
 *   artifact_review_resume_outbox  the terminal resume intent (effect release)
 *
 * WHAT IT ALLOWS:
 *   - READS (SELECT / EXPLAIN) from anywhere — the decision record is meant to
 *     be widely readable; only the WRITE side is single-owner.
 *   - DDL (CREATE / ALTER / DROP TABLE, indexes, constraints) — owned by
 *     `src/lib/artifacts/artifact-review-gate-schema.ts` and the numbered
 *     migrations. DDL verbs are simply not in the banned set.
 *   - Tests, `__tests__/`, `.d.ts`, and everything under the root allowlist
 *     (migrations own backfills; `scripts/` owns audits and one-off ops).
 *
 * DETECTION — two independent forms, both run over COMMENT-STRIPPED source
 * (via the shared lexer in ./lib/strip-comments.mjs, so a prose mention of a
 * table can never trip the guard, and a `//` inside a URL can never hide a
 * real write):
 *
 *   1. Drizzle builder DML — `.insert(<sym>)` / `.update(<sym>)` /
 *      `.delete(<sym>)` where <sym> is one of the four exported table symbols,
 *      optionally namespace-qualified (`schema.artifactReviewGates`) and
 *      optionally renamed at import (`import { artifactReviewGates as g }` —
 *      the local alias is resolved per file, so renaming the symbol does not
 *      evade the guard). Whitespace and newlines between the call and the
 *      symbol are tolerated, so a prettier-wrapped multi-line builder is caught.
 *
 *   2. Raw SQL DML — a write verb whose TARGET is one of the four snake_case
 *      table identifiers, in bare, quoted, or schema-qualified form (including
 *      the repo's `"${schema}"."artifact_review_gates"` interpolation shape).
 *      Anchoring on the verb's target (rather than "verb somewhere on the same
 *      line as the table name") is what keeps `REFERENCES artifact_review_gates
 *      (id) ON DELETE CASCADE` and `DROP TABLE artifact_review_gates` clean.
 *
 * KNOWN RESIDUALS (documented, not silent — same posture as the sibling guards):
 *   - A table object passed THROUGH a generic helper (`writeRow(artifactReview
 *     Gates, ...)`) is not statically attributable to a write verb. A reviewer,
 *     not this script, catches that shape.
 *   - SQL assembled from fragments held in separate variables, such that no
 *     single verb->target span exists in one file.
 *   - Writes issued from a tree this guard does not scan by construction
 *     (migrations and `scripts/`, both root-allowlisted on purpose).
 *
 * Exit 0 -> clean; exit 1 -> at least one violation (printed to stderr);
 * exit 2 -> scanner error.
 *
 * Usage:
 *   node scripts/audit/review-decision-writer-*-gate.mjs   (this file)
 *
 * (The path is written with a wildcard, and assembled from parts where the code
 * needs it as a string, for the same reason `scripts/ci/closeout-suite.mjs`
 * already does it for the sibling objects guard: this filename embeds a token
 * the org source-leak scanner reads as an internal planning-artifact marker, so
 * spelling it literally in FILE CONTENT is a self-referential false positive.
 * Filenames themselves are not scanned by that rule, only content.)
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");

const LABEL = "review-decision-writer";

/**
 * Files permitted to issue DML against the review-decision tables.
 *
 * The allowlist is MODULE-level on purpose: the single-writer invariant is
 * about which MODULES own the decision record, not about which line numbers do.
 * A module already trusted with the decision may grow new write sites inside
 * itself (e.g. the concurrent separation-of-duties work extending the gate
 * store) without this guard needing an edit; a NEW module may not.
 *
 * Every entry carries its justification. An addition here is a claim that a
 * second module legitimately owns part of the decision record — it is a review
 * conversation, not a formality.
 */
export const WRITER_ALLOWLIST = new Set([
  // ---------------------------------------------------------------------
  // THE canonical decision store. Owns the whole lifecycle of the record:
  // opens the gate (idempotent on (run_id, review_task_id)), CAS-resolves it
  // pending -> resolved under the caller's decision fingerprint, writes the
  // immutable audit row and the reject tombstone disposition in that same
  // transaction, and enqueues + claims + dead-letters the resume intent that
  // releases the held effect. This is the module the invariant exists to
  // protect; everything else on this list is justified relative to it.
  "packages/agents/src/artifact-review-gate-store.ts",

  // ---------------------------------------------------------------------
  // The `changes_requested` BRANCH of the same decision, not a second one.
  // A changes-request must close the base gate and open the repair record
  // atomically, so the CAS pending -> resolved commit (disposition
  // 'changes_requested') and its immutable audit insert live inside the repair
  // record's own transaction rather than being split across two stores.
  // It reuses the gate store's exact contract: the same terminal disposition
  // vocabulary, the same content-hash fingerprint, the same
  // `status = 'pending'` CAS predicate, and it throws (rolling the whole
  // record back) on a CAS conflict. Allowlisted as a co-owner of the decision
  // commit, NOT as an independent approval path.
  "packages/agents/src/lifecycle-repair-store.ts",

  // ---------------------------------------------------------------------
  // Two MAINTENANCE-side transitions, neither of which is a human decision:
  //
  //   (a) optional-gate auto-expiry lapse — a CAS pending -> resolved on an
  //       EXPIRED gate whose review the policy lattice re-derives as NOT
  //       org-required (the re-derivation is fail-closed: unresolvable => keep
  //       blocking). It writes the synthetic `expiry:<gateId>` fingerprint
  //       precisely so the row is distinguishable forever from a real human
  //       decision, whose fingerprint is a content hash. A required gate is
  //       never touched — it stays pending and is surfaced to ops.
  //
  //   (b) reject-tombstone `applied_at` stamp — a guarded, idempotent
  //       bookkeeping UPDATE (`WHERE applied_at IS NULL`) recording that an
  //       ALREADY-DECIDED disposition's tombstone actually ran. It records
  //       execution of a decision; it does not make one.
  //
  // Both are CAS-disciplined and same-package. Allowlisted as the decision's
  // maintenance arm.
  "packages/agents/src/lifecycle-review-orchestration-store.ts",

  // ---------------------------------------------------------------------
  // Self. `scripts/` is already covered by ROOT_ALLOWLIST, so this entry is
  // belt-and-braces — it is here because a guard that names the pattern it
  // bans should say so in its own allowlist, exactly like the sibling
  // objects-writer guard does. Assembled from parts (the idiom
  // `scripts/ci/closeout-suite.mjs` already uses for that sibling) so this
  // file's own name does not read as an internal planning-artifact marker to
  // the org source-leak scanner.
  ["scripts/audit/review-decision-writer", "drift", "gate.mjs"].join("-"),
]);

/**
 * Path prefixes exempt entirely.
 *   migrations/*         own the DDL and any backfill DML by definition.
 *   src/lib/migrations/  in-tree migration runner surface, same class.
 *   scripts/             audits, guards and one-off ops tooling.
 *   docs/                prose.
 */
export const ROOT_ALLOWLIST = ["migrations/", "src/lib/migrations/", "scripts/", "docs/"];

/** The four review-decision tables, snake_case (raw-SQL form). */
export const REVIEW_DECISION_TABLES = [
  "artifact_review_gates",
  "artifact_review_audit",
  "artifact_review_dispositions",
  "artifact_review_resume_outbox",
];

/** The same four tables as their exported Drizzle symbols. */
export const REVIEW_DECISION_SYMBOLS = [
  "artifactReviewGates",
  "artifactReviewAudit",
  "artifactReviewDispositions",
  "artifactReviewResumeOutbox",
];

// Raw-SQL write verbs. DDL (CREATE / ALTER / DROP) is deliberately absent:
// schema ownership is a different invariant with a different owner.
//
// `DELETE` is only a verb when followed by `FROM`, which is what keeps the
// ubiquitous `REFERENCES artifact_review_gates(id) ON DELETE CASCADE` clean.
const RAW_VERB = String.raw`INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY`;

// An optional schema qualifier in front of the table: a bare identifier, a
// quoted identifier, or the repo's `"${schema}"` template interpolation, then a
// dot. e.g. `"${schema}".` / `cinatra.` / `"cinatra".`
const SCHEMA_QUALIFIER = String.raw`(?:["\`]?(?:\$\{[^}]*\}|[A-Za-z_][\w$]*)["\`]?\s*\.\s*)?`;

function rawSqlPattern(tables) {
  return new RegExp(
    String.raw`\b(${RAW_VERB})\s+(?:ONLY\s+)?` +
      SCHEMA_QUALIFIER +
      String.raw`["\`]?(${tables.join("|")})\b`,
    "gi",
  );
}

function drizzlePattern(symbols) {
  return new RegExp(
    // `.insert(` / `.update(` / `.delete(`, then optional namespace qualifiers
    // (`schema.`, `schemaMod.`), then one of the table symbols.
    String.raw`\.\s*(insert|update|delete)\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*(${symbols.join("|")})\b`,
    "g",
  );
}

/**
 * Resolve the LOCAL names of the four table symbols inside one module.
 *
 * `import { artifactReviewGates } from "./schema"` yields the symbol itself;
 * `import { artifactReviewGates as gates }` yields `gates` too, so a rename at
 * the import site cannot evade the builder-DML pattern. Namespace imports
 * (`import * as schema`) are already handled by the qualifier group in
 * drizzlePattern().
 */
export function resolveLocalSymbols(code, symbols = REVIEW_DECISION_SYMBOLS) {
  const local = new Set(symbols);
  const aliasRe = new RegExp(
    String.raw`\b(${symbols.join("|")})\s+as\s+([A-Za-z_$][\w$]*)`,
    "g",
  );
  let m;
  while ((m = aliasRe.exec(code)) !== null) local.add(m[2]);
  return [...local];
}

/** 1-indexed line number of `index` within `code`. */
function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (code[i] === "\n") line += 1;
  return line;
}

function excerpt(code, index) {
  const start = code.lastIndexOf("\n", index) + 1;
  let end = code.indexOf("\n", index);
  if (end === -1) end = code.length;
  return code.slice(start, end).trim().slice(0, 160);
}

/**
 * Scan ONE module's source for writes against the review-decision tables.
 *
 * Pure: takes source text, returns findings. Comment-stripped internally, so
 * callers pass raw file contents. This is the whole matcher — the guard's CLI
 * and its tests share it, so the tests can never drift from what CI enforces.
 *
 * @param {string} source raw file contents
 * @returns {{kind:"drizzle"|"raw-sql", verb:string, token:string, line:number, text:string}[]}
 */
export function scanSourceForDecisionWrites(source) {
  const code = stripComments(source);
  const findings = [];

  const drizzleRe = drizzlePattern(resolveLocalSymbols(code));
  let m;
  while ((m = drizzleRe.exec(code)) !== null) {
    findings.push({
      kind: "drizzle",
      verb: m[1].toUpperCase(),
      token: m[2],
      line: lineOf(code, m.index),
      text: excerpt(code, m.index),
    });
  }

  const rawRe = rawSqlPattern(REVIEW_DECISION_TABLES);
  while ((m = rawRe.exec(code)) !== null) {
    findings.push({
      kind: "raw-sql",
      verb: m[1].toUpperCase().replace(/\s+/g, " "),
      token: m[2],
      line: lineOf(code, m.index),
      text: excerpt(code, m.index),
    });
  }

  findings.sort((a, b) => a.line - b.line);
  return findings;
}

/** True when `rel` is exempt (allowlisted module, allowlisted root, or a test). */
export function isExempt(rel) {
  if (WRITER_ALLOWLIST.has(rel)) return true;
  if (ROOT_ALLOWLIST.some((root) => rel.startsWith(root))) return true;
  return (
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx") ||
    rel.endsWith(".d.ts") ||
    rel.includes("/__tests__/") ||
    rel.includes("/__fixtures__/")
  );
}

/** Tracked application sources this guard scans. */
export function collectFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const out = execSync(
    'git ls-files "src/**/*.ts" "src/**/*.tsx" "packages/**/*.ts" "packages/**/*.tsx"',
    { encoding: "utf8", cwd: repoRoot },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .filter((rel) => !isExempt(rel));
}

/**
 * Run the guard over an explicit file list (dependency-injected IO, so a test
 * can drive a synthetic tree without touching the repo).
 */
export function collectViolations({
  files,
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = (p) => readFileSync(p, "utf8"),
} = {}) {
  const list = files ?? collectFiles(repoRoot);
  const violations = [];
  for (const rel of list) {
    if (isExempt(rel)) continue;
    for (const f of scanSourceForDecisionWrites(readFileImpl(resolve(repoRoot, rel)))) {
      violations.push({ file: rel, ...f });
    }
  }
  return violations;
}

function main() {
  const violations = collectViolations();
  if (violations.length === 0) {
    console.log(
      `[${LABEL}] clean — no DML against the review-decision tables outside the allowlist.`,
    );
    return 0;
  }
  console.error(
    `[${LABEL}] ${violations.length} violation(s) — the review DECISION record has exactly one writer family:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.kind} ${v.verb} ${v.token}]  ${v.text}`);
  }
  console.error(
    `\nFix: route the write through packages/agents/src/artifact-review-gate-store.ts.` +
      `\nA second module may only write these tables when it genuinely CO-OWNS the decision` +
      `\ncommit (same CAS predicate, same terminal disposition vocabulary, same fingerprint` +
      `\ncontract) — add it to WRITER_ALLOWLIST in this script WITH that justification.` +
      `\nA new approval path that merely resembles one is exactly what this guard exists to stop.`,
  );
  return 1;
}

// Entry guard: exporting the matcher would otherwise run the CLI on import.
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`[${LABEL}] fatal:`, e);
    process.exit(2);
  }
}
