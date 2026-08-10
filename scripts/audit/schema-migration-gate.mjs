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
//      Neither pass may run over DDL whose SCHEMA NAME the gate cannot vouch
//      for. A line's text says nothing about WHICH schema it executes against,
//      so a builder keeps its cancellation only while every schema-position
//      interpolation it writes — `"${…}"."table"`, or the unquoted `${…}."table"`
//      — TRACES back to the FIRST parameter the caller passed it (the schema
//      arrives first: `...xQueries(schemaName),`): the escape
//      `schemaName.replaceAll('"', '""')` (the literal-position
//      `replaceAll("'", "''")` spelling names the same schema and counts), read
//      through a chain of `const` aliases declared exactly once, over a ROOT
//      that is itself that parameter, with no mutation or second binding in that
//      builder — `const` is the structural guarantee that no re-binding form,
//      modelled by the scanners or not, can move the name under the DDL. The
//      QUOTING has to match the position too: a quoted position takes the bare
//      escaped name, an unquoted one takes a complete quoted identifier, because
//      an UNQUOTED identifier is case-folded into a different schema — and the
//      IDENTIFIER escape and the SQL-LITERAL one are not interchangeable either,
//      so each is accepted only in its own context — and the RAW name, before
//      either escape, satisfies no position at all. A
//      call into a LOCAL wrapper is followed rather than refused — the shipped
//      `quoteIdent(schemaName)` shape — and vouches only if EVERY return it can
//      reach hands THAT FIRST ARGUMENT back exactly once, with nothing but
//      quoting added (a wrapper holding a nested function, or one the gate
//      cannot read whole, or one that can FALL THROUGH to `undefined`, is
//      refused instead of guessed at). A name ASSEMBLED from parts
//      (`"${prefix}${q}"."t"`, `${q}_tail."t"`) never traces — only one piece
//      sits in schema position — and a builder that writes schema-qualified DDL
//      while showing NO schema position has put the name out of reach entirely.
//      A mutation (`s += "_shadow"`, `s++`, `[s] = […]`, `for ([s] of …)`,
//      `catch (s)`, a method or arrow parameter that SHADOWS the root), a rebind
//      to a constant, an escape over a constant root, a modifying wrapper, a
//      parameter default, a second parameter, an opaque qualified-name target, a
//      destructuring or an imported constant all break the trace, so that
//      builder's lines lose BOTH cancellations and are compared verbatim — the
//      removals then red exactly as a deletion would, with a notice saying why,
//      and a binding that STOPPED tracing is also reported as
//      schema-binding-redirected. The refusal is per SCOPE, so a sibling builder
//      in the same leaf keeps its cancellation.
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
// DECLARED limits of the schema TRACE (cinatra#2625, codex rounds 3-23). The
// trace reads a lightweight scan, not a JavaScript parser, and its failure
// direction is a REFUSAL — untraceable DDL is compared verbatim and reds — so
// these cost findings, never waivers:
//   - whether a schema position sits inside a SQL string literal is read from
//     the unescaped `'` parity on its own LINE. This one can fail in EITHER
//     direction: a literal opened on an earlier line of the same statement is
//     read as an identifier context, so the wrong escape can be ACCEPTED there
//     (and the right one refused). Counting across the whole template instead
//     was tried and is worse — the DDL legitimately carries balanced literals
//     like `IN ('pending','approved')` ahead of a later schema position, which
//     refused six shipped leaves. No shipped leaf opens a literal across lines.
//   - a helper is followed only in a deliberately narrow form: one unconditional
//     return, no nested callable, no control flow, a stable binding. A faithful
//     helper outside that form is refused rather than followed.
//   - a declaration the scan cannot delimit (no statement terminator) and a
//     callable form the scope recognisers do not admit are refused.
//   - comment stripping does not model regex literals (as on main).
//   - a scope whose source spells an identifier with a UNICODE ESCAPE is not
//     vouched for at all: the scans read source text, and that name would match
//     none of them.
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

/**
 * One helper's text, for leafDdlLines — INCLUDING its declaration line, which
 * carries the `schemaName` parameter. A schema name the gate cannot trace back
 * to that parameter is one it must not vouch for (codex round 5), and the line
 * is identical on both sides of an untouched helper, so it cancels like the
 * rest of the body.
 */
export function helperBody(content, helper) {
  return content.split("\n").slice(helper.start - 1, helper.end).join("\n");
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
  const { sites, qualifying } = bindingSites(content);
  return new Set([...qualifying].filter((id) => siteCount(sites.get(id)) === 1));
}

/**
 * Every binding SITE one revision gives each identifier, split by kind so a
 * MUTATION is distinguishable from the declaration it mutates. Offsets are the
 * identity (one site counted once, however many scans see it), and the three
 * scans report the SAME offset for the same site — a declaration is matched by
 * both the declaration and the assignment scan, and a defaulted parameter by
 * both the parameter and the assignment scan.
 * `inits` is the ONE-LINE initializer the shipped alias scan has always read;
 * `initsFull` is the same initializer read to its statement terminator, so a
 * WRAPPED declaration (`const q = schemaName\n  .replaceAll('"', '""');`) is read
 * whole. Only the tracing verifier consumes `initsFull` — feeding it to
 * `qualifying` would widen `schemaNameAliases`, and with it the shipped
 * relocation match. A `null` entry means the statement could not be delimited,
 * which the verifier treats as untraceable.
 * @returns {{sites: Map<string, {decl: Set<number>, assign: Set<number>, param: Set<number>,
 *   inits: string[], initsFull: (string|null)[]}>, qualifying: Set<string>}}
 */
