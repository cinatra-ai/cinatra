#!/usr/bin/env node
"use strict";

// Core-store schema migration gate.
//
// Fails a PR that makes a DESTRUCTIVE change to the first-party core store
// schema — the hand-mirrored DDL in `buildCreateStoreSchemaQueries` and the
// Drizzle table definitions in `createStoreTables` (src/lib/drizzle-store.ts)
// — without shipping the migration artifact the convention in
// migrations/README.md requires: a node-pg-migrate runner module at
// `migrations/core/core__NNNN_short-description.mjs` PLUS its per-migration
// manifest FRAGMENT `migrations/manifest.d/core__NNNN_short-description.json`,
// in the same PR (#1335 — fragments replace appends to the legacy
// `migrations/manifest.json` array, which is FROZEN shipped history; the gate
// rejects new entries added to it). The ledger every consumer sees is the
// deterministic UNION of the frozen legacy array + the fragments, computed by
// the shared reader `migrations/manifest-reader.mjs`; append-only semantics
// are kept over the union via seq uniqueness + strict monotonicity past the
// max shipped seq. (The legacy psql artifact form `migrations/NNNN_*.sql` is
// retired for NEW migrations — the runner never executes it; shipped legacy
// artifacts remain append-only history.)
//
// What it does, per PR diff:
//   1. DETECT  — does the diff touch the in-scope schema regions of
//      src/lib/drizzle-store.ts, or the DDL LEAF MODULES those regions spread
//      in? Changes anywhere else in that file (the runtime DML query builders)
//      and in any other file are ignored.
//      Better Auth schema files and the extension migration DSL/runner are
//      explicitly out of scope (owned elsewhere — see migrations/README.md)
//      and are reported as ignored even when bundled in the same PR.
//      DDL LEAVES (cinatra#2625): the executed DDL is COMPOSED — a leaf
//      module's exported query builder is spread into the region
//      (`...triggerSchemaQueries(schemaName),`), and the statements it returns
//      are executed against deployed databases exactly like an inline one. The
//      spread-reached EXPORT of a leaf is therefore an in-scope schema region
//      too, resolved from drizzle-store.ts's own imports on the base AND the
//      post-change side. That is what makes RELOCATING deployed DDL out of
//      drizzle-store.ts into a leaf classify as the no-data-impact move it is
//      (see the cross-file cancellation in step 2) while a drop hidden inside
//      a leaf still reds. The same reasoning covers a LOCAL helper of
//      drizzle-store.ts that the region spreads in (the live
//      `...buildEmailCorrelationIndexQueries(schemaName),`): its body sits
//      outside both named regions, so it is scoped in as its own region too. A
//      spread the resolver cannot pin to either form is refused when ADDED,
//      rather than left as a blind spot.
//   2. CLASSIFY — destructive (user-land data affected: drops, renames,
//      retypes, NOT NULL on existing tables, tightened constraints, unique
//      indexes on existing tables, FK ON DELETE changes, data rewrites)
//      vs additive (new table, new nullable column, non-unique index).
//      Lines that merely MOVED cancel before any rule runs: identical text
//      under the same table cancels within a file, and — since the leaf regions
//      join the same pools — a line removed from one in-scope region and added
//      in ANOTHER FILE's cancels too (the relocation pass; the schema-name
//      interpolation is spelled differently inside a leaf, so that pass
//      compares DDL-normalized text). What does NOT come back is a drop: an
//      uncancelled removal is still a dropped table/column, wherever it lived.
//      Each rule maps 1:1 to a bullet in migrations/README.md. The labelled
//      fixture corpus at scripts/audit/__fixtures__/schema-migration/ is the
//      executable contract: the companion test runs this gate against every
//      fixture and asserts its labelled pass/fail outcome.
//   3. GATE   — exit non-zero when the change is destructive AND the same
//      diff ships no complete migration artifact, OR when the diff tampers
//      with SHIPPED migration state regardless of schema changes (deleting /
//      renaming / editing a shipped artifact or manifest fragment, rewriting
//      a legacy manifest entry, appending to the frozen legacy array, or
//      adding a migrations/core/ file that would brick the runner's boot
//      preflight), OR on any ledger-union inconsistency (duplicate seq
//      across forms, non-monotonic fragment seq, fragment without module or
//      vice versa). Additive changes and destructive changes accompanied by
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
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { FRAGMENT_FILE_RE, buildManifestUnion, parseFragment } from "../../migrations/manifest-reader.mjs";

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
/** Per-migration manifest fragments (#1335) — the authoring form for NEW entries. */
export const MIGRATION_FRAGMENT_DIR = "migrations/manifest.d";
/** Legacy hand-apply artifacts (psql). Shipped history only — retired for NEW migrations. */
export const MIGRATION_SQL_RE = /^migrations\/(\d{4})_([a-z0-9][a-z0-9-]*)\.sql$/;
/**
 * Runner-module artifacts (node-pg-migrate, cinatra#116): the artifact form a
 * NEW destructive change must ship. The `core__` prefix is the per-source
 * ledger namespace (#115). Capture group 1 = the NNNN sequence number.
 * Mirrors CORE_MIGRATION_FILE_RE in packages/migrations/src/core-migrations.mjs.
 */
export const MIGRATION_MODULE_RE = /^migrations\/core\/core__(\d{4})_([a-z0-9][a-z0-9-]*)\.mjs$/;

/**
 * POISON-PILL CORRECTIONS — the single, narrow, maintainer-reviewed exemption
 * to the append-only rule for shipped runner modules (see migrations/README.md
 * "Correcting a poison-pill migration").
 *
 * The append-only rule exists because a shipped module is immutable history
 * backing ledger rows on deployed databases. A module whose body can NEVER
 * have completed on any database — its first executed statement
 * deterministically fails — backs no such history: the only ledger rows for
 * its seq are setup's ledger-FAKED rows on fresh schemas, where the body never
 * executes. And it cannot be superseded: the runner applies pending
 * migrations in seq order, so the broken module always runs first and aborts
 * the chain before any superseding seq is reached. In exactly that case an
 * IN-PLACE correction is the only possible fix, and rewrites no deployed
 * history.
 *
 * Each entry is ONE-SHOT (codex convergence blocker on the correction PR):
 * it authorizes exactly the recorded content transition, pinned by sha256 of
 * the full BASE (broken) module content and of the CORRECTED result. Any
 * other edit — a different base (e.g. a later edit once the correction has
 * shipped, when the merge-base carries the corrected content) or a different
 * result — still fails append-only, as do deletion and rename.
 *
 * Every entry must be added under maintainer review (migrations/** is a
 * high-risk path) with the justification recorded alongside the digests.
 *
 * Key: module basename.
 */
export const SHIPPED_MODULE_CORRECTION_EXEMPTIONS = new Map([
  [
    "core__0053_organization-name-not-null.mjs",
    {
      baseSha256: "e61899a98df8e673b2c40d6566559bf4a3553ceaef13c4c3e5f51bba8f28529c",
      correctedSha256: "a090b5241663b9d92a3be23ee5a7be429e61eb81052936f2d5bb7529b8b888c8",
      justification:
        "shipped body opened with pgm.db.query('LOCK TABLE …') outside any transaction — node-pg-migrate " +
        "executes direct-db queries in autocommit, so PG 25P01 aborted EVERY real execution at the first " +
        "statement (standalone-boot crash on every design-fixtures CI run; would crash-loop a prod deploy). " +
        "The body can never have completed anywhere, and a superseding seq can never run because the broken " +
        "0053 aborts the chain first. Corrected in place to the owned-transaction model (core__0006/0014/0015).",
    },
  ],
]);

