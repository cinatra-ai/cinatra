#!/usr/bin/env node
/**
 * Non-registry system writer manifest gate — cinatra#1941 (S3).
 *
 * WHY THIS EXISTS. Two mechanisms already classify org-scoped writers:
 *   - BACKGROUND_JOB_REGISTRY classifies every QUEUE-dispatched writer
 *     (src/lib/background-jobs-registry.ts — the #1941 S1 authority metadata);
 *   - the org-write REGISTRY classifies the canonical writer ENTRY POINTS
 *     (src/lib/org-write/write-registry.ts — one row per exported writer).
 * What NEITHER covers is WHO ELSE reaches org data OUTSIDE both: boot phases,
 * one-shot backfills, and CLI reconcilers. Those run above per-org policy the
 * same way a migration does, but — unlike a migration — they can and do make
 * per-org decisions, so they are exactly where an unaudited org write hides.
 * This gate ENUMERATES that population into a committed manifest and freezes
 * the set: a new writer that is not in the manifest fails CI, and a manifest
 * row the scanner no longer finds fails too (two-directional drift). The
 * manifest is the reviewable record of "every non-registry system writer we
 * know about, and why it is sanctioned".
 *
 * SCAN ROOTS (scanned; everything else is out of scope by construction):
 *   - src/lib/boot/**            boot phases + boot orchestrator surface
 *   - src/instrumentation.node.ts, src/instrumentation.ts
 *   - scripts/**                 CLI reconcilers / ops / seed / fixtures
 * EXCLUDED WITHIN scripts/**:
 *   - scripts/audit/**           the gate corpus itself contains SQL-shaped
 *                                regex text and table names as DATA; scanning
 *                                it would flag the detectors on their own
 *                                vocabulary (the same self-exemption posture
 *                                every sibling gate takes for its own tree).
 *   - scripts/__tests__/**, any __tests__/ dir, and *.test.* / *.spec.*
 *                                test fixtures carry deliberate SQL strings.
 *
 * MIGRATIONS ARE OUT OF SCOPE BY DOCTRINE — NOT AN OVERSIGHT.
 *   Numbered migrations (migrations/**, packages/migrations/**) and the
 *   in-tree migration runner (src/lib/migrations/**) execute DDL and data
 *   backfills at a privilege boundary ABOVE per-org write policy: they define
 *   the tables the kernel rules over, are serialized by the migration runner,
 *   and are reviewed by their own gate (schema-migration-gate.mjs). They do
 *   not — and must not — consult per-org lifecycle mid-flight. The full
 *   rationale, the compensating controls, and the BOUNDARY RULE (a migration
 *   backfill that needs per-org policy decisions is no longer a migration — it
 *   must become a boot-phase / CLI reconciler, which then lands in THIS
 *   manifest) are the contract in
 *     docs/internals/contracts/schema-migrations-and-org-write-policy.md
 *   None of the scan roots above include a migration tree, so migrations are
 *   excluded simply by never being scanned.
 *
 * DETECTION — three forms, all over COMMENT-STRIPPED source (the shared lexer
 * in ./lib/strip-comments.mjs, so a prose mention of a table or a `//` inside a
 * URL can neither trip nor hide a real write). All three are needed: dropping
 * any one leaves a whole class of writer invisible and the gate green for the
 * wrong reason.
 *
 *   1. RAW SQL DML anchored on a QUALIFIED table identifier. A write verb
 *      (INSERT INTO / UPDATE / DELETE FROM / TRUNCATE / COPY..FROM) whose
 *      TARGET is one of the org-axis tables in either shape this repo actually
 *      writes:
 *        - schema-qualified — `cinatra.objects`, `"cinatra".objects`,
 *          `"${schema}"."objects"` (the src/packages interpolation shape AND
 *          the schema-qualified bare shape that scripts/seed.mjs uses), or
 *        - unqualified but QUOTED — `"objects"`.
 *      A TOTALLY BARE `objects` (no schema, no quotes) is deliberately NOT a
 *      match: that is the org-wide table-sweep lesson (org-write-table-sweep
 *      .mjs) applied — a bare-word anchor matches English prose and fluent JS
 *      (`objects.update(`), producing a prose-only baseline and a gate green
 *      for the wrong reason. Anchoring on the verb->qualified-target span (and
 *      stripping comments first) is what separates real DML from prose. This
 *      is a deliberate, documented WIDENING of the sweep's quoted-only anchor
 *      to also accept a schema-qualified bare table, because every real
 *      raw-SQL org-axis write in the scan roots is one of those two shapes and
 *      the quoted-only anchor alone finds ZERO of them (verified at impl).
 *   2. DRIZZLE-builder DML — `.insert(<sym>)` / `.update(<sym>)` /
 *      `.delete(<sym>)` on an org-axis Drizzle table symbol, with per-file
 *      local-alias resolution (import rename `{ agentRuns as r }`, local
 *      `const r = agentRuns`) and namespace qualifiers (`schema.agentRuns`).
 *      Lifted from review-decision-writer-drift-gate.mjs; same accepted
 *      residuals (a cross-module alias, or a table passed through a generic
 *      helper, is review territory, not lexical).
 *   3. WRITE-REGISTRY entry-point CALL SITES — for each writer exportName in
 *      src/lib/org-write/write-registry.ts, a CALL `<localName>(` (aliases
 *      resolved per file). Boot phases and CLIs mostly write THROUGH the
 *      canonical stores rather than raw SQL, so WITHOUT this form the manifest
 *      is near-empty and every backfill goes unlisted — structural
 *      wrong-reason-green, not a regex miss. A bare import with no call is not
 *      a writer; an aliased call is. The exportName list is read from the
 *      registry SOURCE at runtime (scripts run without the TS toolchain); a
 *      lockstep test pins the extracted set against the real ORG_WRITE_REGISTRY
 *      so the two can never silently diverge.
 *
 * GATE SEMANTICS (no ratchet — zero unlisted tolerated; two-directional):
 *   surface = the { file, ref, count } triples the scanner finds now.
 *   VIOLATION when, comparing surface to the committed manifest:
 *     - a surface triple has NO manifest row              (UNLISTED writer)
 *     - a manifest row has NO surface triple              (STALE row)
 *     - counts differ for a matched (file, ref)           (COUNT DRIFT —
 *       a new write site inside a listed file is a review event, either
 *       direction).
 *   `ref` = `raw-sql:<table>` | `drizzle:<symbol>` | `write-registry:<export>`.
 *   Regenerate deliberately with `--write-manifest`; the diff is the review.
 *
 * Exit 0 -> clean; exit 1 -> at least one drift (printed to stderr);
 * exit 2 -> scanner error.
 *
 * Usage:
 *   node scripts/audit/system-writer-manifest-gate.mjs                  # check
 *   node scripts/audit/system-writer-manifest-gate.mjs --write-manifest # regen
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");

const LABEL = "system-writer-manifest";
export const MANIFEST_PATH = join(__dirname, "system-writer-manifest.json");
export const WRITE_REGISTRY_REL = "src/lib/org-write/write-registry.ts";
export const SWEEP_REL = "scripts/audit/org-write-table-sweep.mjs";

// ---------------------------------------------------------------------------
// Table universe
// ---------------------------------------------------------------------------

/**
 * The org-axis tables owned by the raw-SQL sweep (org-write-table-sweep.mjs).
 * COPIED here rather than imported (that gate does not export the array); a
 * lockstep test reads the sweep SOURCE and asserts this subset equals it, so
 * the two gates can never silently diverge on the org-axis universe.
 */