function bindingSites(content) {
  const code = stripComments(content);
  const sites = new Map();
  const at = (id) => {
    if (!sites.has(id))
      sites.set(id, { decl: new Set(), constDecl: new Set(), assign: new Set(), param: new Set(), loopDecl: new Set(), loopAssign: new Set(), defaulted: false, inits: [], initsFull: [] });
    return sites.get(id);
  };
  const qualifying = new Set();
  for (const m of code.matchAll(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    // Offset of the IDENTIFIER, searched past the keyword — the same site the
    // assignment scan below reports, so a declaration counts once, not twice.
    const rec = at(m[2]);
    const off = m.index + m[0].indexOf(m[2], m[1].length);
    rec.decl.add(off);
    if (m[1] === "const") rec.constDecl.add(off);
    rec.inits.push(m[3].trim());
    rec.initsFull.push(statementInitializer(code, m.index + m[0].lastIndexOf(m[3])));
    if (SCHEMA_ESCAPE_RE.test(m[3].replace(/\s+/g, ""))) qualifying.add(m[2]);
  }
  // Assignment targets (declarations re-match here at the same offset), INCLUDING
  // the compound forms — `s += "_shadow"` mutates the schema just as surely as
  // `s = "shadow"` does. Comparison operators (`>=`, `<=`, `!=`, `===`) are
  // excluded by the operator alternation plus the `=(?!=)` tail.
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*(?:\*\*|<<|>>>|>>|&&|\|\||\?\?|[+\-*/%&|^])?=(?!=)/g)) {
    at(m[1]).assign.add(m.index + m[0].indexOf(m[1]));
  }
  // Parameter lists of function declarations and arrows — the shadowing form.
  for (const m of code.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>/g)) {
    const params = m[1] ?? m[2] ?? "";
    for (const p of params.split(",")) {
      const id = p.trim().match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (!id) continue;
      at(id).param.add(m.index + m[0].indexOf(p));
      // A DEFAULTED parameter does not have to hold what the caller passed —
      // omit the argument and it holds whatever the default says (codex round 7).
      if (/=[^=]/.test(p.replace(/^[^=]*?:[^=]*/, (t) => t.replace(/=/g, "")))) at(id).defaulted = true;
    }
  }
  // A `function`/`class` DECLARATION binds its own name, and inside a block that
  // shadows an outer alias of the same name (codex round 23).
  for (const m of code.matchAll(/(?:^|[^.\w$])(?:function|class)(?:\s*\*)?\s+([A-Za-z_$][\w$]*)/g)) {
    at(m[1]).loopDecl.add(m.index + m[0].lastIndexOf(m[1]));
  }
  // `catch (q)` and `catch ({ q })` bind `q` for their block, shadowing any
  // outer alias of that name — as does a DESTRUCTURED parameter and a bare
  // arrow parameter (`q => …`), neither of which the parenthesised parameter
  // scan above can see. All three land in the verifier-only bucket, so the trace
  // sees the shadow while schemaNameAliases keeps counting what it counts today
  // (codex round 15).
  for (const m of code.matchAll(/\bcatch\s*\(([^)]*)\)/g)) {
    for (const idm of m[1].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
      at(idm[1]).loopDecl.add(m.index + m[0].indexOf(m[1]) + idm.index);
    }
  }
  for (const m of code.matchAll(/(?:^|[^.\w$)\]])([A-Za-z_$][\w$]*)\s*=>/g)) {
    at(m[1]).loopDecl.add(m.index + m[0].indexOf(m[1]));
  }
  // EVERY parameter list, whatever declares it: an object or class METHOD, a
  // getter, a constructor, a generator, a destructured list. A `(…)` followed by
  // `{` or `=>` is a parameter list unless a control keyword introduced it — so
  // this covers the callable forms the two regex scans above never enumerated,
  // and stops enumerating them (codex round 16).
  // DESTRUCTURED parameters of a `function`/arrow head: the plain parameter scan
  // above takes the leading identifier of each comma-separated piece, which a
  // pattern has none of, so those bindings were invisible.
  for (const m of code.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>/g)) {
    const params = m[1] ?? m[2] ?? "";
    if (!/[[{]/.test(params)) continue;
    for (const idm of params.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
      at(idm[1]).loopDecl.add(m.index + m[0].indexOf(params) + idm.index);
    }
  }
  for (const span of parameterListSpans(code)) {
    for (const idm of span.text.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
      at(idm[1]).loopDecl.add(span.at + idm.index);
    }
  }
  // `[q] = […]` / `({ a: q } = …)` re-bind through a PATTERN, which the plain
  // assignment scan never sees, and `q++` / `--q` mutate without an `=` at all.
  // Both land in the loop bucket: the tracing verifier must see them, and
  // schemaNameAliases must keep counting exactly what it counts today.
  for (const span of patternAssignmentSpans(code)) {
    // Every name inside the pattern is treated as re-bound. Over-marking costs a
    // refusal; missing a NESTED pattern (`({ a: { b: q } } = cfg)`) would cost a
    // waiver (codex round 12).
    for (const idm of span.text.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
      at(idm[1]).loopAssign.add(span.at + idm.index);
    }
  }
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*(?:\+\+|--)|(?:\+\+|--)\s*([A-Za-z_$][\w$]*)/g)) {
    const id = m[1] ?? m[2];
    if (id) at(id).loopAssign.add(m.index + m[0].indexOf(id));
  }
  // `for (q of […])` / `for (q in …)` re-bind without an `=`, so the assignment
  // scan never sees them. They land in their OWN bucket: the TRACING verifier
  // must see them, but schemaNameAliases must keep counting exactly the sites it
  // counts on main, so the shipped relocation match is neither loosened NOR
  // tightened by this change. A DECLARED loop variable (`for (const q of …)`) is
  // a binding of its own, not a mutation of an outer name.
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:(const|let|var)\s+)?([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) {
    const rec = at(m[2]);
    const off = m.index + m[0].lastIndexOf(m[2]);
    (m[1] ? rec.loopDecl : rec.loopAssign).add(off);
  }
  // …and the DESTRUCTURING loop head — `for ([q] of …)`, `for ({ a: q } of …)`
  // — which re-binds without an `=` and without a bare identifier either.
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:(const|let|var)\s+)?([[{][^;()]*?[\]}])\s*(?:of|in)\b/g)) {
    for (const idm of m[2].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
      const rec = at(idm[1]);
      const off = m.index + m[0].indexOf(m[2]) + idm.index;
      (m[1] ? rec.loopDecl : rec.loopAssign).add(off);
    }
  }
  return { sites, qualifying };
}

/** Keywords whose parenthesised head is a CONDITION, never a parameter list. */
const CONTROL_HEAD_RE = /(?:^|[^.\w$])(?:if|for|while|switch|catch|with|do|return|typeof|void|await|in|of|new)$/;

/**
 * The parameter lists the `function`/arrow scans above cannot see: an object or
 * class METHOD, a getter or setter, a constructor, a generator — `name(…) {`,
 * with an optional TypeScript return type. Matching the SHAPE rather than the
 * declaring keyword is what stops this from being one more entry in an
 * enumeration of syntax (codex round 16). `function` heads and arrows are
 * excluded here because the scans above already record them, at their own
 * offsets: recording them twice would read every ordinary builder as ambiguous.
 */
function parameterListSpans(code) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== "(") continue;
    // Walk BACK over the callee name (however long) to see what introduced it.
    let h = i - 1;
    while (h >= 0 && /\s/.test(code[h])) h--;
    if (h >= 0 && code[h] === "]") {
      // A COMPUTED method name — `[key](…) { … }` (codex round 19).
      let d = 0;
      for (; h >= 0; h--) {
        if (code[h] === "]") d++;
        else if (code[h] === "[") {
          d--;
          if (d === 0) break;
        }
      }
      if (h < 0) continue;
      out.push({ at: i + 1, text: code.slice(i + 1, balancedParenEnd(code, i)) });
      continue;
    }
    if (h < 0 || !/[\w$]/.test(code[h])) continue; // a bare `(` — a grouping or an arrow head
    while (h >= 0 && /[\w$]/.test(code[h])) h--;
    const name = code.slice(h + 1, i).trim();
    if (CONTROL_HEAD_RE.test(`(${name}`)) continue;
    while (h >= 0 && /\s/.test(code[h])) h--;
    if (code[h] === "*") {
      h--;
      while (h >= 0 && /\s/.test(code[h])) h--;
    }
    if (/(?:^|[^.\w$])function$/.test(code.slice(Math.max(0, h - 8), h + 1))) continue; // the scans above own it
    let depth = 0;
    let quote = null;
    let j = i;
    const limit = Math.min(code.length, i + 4000);
    for (; j < limit; j++) {
      const c = code[j];
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= limit) continue;
    let k = j + 1;
    while (k < code.length && /\s/.test(code[k])) k++;
    // A TypeScript return-type annotation may sit between `)` and the body.
    if (code[k] === ":") {
      const brace = code.indexOf("{", k);
      const arrow = code.indexOf("=>", k);
      const nl = code.indexOf("\n", k);
      if (brace === -1 && arrow === -1) continue;
      if (nl !== -1 && nl < Math.min(brace === -1 ? Infinity : brace, arrow === -1 ? Infinity : arrow) && !/^[^\S\n]*$/.test(code.slice(k, nl))) {
        // fall through: still a declaration head, just annotated
      }
      out.push({ at: i + 1, text: code.slice(i + 1, j) });
      continue;
    }
    if (code[k] === "{") out.push({ at: i + 1, text: code.slice(i + 1, j) });
  }
  return out;
}

