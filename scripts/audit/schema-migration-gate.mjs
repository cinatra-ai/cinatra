#!/usr/bin/env node
"use strict";

// Core-store schema migration gate.
//
// Fails a PR that makes a DESTRUCTIVE change to the first-party core store
// schema — the hand-mirrored DDL in `buildCreateStoreSchemaQueries` and the
// Drizzle table definitions in `createStoreTables` (src/lib/drizzle-store.ts)
// — without shipping the migration artifact the convention in
// migrations/README.md requires: a node-pg-migrate runner module at
// `migrations/core/core__NNNN_short-description.mjs` PLUS its appended
// `migrations/manifest.json` entry, in the same PR. (The legacy psql artifact
// form `migrations/NNNN_*.sql` is retired for NEW migrations — the runner
// never executes it; shipped legacy artifacts remain append-only history.)
//
// What it does, per PR diff:
//   1. DETECT  — does the diff touch the in-scope schema regions of
//      src/lib/drizzle-store.ts? Changes anywhere else in that file (the
//      runtime DML query builders) and in any other file are ignored.
//      Better Auth schema files and the extension migration DSL/runner are
//      explicitly out of scope (owned elsewhere — see migrations/README.md)
//      and are reported as ignored even when bundled in the same PR.
//   2. CLASSIFY — destructive (user-land data affected: drops, renames,
//      retypes, NOT NULL on existing tables, tightened constraints, unique
//      indexes on existing tables, FK ON DELETE changes, data rewrites)
//      vs additive (new table, new nullable column, non-unique index).
//      Each rule maps 1:1 to a bullet in migrations/README.md. The labelled
//      fixture corpus at scripts/audit/__fixtures__/schema-migration/ is the
//      executable contract: the companion test runs this gate against every
//      fixture and asserts its labelled pass/fail outcome.
//   3. GATE   — exit non-zero when the change is destructive AND the same
//      diff ships no complete migration artifact, OR when the diff tampers
//      with SHIPPED migration state regardless of schema changes (deleting /
//      renaming / editing a shipped artifact, rewriting a manifest entry, or
//      adding a migrations/core/ file that would brick the runner's boot
//      preflight). Additive changes and destructive changes accompanied by
//      their artifact pass.
//
// Classification bias: the destructive rules encode the convention's
// ENUMERATED destructive list; an in-scope change matching no rule is
// additive by default (printed as a notice). When the convention gains a new
// destructive case, add a labelled fixture AND a rule in the same PR — the
// corpus is the contract.
//
// Modes:
//   node scripts/audit/schema-migration-gate.mjs
//     git mode (CI/local): diffs SCHEMA_MIGRATION_BASE (default origin/main,
//     merge-base anchored) against HEAD.
//   node scripts/audit/schema-migration-gate.mjs --diff-file <path>
//     classifies a unified-diff file whose base is the CURRENT working tree
//     (the fixture corpus applies cleanly to the tree — the companion test
//     asserts that before trusting this mode).
//
// Modeled on the existing parity gate pattern (the Better Auth schema-drift
// job): a scripts/audit check that exits non-zero with an actionable message.
//
// SECURITY: every git invocation uses execFileSync (no shell) and fixed
// argv; the only user-controlled input is the diff text being classified.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Scope constants (mirrors migrations/README.md "Scope")
// ---------------------------------------------------------------------------

export const IN_SCOPE_FILE = "src/lib/drizzle-store.ts";

/**
 * Out of scope per the convention — ignored even when in the same PR.
 * (The retired extension JSON-DSL files — extension-migration-dsl/runner —
 * were deleted in #118; the extension migration host is host wiring, not
 * executed core-store DDL.)
 */
export const OUT_OF_SCOPE_FILES = new Set([
  "src/lib/better-auth-schema.ts",
  "src/lib/better-auth-plugins.ts",
  "scripts/better-auth-migrate.mts",
  "src/lib/extension-migration-host.ts",
]);

export const MIGRATION_MANIFEST_PATH = "migrations/manifest.json";
/** Legacy hand-apply artifacts (psql). Shipped history only — retired for NEW migrations. */
export const MIGRATION_SQL_RE = /^migrations\/(\d{4})_([a-z0-9][a-z0-9-]*)\.sql$/;
/**
 * Runner-module artifacts (node-pg-migrate, cinatra#116): the artifact form a
 * NEW destructive change must ship. The `core__` prefix is the per-source
 * ledger namespace (#115). Capture group 1 = the NNNN sequence number.
 * Mirrors CORE_MIGRATION_FILE_RE in packages/migrations/src/core-migrations.mjs.
 */
export const MIGRATION_MODULE_RE = /^migrations\/core\/core__(\d{4})_([a-z0-9][a-z0-9-]*)\.mjs$/;