export const SWEEP_ORG_AXIS_TABLES = [
  "objects",
  "resource",
  "representation",
  "artifact_blobs",
  "artifact_audit",
  "change_set",
  "object_change_event",
  "graphiti_projection_outbox",
  "agent_runs",
  "org_archive_lease",
  "org_write_completion_ticket",
  // cinatra#1939 wave 3 edge-family sweep: org-axis tables the per-family
  // write inventory registered (mirrors org-write-table-sweep.mjs's own
  // wave-3 addition — the lockstep test below pins these two lists equal).
  // `semantic_assertion` moves here (out of MAINTENANCE_TABLES) rather than
  // being listed in both: it is a registered storageReferences table in
  // write-registry.ts, so it no longer sits OUTSIDE the kernel write
  // universe as MAINTENANCE_TABLES requires — the sweep now owns it.
  "semantic_assertion",
  "assistant_threads",
  "assistant_turns",
  "assistant_thread_pause_state",
  "artifact_refs",
  "connect_authorization_codes",
  "connect_sites",
  "widget_auth_transactions",
  "widget_auth_codes",
  "widget_user_tokens",
];

/**
 * Org-keyed MAINTENANCE tables surfaced by #1941's job classification that sit
 * OUTSIDE the kernel write universe (caches, run-owned link furniture, the
 * binding reconcile queue). A raw/Drizzle write to one of these from a boot
 * phase or CLI is exactly the unaudited system writer this manifest is meant
 * to enumerate. (The semantic-assertion draft table moved to
 * SWEEP_ORG_AXIS_TABLES above once the #1939 wave-3 sweep started tracking it
 * as a registered org-axis table — see that entry's comment.)
 */
