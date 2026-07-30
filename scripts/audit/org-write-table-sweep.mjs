#!/usr/bin/env node
// CI gate: the org-axis raw-SQL table-writer sweep — cinatra#1938 (S2).
//
// Complements the registry lockstep tests: scans src/ + packages/ + scripts/
// for RAW SQL DML (INSERT INTO / UPDATE / DELETE FROM in string literals)
// against the org-axis tables, and fails on any writer FILE that is neither a
// registry-covered module nor in the committed baseline. Drizzle-call DML is
// deliberately out of scope here — it is covered by the existing per-table
// AST write guards for dashboards and objects, and by the registry lockstep
// test's writer-set pin.
//
// NO-NEW-ROT RATCHET: the committed baseline records the CURRENT raw-SQL
// surface per file; it can only shrink. Regenerate with --write-baseline.
//
// Usage:
//   node scripts/audit/org-write-table-sweep.mjs                  # check
//   node scripts/audit/org-write-table-sweep.mjs --write-baseline # regenerate

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const BASELINE_PATH = join(__dirname, "org-write-table-sweep.baseline.json");

/** Org-axis tables (registry storageReferences universe + kernel tables). */
const ORG_AXIS_TABLES = [
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
  // write inventory registered. The assistant/assertion/pin tables below are
  // written in the quoted-literal style this regex sees; the connect/widget
  // tables' CURRENT writers interpolate their table names (invisible to this
  // regex — the registry writer-set lockstep tests are the pin for those
  // modules), listed here so any FUTURE quoted-style writer is caught.
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

/** Registry-covered / infrastructure modules: raw DML here is accounted for. */
const COVERED_PREFIXES = [
  "src/lib/artifacts/",
  "src/lib/objects/",
  "src/lib/object-history/",
  "src/lib/objects-store.ts",
  "src/lib/dashboards/dashboard-artifact-twin-writer.ts",
  "src/lib/organization-delete.ts",
  // cinatra#1939 wave 3 Stage D: registered (runResourceProjectMove /
  // runAgentRunMoveWithOutputs rows) + converted onto the kernel's guarded
  // fixed-batch — baseline entry removed (the ratchet shrinks).
  "src/lib/resource-project-move.ts",
  // cinatra#1939 wave 3 edge-family sweep: registered SINGLE-PURPOSE store
  // modules (rows + exemptions in write-registry.ts; a writer-set lockstep
  // test pins each module's full export surface — stronger than this count
  // ratchet). The BROAD modules the same sweep registered writers in
  // (src/lib/database.ts and the project-inheritance.ts builders its chat
  // writers execute) are deliberately NOT prefix-covered: they carry
  // committed BASELINE counts instead, so a new raw org-axis DML site in
  // either file fails this gate rather than hiding behind a prefix.
  "src/lib/assistant-thread-store.ts",
  "src/lib/assistant-thread-dormant-content-purge.ts",
  "src/lib/connect-sites-store.ts",
  "src/lib/widget-user-auth.ts",
  "src/lib/drizzle-store.ts", // DDL owner
  "packages/org-write-kernel/",
  "packages/migrations/",
  "scripts/", // schema bootstrap / migrate / audit tooling
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "__generated__"]);
// Raw org-axis DML in this repo is always a QUOTED identifier, optionally
// schema-qualified with a (usually interpolated) quoted schema, e.g.
//   UPDATE "${schema}"."agent_runs"        INSERT INTO "${q}"."objects"
// Anchoring on `"<table>"` (with an optional `"<schema>".` prefix) — rather
// than a bare word within slop — is what separates real DML from English prose
// ("...update authz still applies inside the objects handlers") and fluent JS
// (`objects.update(`, `updateStagedResource(`), which never quote the table.
// Comments are stripped before matching (below), so SQL documented in prose is
// not counted either. Drizzle query-builder writes are out of scope here (they
// emit no raw SQL text); the boundary gate + registry cover those.
const DML_RE = new RegExp(
  `(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:"[^"]*"\\s*\\.\\s*)?"(?:${ORG_AXIS_TABLES.join("|")})"`,
  "gi",
);

function isCovered(fileRel) {
  return (
    COVERED_PREFIXES.some((p) => fileRel === p || fileRel.startsWith(p)) ||
    fileRel.includes("__tests__") ||
    fileRel.includes(".test.") ||
    fileRel.includes("/tests/") ||
    fileRel.startsWith("tests/")
  );
}

function* walk(rootAbs) {
  for (const entry of readdirSync(rootAbs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(rootAbs, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield abs;
  }
}

/** Blank out `//` line comments and block comments before matching. Raw SQL
 *  DML lives in code / template literals, never in a JS comment; prose like
 *  "// UPDATE objects.project_id ..." would otherwise be counted as a write
 *  site. Replacing with spaces (not "") keeps byte offsets stable. SQL uses
 *  `--` for its own comments, so stripping `//` cannot eat real DML. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function scan() {
  const surface = {};
  for (const root of ["src", "packages", "scripts"]) {
    const rootAbs = join(REPO_ROOT, root);
    if (!existsSync(rootAbs)) continue;
    for (const abs of walk(rootAbs)) {
      const fileRel = relative(REPO_ROOT, abs);
      if (isCovered(fileRel)) continue;
      const text = stripComments(readFileSync(abs, "utf-8"));
      const hits = text.match(DML_RE);
      if (hits && hits.length > 0) surface[fileRel] = hits.length;
    }
  }
  return surface;
}

function main() {
  const surface = scan();
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(BASELINE_PATH, JSON.stringify(surface, null, 2) + "\n");
    console.log(`org-write-table-sweep: baseline written (${Object.keys(surface).length} file(s))`);
    return;
  }
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf-8"))
    : {};
  const violations = [];
  for (const [file, count] of Object.entries(surface)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) violations.push(`${file}: ${count} raw org-axis DML site(s) (baseline ${allowed})`);
  }
  if (violations.length > 0) {
    console.error("org-write-table-sweep: NEW unregistered raw org-axis DML:");
    for (const v of violations) console.error(`  ${v}`);
    console.error("Register the writer in src/lib/org-write/write-registry.ts (and extend COVERED_PREFIXES) or shrink the change.");
    process.exit(1);
  }
  console.log(`org-write-table-sweep: OK (${Object.keys(surface).length} baselined file(s), no new surface)`);
}

main();