/** The offset of the `)` closing the `(` at `i`, quote-aware; -1 when unbalanced. */
function balancedParenEnd(code, i) {
  let depth = 0;
  let quote = null;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return -1;
}

/**
 * Every destructuring PATTERN that is the target of an assignment — `[q] = …`,
 * `({ a: q } = …)`, and any nesting of them. The pattern is matched with
 * balanced brackets and quote awareness, then confirmed by the `=` that follows
 * it, so an object LITERAL on the right of a declaration is not mistaken for one.
 */
function patternAssignmentSpans(code) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c !== "[" && c !== "{") continue;
    const prev = code[i - 1];
    if (prev !== undefined && /[.\w$)\]]/.test(prev)) continue;
    let depth = 0;
    let quote = null;
    let j = i;
    // A destructuring pattern is SHORT. The bound keeps this scan linear on a
    // 4000-line file full of `{ text: … }` object literals.
    const limit = Math.min(code.length, i + 2000);
    for (; j < limit; j++) {
      const d = code[j];
      if (quote) {
        if (d === "\\") j++;
        else if (d === quote) quote = null;
        continue;
      }
      if (d === "'" || d === '"' || d === "`") quote = d;
      else if (d === "[" || d === "{") depth++;
      else if (d === "]" || d === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= limit) continue;
    let k = j + 1;
    while (k < code.length && /\s/.test(code[k])) k++;
    // NOT skipping to `j`: an enclosing block would otherwise hide every pattern
    // nested inside it (codex round 12).
    if (code[k] === "=" && code[k + 1] !== "=") out.push({ at: i + 1, text: code.slice(i + 1, j) });
  }
  return out;
}

/**
 * The initializer starting at `from`, read to its statement terminator rather
 * than to the end of the line — quote- and bracket-aware, so a `;` inside a
 * template literal or an argument list does not end it early. `null` when no
 * terminator is found within a sane bound: unreadable, therefore untraceable.
 */
function statementInitializer(code, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < code.length && i - from < 4000; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return null; // ran out of the enclosing block first
      depth--;
    } else if (c === ";" && depth === 0) return code.slice(from, i).trim();
  }
  return null;
}

/** Distinct binding sites of one record — EXACTLY what schemaNameAliases counts on main. */
const siteCount = (rec) => (rec ? new Set([...rec.decl, ...rec.assign, ...rec.param]).size : 0);
/** Sites that BIND the name (a declaration or a parameter), not ones that mutate it. */
const bindCount = (rec) => (rec ? new Set([...rec.decl, ...rec.param, ...rec.loopDecl]).size : 0);
/** Assignments that are not themselves the declaration/parameter — real mutations. */
const mutationCount = (rec) =>
  rec ? [...rec.assign].filter((o) => !rec.decl.has(o) && !rec.param.has(o)).length + rec.loopAssign.size : 0;

const EXPR_NON_IDENTIFIERS = new Set(["new", "typeof", "void", "await", "true", "false", "null", "undefined", "String", "Number", "JSON", "Object"]);

/** The identifiers an interpolated expression READS (property names excluded). */
function expressionIdentifiers(expr) {
  const bare = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, " ");
  return [...bare.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((id) => !EXPR_NON_IDENTIFIERS.has(id));
}

/**
 * The identifiers ONE revision's executed schema NAME depends on — the roots of
 * every interpolation that sits in schema position (`"${…}"."table"`), of the
 * escape expression written out in full, and of a verified alias, closed
 * transitively over those identifiers' own initializers (so the `schemaName`
 * behind `const s = schemaName.replaceAll('"', '""')` is a dependency too).
 */
export function schemaBindingDeps(content) {
  const code = stripComments(content);
  const { sites, qualifying } = bindingSites(content);
  const deps = new Set();
  const add = (expr) => {
    for (const id of expressionIdentifiers(expr)) deps.add(id);
  };
  for (const p of schemaPositionExpressions(code)) add(p.expr);
  for (const m of code.matchAll(/\$\{([^{}]*)\}/g)) {
    const e = m[1].replace(/\s+/g, "");
    if (SCHEMA_ESCAPE_RE.test(e) || qualifying.has(e)) add(m[1]);
  }
  const queue = [...deps];
  while (queue.length > 0) {
    const id = queue.pop();
    for (const init of sites.get(id)?.inits ?? []) {
      for (const r of expressionIdentifiers(init)) {
        if (!deps.has(r)) {
          deps.add(r);
          queue.push(r);
        }
      }
    }
  }
  return deps;
}

const SCOPE_FUNCTION_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/;
const SCOPE_ARROW_RE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/;

/**
 * One revision split into the FUNCTION SCOPES a binding actually lives in, keyed
 * by the function's name (top-level statements land under `#top`). A leaf
 * exports several builders and every one of them declares its own
 * `const q = schemaName.replaceAll('"', '""')` over its own `schemaName`
 * parameter, so counting binding sites file-wide would read a perfectly ordinary
 * leaf as ambiguous. Scope boundaries use the same column-0 closing-brace
 * heuristic as findSchemaRegions/findLocalDdlHelpers.
 *
 * Each scope carries the 0-based line range it occupies (stripComments keeps the
 * line structure, so the range indexes the ORIGINAL content) — that is what lets
 * a redirect ban the cancellation of the affected builder's lines ONLY, instead
 * of every sibling builder that happens to share the file.
 * @returns {Map<string, {start: number, end: number, body: string, lines: number[]}>}
 */
export function schemaBindingScopes(content) {
  const code = stripComments(content);
  const lines = code.split("\n");
  const lineStart = [];
  for (let i = 0, at = 0; i < lines.length; i++) {
    lineStart.push(at);
    at += lines[i].length + 1;
  }
  const scopes = new Map();
  const top = [];
  let anon = 0;
  for (let i = 0; i < lines.length; ) {
    const m = lines[i].match(SCOPE_FUNCTION_RE) ?? lines[i].match(SCOPE_ARROW_RE);
    if (!m) {
      top.push(i);
      i++;
      continue;
    }
    // The function's TRUE end, found by matching its braces with quote and
    // template-interpolation awareness. A column-0 `}` inside one of these
    // multi-line DDL template literals would otherwise cut the scope in half and
    // strand its binding — including the `schemaName` parameter it traces to.
    // A CONCISE arrow (`const q = (x) => expr;`) has no body brace: it ends at
    // its statement terminator. Without that it would swallow the next
    // declaration whole, taking that scope's DDL with it.
    const brace = functionBodyBrace(code, lineStart[i]);
    const endOffset =
      code[brace] === "{" ? blockEnd(code, brace) : lineStart[i] + (statementInitializer(code, lineStart[i])?.length ?? 0) + 1;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lineStart[j] >= endOffset) {
        end = j;
        break;
      }
    }
    // Two functions may share a name (a redeclaration, or a name the gate
    // synthesises); keying the map by name alone would drop the earlier one from
    // the analysis entirely (codex round 11).
    let name = m[1] ?? `#anon${anon++}`;
    for (let dup = 2; scopes.has(name); dup++) name = `${m[1] ?? "#anon"}#${dup}`;
    scopes.set(name, { start: i, end, body: lines.slice(i, end).join("\n"), lines: null });
    i = end;
  }
  scopes.set("#top", { start: 0, end: lines.length, body: top.map((n) => lines[n]).join("\n"), lines: top });
  return scopes;
}