export const MAINTENANCE_TABLES = [
  "artifact_provider_cache",
  "environment_layers",
  "environment_layer_references",
  "agent_run_pm_links",
  "artifact_binding_reconcile_queue",
];

/** The full table universe this gate anchors raw-SQL / Drizzle detection on. */
export const ORG_AXIS_TABLES = [...SWEEP_ORG_AXIS_TABLES, ...MAINTENANCE_TABLES];

const snakeToCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
/** Conventional Drizzle table symbols (camelCase of the snake_case table). */
export const ORG_AXIS_SYMBOLS = ORG_AXIS_TABLES.map(snakeToCamel);

// ---------------------------------------------------------------------------
// Form 1 — raw SQL DML on a QUALIFIED org-axis table target
// ---------------------------------------------------------------------------

// A schema qualifier component: a quoted identifier (covers `"${schema}"` and
// `"cinatra"`) or a bare identifier (`cinatra`).
const SCHEMA_IDENT = String.raw`(?:"[^"]*"|[A-Za-z_][\w$]*)`;
// A leading run of OTHER comma-separated targets so the org-axis table is still
// found when it is not the FIRST target (`TRUNCATE a, cinatra.agent_runs`).
const OTHER_TARGETS = String.raw`(?:${SCHEMA_IDENT}(?:\s*\.\s*${SCHEMA_IDENT})?\s*,\s*)*`;
// Raw-SQL write verbs. DDL (CREATE / ALTER / DROP) is absent by design — schema
// ownership is the migrations' invariant, not this one. `DELETE` matches only
// with `FROM`, which keeps `REFERENCES objects(id) ON DELETE CASCADE` clean.
const RAW_VERB = String.raw`INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?`;

/**
 * A qualified table TARGET, in the two shapes this repo actually writes:
 *   - schema-qualified: `<schema> . <table>` where the table may be quoted or
 *     bare (`cinatra.objects`, `"${schema}"."objects"`, `"cinatra".objects`);
 *   - unqualified but QUOTED: `"objects"`.
 * A totally-bare `objects` is intentionally excluded (prose / fluent-JS class).
 * Table capture groups: quoted-in-qualified, bare-in-qualified, quoted-alone.
 */
function qualifiedTarget(tables) {
  const T = tables.join("|");
  const qualified = SCHEMA_IDENT + String.raw`\s*\.\s*(?:"(${T})"|(${T})\b)`;
  const quotedAlone = String.raw`"(${T})"`;
  return `(?:${qualified}|${quotedAlone})`;
}

function rawSqlPattern(tables) {
  // Groups: 1 = verb, then the three table groups from qualifiedTarget().
  return new RegExp(
    String.raw`\b(${RAW_VERB})\s+(?:ONLY\s+)?` + OTHER_TARGETS + qualifiedTarget(tables),
    "gi",
  );
}

function copyFromPattern(tables) {
  // `COPY <target> [(cols)] FROM` only — the WRITING direction. `COPY .. TO` is
  // an export (a read) and is not matched.
  return new RegExp(
    String.raw`\b(COPY)\s+` + qualifiedTarget(tables) + String.raw`\s*(?:\([^)]*\)\s*)?FROM\b`,
    "gi",
  );
}

// ---------------------------------------------------------------------------
// Form 2 — Drizzle-builder DML on an org-axis symbol
// ---------------------------------------------------------------------------