/** The two schema regions of drizzle-store.ts that are in scope. */
const REGION_STARTS = [
  { name: "createStoreTables", re: /^(?:export\s+)?function\s+createStoreTables\s*\(/, kind: "drizzle-defs" },
  { name: "buildCreateStoreSchemaQueries", re: /^(?:export\s+)?function\s+buildCreateStoreSchemaQueries\s*\(/, kind: "executed-ddl" },
];

// ---------------------------------------------------------------------------
// Unified-diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into per-file structures.
 * @param {string} diffText
 * @returns {Array<{oldPath: string|null, newPath: string|null, status: "added"|"deleted"|"renamed"|"modified",
 *   hunks: Array<{oldStart: number, oldCount: number, newStart: number, newCount: number,
 *   lines: Array<{type: "ctx"|"add"|"del", text: string}>}>}>}
 */
export function parseUnifiedDiff(diffText) {
  const files = [];
  let file = null;
  let hunk = null;
  const stripPrefix = (p) => (p === "/dev/null" ? null : p.replace(/^[ab]\//, ""));

  // Drop the empty string a trailing newline leaves behind — it is not a
  // context line of the final hunk.
  const rawLines = diffText.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();

  for (const raw of rawLines) {
    if (raw.startsWith("diff --git ")) {
      // Paths are re-read from ---/+++ below; the header just opens a file.
      file = { oldPath: null, newPath: null, status: "modified", hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    // Pure renames carry NO ---/+++ lines, so read the paths off the rename
    // headers (they come without the a/ b/ prefixes).
    if (raw.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = raw.slice("rename from ".length).trim();
      continue;
    }
    if (raw.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = raw.slice("rename to ".length).trim();
      continue;
    }
    if (raw.startsWith("--- ")) {
      file.oldPath = stripPrefix(raw.slice(4).trim());
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file.newPath = stripPrefix(raw.slice(4).trim());
      if (file.oldPath === null && file.newPath !== null) file.status = "added";
      else if (file.newPath === null && file.oldPath !== null) file.status = "deleted";
      else if (file.status !== "renamed" && file.oldPath !== file.newPath) file.status = "renamed";
      continue;
    }
    const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) hunk.lines.push({ type: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) hunk.lines.push({ type: "del", text: raw.slice(1) });
    else if (raw.startsWith(" ") || raw === "") hunk.lines.push({ type: "ctx", text: raw.slice(1) });
    // "\ No newline at end of file" and any other marker lines are skipped.
  }
  return files;
}

/**
 * Apply one parsed file-diff to its base content (verbatim hunk application,
 * tolerating the same start-line drift git apply tolerates by re-anchoring
 * each hunk on its old-side lines). Returns the new content, or null when a
 * hunk's old side cannot be located.
 * @param {string} baseContent
 * @param {{hunks: Array}} fileDiff
 * @returns {string|null}
 */
export function applyFileDiff(baseContent, fileDiff) {
  let lines = baseContent.split("\n");
  // Apply hunks bottom-up so earlier offsets stay valid.
  const hunks = [...fileDiff.hunks]
    .map((h) => ({ ...h, resolvedStart: resolveHunkOldStart(lines, h) }))
    .sort((a, b) => b.resolvedStart - a.resolvedStart);
  for (const h of hunks) {
    if (h.resolvedStart < 0) return null;
    const oldSide = h.lines.filter((l) => l.type !== "add");
    const newSide = h.lines.filter((l) => l.type !== "del").map((l) => l.text);
    // For a zero-length old range the hunk header names the line AFTER which
    // the insertion happens; otherwise it names the first replaced line.
    const at = oldSide.length === 0 ? h.resolvedStart : h.resolvedStart - 1;
    lines = [...lines.slice(0, at), ...newSide, ...lines.slice(at + oldSide.length)];
  }
  return lines.join("\n");
}

/**
 * Re-anchor a hunk against the actual base content: find the exact old-side
 * line sequence nearest the stated oldStart. Falls back to the stated start
 * when the old side matches there, returns -1 when it matches nowhere.
 * @param {string[]} baseLines
 * @param {{oldStart: number, lines: Array<{type: string, text: string}>}} hunk
 * @returns {number} 1-based line number, or -1
 */
export function resolveHunkOldStart(baseLines, hunk) {
  const oldSide = hunk.lines.filter((l) => l.type !== "add").map((l) => l.text);
  if (oldSide.length === 0) return hunk.oldStart; // pure insertion, no context
  const matches = [];
  outer: for (let i = 0; i + oldSide.length <= baseLines.length; i++) {
    for (let j = 0; j < oldSide.length; j++) {
      if (baseLines[i + j] !== oldSide[j]) continue outer;
    }
    matches.push(i + 1);
  }
  if (matches.length === 0) return -1;
  matches.sort((a, b) => Math.abs(a - hunk.oldStart) - Math.abs(b - hunk.oldStart));
  return matches[0];
}

// ---------------------------------------------------------------------------
// Schema-region detection (on the BASE version of drizzle-store.ts)
// ---------------------------------------------------------------------------

/**
 * Find the in-scope schema regions. A region runs from its function
 * declaration to the first subsequent column-0 `}`.
 * @param {string} content
 * @returns {Array<{name: string, kind: string, start: number, end: number}>} 1-based inclusive
 */
export function findSchemaRegions(content) {
  const lines = content.split("\n");
  const regions = [];
  for (const { name, re, kind } of REGION_STARTS) {
    const start = lines.findIndex((l) => re.test(l));
    if (start === -1) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\}/.test(lines[i])) {
        end = i + 1;
        break;
      }
    }
    regions.push({ name, kind, start: start + 1, end });
  }
  return regions;
}

const regionAtBaseLine = (regions, line) => regions.find((r) => line >= r.start && line <= r.end) ?? null;
// An added line is an insertion BEFORE base line X: inside a region iff the
// insertion point is after the declaration line and at or before the closing
// brace line (start < X <= end).
const regionAtInsertion = (regions, before) => regions.find((r) => before > r.start && before <= r.end) ?? null;

// ---------------------------------------------------------------------------
// Classification (mirrors migrations/README.md "When a migration artifact is
// required" — each rule cites its bullet)
// ---------------------------------------------------------------------------

const COMMENT_OR_BLANK_RE = /^\s*(?:$|\/\/|--|\/\*|\*)/;

/** Bare column-definition line inside CREATE TABLE text: `name type ...`. */
const COLUMN_DEF_RE =
  /^[a-z_][a-z0-9_]*\s+(?:text|integer|bigint|smallint|boolean|numeric|decimal|timestamp|timestamptz|date|time|interval|jsonb|json|uuid|varchar|character|char|real|double|bytea|serial|bigserial|vector)\b/i;

const TABLE_REF_RE = /(?:CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS|ALTER\s+TABLE)\s+(?:ONLY\s+)?(?:.*?\.)?"([a-z0-9_]+)"/i;
const INDEX_TABLE_RE = /\bON\s+(?:.*?\.)?"([a-z0-9_]+)"\s*\(/i;

/** Destructive rules evaluated on UNMATCHED ADDED lines (executed-DDL region). */
const ADDED_DESTRUCTIVE_RULES = [
  { rule: "drop-table", re: /\bDROP\s+TABLE\b/i, doc: "DROP TABLE on a table that exists on main" },
  { rule: "drop-column", re: /\bDROP\s+COLUMN\b/i, doc: "DROP COLUMN on a table that exists on main" },
  { rule: "rename", re: /\bRENAME\s+(?:TO|COLUMN)\b/i, doc: "renaming a table or column" },
  { rule: "retype", re: /\bALTER\s+COLUMN\b.*\b(?:TYPE|SET\s+DATA\s+TYPE)\b/i, doc: "retyping a column (ALTER COLUMN ... TYPE)" },
  // A split ALTER COLUMN — the line ends after the column name (or a dangling
  // SET / SET DATA) so the action sits on a LATER diff line where this
  // per-line classifier cannot see it. The destructive completions (TYPE /
  // SET DATA TYPE / SET NOT NULL) and the additive ones (SET DEFAULT /
  // DROP NOT NULL / DROP DEFAULT) are indistinguishable from this line, so
  // classify conservatively as a retype: an artifact is demanded, never
  // silently waived. Additive ALTER COLUMN actions kept on one line (the
  // bootstrap DDL's own style) never match — their action keyword closes the
  // statement on the same line.
  { rule: "retype-split-line", re: /\bALTER\s+COLUMN\s+(?:"[^"]+"|[a-z0-9_]+)(?:\s+SET(?:\s+DATA)?)?\s*[,;]?\s*$/i, doc: "ALTER COLUMN whose action continues on a later line — treated as a retype (the action is not visible on this line; keep additive ALTER COLUMN actions like SET DEFAULT on a single line)" },
  { rule: "set-not-null", re: /\bSET\s+NOT\s+NULL\b/i, doc: "adding NOT NULL to an existing column" },
  // Both the named form (ADD/VALIDATE CONSTRAINT) and PostgreSQL's anonymous
  // shorthand (ADD UNIQUE / PRIMARY KEY / FOREIGN KEY / CHECK / EXCLUDE) —
  // identical semantics over existing rows, per the same README bullet.
  { rule: "add-constraint", re: /\b(?:ADD|VALIDATE)\s+CONSTRAINT\b|\bADD\s+(?:UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK|EXCLUDE)\b/i, doc: "adding/tightening a constraint over existing rows (named CONSTRAINT or shorthand ADD UNIQUE / PRIMARY KEY / FOREIGN KEY / CHECK / EXCLUDE)" },
  // INSERT INTO and UPDATE are flagged without requiring a same-line
  // SET/SELECT: the real backfills in the bootstrap DDL are multi-line, so
  // the rest of the statement lands on other diff lines. UPDATE matches a
  // (schema-qualified) quoted target or a single-line `UPDATE x ... SET`
  // form — but not `ON CONFLICT ... DO UPDATE SET`. The new-table carve-out
  // still exempts writes into tables created in the same change.
  { rule: "data-rewrite", re: /\bDELETE\s+FROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+(?:(?:[a-z0-9_]+\.)?"|\S+\s+SET\b)/i, doc: "data rewrite against an existing table (UPDATE / DELETE / INSERT backfill)" },
];

/**
 * Classify the in-scope changed lines of drizzle-store.ts.
 *
 * @param {{hunks: Array}} fileDiff parsed diff of src/lib/drizzle-store.ts
 * @param {string} baseContent the BASE version of that file
 * @returns {{destructive: Array<{rule: string, line: string, doc: string}>,
 *   notices: string[], inScopeChanges: number}}
 */
export function classifyDrizzleStoreDiff(fileDiff, baseContent) {
  const baseLines = baseContent.split("\n");
  const regions = findSchemaRegions(baseContent);
  const notices = [];
  const destructive = [];

  if (regions.length < REGION_STARTS.length) {
    const found = regions.map((r) => r.name).join(", ") || "none";
    destructive.push({
      rule: "schema-regions-missing",
      line: `expected regions ${REGION_STARTS.map((r) => r.name).join(" + ")}; found: ${found}`,
      doc: "the gate cannot locate the in-scope schema regions in the base file — if they were renamed or moved, update scripts/audit/schema-migration-gate.mjs in the same PR",
    });
    return { destructive, notices, inScopeChanges: 0 };
  }

  /** Nearest enclosing table name for a base line (search upward, capped at region start). */
  const baseTableContext = (line, region) => {
    for (let i = line - 1; i >= (region?.start ?? 1) - 1; i--) {
      const m = baseLines[i]?.match(TABLE_REF_RE);
      if (m) return m[1];
    }
    return null;
  };

  // Walk hunks: collect in-region removed lines (with base line numbers) and
  // added lines (anchored to their base insertion point), each with the
  // nearest enclosing table for context-aware move cancellation.
  const removed = [];
  const added = [];
  for (const hunk of fileDiff.hunks) {
    const resolvedStart = resolveHunkOldStart(baseLines, hunk);
    if (resolvedStart === -1) {
      notices.push(`hunk @@ -${hunk.oldStart} could not be anchored to the base file; using its stated position`);
    }
    let oldLine = resolvedStart === -1 ? hunk.oldStart : resolvedStart;
    // Added-side table context: the most recent CREATE/ALTER TABLE seen on the
    // NEW side of this hunk (an added CREATE TABLE names the new table its
    // added column lines belong to). Falls back to base context at the anchor.
    let newSideTable = null;
    for (const l of hunk.lines) {
      if (l.type !== "del") {
        const m = l.text.match(TABLE_REF_RE);
        if (m) newSideTable = m[1];
      }
      if (l.type === "del") {
        const region = regionAtBaseLine(regions, oldLine);
        if (region) removed.push({ text: l.text, trimmed: l.text.trim(), baseLine: oldLine, region, table: baseTableContext(oldLine, region) });
        oldLine++;
      } else if (l.type === "add") {
        const region = regionAtInsertion(regions, oldLine);
        if (region) added.push({ text: l.text, trimmed: l.text.trim(), before: oldLine, region, table: newSideTable ?? baseTableContext(oldLine, region) });
      } else {
        oldLine++;
      }
    }
  }

  // Cancel moved/reformatted lines: whitespace-normalized identical text
  // under the SAME enclosing table cancels (a block reordered, re-indented,
  // or re-spaced is not a schema change). The table key keeps a column
  // dropped from one table from being cancelled by the same column added to
  // a different (e.g. new) table.
  const cancelKey = (l) => `${l.table ?? ""}@@${l.trimmed.replace(/\s+/g, " ")}`;
  const addedPool = new Map();
  for (const a of added) {
    const key = cancelKey(a);
    addedPool.set(key, (addedPool.get(key) ?? []).concat(a));
  }
  const unmatchedRemoved = [];
  for (const r of removed) {
    const pool = addedPool.get(cancelKey(r));
    if (pool && pool.length > 0) pool.pop();
    else unmatchedRemoved.push(r);
  }
  const unmatchedAdded = [...addedPool.values()].flat();

  const effective = (arr) => arr.filter((l) => !COMMENT_OR_BLANK_RE.test(l.trimmed));
  const remEff = effective(unmatchedRemoved);
  const addEff = effective(unmatchedAdded);
  const inScopeChanges = remEff.length + addEff.length;

  // Tables created by this diff (their columns/constraints/indexes are
  // additive: no pre-existing rows — migrations/README.md "Additive").
  const newTables = new Set();
  for (const a of addEff) {
    const m = a.trimmed.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:.*?\.)?"([a-z0-9_]+)"/i);
    if (m) newTables.add(m[1]);
  }
  const removedOnDelete = remEff.some((r) => /\bON\s+DELETE\b/i.test(r.trimmed));

  // The table a statement names ITSELF (DROP TABLE / data writes / CREATE or
  // ALTER TABLE / index ON). Wins over the sticky enclosing-table context so
  // a hunk that creates a new table cannot launder a same-hunk statement
  // aimed at an EXISTING table through the new-table carve-out.
  const ownTarget = (line) =>
    line.match(/\b(?:DROP\s+TABLE|UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:.*?\.)?"([a-z0-9_]+)"/i)?.[1] ??
    line.match(TABLE_REF_RE)?.[1] ??
    line.match(INDEX_TABLE_RE)?.[1] ??
    null;
  // A line that BEGINS a statement must name its target itself — when it
  // does not (the target sits on a later line), it never inherits the sticky
  // enclosing-table context, so it cannot ride a new table's carve-out.
  const isStatementStart = (line) =>
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b|\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b|\bDROP\s+TABLE\b|\bUPDATE\b|\bDELETE\s+FROM\b|\bINSERT\s+INTO\b/i.test(line);

  for (const a of addEff) {
    if (a.region.kind !== "executed-ddl") continue; // Drizzle defs mirror the DDL; the executed-DDL change is the signal
    // Changes scoped to a table created in this same change are additive (no
    // pre-existing rows). Only column-level lines (no statement of their own)
    // fall back to the enclosing-table context.
    const target = ownTarget(a.trimmed) ?? (isStatementStart(a.trimmed) ? null : a.table);
    if (target !== null && newTables.has(target)) continue;
    for (const { rule, re, doc } of ADDED_DESTRUCTIVE_RULES) {
      if (re.test(a.trimmed)) {
        destructive.push({ rule, line: a.trimmed, doc });
        break;
      }
    }
    // Unique index on an existing table can fail outright on duplicates.
    if (/\bCREATE\s+UNIQUE\s+INDEX\b/i.test(a.trimmed)) {
      const t = a.trimmed.match(INDEX_TABLE_RE)?.[1];
      if (!t || !newTables.has(t)) {
        destructive.push({ rule: "unique-index-existing-table", line: a.trimmed, doc: "unique index on an existing table (can fail on existing duplicates)" });
      }
    }
    // A new NOT NULL column is additive only on a table created in the same
    // change; ADD COLUMN targets existing tables by construction.
    if (/\bADD\s+COLUMN\b/i.test(a.trimmed) && /\bNOT\s+NULL\b/i.test(a.trimmed)) {
      destructive.push({ rule: "not-null-column-on-existing-table", line: a.trimmed, doc: "NOT NULL column added to an existing table (additive carve-out covers nullable columns, or NOT NULL on a table created in the same change)" });
    }
    // FK ON DELETE rule change: an added ON DELETE paired with a removed one.
    if (/\bON\s+DELETE\b/i.test(a.trimmed) && removedOnDelete) {
      destructive.push({ rule: "fk-on-delete-change", line: a.trimmed, doc: "changing an existing foreign key's ON DELETE rule" });
    }
  }

  // Removed lines come from the BASE file, so their tables exist on main by
  // construction — no new-table carve-out applies on this side.
  for (const r of remEff) {
    if (r.region.kind !== "executed-ddl") continue;
    if (/\bCREATE\s+TABLE\b/i.test(r.trimmed)) {
      destructive.push({ rule: "table-removed-from-ddl", line: r.trimmed, doc: "removing a table from the CREATE DDL text (the deployed database still has it)" });
    } else if (/\bADD\s+COLUMN\b/i.test(r.trimmed)) {
      destructive.push({ rule: "column-removed-from-ddl", line: r.trimmed, doc: "removing a column from the idempotent ADD COLUMN DDL (drop/rename/retype of a deployed column)" });
    } else if (COLUMN_DEF_RE.test(r.trimmed)) {
      destructive.push({ rule: "column-removed-from-ddl", line: r.trimmed, doc: "removing or rewriting a column definition in the CREATE DDL text (drop/rename/retype of a deployed column)" });
    } else {
      notices.push(`unmatched removed line (treated as additive): ${r.trimmed.slice(0, 120)}`);
    }
  }

  for (const a of addEff) {
    if (!destructive.some((d) => d.line === a.trimmed)) {
      notices.push(`in-scope ${a.region.kind === "executed-ddl" ? "DDL" : "Drizzle-def"} addition (additive): ${a.trimmed.slice(0, 120)}`);
    }
  }

  return { destructive, notices, inScopeChanges };
}

// ---------------------------------------------------------------------------
// Migration-artifact detection (mirrors migrations/README.md "What counts as
// a migration artifact": a node-pg-migrate runner module in migrations/core/
// + its manifest entry, in the same PR). Legacy migrations/NNNN_*.sql
// artifacts are shipped history: protected against deletion, but REJECTED as
// the artifact form for new migrations — the core runner never executes them.
// ---------------------------------------------------------------------------

/**
 * Two problem classes come back separately:
 *   - `integrity` — tampering with SHIPPED migration state (delete / rename /
 *     edit of a shipped artifact, a rewritten manifest entry) or a
 *     migrations/core/ addition that would brick the runner's boot preflight
 *     (malformed filename, duplicate seq). These FAIL the gate on their own,
 *     destructive schema change or not.
 *   - `problems` — an incomplete/wrong-form artifact for THIS PR's change.
 *     These fail the gate only when the PR's schema change is destructive
 *     and therefore demands a complete artifact.
 *
 * @param {Array} files parsed diff files
 * @param {(path: string) => string|null} readBaseFile
 * @returns {{complete: boolean, artifactFiles: string[], problems: string[], integrity: string[], newEntries: Array}}
 */
export function detectMigrationArtifact(files, readBaseFile) {
  const problems = [];
  const integrity = [];
  /** Added runner modules (full paths) — the only artifact form new migrations may ship. */
  const moduleFiles = [];

  const baseManifestRaw = readBaseFile(MIGRATION_MANIFEST_PATH);
  let baseEntries = [];
  if (baseManifestRaw !== null) {
    try {
      baseEntries = JSON.parse(baseManifestRaw)?.migrations ?? [];
    } catch {
      problems.push(`${MIGRATION_MANIFEST_PATH} (base) is not parseable JSON`);
    }
  }

  for (const f of files) {
    // Renames are checked on BOTH sides first: `newPath ?? oldPath` alone
    // would let a shipped artifact be renamed OUT of migrations/ (new path
    // elsewhere) without ever entering the branches below.
    if (f.status === "renamed") {
      const touchesShippedState = [f.oldPath, f.newPath].some(
        (side) => side && (MIGRATION_MODULE_RE.test(side) || MIGRATION_SQL_RE.test(side) || side === MIGRATION_MANIFEST_PATH),
      );
      if (touchesShippedState) {
        integrity.push(`${f.oldPath} -> ${f.newPath}: shipped migration state must never be renamed or moved (append-only — supersede it with a new sequence number)`);
      }
      continue;
    }
    const p = f.newPath ?? f.oldPath;
    if (!p || !p.startsWith("migrations/")) continue;

    if (p.startsWith("migrations/core/")) {
      const basename = p.slice("migrations/core/".length);
      if (basename.includes("/") || basename.startsWith(".")) continue; // nested/dotfiles: not artifacts
      const isModule = MIGRATION_MODULE_RE.test(p);
      if (f.status !== "added") {
        // A shipped module is immutable history backing ledger rows on every
        // deployed database: deletion AND edits are tampering (renames were
        // handled above).
        if (isModule) {
          integrity.push(`${p}: a shipped core migration module must never be ${f.status === "modified" ? "edited" : f.status} (append-only — supersede it with a new sequence number)`);
        }
        continue;
      }
      if (!MIGRATION_MODULE_RE.test(p)) {
        // The runner's boot preflight rejects out-of-contract filenames — a
        // merged one would fail EVERY subsequent boot, so the gate must stop
        // it here regardless of what else the PR does.
        integrity.push(`${p}: core migration filename must match migrations/core/core__NNNN_short-description.mjs (the runner's preflight refuses anything else at boot)`);
        continue;
      }
      moduleFiles.push(p);
      continue;
    }

    if (!p.endsWith(".sql")) continue; // README/manifest and friends
    if (f.status !== "added") {
      if (MIGRATION_SQL_RE.test(p)) {
        integrity.push(`${p}: a shipped migration must never be ${f.status === "modified" ? "edited" : f.status} (append-only — supersede it instead)`);
      }
      continue;
    }
    if (!MIGRATION_SQL_RE.test(p)) {
      problems.push(`${p}: migration filename must match migrations/NNNN_short-description.sql`);
      continue;
    }
    problems.push(
      `${p}: the legacy psql artifact form is retired for new migrations — ship a runner module migrations/core/core__NNNN_short-description.mjs instead (the node-pg-migrate runner is what applies migrations now; see migrations/README.md)`,
    );
  }

  // Runner-form backfills of ALREADY-SHIPPED legacy artifacts (the core__0001/
  // core__0002 wrappers of the psql files): they introduce no schema change
  // and need no new manifest entry — and cannot get one, since the ledger's
  // seqs are strictly increasing. The exception is EXACT: only the module
  // whose name is `core__<legacy stem>.mjs` for a base entry that points at a
  // .sql file qualifies. Anything else re-using a shipped seq would trip the
  // runner's duplicate-seq preflight at boot — integrity-level rejection.
  const legacyBackfillPaths = new Set(
    baseEntries
      .filter((e) => typeof e?.file === "string" && /^\d{4}_[a-z0-9][a-z0-9-]*\.sql$/.test(e.file))
      .map((e) => `migrations/core/core__${e.file.replace(/\.sql$/, ".mjs")}`),
  );
  const baseSeqs = new Set(baseEntries.map((e) => String(e?.seq).padStart(4, "0")));
  const artifactFiles = [];
  const seenSeqs = new Set();
  for (const p of moduleFiles) {
    if (legacyBackfillPaths.has(p)) continue;
    const seq = p.match(MIGRATION_MODULE_RE)[1];
    if (baseSeqs.has(seq)) {
      integrity.push(`${p}: sequence number ${seq} is already shipped — a non-wrapper module re-using it would fail the runner's duplicate-seq preflight at boot (use the next free sequence number)`);
      continue;
    }
    if (seenSeqs.has(seq)) {
      integrity.push(`${p}: duplicate sequence number ${seq} within this diff — the runner's preflight refuses duplicate seqs at boot`);
      continue;
    }
    seenSeqs.add(seq);
    artifactFiles.push(p);
  }

  // The manifest's append-only contract is checked WHENEVER the manifest
  // changed — a manifest-only rewrite (no module in the diff) is tampering
  // with shipped state and must not slide past on an early return.
  const manifestDiff = files.find((f) => (f.newPath ?? f.oldPath) === MIGRATION_MANIFEST_PATH);
  let finalEntries = null;
  if (manifestDiff) {
    if (manifestDiff.status === "deleted") {
      integrity.push(`${MIGRATION_MANIFEST_PATH}: the migration manifest must never be deleted`);
    } else {
      const finalRaw = applyFileDiff(baseManifestRaw ?? "", manifestDiff);
      if (finalRaw !== null) {
        try {
          finalEntries = JSON.parse(finalRaw)?.migrations;
        } catch {
          /* fall through */
        }
      }
      if (!Array.isArray(finalEntries)) {
        problems.push(`${MIGRATION_MANIFEST_PATH}: could not parse the post-change manifest (migrations must stay a JSON array)`);
        finalEntries = null;
      } else {
        // Append-only: the base entries must be an untouched prefix.
        for (let i = 0; i < baseEntries.length; i++) {
          if (JSON.stringify(finalEntries[i]) !== JSON.stringify(baseEntries[i])) {
            integrity.push(`${MIGRATION_MANIFEST_PATH}: existing entry ${i + 1} was rewritten — the ledger is append-only (supersede with a new sequence number)`);
          }
        }
      }
    }
  }

  if (artifactFiles.length === 0) {
    // A manifest edit that leaves the migrations array untouched (e.g. _doc
    // wording) is legitimate without a module. Appending entries is not:
    // every new entry must bind to a module shipped in the same diff.
    // (Rewriting or removing existing entries is already an integrity
    // failure via the append-only prefix check above.)
    if (
      manifestDiff &&
      problems.length === 0 &&
      integrity.length === 0 &&
      Array.isArray(finalEntries) &&
      finalEntries.length > baseEntries.length
    ) {
      problems.push(`${MIGRATION_MANIFEST_PATH} gained entries without a new migrations/core/core__NNNN_*.mjs module`);
    }
    return { complete: false, artifactFiles, problems, integrity, newEntries: [] };
  }
  if (!manifestDiff) {
    problems.push(`new core migration module shipped without the matching ${MIGRATION_MANIFEST_PATH} entry (both pieces are required, in the same PR)`);
    return { complete: false, artifactFiles, problems, integrity, newEntries: [] };
  }
  if (finalEntries === null) {
    return { complete: false, artifactFiles, problems, integrity, newEntries: [] };
  }

  const newEntries = finalEntries.slice(baseEntries.length);
  const maxBaseSeq = baseEntries.reduce((m, e) => Math.max(m, Number(e?.seq) || 0), 0);
  // entry.file is relative to migrations/ (e.g. "core/core__0003_x.mjs").
  const moduleRelPaths = new Set(artifactFiles.map((p) => p.slice("migrations/".length)));
  let prevSeq = maxBaseSeq;
  for (const e of newEntries) {
    const seq = Number(e?.seq);
    if (!Number.isInteger(seq) || seq <= prevSeq) {
      problems.push(`${MIGRATION_MANIFEST_PATH}: new entry seq '${e?.seq}' must be strictly increasing (last shipped: ${String(prevSeq).padStart(4, "0")})`);
    } else {
      prevSeq = seq;
    }
    // Every new ledger entry must bind to a runner module added in THIS diff
    // with a matching sequence prefix — a manifest-only entry (or a
    // mismatched seq) cannot stand in for the migration it claims.
    if (typeof e?.file !== "string" || !moduleRelPaths.has(e.file)) {
      problems.push(`${MIGRATION_MANIFEST_PATH}: entry '${e?.file ?? e?.seq}' has no matching migrations/core/ module added in this diff`);
    } else if (!e.file.startsWith(`core/core__${e?.seq}_`)) {
      problems.push(`${MIGRATION_MANIFEST_PATH}: entry seq '${e?.seq}' does not match its filename '${e.file}'`);
    }
  }
  for (const p of artifactFiles) {
    const rel = p.slice("migrations/".length);
    if (!newEntries.some((e) => e?.file === rel)) {
      problems.push(`${p}: no matching ${MIGRATION_MANIFEST_PATH} entry (entry.file must be '${rel}')`);
    }
  }

  return {
    complete: problems.length === 0 && integrity.length === 0 && artifactFiles.length > 0,
    artifactFiles,
    problems,
    integrity,
    newEntries,
  };
}

// ---------------------------------------------------------------------------
// Gate driver
// ---------------------------------------------------------------------------

/**
 * Run the gate over a unified diff.
 * @param {{diffText: string, readBaseFile: (path: string) => string|null}} input
 * @returns {{verdict: "pass"|"fail", destructive: Array, artifact: ReturnType<typeof detectMigrationArtifact>,
 *   notices: string[], ignored: string[], inScopeChanges: number}}
 */
export function runGate({ diffText, readBaseFile }) {
  const files = parseUnifiedDiff(diffText);
  const notices = [];
  const ignored = [];
  let destructive = [];
  let inScopeChanges = 0;

  for (const f of files) {
    const path = f.newPath ?? f.oldPath;
    if (!path) continue;
    if (path === IN_SCOPE_FILE || f.oldPath === IN_SCOPE_FILE) {
      if (f.status === "deleted" || f.status === "renamed") {
        destructive.push({
          rule: "schema-file-moved",
          line: `${IN_SCOPE_FILE} was ${f.status}`,
          doc: "the gate tracks the schema DDL in this file — update scripts/audit/schema-migration-gate.mjs in the same PR if the schema home moves",
        });
        continue;
      }
      if (f.status === "added") {
        notices.push(`${IN_SCOPE_FILE} is new in this diff — no deployed data to affect; treating as additive`);
        continue;
      }
      const baseContent = readBaseFile(IN_SCOPE_FILE);
      if (baseContent === null) {
        destructive.push({
          rule: "base-unreadable",
          line: IN_SCOPE_FILE,
          doc: "could not read the base version of the schema file to classify against",
        });
        continue;
      }
      const result = classifyDrizzleStoreDiff(f, baseContent);
      destructive = destructive.concat(result.destructive);
      notices.push(...result.notices);
      inScopeChanges += result.inScopeChanges;
    } else if (OUT_OF_SCOPE_FILES.has(path) || (f.oldPath && OUT_OF_SCOPE_FILES.has(f.oldPath))) {
      ignored.push(`${path} (out of scope: owned by Better Auth / extension migrations — see migrations/README.md)`);
    }
    // every other file: not schema-bearing for this gate
  }

  const artifact = detectMigrationArtifact(files, readBaseFile);
  let verdict = "pass";
  // Tampering with shipped migration state (or a core/ addition that would
  // brick the runner's boot preflight) fails on its own — no destructive
  // schema change required.
  if (artifact.integrity.length > 0) verdict = "fail";
  // Any migration-state inconsistency also fails on its own: the runner
  // executes every valid migrations/core/ module regardless of the manifest,
  // so an unmanifested executable module — or a manifest that lies about its
  // modules (entry without module, seq drift) — must never pass merely
  // because no in-scope schema file changed in the same diff.
  if (artifact.problems.length > 0) verdict = "fail";
  if (destructive.length > 0) {
    if (!artifact.complete) verdict = "fail";
    else if (!artifact.newEntries.some((e) => e?.destructive === true)) {
      verdict = "fail";
      artifact.problems.push(`${MIGRATION_MANIFEST_PATH}: a user-land-affecting change needs a new entry with "destructive": true`);
    }
  }
  return { verdict, destructive, artifact, notices, ignored, inScopeChanges };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

function resolveBase() {
  const explicit = process.env.SCHEMA_MIGRATION_BASE;
  const candidates = explicit ? [explicit] : ["origin/main", "main"];
  for (const c of candidates) {
    try {
      git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${c}^{commit}`], { stdio: ["ignore", "pipe", "ignore"] });
      return c;
    } catch {
      if (explicit) {
        console.error(`[schema-migration-gate] SCHEMA_MIGRATION_BASE='${explicit}' does not resolve — check fetch depth / ref name.`);
        process.exit(2);
      }
    }
  }
  console.error("[schema-migration-gate] no diff base resolves (tried origin/main, main).");
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const diffFileIdx = argv.indexOf("--diff-file");
  let diffText;
  let readBaseFile;

  if (diffFileIdx !== -1) {
    const diffPath = argv[diffFileIdx + 1];
    if (!diffPath) {
      console.error("[schema-migration-gate] --diff-file requires a path");
      process.exit(2);
    }
    diffText = readFileSync(resolve(diffPath), "utf8");
    // The working tree IS the diff's base in this mode (the fixture corpus
    // applies cleanly to the tree; the companion test asserts that).
    readBaseFile = (p) => {
      const abs = join(REPO_ROOT, p);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    };
  } else {
    const base = resolveBase();
    let mergeBase;
    try {
      mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"]).trim();
    } catch {
      mergeBase = base;
    }
    const paths = [IN_SCOPE_FILE, "migrations", ...OUT_OF_SCOPE_FILES];
    diffText = git(["diff", "--find-renames", mergeBase, "HEAD", "--", ...paths]);
    readBaseFile = (p) => {
      try {
        return git(["show", `${mergeBase}:${p}`]);
      } catch {
        return null;
      }
    };
    console.log(`[schema-migration-gate] diffing ${mergeBase.slice(0, 12)} (merge base of ${base}) .. HEAD`);
  }

  const { verdict, destructive, artifact, notices, ignored, inScopeChanges } = runGate({ diffText, readBaseFile });

  for (const i of ignored) console.log(`[schema-migration-gate] ignored: ${i}`);
  for (const n of notices) console.log(`[schema-migration-gate] note: ${n}`);
  if (artifact.artifactFiles.length > 0) {
    console.log(`[schema-migration-gate] migration artifact in diff: ${artifact.artifactFiles.join(", ")}${artifact.complete ? "" : " (INCOMPLETE)"}`);
  }

  if (verdict === "fail") {
    console.error(
      destructive.length > 0
        ? `[schema-migration-gate] FAIL — destructive core-store schema change without a complete migration artifact.`
        : `[schema-migration-gate] FAIL — shipped migration state was tampered with (append-only) or a migrations/core/ addition would break the runner's boot preflight.`,
    );
    for (const d of destructive) {
      console.error(`  [${d.rule}] ${d.doc}`);
      console.error(`      ${d.line.slice(0, 160)}`);
    }
    for (const p of artifact.integrity) console.error(`  [integrity] ${p}`);
    for (const p of artifact.problems) console.error(`  [artifact] ${p}`);
    console.error(
      `\nShip the migration artifact (and leave shipped history untouched) in this PR:\n` +
        `  1. migrations/core/core__NNNN_short-description.mjs (next sequence number; a node-pg-migrate\n` +
        `     module exporting up/down — see migrations/README.md "Authoring a migration")\n` +
        `  2. the matching entry appended to migrations/manifest.json\n` +
        `See migrations/README.md for the convention; if the change is genuinely additive and misclassified,\n` +
        `add a labelled fixture to scripts/audit/__fixtures__/schema-migration/ and adjust the classifier in the same PR.`,
    );
    process.exit(1);
  }

  if (destructive.length > 0) {
    console.log(`[schema-migration-gate] OK — destructive change ships its migration artifact (${artifact.artifactFiles.join(", ")}).`);
  } else if (inScopeChanges > 0) {
    console.log(`[schema-migration-gate] OK — ${inScopeChanges} in-scope schema line(s) changed, all additive/no-data-impact.`);
  } else {
    console.log("[schema-migration-gate] OK — no in-scope core-store schema changes in this diff.");
  }
  process.exit(0);
}

// Only run when executed directly — importing for unit tests must not
// trigger the scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