/**
 * The offset of the `{` that opens a function's BODY, given the offset of its
 * declaration. The parameter list is matched first, then the body brace is the
 * LAST `{` on the line that closes it — which is what tells the body apart from
 * a TypeScript return-type annotation (`): { text: string }[] {`, the shape
 * every leaf builder is declared with).
 */
function functionBodyBrace(code, from) {
  let i = code.indexOf("(", from);
  if (i === -1) return from;
  let depth = 0;
  let quote = null;
  for (; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
  }
  // Walk forward from the `)` with QUOTE awareness. A TypeScript return type may
  // sit in between (`): { text: string }[] {`), so each balanced `{…}` is taken
  // as a candidate and skipped; the LAST one before the code stops looking like
  // a type annotation is the body. Quote awareness is what keeps the `${` of a
  // one-line body's template literal from being mistaken for it.
  let k = i + 1;
  let candidate = -1;
  let q = null;
  while (k < code.length) {
    const c = code[k];
    if (q) {
      if (c === "\\") k++;
      else if (c === q) q = null;
      k++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      q = c;
      k++;
      continue;
    }
    if (c === "{") {
      candidate = k;
      const end = blockEnd(code, k);
      if (end <= k) break;
      k = end;
      let n = k;
      while (n < code.length && /\s/.test(code[n])) n++;
      // Still inside a type annotation? Then the body brace is further on.
      if (/[[\]|&<>,.?]/.test(code[n] ?? "")) continue;
      break;
    }
    // A `;` ends the declaration: a CONCISE arrow has no body brace at all, and
    // without stopping here the search would run on into the NEXT declaration
    // and adopt its brace.
    if (c === ";") break;
    k++;
  }
  return candidate === -1 ? from : candidate;
}

/**
 * The offset just past the `}` that closes the first `{` at or after `from`.
 * Strings, template literals and `${…}` interpolations inside them are tracked,
 * so DDL text can contain any brace at any indentation.
 */
function blockEnd(code, from) {
  const stack = ["code"];
  const depths = [];
  let depth = 0;
  let quote = null;
  let opened = false;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (stack[stack.length - 1] === "tmpl") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && code[i + 1] === "{") {
        stack.push("code");
        depths.push(depth);
        depth = 0;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "`") stack.push("tmpl");
    else if (c === "{") {
      depth++;
      opened = true;
    } else if (c === "}") {
      if (depth === 0) {
        if (stack.length === 1) return i + 1;
        stack.pop();
        depth = depths.pop() ?? 0;
        continue;
      }
      depth--;
      if (opened && depth === 0 && stack.length === 1) return i + 1;
    }
  }
  return code.length;
}

/** The 0-based line numbers a scope owns (the `#top` scope is not contiguous). */
const scopeLineNumbers = (scope) => scope.lines ?? Array.from({ length: scope.end - scope.start }, (_, k) => scope.start + k);

/**
 * Every interpolation that sits in SCHEMA position — `"${…}"."table"`, and the
 * unquoted `${…}."table"` an unquotable schema name allows. The expression is
 * read with BALANCED braces, so a nested template (`"${`${a}${b}`}"."t"`) is
 * extracted whole and then judged, rather than slipping past a `[^{}]*` capture
 * and leaving the schema position invisible (codex round 5).
 * A schema name ASSEMBLED from more than one part — `"${prefix}${q}"."t"`, or
 * `"pre${q}"."t"` — is reported as `composed`, and composed never traces: only
 * the last interpolation would be checked, so a redirect could be parked in the
 * part before it (codex round 8).
 * @param {string} text a scope body
 * @returns {Array<{expr: string, composed: boolean}>} in source order
 */