function drizzlePattern(symbols) {
  return new RegExp(
    String.raw`\.\s*(insert|update|delete)\s*(?:<[^<>]*>)?\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*(${symbols.join("|")})\b`,
    "g",
  );
}

/**
 * Resolve the LOCAL names of the org-axis Drizzle symbols inside one module:
 * import renames (`agentRuns as r`) and local assignments (`const r =
 * agentRuns`). Cross-module aliases are the documented residual (see header).
 */
export function resolveLocalSymbols(code, symbols = ORG_AXIS_SYMBOLS) {
  const local = new Set(symbols);
  const group = `(?:${symbols.join("|")})`;
  const patterns = [
    new RegExp(String.raw`\b${group}\s+as\s+([A-Za-z_$][\w$]*)`, "g"),
    new RegExp(
      String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*${group}\b`,
      "g",
    ),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) local.add(m[1]);
  }
  return [...local];
}

// ---------------------------------------------------------------------------
// Form 3 — write-registry entry-point call sites
// ---------------------------------------------------------------------------

/**
 * Extract every canonical writer exportName from write-registry.ts SOURCE.
 * Two shapes are in the file today: an explicit `exportName: "x"` field and the
 * `dashboardsWriter("x", ...)` helper whose first argument IS the exportName.
 * A lockstep test pins the union against the real ORG_WRITE_REGISTRY so a
 * future shape the extractor misses (or a helper rename) fails loudly.
 */
export function extractWriteRegistryWriters(registrySource) {
  const names = new Set();
  for (const m of registrySource.matchAll(/exportName:\s*"([^"]+)"/g)) names.add(m[1]);
  for (const m of registrySource.matchAll(/dashboardsWriter\(\s*"([^"]+)"/g)) names.add(m[1]);
  return [...names];
}

/**
 * Per-file local-name map for the writer exportNames: canonical name -> canon,
 * plus import renames (`backfillX as b`) and local assignments (`const b =
 * backfillX`). Returns Map<localName, canonicalName>.
 */
export function resolveWriterLocalNames(code, writerNames) {
  const local = new Map(writerNames.map((n) => [n, n]));
  if (writerNames.length === 0) return local;
  const group = `(?:${writerNames.join("|")})`;
  for (const m of code.matchAll(new RegExp(String.raw`\b(${group})\s+as\s+([A-Za-z_$][\w$]*)`, "g"))) {
    local.set(m[2], m[1]);
  }
  for (const m of code.matchAll(
    new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(${group})\b`, "g"),
  )) {
    local.set(m[1], m[2]);
  }
  return local;
}

// ---------------------------------------------------------------------------
// The shared matcher — CLI and tests both call this, so they cannot drift.
// ---------------------------------------------------------------------------

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
 * Scan ONE module's source for non-registry org writers, all three forms.
 * Pure: takes source text (raw file contents — comment-stripped internally)
 * plus the writer exportName list, returns findings.
 *
 * @param {string} source raw file contents
 * @param {{ writerNames?: string[], tables?: string[], symbols?: string[] }} opts
 * @returns {{form:string, target:string, ref:string, line:number, text:string}[]}
 */