/** sha256 hex digest of full file content (the exemption pin format). */
export function contentDigest(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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

  // Exact header-path parse for the `diff --git a/P b/P` form: every
  // add/delete/modify names the SAME path twice, so try each " b/" split and
  // keep the one where both sides are equal — correct even when the path
  // itself contains " b/". Renames (P != Q) fall back to the greedy split and
  // are corrected by their rename from/to headers. C-quoted headers (unusual
  // bytes in the name) are left unparsed — and therefore unconfirmed.
  const parseHeaderPaths = (rest) => {
    if (!rest.startsWith("a/")) return { oldPath: null, newPath: null, confirmed: false };
    const s = rest.slice(2);
    for (let idx = s.indexOf(" b/"); idx !== -1; idx = s.indexOf(" b/", idx + 1)) {
      const left = s.slice(0, idx);
      const right = s.slice(idx + 3);
      if (left === right) return { oldPath: left, newPath: right, confirmed: true };
    }
    const m = rest.match(/^a\/(.+) b\/(.+)$/);
    return m ? { oldPath: m[1], newPath: m[2], confirmed: false } : { oldPath: null, newPath: null, confirmed: false };
  };

  for (const raw of rawLines) {
    if (raw.startsWith("diff --git ")) {
      // Paths are refined by the mode/rename/---/+++ headers below, but the
      // header itself must seed them: EMPTY additions, binary changes, and
      // mode-only changes carry NO ---/+++ lines at all, and a file the
      // parser cannot name is a file the gate cannot protect. Files whose
      // paths are never CONFIRMED (exact header match or a later header)
      // carry pathsConfirmed=false so consumers can fail closed.
      const seeded = parseHeaderPaths(raw.slice("diff --git ".length));
      file = {
        oldPath: seeded.oldPath,
        newPath: seeded.newPath,
        status: "modified",
        newMode: null,
        headerLine: raw,
        // Confirmation is tracked PER SIDE: a C-quoted rename/add can have
        // one parseable side (e.g. `--- /dev/null`) while the other stays
        // unparsed — one confirmed side must never vouch for both.
        oldConfirmed: seeded.confirmed,
        newConfirmed: seeded.confirmed,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    // new/deleted file headers: authoritative for header-only diffs (empty
    // or binary adds/deletes emit no ---/+++). The new-side file MODE is
    // captured too — a symlink (120000) added where a regular file is
    // expected must be rejectable downstream.
    const newMode = raw.match(/^new (?:file )?mode (\d{6})$/);
    if (newMode) {
      if (raw.startsWith("new file mode ")) {
        file.status = "added";
        file.oldPath = null;
      }
      file.newMode = newMode[1];
      continue;
    }
    if (raw.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.newPath = null;
      continue;
    }
    // Pure renames carry NO ---/+++ lines, so read the paths off the rename
    // headers (they come without the a/ b/ prefixes).
    if (raw.startsWith("rename from ")) {
      file.status = "renamed";
      const v = raw.slice("rename from ".length).trim();
      if (v.startsWith('"')) continue; // C-quoted name — this side stays unconfirmed
      file.oldPath = v;
      file.oldConfirmed = true;
      continue;
    }
    if (raw.startsWith("rename to ")) {
      file.status = "renamed";
      const v = raw.slice("rename to ".length).trim();
      if (v.startsWith('"')) continue; // C-quoted name — this side stays unconfirmed
      file.newPath = v;
      file.newConfirmed = true;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const v = raw.slice(4).trim();
      if (v.startsWith('"')) continue; // C-quoted name — this side stays unconfirmed
      file.oldPath = stripPrefix(v);
      file.oldConfirmed = true;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const v = raw.slice(4).trim();
      if (v.startsWith('"')) continue; // C-quoted name — this side stays unconfirmed
      file.newPath = stripPrefix(v);
      file.newConfirmed = true;
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

// ---------------------------------------------------------------------------
// DDL LEAF MODULES (cinatra#2625)
//
// The executed core-store DDL is COMPOSED, not literal: leaf modules export a
// pure-strings query builder that buildCreateStoreSchemaQueries SPREADS into its
// array (`...triggerSchemaQueries(schemaName),` — the established remedy for the
// file-size ratchet on drizzle-store.ts). Every statement such a leaf returns is
// executed against deployed databases exactly like an inline one, so a leaf that
// is spread in IS in-scope core-store schema.
//
// A leaf is taken WHOLE. Scoping it to the spread-reached export's body would be
// tighter but wrong: these leaves compose their DDL out of module-level helpers
// and constants (assistant-thread-schema.ts's `addConstraintIfAbsent` is the
// live example), so DDL genuinely lives outside the exported body.
//
// Resolution is deliberately narrow and fails CLOSED: only `...ident(` spreads
// written as CODE inside the executed-DDL region (commented-out spreads are
// stripped first, so a decoy `// ...fakeQueries(x)` cannot point the gate at a
// module the bootstrap never calls), only identifiers bound by a named import in
// drizzle-store.ts itself, and only first-party specifiers (`@/…`, `./…`,
// `../…`). Anything the resolver cannot pin — a bare package, a re-export chain,
// a dynamically built spread — yields no leaf, which leaves the gate's
// pre-existing behaviour (an unexplained removal is destructive) intact.
//
// A leaf contributes its FULL in-scope content on each side rather than its
// diff hunks: the BASE revision's lines when the spread reached it on base, the
// POST-CHANGE revision's lines when the spread reaches it after. Cancellation
// then reduces that to the real delta, and the two REACHABILITY edges fall out
// for free — adding a spread makes a leaf's whole DDL an addition, and REMOVING
// a spread (which un-executes every table the leaf creates, with the leaf file
// itself untouched) makes it a removal that reds like any other drop.
// ---------------------------------------------------------------------------

/** `...someLeafQueries(` spread call sites. */
const DDL_LEAF_SPREAD_RE = /\.\.\.([A-Za-z_$][\w$]*)\s*\(/g;
/** `import { a, b as c } from "spec"` — the only binding form leaves use. */
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
/** `X.replaceAll('"', '""')` — the ONE schema-name escape the DDL text uses. */
const SCHEMA_ESCAPE_RE = /^[A-Za-z_$][\w$]*\.replaceAll\(['"]"['"],['"]""['"]\)$/;

/**
 * Drop comments so commented-out code is never read as code — and so real code
 * is never truncated by a comment marker that merely sits inside a string.
 *
 * ONE left-to-right scan over the whole text tracks quote state (with backslash
 * escapes, and templates spanning lines) and block-comment state together. Both
 * halves must be quote-aware: a parity count is defeated by `'\''`, and
 * stripping `/*…*\/` textually first is defeated by a string that merely
 * CONTAINS those two markers, which would erase the real import between them.
 * Not modelled: regex literals, and `${…}` nesting inside a template.
 */
export function stripComments(text) {
  let out = "";
  let quote = null; // '"' | "'" | "`" — a template legitimately spans lines
  let block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const d = text[i + 1];
    if (block) {
      if (c === "*" && d === "/") {
        block = false;
        i++;
      } else if (c === "\n") out += "\n"; // keep line structure for the scans
      continue;
    }
    if (quote) {
      out += c;
      if (c === "\\") {
        if (d !== undefined) out += d;
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && d === "*") {
      block = true;
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return out;
}

/** Repo-relative candidate paths for a first-party module specifier. */
export function resolveLeafSpecifier(specifier, fromFile = IN_SCOPE_FILE) {
  let raw;
  if (specifier.startsWith("@/")) raw = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    raw = `${fromFile.slice(0, fromFile.lastIndexOf("/"))}/${specifier}`;
  } else return []; // bare package — never a first-party DDL leaf
  const parts = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const base = parts.join("/");
  return base ? [`${base}.ts`, `${base}/index.ts`] : [];
}

/**
 * The DDL leaves drizzle-store.ts reaches by spread, in ONE revision of it.
 * @param {string} content a full drizzle-store.ts revision
 * @returns {Map<string, Set<string>>} repo path -> exported names spread in
 */
export function findDdlLeafModules(content) {
  const leaves = new Map();
  const region = findSchemaRegions(content).find((r) => r.kind === "executed-ddl");
  if (!region) return leaves;
  const lines = content.split("\n");
  const spread = new Set();
  for (const m of stripComments(lines.slice(region.start, region.end).join("\n")).matchAll(DDL_LEAF_SPREAD_RE)) {
    spread.add(m[1]);
  }
  if (spread.size === 0) return leaves;
  for (const stmt of stripComments(content).matchAll(NAMED_IMPORT_RE)) {
    for (const clause of stmt[1].split(",")) {
      const [exported, alias] = clause.trim().split(/\s+as\s+/);
      if (!exported) continue;
      // The LOCAL name is what the spread writes; the EXPORTED name identifies
      // the builder inside the leaf.
      if (!spread.has((alias ?? exported).trim())) continue;
      for (const p of resolveLeafSpecifier(stmt[2])) {
        if (!leaves.has(p)) leaves.set(p, new Set());
        leaves.get(p).add(exported.trim());
      }
    }
  }
  return leaves;
}

/**
 * Local functions of drizzle-store.ts that the executed-DDL region SPREADS in —
 * `...buildEmailCorrelationIndexQueries(schemaName),` is the live example. Their
 * bodies sit outside both named regions, yet every statement they return is
 * executed core-store DDL, so they are in-scope regions of this file too.
 * @param {string} content a full drizzle-store.ts revision
 * @returns {Array<{name: string, start: number, end: number}>} 1-based inclusive
 */
export function findLocalDdlHelpers(content) {
  const region = findSchemaRegions(content).find((r) => r.kind === "executed-ddl");
  if (!region) return [];
  const code = stripComments(content);
  const lines = code.split("\n");
  const imported = new Set();
  for (const m of code.matchAll(/import\s+(?:type\s+)?([^;]*?)\s*from\s*["'][^"']+["']/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().replace(/^\{|\}$/g, "").trim();
      if (!t) continue;
      const local = t.startsWith("* as ") ? t.slice(5).trim() : (t.split(/\s+as\s+/)[1] ?? t).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) imported.add(local);
    }
  }
  const helpers = [];
  const seen = new Set();
  for (const m of lines.slice(region.start, region.end).join("\n").matchAll(/\.\.\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (imported.has(name) || seen.has(name)) continue;
    seen.add(name);
    const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
    const start = lines.findIndex((l) => re.test(l));
    if (start === -1) continue; // not a local function declaration — unresolved
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\}/.test(lines[i])) {
        end = i + 1;
        break;
      }
    }
    helpers.push({ name, start: start + 1, end });
  }
  return helpers;
}

/** The text of one helper's body, for leafDdlLines. */
export function helperBody(content, helper) {
  return content.split("\n").slice(helper.start, helper.end).join("\n");
}

/**
 * The identifiers a file binds to the schema-name escape — `s` in
 * `const s = schemaName.replaceAll('"', '""');`. ONLY these (and the escape
 * expression written out in full) are treated as the same schema when matching
 * a relocation, so a leaf that quietly points its DDL at a DIFFERENT schema is
 * NOT a relocation and its removals still red.
 *
 * The binding must be UNAMBIGUOUS. A name the file binds more than once — a
 * second declaration, a later reassignment, or a function parameter that
 * shadows it (`function q(s = "shadow_schema")`) — is DROPPED, because the gate
 * cannot tell which binding a given `${s}` resolves to. A dropped alias means
 * its lines simply do not normalize, so the relocation does not match and the
 * removal still reds: the ambiguity costs a refusal, never a waiver.
 */
export function schemaNameAliases(content) {
  const code = stripComments(content);
  /** id -> distinct binding SITES (by offset, so one site is counted once). */
  const sites = new Map();
  const note = (id, at) => {
    if (!sites.has(id)) sites.set(id, new Set());
    sites.get(id).add(at);
  };
  const qualifying = new Set();
  for (const m of code.matchAll(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    // Offset of the IDENTIFIER, searched past the keyword — the same site the
    // assignment scan below reports, so a declaration counts once, not twice.
    note(m[2], m.index + m[0].indexOf(m[2], m[1].length));
    if (SCHEMA_ESCAPE_RE.test(m[3].replace(/\s+/g, ""))) qualifying.add(m[2]);
  }
  // Assignment targets (declarations re-match here at the same offset), INCLUDING
  // the compound forms — `s += "_shadow"` mutates the schema just as surely as
  // `s = "shadow"` does. Comparison operators (`>=`, `<=`, `!=`, `===`) are
  // excluded by the operator alternation plus the `=(?!=)` tail.
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*(?:\*\*|<<|>>>|>>|&&|\|\||\?\?|[+\-*/%&|^])?=(?!=)/g)) {
    note(m[1], m.index + m[0].indexOf(m[1]));
  }
  // Parameter lists of function declarations and arrows — the shadowing form.
  for (const m of code.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>/g)) {
    const params = m[1] ?? m[2] ?? "";
    for (const p of params.split(",")) {
      const id = p.trim().match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (id) note(id, m.index + m[0].indexOf(p));
    }
  }
  return new Set([...qualifying].filter((id) => sites.get(id)?.size === 1));
}

/**
 * Spread callees inside the executed-DDL region that the gate CANNOT pin to a
 * first-party leaf file, restricted to identifiers drizzle-store.ts IMPORTS —
 * `import * as leaf` + `...leaf.queries(x)`, a default import, an aliased
 * re-export. Those compose executed DDL out of a module the classifier never
 * sees, so ADDING one fails the gate closed rather than opening a blind spot.
 * Spreads of LOCAL values (`...queries.filter(…)`) are not import-bound and are
 * deliberately not reported — they compose lines this file already carries.
 * @param {string} content a full drizzle-store.ts revision
 * @returns {Set<string>} unresolvable import-bound spread roots
 */
export function unresolvedLeafSpreads(content) {
  const region = findSchemaRegions(content).find((r) => r.kind === "executed-ddl");
  if (!region) return new Set();
  const code = stripComments(content);
  const body = stripComments(content.split("\n").slice(region.start, region.end).join("\n"));
  const imported = new Set();
  for (const m of code.matchAll(/import\s+(?:type\s+)?([^;]*?)\s*from\s*["'][^"']+["']/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().replace(/^\{|\}$/g, "").trim();
      if (!t) continue;
      const local = t.startsWith("* as ") ? t.slice(5).trim() : (t.split(/\s+as\s+/)[1] ?? t).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) imported.add(local);
    }
  }
  // The LOCAL names a first-party named import binds — exactly what
  // findDdlLeafModules can pin to a file.
  const resolved = new Set();
  for (const stmt of code.matchAll(NAMED_IMPORT_RE)) {
    if (resolveLeafSpecifier(stmt[2]).length === 0) continue;
    for (const clause of stmt[1].split(",")) {
      const [exported, alias] = clause.trim().split(/\s+as\s+/);
      if (exported) resolved.add((alias ?? exported).trim());
    }
  }
  const unresolved = new Set();
  // `...root(` and `...root.member(`. A BARE call must resolve either to an
  // imported leaf or to a LOCAL FUNCTION whose body findLocalDdlHelpers scopes
  // in — anything else (`const alias = evilQueries; ...alias(x)`) composes
  // executed DDL the classifier never reads. The MEMBER form is reported only
  // for an IMPORTED root (`import * as leaf` / a default import): a member call
  // on a local value is this file's own composition of lines it already
  // carries — `...queries.filter(…)`.
  const localHelpers = new Set(findLocalDdlHelpers(content).map((h) => h.name));
  for (const m of body.matchAll(/\.\.\.([A-Za-z_$][\w$]*)(\s*\.\s*[\w$]+)?\s*\(/g)) {
    const root = m[1];
    if (m[2]) {
      if (imported.has(root)) unresolved.add(`${root}${m[2].replace(/\s+/g, "")}`);
      continue;
    }
    if (!resolved.has(root) && !localHelpers.has(root)) unresolved.add(root);
  }
  return unresolved;
}

/**
 * Canonical form of a DDL line for CROSS-FILE relocation matching only.
 *
 * ONLY a schema-name interpolation collapses — `${s}` inside a leaf and
 * `${schemaName.replaceAll('"', '""')}` inline name the same schema, and that is
 * the only spelling difference a relocation legitimately introduces. Every other
 * `${…}` is left VERBATIM, so a changed FK target, predicate, generated
 * constraint or hardcoded schema keeps the two lines distinct and the removal
 * red. Whitespace collapses so re-indentation does not defeat the match. The
 * SAME-FILE cancellation keeps its exact-text key — this normalization never
 * loosens a comparison the gate makes today.
 */
export function normalizeDdlLine(text, aliases = new Set()) {
  return text
    .replace(/\$\{([^{}]*)\}/g, (whole, expr) => {
      const e = expr.replace(/\s+/g, "");
      return SCHEMA_ESCAPE_RE.test(e) || aliases.has(e) ? "${SCHEMA}" : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One leaf revision's in-scope lines, in the shape classifyDrizzleStoreDiff
 * builds for drizzle-store.ts so both feed one pool. The whole file is DDL (see
 * the block comment above); the nearest enclosing CREATE/ALTER TABLE gives each
 * line its cancellation table, exactly as inline DDL gets it.
 * @param {string} origin repo path — also the cancellation identity
 * @param {string} content one full revision of the leaf ("" when absent)
 */
export function leafDdlLines(origin, content) {
  if (!content) return [];
  const aliases = schemaNameAliases(content);
  const region = { name: origin, kind: "executed-ddl", start: 0, end: Number.MAX_SAFE_INTEGER };
  const out = [];
  let table = null;
  for (const text of content.split("\n")) {
    const m = text.match(TABLE_REF_RE);
    if (m) table = m[1];
    const trimmed = text.trim();
    out.push({ text, trimmed, origin, region, table, norm: normalizeDdlLine(trimmed, aliases) });
  }
  return out;
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
 * @param {{added: Array, removed: Array}} [leafLines] in-scope DDL LEAF lines
 *   (cinatra#2625) from leafDdlLines — the leaves' POST-CHANGE content as
 *   `added`, their BASE content as `removed`. They join the same pools as this
 *   file's own lines, so a relocation cancels across files and a leaf's own DDL
 *   is classified by the same rules.
 * @returns {{destructive: Array<{rule: string, line: string, doc: string}>,
 *   notices: string[], inScopeChanges: number}}
 */
export function classifyDrizzleStoreDiff(fileDiff, baseContent, leafLines = { added: [], removed: [] }, finalContent = null) {
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

  // Identifiers THIS file binds to the schema-name escape — the only
  // interpolation the cross-file relocation match is allowed to collapse. Each
  // SIDE reads its own revision: a base alias that the diff rebinds must not
  // vouch for an added line's `${s}`.
  const removedAliases = schemaNameAliases(baseContent);
  const addedAliases = typeof finalContent === "string" ? schemaNameAliases(finalContent) : removedAliases;

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
        if (region) removed.push({ text: l.text, trimmed: l.text.trim(), baseLine: oldLine, region, origin: IN_SCOPE_FILE, table: baseTableContext(oldLine, region), norm: normalizeDdlLine(l.text.trim(), removedAliases) });
        oldLine++;
      } else if (l.type === "add") {
        const region = regionAtInsertion(regions, oldLine);
        if (region) added.push({ text: l.text, trimmed: l.text.trim(), before: oldLine, region, origin: IN_SCOPE_FILE, table: newSideTable ?? baseTableContext(oldLine, region), norm: normalizeDdlLine(l.text.trim(), addedAliases) });
      } else {
        oldLine++;
      }
    }
  }

  // DDL LEAF lines (cinatra#2625) join the SAME pools: the composed DDL is one
  // schema, so a statement that left this file for a spread-in leaf must be
  // matched against the leaf's lines, and a leaf's own DDL must face the same
  // destructive rules.
  added.push(...(leafLines?.added ?? []));
  removed.push(...(leafLines?.removed ?? []));

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

  // RELOCATION across in-scope regions (cinatra#2625): a line removed from one
  // FILE and added in ANOTHER, under the same table, MOVED — it is still
  // executed against every deployed database, so it is not a drop. Matched on
  // `norm`, which differs from the exact text ONLY in collapsing a verified
  // schema-name interpolation (`${s}` in a leaf vs
  // `${schemaName.replaceAll('"', '""')}` inline). Same-file pairs are excluded
  // outright: stage 1 above owns those with the exact-text key, so no comparison
  // the gate makes today is loosened by this pass. An uncancelled removal falls
  // through to the drop rules exactly as before.
  const relocKey = (l) => `${l.table ?? ""}@@${l.norm ?? l.trimmed}`;
  const relocPool = new Map();
  for (const a of unmatchedAdded) {
    const key = relocKey(a);
    relocPool.set(key, (relocPool.get(key) ?? []).concat(a));
  }
  const relocatedAdds = new Set();
  const relocations = new Map();
  const survivingRemoved = [];
  for (const r of unmatchedRemoved) {
    const pool = relocPool.get(relocKey(r));
    const match = pool?.find((a) => a.origin !== r.origin && !relocatedAdds.has(a));
    if (!match) {
      survivingRemoved.push(r);
      continue;
    }
    relocatedAdds.add(match);
    const key = `${r.origin} -> ${match.origin}`;
    relocations.set(key, (relocations.get(key) ?? 0) + 1);
  }
  for (const [pair, count] of relocations) {
    notices.push(`${count} in-scope DDL line(s) relocated between in-scope regions (${pair}) — same executed schema, no data impact`);
  }

  const effective = (arr) => arr.filter((l) => !COMMENT_OR_BLANK_RE.test(l.trimmed));
  const remEff = effective(survivingRemoved);
  const addEff = effective(unmatchedAdded.filter((a) => !relocatedAdds.has(a)));
  const inScopeChanges = remEff.length + addEff.length;

  // Every table the BASE side of an in-scope region named already exists on
  // deployed databases — including a table whose CREATE merely MOVED, whose
  // relocated copy cancelled above. Subtracting these from the new-table
  // carve-out closes the multiplicity laundering a second, uncancelled copy of
  // a relocated CREATE would otherwise buy (codex round 1, finding B): the
  // surviving copy can no longer make a deployed table look brand new.
  const preExistingTables = new Set();
  for (const r of removed) {
    if (r.table) preExistingTables.add(r.table);
    const m = r.trimmed.match(TABLE_REF_RE) ?? r.trimmed.match(INDEX_TABLE_RE);
    if (m) preExistingTables.add(m[1]);
  }

  // Tables created by this diff (their columns/constraints/indexes are
  // additive: no pre-existing rows — migrations/README.md "Additive").
  const newTables = new Set();
  for (const a of addEff) {
    const m = a.trimmed.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:.*?\.)?"([a-z0-9_]+)"/i);
    if (m && !preExistingTables.has(m[1])) newTables.add(m[1]);
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
// + its per-migration manifest fragment in migrations/manifest.d/, in the
// same PR). Legacy migrations/NNNN_*.sql artifacts are shipped history:
// protected against deletion, but REJECTED as the artifact form for new
// migrations — the core runner never executes them. The legacy manifest.json
// array is likewise frozen: rewrites AND appends are rejected.
// ---------------------------------------------------------------------------

/**
 * Two problem classes come back separately:
 *   - `integrity` — tampering with SHIPPED migration state (delete / rename /
 *     edit of a shipped artifact or manifest fragment, a rewritten legacy
 *     manifest entry, an unrecognized file under migrations/manifest.d/) or a
 *     migrations/core/ addition that would brick the runner's boot preflight
 *     (malformed filename, duplicate seq). These FAIL the gate on their own,
 *     destructive schema change or not.
 *   - `problems` — an incomplete/wrong-form artifact for THIS PR's change,
 *     or a ledger-union inconsistency introduced by it (duplicate seq across
 *     forms, non-monotonic fragment seq, a legacy-array append). These also
 *     fail the gate on their own (see runGate).
 *
 * @param {Array} files parsed diff files
 * @param {(path: string) => string|null} readBaseFile
 * @param {(dir: string) => string[]|null} listBaseDir base-side directory
 *   listing (basenames), null when the directory does not exist on base —
 *   needed so base-vs-final manifest.d/ directory diffs are checked, not just
 *   known paths.
 * @param {Map<string, {baseSha256: string, correctedSha256: string, justification: string}>} [correctionExemptions]
 *   one-shot poison-pill correction pins (injectable for tests; defaults to
 *   the reviewed live map).
 * @returns {{complete: boolean, artifactFiles: string[], problems: string[], integrity: string[], corrections: string[], newEntries: Array}}
 */
export function detectMigrationArtifact(
  files,
  readBaseFile,
  listBaseDir = () => null,
  correctionExemptions = SHIPPED_MODULE_CORRECTION_EXEMPTIONS,
) {
  const problems = [];
  const integrity = [];
  /** Exempted in-place poison-pill corrections — surfaced as notices, never failures. */
  const corrections = [];
  /** Added runner modules (full paths) — the only artifact form new migrations may ship. */
  const moduleFiles = [];
  /** Added manifest fragments: {path, name, raw}. */
  const addedFragments = [];

  const baseManifestRaw = readBaseFile(MIGRATION_MANIFEST_PATH);
  let baseEntries = [];
  if (baseManifestRaw !== null) {
    try {
      baseEntries = JSON.parse(baseManifestRaw)?.migrations ?? [];
    } catch {
      problems.push(`${MIGRATION_MANIFEST_PATH} (base) is not parseable JSON`);
    }
  }

  // The BASE ledger union: frozen legacy entries + already-shipped fragments.
  // Enumerated from the base side (not the diff) so a new fragment colliding
  // with a shipped fragment that this diff never touches is still caught.
  // NOTE (inherited anchoring): "base" is the same merge-base the whole gate
  // diffs against, so like the legacy tail check this is PR-time state — the
  // push-triggered run on the target branch re-checks what actually landed.
  const baseFragmentReads = (listBaseDir(MIGRATION_FRAGMENT_DIR) ?? []).map((name) => ({
    name,
    raw: readBaseFile(`${MIGRATION_FRAGMENT_DIR}/${name}`),
  }));
  // A listed-but-unreadable base fragment must not silently vanish from the
  // union — its seq would stop guarding uniqueness/monotonicity.
  for (const f of baseFragmentReads) {
    if (typeof f.raw !== "string") {
      problems.push(`ledger union (base): ${MIGRATION_FRAGMENT_DIR}/${f.name}: listed on the base revision but unreadable — cannot trust the base ledger union`);
    }
  }
  const baseFragments = baseFragmentReads.filter((f) => typeof f.raw === "string");
  const baseUnion = buildManifestUnion({ legacyEntries: baseEntries, fragments: baseFragments });
  const baseUnionErrors = new Set(baseUnion.errors);
  const baseUnionSeqs = new Set(baseUnion.entries.map((e) => String(e?.seq).padStart(4, "0")));
  const maxShippedSeq = baseUnion.entries.reduce((m, e) => Math.max(m, Number(e?.seq) || 0), 0);

  for (const f of files) {
    // Fail CLOSED on a file whose paths could never be reliably parsed on
    // BOTH sides (C-quoted unusual bytes, or an ambiguous ` b/` segment in a
    // header-only diff) when its header references migrations/ — an
    // unparseable path must not become an unprotected one, and one confirmed
    // side never vouches for the other.
    if ((f.oldConfirmed === false || f.newConfirmed === false) && typeof f.headerLine === "string" && f.headerLine.includes("migrations/")) {
      integrity.push(
        `${f.headerLine}: cannot reliably parse this diff header (unusual path); files under migrations/ must use plain ASCII paths so the gate can verify them`,
      );
      continue;
    }
    // Renames are checked on BOTH sides first: `newPath ?? oldPath` alone
    // would let a shipped artifact be renamed OUT of migrations/ (new path
    // elsewhere) without ever entering the branches below.
    if (f.status === "renamed") {
      const touchesShippedState = [f.oldPath, f.newPath].some(
        (side) =>
          side &&
          (MIGRATION_MODULE_RE.test(side) ||
            MIGRATION_SQL_RE.test(side) ||
            side === MIGRATION_MANIFEST_PATH ||
            side.startsWith(`${MIGRATION_FRAGMENT_DIR}/`)),
      );
      if (touchesShippedState) {
        integrity.push(`${f.oldPath} -> ${f.newPath}: shipped migration state must never be renamed or moved (append-only — supersede it with a new sequence number)`);
      }
      continue;
    }
    const p = f.newPath ?? f.oldPath;
    if (!p || !p.startsWith("migrations/")) continue;

    if (p.startsWith(`${MIGRATION_FRAGMENT_DIR}/`)) {
      const name = p.slice(`${MIGRATION_FRAGMENT_DIR}/`.length);
      if (f.status !== "added") {
        // A shipped fragment is immutable ledger history backing rows on every
        // deployed database: edits AND deletions are tampering (renames were
        // handled above).
        integrity.push(`${p}: a shipped manifest fragment must never be ${f.status === "modified" ? "edited" : f.status} (append-only — supersede it with a new sequence number)`);
        continue;
      }
      if (name.includes("/") || !FRAGMENT_FILE_RE.test(name)) {
        // Malformed/unrecognized files under manifest.d/ are errors, not
        // skips — the union reader refuses them at every consumer.
        integrity.push(`${p}: unrecognized file under ${MIGRATION_FRAGMENT_DIR}/ — every file there must be a per-migration fragment named core__NNNN_<slug>.json (see migrations/README.md)`);
        continue;
      }
      // A fragment must be a REGULAR file: a symlink (120000) or gitlink
      // (160000) whose target text happens to parse as JSON would pass a
      // content check here yet be refused by the union reader's regular-file
      // rule at every consumer — reject it at the PR instead.
      if (f.newMode && f.newMode !== "100644" && f.newMode !== "100755") {
        integrity.push(`${p}: must be a regular file (git mode 100644), not mode ${f.newMode} — the union reader refuses non-regular files under ${MIGRATION_FRAGMENT_DIR}/`);
        continue;
      }
      const raw = applyFileDiff("", f);
      if (raw === null) {
        problems.push(`${p}: could not reconstruct the added fragment from the diff`);
        continue;
      }
      addedFragments.push({ path: p, name, raw });
      continue;
    }

    if (p.startsWith("migrations/core/")) {
      const basename = p.slice("migrations/core/".length);
      if (basename.includes("/") || basename.startsWith(".")) continue; // nested/dotfiles: not artifacts
      const isModule = MIGRATION_MODULE_RE.test(p);
      if (f.status !== "added") {
        // A shipped module is immutable history backing ledger rows on every
        // deployed database: deletion AND edits are tampering (renames were
        // handled above). ONE exception: the exact ONE-SHOT content transition
        // of a listed poison-pill correction (a body that can never have
        // completed anywhere and cannot be superseded) — verified against the
        // recorded base AND corrected sha256 pins, fail-closed on any
        // reconstruction failure. See SHIPPED_MODULE_CORRECTION_EXEMPTIONS.
        if (isModule) {
          const exemption =
            f.status === "modified" ? correctionExemptions.get(basename) : undefined;
          if (exemption) {
            const baseContent = readBaseFile(p);
            const resultContent = baseContent === null ? null : applyFileDiff(baseContent, f);
            const baseOk = baseContent !== null && contentDigest(baseContent) === exemption.baseSha256;
            const resultOk =
              resultContent !== null && contentDigest(resultContent) === exemption.correctedSha256;
            if (baseOk && resultOk) {
              corrections.push(
                `${p}: in-place correction of a shipped poison-pill module (maintainer-reviewed one-shot exemption, base ${exemption.baseSha256.slice(0, 12)} -> corrected ${exemption.correctedSha256.slice(0, 12)}): ${exemption.justification}`,
              );
            } else {
              integrity.push(
                `${p}: edit does not match the recorded one-shot poison-pill correction transition ` +
                  `(expected base sha256 ${exemption.baseSha256.slice(0, 12)}… -> corrected ${exemption.correctedSha256.slice(0, 12)}…) — ` +
                  `a shipped core migration module must never be edited (append-only — supersede it with a new sequence number)`,
              );
            }
          } else {
            integrity.push(`${p}: a shipped core migration module must never be ${f.status === "modified" ? "edited" : f.status} (append-only — supersede it with a new sequence number)`);
          }
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
  const artifactFiles = [];
  const seenSeqs = new Set();
  for (const p of moduleFiles) {
    if (legacyBackfillPaths.has(p)) continue;
    const seq = p.match(MIGRATION_MODULE_RE)[1];
    if (baseUnionSeqs.has(seq)) {
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

  // The legacy manifest's contract is checked WHENEVER it changed — a
  // manifest-only rewrite (no module in the diff) is tampering with shipped
  // state, and the array is FROZEN (#1335): gaining entries is rejected too,
  // forcing fragment authoring.
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
        // Append-only: the base entries must be an untouched prefix …
        for (let i = 0; i < baseEntries.length; i++) {
          if (JSON.stringify(finalEntries[i]) !== JSON.stringify(baseEntries[i])) {
            integrity.push(`${MIGRATION_MANIFEST_PATH}: existing entry ${i + 1} was rewritten — the ledger is append-only (supersede with a new sequence number)`);
          }
        }
        // … and FROZEN: new entries are authored as fragments, never appended
        // to the shared positional tail (the merge hotspot #1335 removes).
        if (finalEntries.length > baseEntries.length) {
          problems.push(
            `${MIGRATION_MANIFEST_PATH}: the legacy array is frozen — author the new entry as a per-migration fragment ${MIGRATION_FRAGMENT_DIR}/core__NNNN_<slug>.json instead (one file per migration; see migrations/README.md)`,
          );
        }
      }
    }
  }

  // The FINAL ledger union: the post-change legacy array + shipped fragments
  // + fragments added in this diff. Union errors the base did not already
  // carry (duplicate seq across forms or within the diff, malformed
  // fragments) were introduced by this PR.
  const finalUnion = buildManifestUnion({
    legacyEntries: finalEntries ?? baseEntries,
    fragments: [...baseFragments, ...addedFragments.map(({ name, raw }) => ({ name, raw }))],
  });
  for (const err of finalUnion.errors) {
    if (!baseUnionErrors.has(err)) problems.push(`ledger union: ${err}`);
  }
  // A broken BASE union is not this PR's doing but the gate's arithmetic
  // cannot be trusted over it — fail loudly rather than guessing.
  for (const err of baseUnion.errors) problems.push(`ledger union (base): ${err}`);

  // New ledger entries = the entries of fragments added in this diff (the
  // union above already rejected malformed ones; parse errors are not
  // re-reported here).
  const newEntries = addedFragments
    .map(({ path, name, raw }) => ({ path, entry: parseFragment(name, raw).entry }))
    .filter((f) => f.entry !== null)
    .sort((a, b) => Number(a.entry.seq) - Number(b.entry.seq));

  // Monotonicity over the union: a new fragment's seq must be strictly
  // greater than the max SHIPPED seq on base — the same rule that today
  // guarantees a seq below an already-deployed ledger head can never land.
  // (Uniqueness over the union is enforced by the union errors above.)
  for (const { path, entry } of newEntries) {
    if (Number(entry.seq) <= maxShippedSeq) {
      problems.push(
        `${path}: new fragment seq '${entry.seq}' must be strictly greater than the max shipped seq (${String(maxShippedSeq).padStart(4, "0")})`,
      );
    }
  }

  // Every new ledger entry must bind to a runner module added in THIS diff —
  // a fragment-only entry cannot stand in for the migration it claims — and
  // vice versa. (entry.file == core/<fragment stem>.mjs and entry.seq ==
  // filename seq are already enforced by the fragment contract.)
  // entry.file is relative to migrations/ (e.g. "core/core__0003_x.mjs").
  const moduleRelPaths = new Set(artifactFiles.map((p) => p.slice("migrations/".length)));
  for (const { path, entry } of newEntries) {
    if (!moduleRelPaths.has(entry.file)) {
      problems.push(`${path}: entry '${entry.file}' has no matching migrations/core/ module added in this diff`);
    }
  }
  const newEntryFiles = new Set(newEntries.map(({ entry }) => entry.file));
  for (const p of artifactFiles) {
    const rel = p.slice("migrations/".length);
    if (!newEntryFiles.has(rel)) {
      problems.push(
        `${p}: no matching manifest fragment (add ${MIGRATION_FRAGMENT_DIR}/${p.slice("migrations/core/".length).replace(/\.mjs$/, ".json")} with "file": '${rel}' — both pieces are required, in the same PR)`,
      );
    }
  }

  return {
    complete: problems.length === 0 && integrity.length === 0 && artifactFiles.length > 0,
    artifactFiles,
    problems,
    integrity,
    corrections,
    newEntries: newEntries.map(({ entry }) => entry),
  };
}

// ---------------------------------------------------------------------------
// Gate driver
// ---------------------------------------------------------------------------

/**
 * Run the gate over a unified diff.
 * @param {{diffText: string, readBaseFile: (path: string) => string|null,
 *   listBaseDir?: (dir: string) => string[]|null}} input
 * @returns {{verdict: "pass"|"fail", destructive: Array, artifact: ReturnType<typeof detectMigrationArtifact>,
 *   notices: string[], ignored: string[], inScopeChanges: number}}
 */
export function runGate({
  diffText,
  readBaseFile,
  listBaseDir = () => null,
  correctionExemptions = SHIPPED_MODULE_CORRECTION_EXEMPTIONS,
}) {
  const files = parseUnifiedDiff(diffText);
  const notices = [];
  const ignored = [];
  let destructive = [];
  let inScopeChanges = 0;

  // ---- DDL LEAF pre-pass (cinatra#2625) ---------------------------------
  // Which files carry executed core-store DDL by spread must be known BEFORE
  // any file is classified — a leaf can appear in the diff before (or without)
  // drizzle-store.ts. Each leaf contributes its FULL content per side: the BASE
  // revision as `removed` when the spread reached it on base, the POST-CHANGE
  // revision as `added` when it reaches it after. Cancellation reduces that to
  // the real delta, and both REACHABILITY edges fall out of it — a spread added
  // for an untouched leaf makes its DDL an addition, a spread REMOVED from an
  // untouched leaf makes its DDL a removal, and a leaf renamed together with its
  // import cancels across the two paths.
  const storeDiff = files.find((f) => f.newPath === IN_SCOPE_FILE || f.oldPath === IN_SCOPE_FILE);
  const storeBase = readBaseFile(IN_SCOPE_FILE);
  const storeFinal =
    typeof storeBase === "string" && storeDiff && storeDiff.status === "modified"
      ? applyFileDiff(storeBase, storeDiff)
      : storeBase;
  const baseLeaves = typeof storeBase === "string" ? findDdlLeafModules(storeBase) : new Map();
  const finalLeaves = typeof storeFinal === "string" ? findDdlLeafModules(storeFinal) : new Map();

  const leafLines = { added: [], removed: [] };
  const leafDiffOf = (p) => files.find((f) => f.newPath === p || f.oldPath === p) ?? null;
  /** The two revisions of one leaf path, or null when it cannot be pinned. */
  const leafRevisions = (p) => {
    const f = leafDiffOf(p);
    if (!f) {
      const content = readBaseFile(p);
      // An unresolvable candidate (resolveLeafSpecifier offers both `x.ts` and
      // `x/index.ts`; only one exists) simply contributes nothing.
      return typeof content === "string" ? { base: content, final: content } : null;
    }
    if (f.status === "added") return { base: "", final: applyFileDiff("", f) };
    // A rename carries its content on the OLD path; its hunks (if any) apply to
    // that content, so both revisions come from the one diff entry.
    const base = readBaseFile(f.oldPath ?? p);
    if (typeof base !== "string") return null;
    return { base, final: f.status === "deleted" ? "" : applyFileDiff(base, f) };
  };

  const candidatePaths = [...new Set([...baseLeaves.keys(), ...finalLeaves.keys()])];
  const revisions = new Map();
  for (const p of candidatePaths) {
    const rev = leafRevisions(p);
    if (rev === null || rev.final === null) {
      // Fail CLOSED: a leaf whose content the gate cannot pin is a leaf whose
      // DDL it cannot classify, and a relocation into it must not be waived.
      if (leafDiffOf(p)) {
        destructive.push({
          rule: "ddl-leaf-unreadable",
          line: p,
          doc: "could not reconstruct both revisions of a DDL leaf module spread into buildCreateStoreSchemaQueries — its executed DDL cannot be classified",
        });
      }
      continue;
    }
    revisions.set(p, rev);
  }

  // `x.ts` vs `x/index.ts`: resolveLeafSpecifier offers both, but TypeScript
  // executes exactly ONE — `x.ts` when it exists. The preference is applied PER
  // SIDE against that side's file set, so a PR that ADDS `x.ts` beside a base
  // `x/index.ts` still reads the index leaf on the BASE side; dropping it from
  // both would silently forget the DDL that revision actually created.
  const shadowedOnSide = (p, side) => {
    if (!p.endsWith("/index.ts")) return false;
    const sibling = p.replace(/\/index\.ts$/, ".ts");
    return (revisions.get(sibling)?.[side] ?? "") !== "";
  };

  for (const [p, rev] of revisions) {
    if (baseLeaves.has(p) && !shadowedOnSide(p, "base")) leafLines.removed.push(...leafDdlLines(p, rev.base));
    if (finalLeaves.has(p) && !shadowedOnSide(p, "final")) leafLines.added.push(...leafDdlLines(p, rev.final));
  }

  // LOCAL helper regions of drizzle-store.ts itself: the executed-DDL region
  // spreads them in, but their bodies sit outside both named regions, so their
  // DDL was invisible. Contributed per side under their own origin, exactly like
  // a leaf — unchanged bodies cancel, an edited one is classified.
  for (const [content, bucket] of [
    [storeBase, leafLines.removed],
    [storeFinal, leafLines.added],
  ]) {
    if (typeof content !== "string") continue;
    for (const h of findLocalDdlHelpers(content)) {
      bucket.push(...leafDdlLines(`${IN_SCOPE_FILE}#${h.name}`, helperBody(content, h)));
    }
  }

  // A spread the resolver cannot pin composes executed DDL out of a module the
  // classifier never sees. ADDING one is refused rather than silently trusted —
  // `import * as leaf` + `...leaf.queries(x)`, a default import, an aliased
  // re-export. Only NEWLY ADDED spread lines are reported, so an existing one
  // never reds an unrelated PR.
  if (typeof storeFinal === "string" && storeDiff) {
    const unresolved = unresolvedLeafSpreads(storeFinal);
    const addedSpreads = new Set();
    for (const hunk of storeDiff.hunks) {
      for (const l of hunk.lines) {
        if (l.type !== "add") continue;
        for (const m of stripComments(l.text).matchAll(/\.\.\.([A-Za-z_$][\w$]*)(\s*\.\s*[\w$]+)?\s*\(/g)) {
          const name = m[2] ? `${m[1]}${m[2].replace(/\s+/g, "")}` : m[1];
          if (unresolved.has(name)) addedSpreads.add(name);
        }
      }
    }
    for (const name of addedSpreads) {
      destructive.push({
        rule: "ddl-leaf-unresolved",
        line: `...${name}(…)`,
        doc: "a spread added to buildCreateStoreSchemaQueries composes executed DDL from a module the gate cannot resolve — bind the leaf with a plain named import from a first-party path (`import { xQueries } from \"@/lib/x-schema\"`) so its DDL is classified, or update scripts/audit/schema-migration-gate.mjs in the same PR",
      });
    }
  }
  let leafLinesConsumed = false;

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
      const result = classifyDrizzleStoreDiff(f, baseContent, leafLines, typeof storeFinal === "string" ? storeFinal : null);
      leafLinesConsumed = true;
      destructive = destructive.concat(result.destructive);
      notices.push(...result.notices);
      inScopeChanges += result.inScopeChanges;
    } else if (OUT_OF_SCOPE_FILES.has(path) || (f.oldPath && OUT_OF_SCOPE_FILES.has(f.oldPath))) {
      ignored.push(`${path} (out of scope: owned by Better Auth / extension migrations — see migrations/README.md)`);
    }
    // every other file: not schema-bearing for this gate
  }

  // A diff that touches a DDL leaf but NOT drizzle-store.ts still changes the
  // executed schema — classify the leaf lines on their own rather than letting
  // them fall out of the gate with the schema file absent.
  if (!leafLinesConsumed && (leafLines.added.length > 0 || leafLines.removed.length > 0) && typeof storeBase === "string") {
    const result = classifyDrizzleStoreDiff({ hunks: [] }, storeBase, leafLines, typeof storeFinal === "string" ? storeFinal : null);
    destructive = destructive.concat(result.destructive);
    notices.push(...result.notices);
    inScopeChanges += result.inScopeChanges;
  }

  const artifact = detectMigrationArtifact(files, readBaseFile, listBaseDir, correctionExemptions);
  // Exempted poison-pill corrections pass, but LOUDLY — the exemption and its
  // recorded justification always appear in the gate output for review.
  notices.push(...artifact.corrections);
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
      artifact.problems.push(`${MIGRATION_FRAGMENT_DIR}: a user-land-affecting change needs a new fragment with "destructive": true`);
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
  let listBaseDir;

  if (diffFileIdx !== -1) {
    const diffPath = argv[diffFileIdx + 1];
    if (!diffPath) {
      console.error("[schema-migration-gate] --diff-file requires a path");
      process.exit(2);
    }
    diffText = readFileSync(resolve(diffPath), "utf8");
    // Base resolution for --diff-file mode. By default the working tree IS the
    // diff's base. --base-dir <dir> overlays a pinned base on top of the tree:
    // a file present under <dir> is read from there, otherwise the working tree
    // wins. The fixture corpus pins migrations/manifest.json this way so the
    // ledger's append-only tail can't rot the fixtures as real migrations land.
    const baseDirIdx = argv.indexOf("--base-dir");
    const baseDir = baseDirIdx !== -1 ? argv[baseDirIdx + 1] : null;
    if (baseDirIdx !== -1 && !baseDir) {
      console.error("[schema-migration-gate] --base-dir requires a path");
      process.exit(2);
    }
    const baseDirAbs = baseDir ? resolve(baseDir) : null;
    readBaseFile = (p) => {
      if (baseDirAbs) {
        const pinned = join(baseDirAbs, p);
        if (existsSync(pinned)) return readFileSync(pinned, "utf8");
      }
      const abs = join(REPO_ROOT, p);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    };
    // Directory listings follow the same overlay, EXCLUSIVELY: when the pinned
    // base carries the directory, its listing wins outright (the fixture
    // corpus pins migrations/manifest.d/ so live fragments landing later
    // cannot rot the fixtures).
    listBaseDir = (dir) => {
      if (baseDirAbs) {
        const pinned = join(baseDirAbs, dir);
        if (existsSync(pinned)) return readdirSync(pinned);
      }
      const abs = join(REPO_ROOT, dir);
      return existsSync(abs) ? readdirSync(abs) : null;
    };
  } else {
    const base = resolveBase();
    let mergeBase;
    try {
      mergeBase = git(["merge-base", "--end-of-options", base, "HEAD"]).trim();
    } catch {
      mergeBase = base;
    }
    // The pathspec must also carry the DDL LEAF modules (cinatra#2625) — a leaf
    // left out here would be invisible to the classifier, which is exactly the
    // gap that makes a relocation look like a drop. Enumerated from BOTH sides
    // so a leaf introduced (or retired) by this diff is included.
    const showOrNull = (rev, p) => {
      try {
        return git(["show", `${rev}:${p}`], { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    };
    const leafPaths = new Set();
    for (const rev of [mergeBase, "HEAD"]) {
      const content = showOrNull(rev, IN_SCOPE_FILE);
      if (content === null) continue;
      for (const p of findDdlLeafModules(content).keys()) leafPaths.add(p);
    }
    const paths = [IN_SCOPE_FILE, "migrations", ...OUT_OF_SCOPE_FILES, ...leafPaths];
    diffText = git(["diff", "--find-renames", mergeBase, "HEAD", "--", ...paths]);
    readBaseFile = (p) => {
      try {
        // stderr silenced: the DDL-leaf resolver probes both `x.ts` and
        // `x/index.ts` for every specifier, so "path does not exist" is the
        // NORMAL answer for half of them — not something to print in CI.
        return git(["show", `${mergeBase}:${p}`], { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    };
    listBaseDir = (dir) => {
      try {
        // -z: NUL-delimited raw names — the newline form C-quotes unusual
        // names, which would then fail the follow-up blob read and drop the
        // fragment from the base union silently.
        return git(["ls-tree", "--name-only", "-z", `${mergeBase}:${dir}`], { stdio: ["ignore", "pipe", "ignore"] })
          .split("\0")
          .filter(Boolean);
      } catch {
        return null; // directory absent on base
      }
    };
    console.log(`[schema-migration-gate] diffing ${mergeBase.slice(0, 12)} (merge base of ${base}) .. HEAD`);
  }

  const { verdict, destructive, artifact, notices, ignored, inScopeChanges } = runGate({ diffText, readBaseFile, listBaseDir });

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
        `  2. the matching per-migration fragment migrations/manifest.d/core__NNNN_short-description.json\n` +
        `     (same filename stem as the module; the legacy migrations/manifest.json array is frozen —\n` +
        `     never append to it)\n` +
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
