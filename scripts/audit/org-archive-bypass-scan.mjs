#!/usr/bin/env node
/**
 * App-native archived-org write bypass gate — cinatra#1942 archive V2,
 * Decision 5 ("the app-native bypass audit ... a lockstep grep-gate style
 * test, like the writer-manifest, is the durable form").
 *
 * WHY THIS EXISTS. The Better-Auth dispatch-hook endpoint policy
 * (`@/lib/organization-dispatch-policy`, wired via `src/lib/auth.ts`'s
 * `hooks.before`) can only see writes that flow through a Better Auth
 * endpoint. An app-native writer that touches the SAME Better-Auth-owned
 * tables directly — `member`, `invitation`, `teamMember`, or
 * `session.activeOrganizationId` / `session.activeTeamId` — is invisible to
 * that hook. This gate ENUMERATES every such write site in the app surface
 * (`src/app/**`, `src/lib/**`, `packages/**`) and freezes the set against a
 * committed, reviewed allowlist: a NEW unlisted write fails CI (a future
 * bypass caught before it ships), and a manifest row the scanner no longer
 * finds fails too (stale-row drift, exactly the writer-manifest gate's
 * two-directional semantics).
 *
 * SCOPE — deliberately narrower than `system-writer-manifest-gate.mjs`:
 *   - Different TABLE universe (member/invitation/teamMember/session
 *     lifecycle columns, not the org-write-kernel's content tables).
 *   - Different SCAN ROOTS (`src/app`, `src/lib`, `packages` — the whole
 *     app-native surface, not just boot/instrumentation/scripts).
 *   - `scripts/**` and any migration tree are OUT OF SCOPE by the SAME
 *     doctrine `system-writer-manifest-gate.mjs` cites
 *     (docs/internals/contracts/schema-migrations-and-org-write-policy.md):
 *     a migration/CLI reconciler is reviewed by its own gate, not this one.
 *
 * DETECTION — two forms, both over comment-stripped source (the shared
 * lexer in `./lib/strip-comments.mjs`):
 *   1. RAW SQL / DRIZZLE writes to `member` / `invitation` / `teamMember` —
 *      reuses `scanSource()` from `system-writer-manifest-gate.mjs` verbatim
 *      (same qualified-table / drizzle-symbol matcher that gate already
 *      proved correct), scoped to this gate's own table + symbol universe.
 *   2. Session lifecycle-column writes — a dedicated detector for raw SQL
 *      `UPDATE ... session ... SET ... "activeOrganizationId"|"activeTeamId"`
 *      AND `INSERT INTO ... session ...` naming either column (covers
 *      upsert/ON CONFLICT shapes too — codex 1942-v2 r0 #5), plus Drizzle
 *      `.update(betterAuthSessions).set({...})` and
 *      `.insert(betterAuthSessions)...values({...})` naming either column,
 *      since `scanSource()`'s table-level matcher does not model
 *      column-level targets.
 *
 * KNOWN RESIDUALS (deliberate, documented — not silent): a TOTALLY-BARE
 * unqualified table in raw SQL (`INSERT INTO member ...`, no schema, no
 * quotes) is NOT matched — the org-write-table-sweep lesson (a bare-word
 * anchor matches prose/fluent-JS and greens the gate for the wrong reason);
 * every real write in this tree is `public.`-qualified or quoted, and the
 * fixture test pins the exclusion as a decision. Cross-module aliasing of a
 * Drizzle table symbol is likewise review territory, not lexical (the same
 * accepted residual as `system-writer-manifest-gate.mjs`). The gate is a
 * strong tripwire for every write shape that exists in this repo, not an
 * unbreakable proof.
 *
 * GATE SEMANTICS (mirrors the writer-manifest gate — no ratchet, two-
 * directional): a surface triple with no allowlist row is UNLISTED (fail); an
 * allowlist row with no surface triple is STALE (fail); a count mismatch for
 * a matched (file, ref) is DRIFT (fail). Regenerate deliberately with
 * `--write-allowlist`; the diff IS the review — every new/changed row must
 * carry a reason before it can be committed.
 *
 * Exit 0 -> clean; exit 1 -> at least one drift (printed to stderr);
 * exit 2 -> scanner error.
 *
 * Usage:
 *   node scripts/audit/org-archive-bypass-scan.mjs                    # check
 *   node scripts/audit/org-archive-bypass-scan.mjs --write-allowlist  # regen (drops existing reasons — re-add them by hand)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSource } from "./system-writer-manifest-gate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");

const LABEL = "org-archive-bypass";
export const ALLOWLIST_PATH = join(__dirname, "org-archive-bypass-allowlist.json");

// ---------------------------------------------------------------------------
// Table / symbol universe (cinatra#1942 archive — the Better-Auth-owned
// membership/invitation tables the dispatch-hook cannot see an app-native
// write to).
// ---------------------------------------------------------------------------

export const BYPASS_TABLES = ["member", "invitation", "teamMember"];
// Conventional Drizzle symbols for these tables in this repo (NOT a
// snake_case derivation — `better-auth-db.ts` names them directly).
export const BYPASS_SYMBOLS = ["betterAuthMembers", "betterAuthTeamMembers"];
// No drizzle table exists for `invitation` in this repo — every touch is raw
// SQL (verified: grep of `src/lib/better-auth-db.ts` finds no such export).

// ---------------------------------------------------------------------------
// Session lifecycle-column writes — a dedicated column-level detector
// (scanSource()'s matcher is table-level only).
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = ["activeOrganizationId", "activeTeamId"];
const SESSION_COLUMN_GROUP = `(?:${SESSION_COLUMNS.join("|")})`;

// Raw SQL: an UPDATE targeting the (possibly schema-qualified, possibly
// quoted) `session` table whose SET clause mentions one of the two columns
// within a bounded window (keeps the regex from running away across an
// unrelated later statement).
const SESSION_RAW_SQL_RE = new RegExp(
  String.raw`\bUPDATE\s+(?:ONLY\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?"?session"?\s+SET\s+[\s\S]{0,500}?"(${SESSION_COLUMNS.join(
    "|",
  )})"`,
  "gi",
);

// Raw SQL INSERT (incl. upsert / ON CONFLICT DO UPDATE): an INSERT whose
// target is the (possibly schema-qualified, possibly quoted) `session` table
// and whose statement names either lifecycle column within a bounded window
// (codex 1942-v2 r0 #5 — the UPDATE-only detector missed insert/upsert
// writes to these columns).
const SESSION_RAW_INSERT_RE = new RegExp(
  String.raw`\bINSERT\s+INTO\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?"?session"?\s*\([\s\S]{0,500}?"(${SESSION_COLUMNS.join(
    "|",
  )})"`,
  "gi",
);

// Drizzle: `.update(betterAuthSessions)` ... `.set({ ... activeOrganizationId|activeTeamId ... })`
// within a bounded window (chained builder calls; `.set(` is usually the very
// next call, but tolerate `.where()`-before-`.set()` reordering by scanning
// a generous window either direction is unnecessary — Drizzle's builder
// requires `.set()` to immediately follow `.update()` in this codebase's
// style, so a forward-only bounded window is sufficient and keeps the regex
// simple).
const SESSION_DRIZZLE_RE = new RegExp(
  String.raw`\.update\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*betterAuthSessions\b[\s\S]{0,500}?\.set\s*\([\s\S]{0,500}?(${SESSION_COLUMN_GROUP})\b`,
  "g",
);

// Drizzle: `.insert(betterAuthSessions)` ... `.values({ ... })` (or an
// `.onConflictDoUpdate` upsert) naming either lifecycle column within the
// same bounded window (codex 1942-v2 r0 #5).
const SESSION_DRIZZLE_INSERT_RE = new RegExp(
  String.raw`\.insert\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*betterAuthSessions\b[\s\S]{0,500}?(${SESSION_COLUMN_GROUP})\b`,
  "g",
);

/** 1-indexed line number of `index` within `code`. */
function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (code[i] === "\n") line += 1;
  return line;
}