export function scanSource(source, opts = {}) {
  const tables = opts.tables ?? ORG_AXIS_TABLES;
  const symbols = opts.symbols ?? ORG_AXIS_SYMBOLS;
  const writerNames = opts.writerNames ?? [];
  const code = stripComments(source);
  const findings = [];

  // Form 1 — raw SQL (write verbs + COPY..FROM), qualified targets.
  for (const re of [rawSqlPattern(tables), copyFromPattern(tables)]) {
    let m;
    while ((m = re.exec(code)) !== null) {
      // Verb pattern has group 1 = verb then 3 table groups; COPY pattern has
      // group 1 = COPY then 3 table groups. In both, coalesce the table.
      const table = m[2] ?? m[3] ?? m[4];
      if (!table) continue;
      findings.push({
        form: "raw-sql",
        target: table,
        ref: `raw-sql:${table}`,
        line: lineOf(code, m.index),
        text: excerpt(code, m.index),
      });
    }
  }

  // Form 2 — Drizzle builder DML on org-axis symbols (alias-resolved).
  const localSymbols = resolveLocalSymbols(code, symbols);
  const canonicalOf = new Map();
  // Map any resolved local symbol back to its canonical camelCase for the ref.
  for (const sym of symbols) canonicalOf.set(sym, sym);
  // Re-derive alias -> canonical so the ref is stable across renames.
  for (const sym of symbols) {
    for (const m of code.matchAll(new RegExp(String.raw`\b${sym}\s+as\s+([A-Za-z_$][\w$]*)`, "g"))) {
      canonicalOf.set(m[1], sym);
    }
    for (const m of code.matchAll(
      new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*${sym}\b`, "g"),
    )) {
      canonicalOf.set(m[1], sym);
    }
  }
  const drizzleRe = drizzlePattern(localSymbols);
  let dm;
  while ((dm = drizzleRe.exec(code)) !== null) {
    const canonical = canonicalOf.get(dm[2]) ?? dm[2];
    findings.push({
      form: "drizzle",
      target: canonical,
      ref: `drizzle:${canonical}`,
      line: lineOf(code, dm.index),
      text: excerpt(code, dm.index),
    });
  }

  // Form 3 — write-registry entry-point call sites (alias-resolved).
  if (writerNames.length > 0) {
    const localNames = resolveWriterLocalNames(code, writerNames);
    for (const [local, canonical] of localNames) {
      const callRe = new RegExp(String.raw`\b${local}\s*\(`, "g");
      let cm;
      while ((cm = callRe.exec(code)) !== null) {
        findings.push({
          form: "write-registry",
          target: canonical,
          ref: `write-registry:${canonical}`,
          line: lineOf(code, cm.index),
          text: excerpt(code, cm.index),
        });
      }
    }
  }

  findings.sort((a, b) => a.line - b.line || a.ref.localeCompare(b.ref));
  return findings;
}

// ---------------------------------------------------------------------------
// Scan roots + surface computation
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "__generated__"]);

/** True when a scan-root file is IN scope: not the gate corpus, not a test,
 *  not a type-declaration file. Applied to every root (boot / instrumentation /
 *  scripts); the scripts/-prefixed checks are simply no-ops for src/ paths. */
export function isScannable(rel) {
  if (rel.startsWith("scripts/audit/")) return false;
  if (rel.startsWith("scripts/__tests__/")) return false;
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
    else if (/\.(ts|tsx|mts|mjs|cts|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield abs;
  }
}

/** The concrete file list this gate scans (boot + instrumentation + scripts).
 *  isScannable() is applied to EVERY root so a stray test file under any of
 *  them (e.g. a future src/lib/boot/**\/*.test.ts) can never become a row. */
export function collectScanFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const files = [];
  for (const abs of walk(join(repoRoot, "src", "lib", "boot"))) files.push(relative(repoRoot, abs));
  for (const inst of ["src/instrumentation.node.ts", "src/instrumentation.ts"]) {
    if (existsSync(join(repoRoot, inst))) files.push(inst);
  }
  for (const abs of walk(join(repoRoot, "scripts"))) files.push(relative(repoRoot, abs));
  return files.filter(isScannable).sort();
}

/** Read the writer exportName list from the registry source. */
export function loadWriterNames(repoRoot = DEFAULT_REPO_ROOT, readFileImpl = (p) => readFileSync(p, "utf8")) {
  return extractWriteRegistryWriters(readFileImpl(join(repoRoot, WRITE_REGISTRY_REL)));
}

/**
 * Compute the writer surface as sorted { file, ref, count } rows — the exact
 * shape the manifest stores. Dependency-injected IO so a test can drive a
 * synthetic tree without touching the repo.
 */
export function computeSurface({
  files,
  repoRoot = DEFAULT_REPO_ROOT,
  readFileImpl = (p) => readFileSync(p, "utf8"),
  writerNames,
} = {}) {
  const list = files ?? collectScanFiles(repoRoot);
  const names = writerNames ?? loadWriterNames(repoRoot, readFileImpl);
  const counts = new Map(); // `${file} ${ref}` -> count
  for (const rel of list) {
    const findings = scanSource(readFileImpl(join(repoRoot, rel)), { writerNames: names });
    for (const f of findings) {
      const key = `${rel} ${f.ref}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, ref] = key.split(" ");
      return { file, ref, count };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.ref.localeCompare(b.ref));
}

export function loadManifest(repoRoot = DEFAULT_REPO_ROOT) {
  const path = repoRoot === DEFAULT_REPO_ROOT ? MANIFEST_PATH : join(repoRoot, "scripts", "audit", "system-writer-manifest.json");
  if (!existsSync(path)) return { writers: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Two-directional diff of a computed surface against a manifest's writer rows.
 * @returns {{unlisted:object[], stale:object[], drifted:object[]}}
 */
export function diffManifest(surface, manifestWriters) {
  const key = (r) => `${r.file} ${r.ref}`;
  const manifestByKey = new Map(manifestWriters.map((r) => [key(r), r]));
  const surfaceByKey = new Map(surface.map((r) => [key(r), r]));
  const unlisted = [];
  const drifted = [];
  for (const r of surface) {
    const m = manifestByKey.get(key(r));
    if (!m) unlisted.push(r);
    else if (m.count !== r.count) drifted.push({ file: r.file, ref: r.ref, found: r.count, manifest: m.count });
  }
  const stale = manifestWriters.filter((r) => !surfaceByKey.has(key(r)));
  return { unlisted, stale, drifted };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MANIFEST_NOTE =
  "Non-registry system writers (cinatra#1941). Every row is a concrete writer " +
  "site OUTSIDE BACKGROUND_JOB_REGISTRY and OUTSIDE the write-registry modules' " +
  "own bodies: boot phases, backfills, CLI reconcilers. Rows are {file, ref, " +
  "count}; ref = raw-sql:<table> | drizzle:<symbol> | write-registry:<export>. " +
  "The gate fails on any scanner hit absent here (no ratchet — zero unlisted " +
  "tolerated), on any row the scanner no longer finds (stale), and on any count " +
  "drift. Migrations are excluded by doctrine — see " +
  "docs/internals/contracts/schema-migrations-and-org-write-policy.md. " +
  "Regenerate with: node scripts/audit/system-writer-manifest-gate.mjs --write-manifest";

function writeManifest(repoRoot = DEFAULT_REPO_ROOT) {
  const surface = computeSurface({ repoRoot });
  const doc = { note: MANIFEST_NOTE, version: 1, writers: surface };
  writeFileSync(MANIFEST_PATH, JSON.stringify(doc, null, 2) + "\n");
  return surface;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--write-manifest")) {
    const surface = writeManifest();
    console.log(`[${LABEL}] manifest written — ${surface.length} writer row(s).`);
    return 0;
  }

  const surface = computeSurface();
  const manifest = loadManifest();
  const { unlisted, stale, drifted } = diffManifest(surface, manifest.writers ?? []);

  if (unlisted.length === 0 && stale.length === 0 && drifted.length === 0) {
    console.log(
      `[${LABEL}] clean — ${surface.length} non-registry system writer row(s) match the manifest.`,
    );
    return 0;
  }

  if (unlisted.length > 0) {
    console.error(`[${LABEL}] ${unlisted.length} UNLISTED writer(s) (present in the tree, absent from the manifest):`);
    for (const r of unlisted) console.error(`  + ${r.file}  [${r.ref}]  x${r.count}`);
  }
  if (stale.length > 0) {
    console.error(`[${LABEL}] ${stale.length} STALE manifest row(s) (in the manifest, no longer in the tree):`);
    for (const r of stale) console.error(`  - ${r.file}  [${r.ref}]  x${r.count}`);
  }
  if (drifted.length > 0) {
    console.error(`[${LABEL}] ${drifted.length} COUNT DRIFT (a write site was added/removed inside a listed file):`);
    for (const r of drifted) console.error(`  ~ ${r.file}  [${r.ref}]  found ${r.found}, manifest ${r.manifest}`);
  }
  console.error(
    `\nA non-registry system writer (boot phase / backfill / CLI reconciler) reaches org data ` +
      `outside both registries. Enumerate it deliberately:\n` +
      `  node scripts/audit/system-writer-manifest-gate.mjs --write-manifest\n` +
      `then justify each new/changed row in the commit. If the writer makes PER-ORG decisions it ` +
      `must mint system authority (post wave-3); if it belongs in a migration, see ` +
      `docs/internals/contracts/schema-migrations-and-org-write-policy.md.`,
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