function schemaPositionExpressions(text) {
  const out = [];
  const dotAfter = (at) => {
    let k = at;
    while (k < text.length && /\s/.test(text[k])) k++;
    return text[k] === ".";
  };
  // Inside a SQL STRING LITERAL the schema name needs the literal escape, not
  // the identifier one. An odd number of `'` before the position on its own line
  // means the SQL is mid-literal (`'"${lit}"."t"'::regclass`, a shipped shape).
  const inLiteral = (at) => {
    const bol = text.lastIndexOf("\n", at) + 1;
    let n = 0;
    for (let k = bol; k < at; k++) if (text[k] === "'" && text[k - 1] !== "\\") n++;
    return n % 2 === 1;
  };
  for (let i = 0; i + 1 < text.length; i++) {
    if (text[i] !== "$" || text[i + 1] !== "{") continue;
    const j = interpolationEnd(text, i);
    if (j === -1) {
      out.push({ expr: text.slice(i + 2), composed: true, quoted: false, inLiteral: false }); // unterminated
      break;
    }
    const expr = text.slice(i + 2, j - 1);
    const before = text[i - 1];
    // Three ways this interpolation can sit in schema position: it FILLS a
    // quoted name exactly (`"${q}".`), it is PART of a quoted name
    // (`"pre${q}".` / `"${q}post".` / `"${a}${q}".`), or the name is unquoted —
    // where it may still be only part of the token (`${q}_tail.`). Only the
    // first traces; everything else is assembled from pieces the trace never
    // sees, so it is reported as composed (codex rounds 8-10).
    if (text[j] === '"') {
      if (dotAfter(j + 1)) out.push({ expr, composed: before !== '"', quoted: true, inLiteral: inLiteral(i) });
      i = j - 1;
      continue;
    }
    if (before === '"') {
      const close = text.indexOf('"', j);
      if (close !== -1 && dotAfter(close + 1)) out.push({ expr, composed: true, quoted: true, inLiteral: inLiteral(i) });
      i = j - 1;
      continue;
    }
    // Unquoted: walk the rest of the token — literal word characters and any
    // further interpolations — up to the dot that makes it a schema name.
    let k = j;
    let more = false;
    while (k < text.length) {
      if (text[k] === "$" && text[k + 1] === "{") {
        const e = interpolationEnd(text, k);
        if (e === -1) break;
        k = e;
        more = true;
        continue;
      }
      if (/[\w$\u0080-\uffff]/.test(text[k])) {
        k++;
        more = true;
        continue;
      }
      break;
    }
    if (dotAfter(k))
      out.push({
        expr,
        composed: more || before === "}" || /[\w$'`\u0080-\uffff]/.test(before ?? " "),
        quoted: false,
        inLiteral: inLiteral(i),
      });
    i = j - 1;
  }
  return out;
}

/**
 * The offset just past the `}` closing the `${` that starts at `i`, or -1 when
 * it is unterminated. Braces inside a string argument (`${select("}")}`) are
 * skipped, so the expression is extracted whole (codex round 6).
 */
function interpolationEnd(text, i) {
  let depth = 1;
  let quote = null;
  for (let j = i + 2; j < text.length; j++) {
    const c = text[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j + 1;
  }
  return -1;
}

// The LITERAL-position sibling of SCHEMA_ESCAPE_RE: the same schema name escaped
// for a SQL string literal (`'"${lit}"."t"'::regclass` in a catalogue lookup).
// It names the same schema, so it VOUCHES for a line the same way — but it is
// deliberately kept out of SCHEMA_ESCAPE_RE, which drives normalizeDdlLine and
// schemaNameAliases: collapsing a second spelling there would LOOSEN the
// relocation match that already ships.
const SCHEMA_LITERAL_ESCAPE_RE = /^[A-Za-z_$][\w$]*\.replaceAll\(['"]'['"],['"]''['"]\)$/;

/**
 * A predicate over one scope: can this expression be TRACED to the schema-name
 * escape? It can when it IS the escape written out over an unmutated root, or
 * when it is a bare identifier declared exactly once in the scope whose single
 * initializer is itself traceable (a chain of plain aliases).
 *
 * Everything else is UNVERIFIED — a call (`selectSchema(q)`), a concatenation, a
 * parameter default, a destructured binding, an imported constant. The gate
 * cannot follow those to a schema, so it must not vouch for the DDL they name
 * (codex round 4: provenance leaves the scope, and a redirect can then be
 * planted in a helper the builder itself never mentions).
 */
function schemaExprVerifier(body, scopes = new Map(), depthBudget = 3, rootParam = null, calleeIsStable = () => true) {
  const { sites } = bindingSites(body);
  const unmutated = (id) => {
    const rec = sites.get(id);
    return mutationCount(rec) === 0 && bindCount(rec) <= 1;
  };
  /** The single initializer of a name declared exactly once, read whole. */
  // A traced alias must be declared `const`, ONCE. That is the structural
  // guarantee behind every re-binding form the scanners below model AND the ones
  // they do not: a `const` cannot be reassigned, destructured into, rebound by a
  // loop head or shadowed without a second declaration the site count sees
  // (codex round 14 — `for ([q] of …)` was the third scanner gap in a row).
  const soleInit = (id) => {
    const rec = sites.get(id);
    if (rec === undefined || !unmutated(id) || rec.decl.size !== 1 || rec.constDecl.size !== 1 || rec.initsFull.length !== 1) return undefined;
    return rec.initsFull[0] ?? undefined; // null = undelimited, therefore unreadable
  };
  const rootMemo = new Map();
  /**
   * Does this identifier hold the schema name the CALLER passed in? Only the
   * scope's own PARAMETER does, or a plain alias chain back to one. An
   * identifier the scope declares from anything else — a constant, a call, an
   * import — does NOT, which is what stops `const raw = "shadow_schema"` from
   * vouching for `raw.replaceAll('"', '""')` (codex round 5).
   */
  const tracesToParameter = (id, depth = 0) => {
    if (depth > 8 || !/^[A-Za-z_$][\w$]*$/.test(id)) return false;
    if (rootMemo.has(id)) return rootMemo.get(id);
    rootMemo.set(id, false); // a cycle can never trace
    const rec = sites.get(id);
    let ok = false;
    if (rec !== undefined && unmutated(id)) {
      // With a rootParam set (inside a followed wrapper) ONLY that parameter is
      // the schema — the argument bound to any OTHER parameter is not the one
      // the caller vouched for (codex round 6).
      if (rec.param.size === 1 && rec.decl.size === 0 && !rec.defaulted) ok = rootParam === null || id === rootParam;
      else {
        const init = soleInit(id);
        ok = init !== undefined && tracesToParameter(init.replace(/\s+/g, ""), depth + 1);
      }
    }
    rootMemo.set(id, ok);
    return ok;
  };
  const memo = new Map();
  /**
   * The SHAPE this expression produces — `"bare"` (the escaped schema name, to be
   * written inside identifier quotes) or `"quoted"` (a complete quoted
   * identifier) — or null when it is not the schema at all. The two are NOT
   * interchangeable: `"${bare}"` and `${quoted}` are the same SQL, but
   * `${bare}` is an UNQUOTED identifier that PostgreSQL case-folds, so a
   * mixed-case schema silently becomes a different one (codex round 20).
   */
  const verify = (expr, depth = 0) => {
    if (depth > 8) return null;
    const e = expr.replace(/\s+/g, "");
    if (SCHEMA_ESCAPE_RE.test(e) || SCHEMA_LITERAL_ESCAPE_RE.test(e)) {
      if (!tracesToParameter(e.slice(0, e.indexOf(".")))) return null;
      // The two escapes are NOT interchangeable: `replaceAll('"','""')` doubles
      // the IDENTIFIER quote and `replaceAll("'","''")` the STRING-LITERAL one.
      // A name containing the other quote comes out different (codex round 21).
      return SCHEMA_ESCAPE_RE.test(e) ? "bare-ident" : "bare-literal";
    }
    if (/^[A-Za-z_$][\w$]*$/.test(e)) {
      if (memo.has(e)) return memo.get(e);
      memo.set(e, null); // a cycle can never verify
      // The bare name of the schema itself counts — but only through
      // tracesToParameter, which is what checks it is unmutated and bound once.
      const init = soleInit(e);
      // The RAW parameter is the schema name before escaping. It is not the same
      // value as the escaped one — a name containing the identifier quote comes
      // out different — so it is its own shape and satisfies no position
      // (codex round 22).
      const shape = tracesToParameter(e) ? "raw" : init !== undefined ? verify(init, depth + 1) : null;
      memo.set(e, shape);
      return shape;
    }
    // A call INTO a local wrapper — the real `quoteIdent(schemaName)` shape. It
    // is followed rather than refused: the argument must already be the schema,
    // and the callee must hand it back with nothing but quoting added.
    const call = expr.trim().match(/^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/);
    if (call && depthBudget > 0) {
      const callee = scopes.get(call[1]);
      const arg = call[2].split(",")[0]?.trim() ?? "";
      // Following the DECLARED body is only sound while that declaration is what
      // the call reaches: `quoteIdent = () => '"shadow"'` elsewhere in the module
      // replaces it wholesale (codex round 21).
      if (callee && calleeIsStable(call[1]) && arg !== "" && (verify(arg, depth + 1) !== null || tracesToParameter(arg.replace(/\s+/g, "")))) {
        return calleeReturnsItsSchemaArgument(callee.body, scopes, depthBudget - 1, calleeIsStable);
      }
    }
    return null;
  };
  return verify;
}

/**
 * Does this function hand its FIRST argument back as the schema, adding nothing
 * but quote characters? `quoteIdent(value) { return `"${value.replaceAll('"',
 * '""')}"` }` does; `selectSchema(x) { return `${x}_shadow` }` does not, and
 * neither does one with no return the gate can read. Every return must qualify —
 * one that does not is a schema this function can produce.
 */
function calleeReturnsItsSchemaArgument(calleeBody, scopes, depthBudget, calleeIsStable = () => true) {
  const code = stripComments(calleeBody);
  // The FIRST parameter — the one the caller's verified argument binds to. Only
  // that one is the schema; a second parameter carries whatever the call site
  // chose, which is exactly how a wrapper can launder one (codex round 6).
  const param = code.match(/\(\s*([A-Za-z_$][\w$]*)/)?.[1];
  if (!param) return false;
  const returns = calleeReturnExpressions(code);
  if (returns === null || returns.length !== 1) return false;
  const verify = schemaExprVerifier(calleeBody, scopes, depthBudget, param, calleeIsStable);
  // NO shortcut on the name: `value` is the schema only while the wrapper leaves
  // it alone, and `value += "_shadow"` is exactly what a name comparison would
  // wave through (codex round 11).
  const isTheSchema = (e) => verify(e.trim());
  /** The one shape every return must agree on, or null. */
  let shape = null;
  const agrees = (produced) => {
    if (produced === null) return false;
    if (shape === null) shape = produced;
    return shape === produced;
  };
  const ok = returns.every((expr) => {
    const t = expr.trim();
    if (!t.startsWith("`") || !t.endsWith("`")) return agrees(isTheSchema(t));
    // A template: EXACTLY one interpolation, which must itself be the schema,
    // and literal text that is either nothing or ONE identifier quote on each
    // side. `${v}${v}` returns "corecore" (round 7) and `\"\"\"${v}\"\"\"` is the
    // quoted identifier `\"core\"`, not `core` (round 13) — every part traces in
    // both, and the whole names a different schema.
    const inner = t.slice(1, -1);
    const chunks = [];
    let literal = "";
    let ok = true;
    let inner_shape = null;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "$" && inner[i + 1] === "{") {
        const j = interpolationEnd(inner, i);
        if (j === -1) return false;
        chunks.push(literal);
        literal = "";
        inner_shape = isTheSchema(inner.slice(i + 2, j - 1));
        if (inner_shape === null) ok = false;
        i = j - 1; // interpolationEnd points PAST the `}`; the loop adds one
        continue;
      }
      literal += inner[i];
    }
    chunks.push(literal);
    if (!ok || chunks.length !== 2) return false;
    const [pre, post] = chunks;
    // `${bare}` hands the escaped name straight on; `"${bare}"` wraps it into a
    // complete quoted identifier. Anything else is a different name.
    if (pre === "" && post === "") return agrees(inner_shape);
    if (pre === '"' && post === '"') return inner_shape === "bare-ident" && agrees("quoted");
    return false;
  });
  return ok ? shape : null;
}

/**
 * Every expression one wrapper can RETURN, or null when the gate cannot read
 * them all. `return` is found by a quote-aware scan (the word inside a string is
 * not a return), a CONCISE arrow body counts as its single return, and a wrapper
 * containing a NESTED function is refused outright — its returns could belong to
 * either function, and either could produce a schema (codex round 6).
 */
function calleeReturnExpressions(code) {
  // An ASYNC helper returns a promise and a GENERATOR returns an iterator;
  // interpolating either stringifies to something that is not a schema name at
  // all, while its `return` still reads as the schema (codex round 27).
  const header = code.slice(0, code.indexOf("(") + 1);
  if (/(?:^|[^.\w$])async(?:\s|\()/.test(header) || /\*\s*[A-Za-z_$][\w$]*\s*\($|\bfunction\s*\*/.test(header)) return null;
  let i = code.indexOf("(");
  if (i === -1) return null;
  let depth = 0;
  let quote = null;
  for (; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) break;
  }
  let k = i + 1;
  while (k < code.length && /\s/.test(code[k])) k++;
  if (code.startsWith("=>", k)) {
    k += 2;
    while (k < code.length && /\s/.test(code[k])) k++;
    if (code[k] !== "{") {
      const expr = statementInitializer(code, k) ?? code.slice(k).trim();
      return expr === "" ? null : [expr];
    }
  } else {
    const brace = functionBodyBrace(code, 0);
    if (code[brace] !== "{") return null;
    k = brace;
  }
  const inner = code.slice(k + 1, Math.max(k + 1, blockEnd(code, k) - 1));
  const bare = stripStringLiterals(inner);
  // A nested function's returns could belong to either function, and any
  // control flow means the wrapper may fall through and return `undefined` —
  // which would build DDL in a schema called "undefined" while the caller's
  // statements never changed (codex round 10). Both are refused rather than
  // guessed at: a wrapper the gate vouches for returns unconditionally.
  // A nested callable of ANY shape — `function`, an arrow, or a method head the
  // keyword scan cannot see (`quote() { … }`, codex round 17) — could own the
  // return this scan is about to read, leaving the wrapper itself falling
  // through to `undefined`.
  if (/\bfunction\b|=>/.test(bare) || parameterListSpans(inner).length > 0) return null;
  if (/\b(?:if|else|for|while|do|switch|case|try|catch|finally|break|continue|throw)\b/.test(bare)) return null;
  // A LABEL plus `break label` jumps past the return without any of the keywords
  // above being the thing that guards it (codex round 25).
  if (/(?:^|[;{}])\s*[A-Za-z_$][\w$]*\s*:\s*[{(]/.test(bare)) return null;
  const out = [];
  quote = null;
  for (let j = 0; j < inner.length; j++) {
    const c = inner[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c !== "r" || !/^return\b/.test(inner.slice(j, j + 7)) || /[\w$.]/.test(inner[j - 1] ?? " ")) continue;
    // `return\n  x;` returns UNDEFINED — automatic semicolon insertion ends the
    // statement at the newline. Reading the next line as the value would vouch
    // for a wrapper that hands back nothing (codex round 12).
    const gap = inner.slice(j + 6).match(/^[^\S\n]*/)?.[0] ?? "";
    if (inner[j + 6 + gap.length] === "\n") return null;
    const expr = statementInitializer(inner, j + 6);
    if (expr === null) return null; // an unreadable return could be anything
    out.push(expr);
    j += 6;
  }
  return out;
}

/** The text with every string/template literal blanked, for keyword scans. */
const stripStringLiterals = (text) => text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/gs, " ");

/**
 * The scopes of one revision whose DDL names a schema the gate CANNOT trace to
 * the schema-name escape. Their lines may not cancel: identical text does not
 * mean an identical executed schema when the gate cannot say what the schema is.
 */
export function unverifiedSchemaScopes(content) {
  const scopes = schemaBindingScopes(content);
  const stable = stableCalleePredicate(content, scopes);
  const out = new Set();
  for (const [name, scope] of scopes) {
    if (scopeHasUnverifiedSchema(scope.body, scopes, stable)) out.add(name);
  }
  return out;
}

/**
 * Whether a helper NAME still means the function this module declares — no
 * assignment, no loop or pattern rebinding, no second declaration anywhere in
 * the file. Following a declared body is only sound while the call reaches it.
 */
function stableCalleePredicate(content, scopes) {
  const { sites } = bindingSites(content);
  return (name) => {
    // Declared twice: schemaBindingScopes keeps the second as `name#2`, and
    // which one a call reaches is not something the gate can say.
    if (scopes.has(`${name}#2`)) return false;
    const rec = sites.get(name);
    if (rec === undefined) return true; // never bound as a value — a plain declaration
    return mutationCount(rec) === 0 && bindCount(rec) <= 1;
  };
}

/** Does this scope name a schema the gate cannot trace to an escape? */
function scopeHasUnverifiedSchema(body, scopes, calleeIsStable = () => true) {
  // An identifier written with a UNICODE ESCAPE (`schem\u0061Name`) is the same
  // name to JavaScript and a different one to every scan here, so a re-binding
  // could hide behind it. The scans read source text; where the source spells a
  // name in a way they cannot match, the scope does not get vouched for
  // (codex round 26).
  if (/\\u[0-9a-fA-F{]/.test(stripStringLiterals(stripComments(body)))) return true;
  const positions = schemaPositionExpressions(body);
  // The schema is what the CALLER passed, and the caller passes it first:
  // `...xQueries(schemaName),`. A builder that switches its DDL to a SECOND
  // parameter is naming something else (codex round 12).
  const rootParam = stripComments(body).match(/\(\s*([A-Za-z_$][\w$]*)/)?.[1] ?? null;
  // A scope that WRITES schema-qualified DDL and shows the gate no schema
  // position at all has assembled the qualified name somewhere the trace cannot
  // follow. Vouching for it would be vouching for nothing (codex round 8).
  if (positions.length === 0) return DDL_STATEMENT_RE.test(body);
  const verify = schemaExprVerifier(body, scopes, 3, rootParam, calleeIsStable);
  // A QUOTED position needs the bare escaped name; an UNQUOTED one needs a
  // complete quoted identifier, because PostgreSQL case-folds what is not
  // quoted (codex round 20).
  const fits = (p) => !p.composed && verify(p.expr) === (p.quoted ? (p.inLiteral ? "bare-literal" : "bare-ident") : "quoted");
  if (positions.some((p) => !fits(p))) return true;
  return unverifiedDdlTargets(body, scopes, rootParam, fits).length > 0;
}

// The object a statement builds, as written after the DDL keyword — every form
// DDL_STATEMENT_RE recognises, with the optional IF [NOT] EXISTS in between
// (`ALTER TABLE IF EXISTS ${t}` used to name `IF` as its target, codex round 24).
const DDL_TARGET_RE =
  /\b(?:CREATE\s+(?:TABLE|MATERIALIZED\s+VIEW|VIEW|SEQUENCE)|ALTER\s+(?:TABLE|MATERIALIZED\s+VIEW|VIEW|SEQUENCE)|DROP\s+(?:TABLE|MATERIALIZED\s+VIEW|VIEW|SEQUENCE)|ON)(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+(?:ONLY\s+)?(\S+)/gi;

/**
 * DDL targets written as an OPAQUE interpolation — `ON ${t} (…)` — whose value
 * the gate cannot see a schema position inside. The shipped
 * `buildEmailCorrelationIndexQueries` writes exactly that, and it is fine
 * because `t` is bound to `` `"${escape}"."objects"` ``: the position is visible
 * in the binding. A target bound to something the gate cannot read that way —
 * `const hidden = qi(s) + "." + qi("t")` — hides the schema even though a
 * SIBLING statement in the same builder showed a perfectly good one, which is
 * why the empty-position check above is not enough (codex round 18).
 */
function unverifiedDdlTargets(body, scopes, rootParam, fits) {
  const code = stripComments(body);
  const bad = [];
  for (const m of code.matchAll(DDL_TARGET_RE)) {
    const target = m[1];
    if (!target.startsWith("${")) continue; // a quoted or literal name — the position scan owns it
    const end = interpolationEnd(target, 0);
    if (end === -1) {
      bad.push(target);
      continue;
    }
    // `${s}.${quoteIdent(t)}` — the first interpolation IS a schema position, so
    // the position scan already vouched for it (a real leaf writes this).
    if (target[end] === ".") continue;
    const expr = target.slice(2, end - 1).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(expr)) {
      bad.push(expr); // composed inline — never traceable
      continue;
    }
    // The identifier must be bound to text that itself carries a schema position
    // the gate verifies.
    const init = qualifiedNameBinding(code, expr);
    const inner = init === null ? [] : schemaPositionExpressions(init);
    if (inner.length === 0 || inner.some((p) => !fits(p))) bad.push(expr);
  }
  return bad;
}

/** The sole `const` initializer of a name, read whole — or null. */
function qualifiedNameBinding(code, id) {
  const { sites } = bindingSites(code);
  const rec = sites.get(id);
  if (rec === undefined || rec.decl.size !== 1 || rec.constDecl.size !== 1 || rec.initsFull.length !== 1) return null;
  return rec.initsFull[0] ?? null;
}

/** A statement that builds a schema-qualified object — the DDL this gate reads. */
const DDL_STATEMENT_RE = /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|SEQUENCE|VIEW)\b/i;

/** A scope whose DDL the gate can vouch for: traceable schema, no mutation. */
const scopeVouchesForItsSchema = (body, scopes, calleeIsStable) =>
  !scopeHasUnverifiedSchema(body, scopes, calleeIsStable) && mutatedInScope(body).size === 0;

/** The dependencies ONE SCOPE mutates or binds ambiguously. */
function mutatedInScope(body) {
  const { sites } = bindingSites(body);
  const out = new Set();
  for (const id of schemaBindingDeps(body)) {
    const rec = sites.get(id);
    if (mutationCount(rec) > 0 || bindCount(rec) > 1) out.add(id);
  }
  return out;
}

/**
 * The schema-name dependencies ONE revision MUTATES or binds AMBIGUOUSLY within
 * a single scope — a compound assignment (`s += "_shadow"`), a plain
 * reassignment, a second declaration, a shadowing parameter. Any of them means
 * the gate cannot say WHICH schema that scope's DDL executes against, so none of
 * its lines may cancel anything (cinatra#2625 codex round 3).
 */
export function mutatedSchemaBindings(content) {
  const out = new Set();
  for (const scope of schemaBindingScopes(content).values()) {
    for (const id of mutatedInScope(scope.body)) out.add(id);
  }
  return out;
}

/**
 * The 0-based line numbers of `content` whose scope cannot vouch for the schema
 * its DDL names — the scopes `mutatedSchemaBindings` reports, plus any scope
 * named in `alsoBan` (the ones a cross-revision redirect implicates). These
 * lines sit out both cancellation passes.
 */
export function uncancellableLines(content, alsoBan = new Set()) {
  const banned = new Set();
  const scopes = schemaBindingScopes(content);
  const stable = stableCalleePredicate(content, scopes);
  for (const [name, scope] of scopes) {
    if (scopeVouchesForItsSchema(scope.body, scopes, stable) && !alsoBan.has(name)) continue;
    for (const n of scopeLineNumbers(scope)) banned.add(n);
  }
  return banned;
}

/**
 * The schema-name dependencies whose binding STOPPED naming the verified schema
 * between two revisions of one SCOPE — it lost its verified escape binding, or
 * it gained a mutation / a second binding. Empty for identical revisions, for a
 * scope that only exists on one side (a leaf gaining a builder is not a
 * redirect), and for a dependency that only appears on one side, so a benign
 * edit keeps its cancellation.
 *
 * This is what makes "same text" mean "same executed schema": a leaf whose DDL
 * text is untouched while `s` is redirected under it is NOT unchanged, and its
 * lines must be compared verbatim rather than cancelled (codex round 3).
 */
export function schemaBindingRedirects(baseContent, finalContent) {
  if (typeof baseContent !== "string" || typeof finalContent !== "string") return [];
  if (baseContent === finalContent) return [];
  const finalScopes = schemaBindingScopes(finalContent);
  const baseScopes = schemaBindingScopes(baseContent);
  const baseStable = stableCalleePredicate(baseContent, baseScopes);
  const finalStable = stableCalleePredicate(finalContent, finalScopes);
  const out = [];
  for (const [name, baseScope] of baseScopes) {
    const finalBody = finalScopes.get(name)?.body;
    if (finalBody === undefined || finalBody === baseScope.body) continue;
    if (!scopeVouchesForItsSchema(baseScope.body, baseScopes, baseStable) || scopeVouchesForItsSchema(finalBody, finalScopes, finalStable)) continue;
    const mutated = [...mutatedSchemaBindings(finalBody)];
    out.push({
      scope: name,
      why:
        mutated.length > 0
          ? `${mutated.join(", ")} — the binding is mutated or re-bound after this change`
          : "the schema name its DDL interpolates no longer resolves to the schema-name escape",
    });
  }
  return out;
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
export function leafDdlLines(origin, content, alsoBan = new Set()) {
  if (!content) return [];
  const aliases = schemaNameAliases(content);
  // A scope that MUTATES the schema name its DDL interpolates cannot say which
  // schema that DDL executes against, so none of ITS lines may cancel — not
  // through the normalized relocation pass, and not through the exact-text pass
  // either (codex round 3: `s += "_shadow"` drops the alias, but the unchanged
  // DDL text still cancelled against the untouched other side). `alsoBan` adds
  // the scopes a cross-revision redirect implicates; a builder that shares the
  // file with a redirected one keeps its cancellation.
  const banned = uncancellableLines(content, alsoBan);
  const region = { name: origin, kind: "executed-ddl", start: 0, end: Number.MAX_SAFE_INTEGER };
  const out = [];
  let table = null;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const m = text.match(TABLE_REF_RE);
    if (m) table = m[1];
    const trimmed = text.trim();
    out.push({ text, trimmed, origin, region, table, norm: normalizeDdlLine(trimmed, aliases), noCancel: banned.has(i) || undefined });
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
  //
  // A line whose origin REDIRECTED the schema its DDL executes against is
  // marked `noCancel` and sits out BOTH passes (cinatra#2625 codex round 3):
  // its text may be identical on the two sides, but the schema underneath it is
  // not, so it must be compared verbatim — it neither cancels nor absorbs.
  const cancelKey = (l) => `${l.table ?? ""}@@${l.trimmed.replace(/\s+/g, " ")}`;
  const addedPool = new Map();
  for (const a of added) {
    if (a.noCancel) continue;
    const key = cancelKey(a);
    addedPool.set(key, (addedPool.get(key) ?? []).concat(a));
  }
  const unmatchedRemoved = [];
  for (const r of removed) {
    const pool = r.noCancel ? null : addedPool.get(cancelKey(r));
    if (pool && pool.length > 0) pool.pop();
    else unmatchedRemoved.push(r);
  }
  const unmatchedAdded = [...addedPool.values()].flat().concat(added.filter((a) => a.noCancel));

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
    if (a.noCancel) continue;
    const key = relocKey(a);
    relocPool.set(key, (relocPool.get(key) ?? []).concat(a));
  }
  const relocatedAdds = new Set();
  const relocations = new Map();
  const survivingRemoved = [];
  for (const r of unmatchedRemoved) {
    const pool = r.noCancel ? null : relocPool.get(relocKey(r));
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

  // A REDIRECT of the schema name under otherwise-untouched DDL is a change to
  // the executed schema, however identical the text reads (cinatra#2625 codex
  // round 3). It is reported on its own, and it strips BOTH revisions of the
  // origin of any cancellation, so the DDL is compared verbatim: the removals
  // fall through to the drop rules exactly as a deletion would.
  /** origin -> the scope names a redirect implicates on BOTH of its revisions. */
  const redirectedScopes = new Map();
  const noteRedirect = (origin, base, final) => {
    if (base === "" || final === "") return;
    const redirects = schemaBindingRedirects(base, final);
    if (redirects.length === 0) return;
    redirectedScopes.set(origin, new Set(redirects.map((r) => r.scope)));
    destructive.push({
      rule: "schema-binding-redirected",
      line: `${origin}: ${redirects.map((r) => `${r.scope}: ${r.why}`).join("; ")}`,
      doc: "executed DDL was pointed at a DIFFERENT schema without its text changing — deployed databases keep the old schema's objects while the DDL now builds someone else's, so this needs a migration artifact (or a binding that resolves to the schema-name escape exactly once)",
    });
  };

  // A scope whose schema the gate cannot TRACE never cancels either, so say so:
  // without this note the resulting drop findings read as a mystery.
  const noteUnverified = (origin, content) => {
    const scopes = typeof content === "string" ? unverifiedSchemaScopes(content) : new Set();
    if (scopes.size === 0) return;
    notices.push(
      `${origin}: the schema name interpolated by ${[...scopes].join(", ")} cannot be traced to \`schemaName.replaceAll('"', '""')\` — its DDL is compared verbatim (bind the schema once, in the builder, to that escape)`,
    );
  };

  for (const [p, rev] of revisions) noteRedirect(p, rev.base, rev.final);
  for (const [p, rev] of revisions) {
    noteUnverified(p, rev.final || rev.base);
    const banned = redirectedScopes.get(p) ?? new Set();
    if (baseLeaves.has(p) && !shadowedOnSide(p, "base")) leafLines.removed.push(...leafDdlLines(p, rev.base, banned));
    if (finalLeaves.has(p) && !shadowedOnSide(p, "final")) leafLines.added.push(...leafDdlLines(p, rev.final, banned));
  }

  // LOCAL helper regions of drizzle-store.ts itself: the executed-DDL region
  // spreads them in, but their bodies sit outside both named regions, so their
  // DDL was invisible. Contributed per side under their own origin, exactly like
  // a leaf — unchanged bodies cancel, an edited one is classified.
  // The helper's DECLARATION line rides along: it carries the `schemaName`
  // parameter, and a schema name the gate cannot trace back to that parameter is
  // a schema name it must not vouch for (codex round 5). The line is identical
  // on both sides of an untouched helper, so it cancels like any other.
  const helperBodies = (content) => {
    const out = new Map();
    if (typeof content !== "string") return out;
    for (const h of findLocalDdlHelpers(content)) out.set(h.name, helperBody(content, h));
    return out;
  };
  const baseHelpers = helperBodies(storeBase);
  const finalHelpers = helperBodies(storeFinal);
  for (const name of new Set([...baseHelpers.keys(), ...finalHelpers.keys()])) {
    noteRedirect(`${IN_SCOPE_FILE}#${name}`, baseHelpers.get(name) ?? "", finalHelpers.get(name) ?? "");
  }
  for (const [helpers, bucket] of [
    [baseHelpers, leafLines.removed],
    [finalHelpers, leafLines.added],
  ]) {
    for (const [name, body] of helpers) {
      const origin = `${IN_SCOPE_FILE}#${name}`;
      bucket.push(...leafDdlLines(origin, body, redirectedScopes.get(origin) ?? new Set()));
    }
  }

  // The executed-DDL region of drizzle-store.ts itself. Its inline DDL is not
  // in the cancellation pools unless the diff touches it, so a redirect there
  // is caught by the report rather than by a surviving removal.
  const regionBody = (content) => {
    if (typeof content !== "string") return "";
    const r = findSchemaRegions(content).find((x) => x.kind === "executed-ddl");
    return r ? content.split("\n").slice(r.start - 1, r.end).join("\n") : "";
  };
  noteRedirect(`${IN_SCOPE_FILE}#buildCreateStoreSchemaQueries`, regionBody(storeBase), regionBody(storeFinal));

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