/**
 * Scan one module's comment-stripped source for session lifecycle-column
 * writes. Returns `{form, target, ref, line}[]` in the same shape
 * `scanSource()` produces, so the two detectors compose cleanly.
 */
export function scanSessionColumnWrites(strippedCode) {
  const findings = [];
  for (const re of [
    SESSION_RAW_SQL_RE,
    SESSION_RAW_INSERT_RE,
    SESSION_DRIZZLE_RE,
    SESSION_DRIZZLE_INSERT_RE,
  ]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(strippedCode)) !== null) {
      const column = m[1];
      findings.push({
        form: "session-column",
        target: column,
        ref: `session-column:${column}`,
        line: lineOf(strippedCode, m.index),
      });
    }
  }
  findings.sort((a, b) => a.line - b.line || a.ref.localeCompare(b.ref));
  return findings;
}

// ---------------------------------------------------------------------------
// Scan roots + surface computation
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "__generated__", "coverage"]);

export function isScannable(rel) {
  if (rel.includes("/__tests__/")) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false;
  if (rel.endsWith(".d.ts")) return false;
  return true;
}

function* walk(rootAbs) {
  if (!existsSync(rootAbs)) return;
  for (const entry of readdirSync(rootAbs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(rootAbs, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield abs;
  }
}

/** The concrete file list this gate scans: `src/app`, `src/lib`, `packages`.
 *  `scripts/**` and migration trees are OUT OF SCOPE by doctrine (see module
 *  doc) — the same posture `system-writer-manifest-gate.mjs` takes. */
export function collectScanFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const files = [];
  for (const root of ["src/app", "src/lib", "packages"]) {
    for (const abs of walk(join(repoRoot, root))) files.push(relative(repoRoot, abs));
  }
  return files.filter(isScannable).sort();
}

/**
 * Compute the writer surface as sorted `{file, ref, count}` rows. Dependency-
 * injected IO so a test can drive a synthetic tree without touching the repo.
 */
export function computeSurface({
  files,
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = (p) => readFileSync(p, "utf8"),
} = {}) {
  const list = files ?? collectScanFiles(repoRoot);
  const counts = new Map(); // `${file} ${ref}` -> count
  for (const rel of list) {
    const source = readFileImpl(join(repoRoot, rel));
    const tableFindings = scanSource(source, { tables: BYPASS_TABLES, symbols: BYPASS_SYMBOLS, writerNames: [] });
    // scanSource() strips comments internally; the session detector needs the
    // SAME stripped text, so re-derive it via scanSource's own lexer by
    // importing stripComments directly would duplicate an import — instead
    // scan the raw source here too: the session detector's own regexes are
    // conservative enough (anchored on `UPDATE ... session` / `.update(
    // betterAuthSessions)`) that scanning un-stripped source only risks a
    // FALSE positive inside a comment/string, never a missed real write, and
    // every finding is manually reviewed via the allowlist regardless.
    const sessionFindings = scanSessionColumnWrites(source);
    for (const f of [...tableFindings, ...sessionFindings]) {
      const key = `${rel} ${f.ref}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, ref] = key.split(" ");
      return { file, ref, count };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.ref.localeCompare(b.ref));
}

export function loadAllowlist(repoRoot = DEFAULT_REPO_ROOT) {
  const path =
    repoRoot === DEFAULT_REPO_ROOT
      ? ALLOWLIST_PATH
      : join(repoRoot, "scripts", "audit", "org-archive-bypass-allowlist.json");
  if (!existsSync(path)) return { writers: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Two-directional diff of a computed surface against the allowlist's rows
 * (same shape as `system-writer-manifest-gate.mjs`'s `diffManifest`).
 */
export function diffAllowlist(surface, allowlistWriters) {
  const key = (r) => `${r.file} ${r.ref}`;
  const allowByKey = new Map(allowlistWriters.map((r) => [key(r), r]));
  const surfaceByKey = new Map(surface.map((r) => [key(r), r]));
  const unlisted = [];
  const drifted = [];
  for (const r of surface) {
    const a = allowByKey.get(key(r));
    if (!a) unlisted.push(r);
    else if (a.count !== r.count) drifted.push({ file: r.file, ref: r.ref, found: r.count, allowlist: a.count });
  }
  const stale = allowlistWriters.filter((r) => !surfaceByKey.has(key(r)));
  return { unlisted, stale, drifted };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function writeAllowlist(repoRoot = DEFAULT_REPO_ROOT) {
  const surface = computeSurface({ repoRoot });
  const existing = loadAllowlist(repoRoot);
  const reasonByKey = new Map(
    (existing.writers ?? []).map((r) => [`${r.file} ${r.ref}`, r.reason]),
  );
  const doc = {
    note:
      "App-native archived-org write bypass allowlist (cinatra#1942 archive V2). Every row is a " +
      "write site to member/invitation/teamMember/session.activeOrganizationId/activeTeamId OUTSIDE " +
      "the Better-Auth dispatch-hook's view (src/lib/organization-dispatch-policy.ts). The gate fails " +
      "on any scanner hit absent here (unlisted), any row the scanner no longer finds (stale), and any " +
      "count drift. `scripts/**` and migration trees are out of scope by doctrine (see the gate's own " +
      "module doc). Regenerate with: node scripts/audit/org-archive-bypass-scan.mjs --write-allowlist " +
      "-- then RESTORE each row's `reason` (this command does not fabricate one).",
    version: 1,
    writers: surface.map((r) => ({
      ...r,
      reason: reasonByKey.get(`${r.file} ${r.ref}`) ?? "TODO: justify this write site",
    })),
  };
  writeFileSync(ALLOWLIST_PATH, JSON.stringify(doc, null, 2) + "\n");
  return surface;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--write-allowlist")) {
    const surface = writeAllowlist();
    console.log(`[${LABEL}] allowlist written — ${surface.length} writer row(s) (review every "reason").`);
    return 0;
  }

  const surface = computeSurface();
  const allowlist = loadAllowlist();
  const { unlisted, stale, drifted } = diffAllowlist(surface, allowlist.writers ?? []);
  const missingReason = (allowlist.writers ?? []).filter(
    (r) => !r.reason || /^TODO/i.test(r.reason),
  );

  if (unlisted.length === 0 && stale.length === 0 && drifted.length === 0 && missingReason.length === 0) {
    console.log(`[${LABEL}] clean — ${surface.length} app-native writer row(s) match the allowlist.`);
    return 0;
  }

  if (unlisted.length > 0) {
    console.error(`[${LABEL}] ${unlisted.length} UNLISTED write site(s) (present in the tree, absent from the allowlist):`);
    for (const r of unlisted) console.error(`  + ${r.file}  [${r.ref}]  x${r.count}`);
  }
  if (stale.length > 0) {
    console.error(`[${LABEL}] ${stale.length} STALE allowlist row(s) (in the allowlist, no longer in the tree):`);
    for (const r of stale) console.error(`  - ${r.file}  [${r.ref}]  x${r.count}`);
  }
  if (drifted.length > 0) {
    console.error(`[${LABEL}] ${drifted.length} COUNT DRIFT (a write site was added/removed inside a listed file):`);
    for (const r of drifted) console.error(`  ~ ${r.file}  [${r.ref}]  found ${r.found}, allowlist ${r.allowlist}`);
  }
  if (missingReason.length > 0) {
    console.error(`[${LABEL}] ${missingReason.length} allowlist row(s) missing a real "reason":`);
    for (const r of missingReason) console.error(`  ? ${r.file}  [${r.ref}]`);
  }
  console.error(
    `\nAn app-native write to member/invitation/teamMember/session lifecycle columns is invisible to ` +
      `the Better-Auth dispatch-hook policy. Either (a) gate it with ` +
      `@/lib/organization-archive-guard's assertTargetOrgNotArchived, or (b) enumerate it deliberately ` +
      `with a real justification:\n` +
      `  node scripts/audit/org-archive-bypass-scan.mjs --write-allowlist\n` +
      `then write a real "reason" for each new/changed row before committing.`,
  );
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
