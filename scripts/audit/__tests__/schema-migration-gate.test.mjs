// Core-store schema migration gate — tests.
//
// Two layers:
//   1. The CORPUS CONTRACT: every labelled fixture diff in
//      scripts/audit/__fixtures__/schema-migration/ is run through the REAL
//      gate CLI (--diff-file mode) and must produce its labelled pass/fail
//      outcome. The fixtures are the executable form of the convention in
//      migrations/README.md — a misclassified fixture fails this suite.
//   2. Unit tests for the pure helpers (diff parser, region finder,
//      classifier, artifact detector) covering edges the corpus does not pin.
//
// Zero-dep (node:test) so the CI job needs no package install — the gate
// itself is pure node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  parseUnifiedDiff,
  applyFileDiff,
  resolveHunkOldStart,
  findSchemaRegions,
  classifyDrizzleStoreDiff,
  detectMigrationArtifact,
  runGate,
  findDdlLeafModules,
  resolveLeafSpecifier,
  normalizeDdlLine,
  schemaNameAliases,
  mutatedSchemaBindings,
  schemaBindingRedirects,
  schemaBindingScopes,
  unverifiedSchemaScopes,
  stripComments,
  unresolvedLeafSpreads,
  findLocalDdlHelpers,
  helperBody,
  leafDdlLines,
  IN_SCOPE_FILE,
  MIGRATION_MANIFEST_PATH,
  MIGRATION_FRAGMENT_DIR,
  SHIPPED_MODULE_CORRECTION_EXEMPTIONS,
  contentDigest,
} from "../schema-migration-gate.mjs";
import { buildManifestUnion, readManifestUnion } from "../../../migrations/manifest-reader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "schema-migration-gate.mjs");
const FIXTURES_DIR = join(REPO_ROOT, "scripts", "audit", "__fixtures__", "schema-migration");

// ---------------------------------------------------------------------------
// 1. Corpus contract — the gate reproduces every fixture's labelled verdict
// ---------------------------------------------------------------------------

const corpus = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8"));

test("fixture corpus covers the convention's required cases", () => {
  assert.ok(Array.isArray(corpus.fixtures) && corpus.fixtures.length >= 5, "corpus must keep at least the five founding fixtures");
  const expects = new Set(corpus.fixtures.map((f) => f.expect));
  assert.ok(expects.has("pass") && expects.has("fail"), "corpus must contain both pass and fail labels");
  const categories = corpus.fixtures.map((f) => f.category).join(" | ");
  for (const needle of ["destructive, no artifact", "destructive, has artifact", "additive", "out of scope", "spread-in leaf", "BY the relocation", "hidden inside the DDL leaf", "binding redirected under unchanged leaf DDL", "provenance leaves the builder"]) {
    assert.ok(categories.includes(needle), `corpus must keep a "${needle}" fixture (have: ${categories})`);
  }
});

// The corpus applies each fixture against a PINNED base: the volatile
// migrations/manifest.json is read from a frozen snapshot (base-manifest.json)
// while every other base file is the live working tree. This stops the ledger's
// append-only tail from rotting the fixtures every time a real migration lands
// — the snapshot ends at the sequence the fixtures were cut against, so their
// hunks (and the gate's own base read, via --base-dir) stay stable forever,
// while a genuine change to the in-scope DDL still invalidates a stale fixture
// through the live-tree files copied below.
const PINNED_BASE_MANIFEST = join(FIXTURES_DIR, "base-manifest.json");
// The pinned SHIPPED-fragment snapshot (base-manifest.d/): the base side of
// migrations/manifest.d/, so fragment fixtures can exercise seq collisions
// with — and tampering against — already-shipped fragments without rotting as
// real fragments land.
const PINNED_BASE_FRAGMENTS = join(FIXTURES_DIR, "base-manifest.d");

/**
 * Build a throwaway git work tree for one fixture: migrations/manifest.json
 * and migrations/manifest.d/ are the pinned snapshots; every other file the
 * fixture patches is copied live from the repo. `git apply --check` and the
 * gate (via --base-dir) both run against it, so neither rots when unrelated
 * migrations append to the live ledger.
 */
function makePinnedBase(fixtureText) {
  const dir = mkdtempSync(join(tmpdir(), "schema-migration-base-"));
  execFileSync("git", ["init", "-q", dir]);
  // The pinned ledger — always present so the gate's base manifest read is
  // deterministic even for fixtures that don't patch the manifest.
  mkdirSync(join(dir, "migrations", "core"), { recursive: true });
  copyFileSync(PINNED_BASE_MANIFEST, join(dir, MIGRATION_MANIFEST_PATH));
  // The pinned shipped fragments — the directory always exists (possibly
  // empty) so the gate's --base-dir listing is EXCLUSIVELY the snapshot and
  // live fragments cannot leak into fixture replays.
  mkdirSync(join(dir, MIGRATION_FRAGMENT_DIR), { recursive: true });
  for (const name of readdirSync(PINNED_BASE_FRAGMENTS)) {
    copyFileSync(join(PINNED_BASE_FRAGMENTS, name), join(dir, MIGRATION_FRAGMENT_DIR, name));
  }
  // Live copies of every other base file the fixture patches.
  for (const f of parseUnifiedDiff(fixtureText)) {
    if (f.status === "added") continue; // /dev/null base — nothing to seed
    const p = f.oldPath ?? f.newPath;
    if (!p || p === MIGRATION_MANIFEST_PATH || p.startsWith(`${MIGRATION_FRAGMENT_DIR}/`)) continue;
    const src = join(REPO_ROOT, p);
    if (!existsSync(src)) continue;
    const dest = join(dir, p);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  return dir;
}

for (const fixture of corpus.fixtures) {
  test(`fixture ${fixture.file} → ${fixture.expect} (${fixture.category})`, () => {
    const diffPath = join(FIXTURES_DIR, fixture.file);
    const fixtureText = readFileSync(diffPath, "utf8");
    const baseDir = makePinnedBase(fixtureText);
    try {
      // Corpus contract: the fixture applies cleanly to its pinned base. If this
      // throws, the in-scope DDL moved under the fixture — refresh it (and the
      // snapshot, if a real migration changed the ledger shape the fixtures
      // assume). See the corpus manifest _doc.
      execFileSync("git", ["apply", "--check", "--end-of-options", diffPath], { cwd: baseDir });

      const run = spawnSync(process.execPath, [GATE, "--diff-file", diffPath, "--base-dir", baseDir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      const output = `${run.stdout}\n${run.stderr}`;
      if (fixture.expect === "pass") {
        assert.equal(run.status, 0, `expected pass (exit 0), got ${run.status}:\n${output}`);
      } else {
        assert.equal(run.status, 1, `expected fail (exit 1), got ${run.status}:\n${output}`);
        assert.match(run.stderr, /migration artifact/i, "fail output must tell the author what to ship");
        assert.match(run.stderr, /migrations\/README\.md/, "fail output must cite the convention");
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Unit tests — diff parsing and application
// ---------------------------------------------------------------------------

/** Build a one-file unified diff that fully replaces oldContent with newContent. */
function fullReplaceDiff(path, oldContent, newContent) {
  const oldLines = oldContent === null ? [] : oldContent.split("\n");
  const newLines = newContent === null ? [] : newContent.split("\n");
  const header =
    oldContent === null
      ? `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${newLines.length} @@\n`
      : newContent === null
        ? `--- a/${path}\n+++ /dev/null\n@@ -1,${oldLines.length} +0,0 @@\n`
        : `--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  return (
    `diff --git a/${path} b/${path}\n` +
    header +
    oldLines.map((l) => `-${l}`).join("\n") +
    (oldLines.length ? "\n" : "") +
    newLines.map((l) => `+${l}`).join("\n") +
    (newLines.length ? "\n" : "")
  );
}

/** Build a one-hunk diff against `base` replacing the 1-based [from..to] range. */
function hunkDiff(path, base, from, to, replacement, ctx = 2) {
  const lines = base.split("\n");
  const before = lines.slice(Math.max(0, from - 1 - ctx), from - 1);
  const removed = lines.slice(from - 1, to);
  const after = lines.slice(to, to + ctx);
  const oldStart = from - before.length;
  const oldCount = before.length + removed.length + after.length;
  const newCount = before.length + replacement.length + after.length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@\n` +
    [...before.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...replacement.map((l) => `+${l}`), ...after.map((l) => ` ${l}`)].join("\n") +
    "\n"
  );
}

test("parseUnifiedDiff reads file statuses and hunks", () => {
  const text =
    fullReplaceDiff("migrations/0002_demo.sql", null, "ALTER TABLE x;") +
    hunkDiff("src/lib/drizzle-store.ts", "a\nb\nc\nd\ne", 3, 3, ["C"]);
  const files = parseUnifiedDiff(text);
  assert.equal(files.length, 2);
  assert.equal(files[0].status, "added");
  assert.equal(files[0].newPath, "migrations/0002_demo.sql");
  assert.equal(files[1].status, "modified");
  assert.equal(files[1].hunks.length, 1);
  assert.deepEqual(
    files[1].hunks[0].lines.map((l) => l.type),
    ["ctx", "ctx", "del", "add", "ctx", "ctx"],
  );
});

test("applyFileDiff reproduces the new content (anchored by old-side lines, not stated offsets)", () => {
  const base = ["one", "two", "three", "four", "five"].join("\n");
  const diff = parseUnifiedDiff(hunkDiff("f", base, 3, 3, ["THREE", "three-and-a-half"]));
  assert.equal(applyFileDiff(base, diff[0]), ["one", "two", "THREE", "three-and-a-half", "four", "five"].join("\n"));
  // Same hunk with a drifted stated line number still applies (re-anchored).
  const drifted = parseUnifiedDiff(hunkDiff("f", base, 3, 3, ["THREE"]).replace("@@ -1,5 +1,5 @@", "@@ -7,5 +7,5 @@"));
  assert.equal(applyFileDiff(base, drifted[0]), ["one", "two", "THREE", "four", "five"].join("\n"));
});

test("resolveHunkOldStart returns -1 when the old side matches nowhere", () => {
  const diff = parseUnifiedDiff(hunkDiff("f", "x\ny\nz", 2, 2, ["Y"]));
  assert.equal(resolveHunkOldStart(["completely", "different", "file"], diff[0].hunks[0]), -1);
});

// ---------------------------------------------------------------------------
// 3. Unit tests — region scoping on the REAL schema file
// ---------------------------------------------------------------------------

test("findSchemaRegions locates both in-scope regions of the real drizzle-store.ts and excludes the DML builders", () => {
  const content = readFileSync(join(REPO_ROOT, IN_SCOPE_FILE), "utf8");
  const regions = findSchemaRegions(content);
  assert.deepEqual(
    regions.map((r) => r.name).sort(),
    ["buildCreateStoreSchemaQueries", "createStoreTables"],
  );
  for (const r of regions) assert.ok(r.end > r.start, `${r.name} region must span lines`);
  // The runtime DML query builders below the DDL must be OUT of both regions.
  const lines = content.split("\n");
  const dmlLine = lines.findIndex((l) => l.includes("function buildWriteMetadataQuery")) + 1;
  assert.ok(dmlLine > 0, "expected the DML builders to exist in drizzle-store.ts");
  assert.ok(!regions.some((r) => dmlLine >= r.start && dmlLine <= r.end), "DML builders must not be in scope");
});

// ---------------------------------------------------------------------------
// 4. Unit tests — classifier edges (synthetic schema file)
// ---------------------------------------------------------------------------

const S = '"${s}"';
const BASE = [
  "function createStoreTables(schemaName: string) {",
  "  const schema = pgSchema(schemaName);",
  "  return {",
  '    widgets: schema.table("widgets", {',
  '      id: text("id").primaryKey(),',
  '      label: text("label"),',
  "    }),",
  "  };",
  "}",
  "",
  "export function buildCreateStoreSchemaQueries(schemaName: string): QueryInput[] {",
  "  return [",
  `    { text: \`CREATE TABLE IF NOT EXISTS ${S}."widgets" (`,
  "      id text PRIMARY KEY,",
  "      label text,",
  "      amount numeric(12,8)",
  "    )` },",
  `    { text: \`ALTER TABLE ${S}."widgets"`,
  "      ADD COLUMN IF NOT EXISTS label text,",
  "      ADD COLUMN IF NOT EXISTS amount numeric(12,8)` },",
  `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
  "  ];",
  "}",
  "",
  "export function buildUpdateWidgetQuery() {",
  '  return { text: `UPDATE "x"."widgets" SET label = $1` };',
  "}",
].join("\n");

/** Classify a single replacement against the synthetic base. */
function classify(from, to, replacement) {
  const files = parseUnifiedDiff(hunkDiff(IN_SCOPE_FILE, BASE, from, to, replacement));
  return classifyDrizzleStoreDiff(files[0], BASE);
}

test("additive: new nullable ADD COLUMN and non-unique index pass", () => {
  const r = classify(20, 20, [
    "      ADD COLUMN IF NOT EXISTS amount numeric(12,8)` },",
    `    { text: \`ALTER TABLE ${S}."widgets" ADD COLUMN IF NOT EXISTS note text\` },`,
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_note_idx ON ${S}."widgets" (note) WHERE note IS NOT NULL\` },`,
  ]);
  assert.deepEqual(r.destructive, []);
  assert.equal(r.inScopeChanges, 2);
});

test("destructive: NOT NULL column added to an existing table (even with DEFAULT)", () => {
  const r = classify(20, 20, [
    "      ADD COLUMN IF NOT EXISTS amount numeric(12,8)` },",
    `    { text: \`ALTER TABLE ${S}."widgets" ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT ''\` },`,
  ]);
  assert.deepEqual(r.destructive.map((d) => d.rule), ["not-null-column-on-existing-table"]);
});

test("destructive: unique index on an existing table; additive on a table created in the same change", () => {
  const existing = classify(21, 21, [
    `    { text: \`CREATE UNIQUE INDEX IF NOT EXISTS widgets_label_uq ON ${S}."widgets" (label)\` },`,
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
  ]);
  assert.deepEqual(existing.destructive.map((d) => d.rule), ["unique-index-existing-table"]);

  const newTable = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`CREATE TABLE IF NOT EXISTS ${S}."gadgets" (`,
    "      id text PRIMARY KEY,",
    "      name text NOT NULL",
    "    )` },",
    `    { text: \`CREATE UNIQUE INDEX IF NOT EXISTS gadgets_name_uq ON ${S}."gadgets" (name)\` },`,
  ]);
  assert.deepEqual(newTable.destructive, []);
});

test("destructive: data rewrite (UPDATE) added inside the DDL region; DML builders below are out of scope", () => {
  const rewrite = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`UPDATE ${S}."widgets" SET label = '' WHERE label IS NULL\` },`,
  ]);
  assert.deepEqual(rewrite.destructive.map((d) => d.rule), ["data-rewrite"]);

  // The same UPDATE text changed in the runtime query builders is ignored.
  const dml = classify(26, 26, ['  return { text: `UPDATE "x"."widgets" SET label = $2` };']);
  assert.deepEqual(dml.destructive, []);
  assert.equal(dml.inScopeChanges, 0);
});

test("destructive: multi-line INSERT backfill into an existing table (no same-line SELECT needed); seed into a new table is additive", () => {
  const backfill = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`INSERT INTO ${S}."widgets" (id, label)`,
    `      SELECT id, name FROM ${S}."legacy_widgets"\` },`,
  ]);
  assert.deepEqual(backfill.destructive.map((d) => d.rule), ["data-rewrite"]);

  const seed = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`CREATE TABLE IF NOT EXISTS ${S}."defaults" (id text PRIMARY KEY)\` },`,
    `    { text: \`INSERT INTO ${S}."defaults" (id) VALUES ('a') ON CONFLICT DO NOTHING\` },`,
  ]);
  assert.deepEqual(seed.destructive, []);
});

test("destructive: multi-line UPDATE with a schema-qualified target (SET on a later line)", () => {
  const r = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`UPDATE ${S}."widgets"`,
    "      SET label = '' WHERE label IS NULL` },",
  ]);
  assert.deepEqual(r.destructive.map((d) => d.rule), ["data-rewrite"]);
});

test("destructive: shorthand anonymous constraints (ADD UNIQUE / CHECK / PRIMARY KEY / FOREIGN KEY) on an existing table; additive on a new table", () => {
  const existing = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`ALTER TABLE ${S}."widgets" ADD UNIQUE (label)\` },`,
    `    { text: \`ALTER TABLE ${S}."widgets" ADD CHECK (amount > 0)\` },`,
    `    { text: \`ALTER TABLE ${S}."widgets" ADD PRIMARY KEY (id)\` },`,
    `    { text: \`ALTER TABLE ${S}."widgets" ADD FOREIGN KEY (label) REFERENCES ${S}."labels" (id)\` },`,
  ]);
  assert.deepEqual(
    existing.destructive.map((d) => d.rule),
    ["add-constraint", "add-constraint", "add-constraint", "add-constraint"],
  );

  const newTable = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`CREATE TABLE IF NOT EXISTS ${S}."gadgets" (id text PRIMARY KEY, name text)\` },`,
    `    { text: \`ALTER TABLE ${S}."gadgets" ADD UNIQUE (name)\` },`,
  ]);
  assert.deepEqual(newTable.destructive, []);
});

test("destructive: split-line ALTER COLUMN retype (TYPE lands on a later diff line)", () => {
  const split = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`ALTER TABLE ${S}."widgets" ALTER COLUMN amount`,
    "      TYPE numeric(12,4)` },",
  ]);
  assert.deepEqual(split.destructive.map((d) => d.rule), ["retype-split-line"]);

  // Dangling SET / SET DATA continuations are equally invisible — conservative.
  const splitSetData = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`ALTER TABLE ${S}."widgets" ALTER COLUMN amount SET DATA`,
    "      TYPE numeric(12,4)` },",
  ]);
  assert.deepEqual(splitSetData.destructive.map((d) => d.rule), ["retype-split-line"]);
});

test("additive: same-line ALTER COLUMN SET DEFAULT / DROP NOT NULL do not trip the split-line retype rule", () => {
  const r = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`ALTER TABLE ${S}."widgets" ALTER COLUMN amount SET DEFAULT 0\` },`,
    `    { text: \`ALTER TABLE ${S}."widgets" ALTER COLUMN amount DROP NOT NULL\` },`,
  ]);
  assert.deepEqual(r.destructive, []);
});

test("whitespace-only reformatting of a column definition is NOT destructive", () => {
  const r = classify(15, 15, ["      label   text,"]);
  assert.deepEqual(r.destructive, []);
  assert.equal(r.inScopeChanges, 0);
});

test("a new table in the same hunk cannot launder a statement aimed at an EXISTING table", () => {
  const r = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`CREATE TABLE IF NOT EXISTS ${S}."gadgets" (id text PRIMARY KEY)\` },`,
    `    { text: \`CREATE UNIQUE INDEX IF NOT EXISTS widgets_label_uq ON ${S}."widgets" (label)\` },`,
    `    { text: \`UPDATE ${S}."widgets" SET label = ''\` },`,
  ]);
  assert.deepEqual(r.destructive.map((d) => d.rule).sort(), ["data-rewrite", "unique-index-existing-table"]);

  // Multi-line form: the statement-start line carries no target of its own,
  // so it must NOT inherit the new table's context either.
  const multiLine = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`CREATE TABLE IF NOT EXISTS ${S}."gadgets" (id text PRIMARY KEY)\` },`,
    "    { text: `CREATE UNIQUE INDEX IF NOT EXISTS widgets_label_uq",
    `      ON ${S}."widgets" (label)\` },`,
  ]);
  assert.deepEqual(multiLine.destructive.map((d) => d.rule), ["unique-index-existing-table"]);
});

test("destructive: DROP TABLE on an existing table; additive when the table is created in the same change", () => {
  const existing = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`DROP TABLE IF EXISTS ${S}."widgets"\` },`,
  ]);
  assert.deepEqual(existing.destructive.map((d) => d.rule), ["drop-table"]);

  const churn = classify(21, 21, [
    `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
    `    { text: \`CREATE TABLE IF NOT EXISTS ${S}."scratch" (id text PRIMARY KEY)\` },`,
    `    { text: \`DROP TABLE IF EXISTS ${S}."scratch"\` },`,
  ]);
  assert.deepEqual(churn.destructive, []);
});

test("moved lines cancel within the same table, but NOT across tables", () => {
  // Reorder: the label column moves below amount — same table, no-op.
  const moved = classify(15, 16, ["      amount numeric(12,8)", "      label text,"]);
  assert.deepEqual(moved.destructive, []);

  // The label column is REMOVED from widgets and an identical line appears in
  // a brand-new table: the drop must still be flagged.
  const crossTable = classify(15, 15, []);
  assert.deepEqual(crossTable.destructive.map((d) => d.rule), ["column-removed-from-ddl"]);
  const files = parseUnifiedDiff(
    hunkDiff(IN_SCOPE_FILE, BASE, 15, 15, []) +
      hunkDiff(IN_SCOPE_FILE, BASE, 21, 21, [
        `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
        `    { text: \`CREATE TABLE IF NOT EXISTS ${S}."gadgets" (`,
        "      label text,",
        "    )` },",
      ]),
  );
  const r = classifyDrizzleStoreDiff(files[0], BASE);
  assert.deepEqual(r.destructive.map((d) => d.rule), ["column-removed-from-ddl"]);
});

test("Drizzle-def-only changes are detected in scope but classified additive (the executed DDL is the signal)", () => {
  const r = classify(6, 6, ['      label: text("label"),', '      note: text("note"),']);
  assert.deepEqual(r.destructive, []);
  assert.equal(r.inScopeChanges, 1);
});

test("fails closed when the schema regions cannot be found in the base file", () => {
  const files = parseUnifiedDiff(hunkDiff("f", "a\nb\nc", 2, 2, ["B"]));
  const r = classifyDrizzleStoreDiff(files[0], "export function somethingElse() {\n}\n");
  assert.deepEqual(r.destructive.map((d) => d.rule), ["schema-regions-missing"]);
});

// ---------------------------------------------------------------------------
// 5. Unit tests — migration-artifact detection
// ---------------------------------------------------------------------------

const BASE_MANIFEST = JSON.stringify(
  {
    _doc: ["ledger"],
    migrations: [{ seq: "0001", file: "0001_first.sql", summary: "first", destructive: true, tables: ["widgets"] }],
  },
  null,
  2,
);

const manifestWith = (entries) => JSON.stringify({ _doc: ["ledger"], migrations: entries }, null, 2);
const ENTRY_0001 = { seq: "0001", file: "0001_first.sql", summary: "first", destructive: true, tables: ["widgets"] };
const readBase = (p) => (p === MIGRATION_MANIFEST_PATH ? BASE_MANIFEST : null);

const MODULE_0002 = "migrations/core/core__0002_drop-widgets-label.mjs";
const MODULE_0002_SRC = "export function up(pgm) { pgm.sql(`ALTER TABLE widgets DROP COLUMN IF EXISTS label;`); }\nexport function down(pgm) {}";

/** Fragment file for a seq/slug — the manifest.d authoring form (#1335). */
const fragmentPath = (seq, slug) => `${MIGRATION_FRAGMENT_DIR}/core__${seq}_${slug}.json`;
const fragmentSrc = (seq, slug, extra = {}) =>
  JSON.stringify(
    { seq, file: `core/core__${seq}_${slug}.mjs`, summary: "drop", destructive: true, tables: ["widgets"], ...extra },
    null,
    2,
  );

test("artifact: runner module + its manifest fragment is complete", () => {
  const text =
    fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
    fullReplaceDiff(fragmentPath("0002", "drop-widgets-label"), null, fragmentSrc("0002", "drop-widgets-label"));
  const a = detectMigrationArtifact(parseUnifiedDiff(text), readBase);
  assert.deepEqual(a.problems, []);
  assert.equal(a.complete, true);
  assert.equal(a.newEntries.length, 1);
  assert.equal(a.newEntries[0].destructive, true);
});

test("artifact: a runner module without a manifest fragment is incomplete (both pieces, same PR)", () => {
  const a = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC)),
    readBase,
  );
  assert.equal(a.complete, false);
  assert.ok(a.problems.some((p) => p.includes("manifest fragment")), a.problems.join("; "));
});

test("artifact: appending a new entry to the frozen legacy array is rejected (fragment authoring is forced)", () => {
  const text =
    fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
    fullReplaceDiff(
      MIGRATION_MANIFEST_PATH,
      BASE_MANIFEST,
      manifestWith([ENTRY_0001, { seq: "0002", file: "core/core__0002_drop-widgets-label.mjs", summary: "drop", destructive: true, tables: ["widgets"] }]),
    );
  const a = detectMigrationArtifact(parseUnifiedDiff(text), readBase);
  assert.equal(a.complete, false);
  assert.ok(a.problems.some((p) => p.includes("frozen") && p.includes(MIGRATION_FRAGMENT_DIR)), a.problems.join("; "));
});

test("artifact: the legacy psql artifact form is retired for new migrations", () => {
  const a = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff("migrations/0002_drop.sql", null, "ALTER TABLE x;") +
        fullReplaceDiff(
          MIGRATION_MANIFEST_PATH,
          BASE_MANIFEST,
          manifestWith([ENTRY_0001, { seq: "0002", file: "0002_drop.sql", summary: "drop", destructive: true, tables: [] }]),
        ),
    ),
    readBase,
  );
  assert.equal(a.complete, false);
  assert.ok(a.problems.some((p) => p.includes("retired")), a.problems.join("; "));
});

test("artifact: deleting, renaming, or EDITING a shipped artifact is an integrity failure", () => {
  const sqlDeleted = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/0001_first.sql", "ALTER TABLE x;", null)),
    readBase,
  );
  assert.ok(sqlDeleted.integrity.some((p) => p.includes("never be deleted")), sqlDeleted.integrity.join("; "));

  const sqlEdited = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/0001_first.sql", "ALTER TABLE x;", "ALTER TABLE x DROP COLUMN y;")),
    readBase,
  );
  assert.ok(sqlEdited.integrity.some((p) => p.includes("never be edited")), sqlEdited.integrity.join("; "));

  const moduleDeleted = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/core/core__0001_first.mjs", MODULE_0002_SRC, null)),
    readBase,
  );
  assert.ok(moduleDeleted.integrity.some((p) => p.includes("never be deleted")), moduleDeleted.integrity.join("; "));

  const moduleEdited = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/core/core__0001_first.mjs", MODULE_0002_SRC, "export function up() {}")),
    readBase,
  );
  assert.ok(moduleEdited.integrity.some((p) => p.includes("never be edited")), moduleEdited.integrity.join("; "));
});

// ---------------------------------------------------------------------------
// Poison-pill correction exemption: ONE-SHOT, digest-bound (codex blocker on
// the core__0053 correction PR: a basename-only exemption would permanently
// disable append-only protection for that module).
// ---------------------------------------------------------------------------

const BROKEN_SRC = "export async function up(pgm) { broken(); }\n";
const CORRECTED_SRC = "export async function up(pgm) { fixed(); }\n";
const CORRECTION_BASENAME = "core__0042_poisoned.mjs";
const CORRECTION_PATH = `migrations/core/${CORRECTION_BASENAME}`;
const syntheticExemptions = new Map([
  [
    CORRECTION_BASENAME,
    {
      baseSha256: contentDigest(BROKEN_SRC),
      correctedSha256: contentDigest(CORRECTED_SRC),
      justification: "synthetic poison-pill for the exemption contract test",
    },
  ],
]);
const readCorrectionBase = (p) =>
  p === CORRECTION_PATH ? BROKEN_SRC : p === MIGRATION_MANIFEST_PATH ? BASE_MANIFEST : null;

test("correction exemption: ONLY the exact recorded base->corrected transition passes", () => {
  // The intended transition: no integrity failure, loud correction notice.
  const intended = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(CORRECTION_PATH, BROKEN_SRC, CORRECTED_SRC)),
    readCorrectionBase,
    () => null,
    syntheticExemptions,
  );
  assert.deepEqual(intended.integrity, [], intended.integrity.join("; "));
  assert.ok(
    intended.corrections.some((n) => n.includes(CORRECTION_PATH) && n.includes("poison-pill")),
    intended.corrections.join("; "),
  );

  // runGate end-to-end: pass, and the correction notice reaches the output.
  const gated = runGate({
    diffText: fullReplaceDiff(CORRECTION_PATH, BROKEN_SRC, CORRECTED_SRC),
    readBaseFile: readCorrectionBase,
    correctionExemptions: syntheticExemptions,
  });
  assert.equal(gated.verdict, "pass");
  assert.ok(gated.notices.some((n) => n.includes("poison-pill")), gated.notices.join("; "));

  // A DIFFERENT RESULT than the recorded corrected content fails.
  const wrongResult = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(CORRECTION_PATH, BROKEN_SRC, "export async function up(pgm) { evil(); }\n")),
    readCorrectionBase,
    () => null,
    syntheticExemptions,
  );
  assert.ok(wrongResult.integrity.some((n) => n.includes("one-shot")), wrongResult.integrity.join("; "));

  // A SUBSEQUENT EDIT (base is already the corrected content) fails — the
  // exemption is spent once the correction has shipped.
  const afterShipped = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(CORRECTION_PATH, CORRECTED_SRC, "export async function up(pgm) { again(); }\n")),
    (p) => (p === CORRECTION_PATH ? CORRECTED_SRC : readCorrectionBase(p)),
    () => null,
    syntheticExemptions,
  );
  assert.ok(afterShipped.integrity.some((n) => n.includes("one-shot")), afterShipped.integrity.join("; "));

  // An UNREADABLE base fails closed.
  const noBase = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(CORRECTION_PATH, BROKEN_SRC, CORRECTED_SRC)),
    () => null,
    () => null,
    syntheticExemptions,
  );
  assert.ok(noBase.integrity.some((n) => n.includes("one-shot")), noBase.integrity.join("; "));

  // A NON-exempted module edit still fails with the plain append-only message.
  const other = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/core/core__0001_first.mjs", BROKEN_SRC, CORRECTED_SRC)),
    readCorrectionBase,
    () => null,
    syntheticExemptions,
  );
  assert.ok(other.integrity.some((n) => n.includes("never be edited")), other.integrity.join("; "));

  // DELETING the exempted module is still tampering.
  const deleted = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(CORRECTION_PATH, BROKEN_SRC, null)),
    readCorrectionBase,
    () => null,
    syntheticExemptions,
  );
  assert.ok(deleted.integrity.some((n) => n.includes("never be deleted")), deleted.integrity.join("; "));

  // RENAMING it away is still tampering (rename branch runs before the exemption).
  const renamed = detectMigrationArtifact(
    parseUnifiedDiff(
      `diff --git a/${CORRECTION_PATH} b/migrations/core/core__9999_renamed-away.mjs\n` +
        `similarity index 100%\nrename from ${CORRECTION_PATH}\nrename to migrations/core/core__9999_renamed-away.mjs\n`,
    ),
    readCorrectionBase,
    () => null,
    syntheticExemptions,
  );
  assert.ok(renamed.integrity.some((n) => n.includes("never be renamed")), renamed.integrity.join("; "));
});

test("correction exemption: the LIVE map's pins are well-formed and its corrected digests match the shipped tree", () => {
  for (const [basename, entry] of SHIPPED_MODULE_CORRECTION_EXEMPTIONS) {
    assert.match(basename, /^core__\d{4}_[a-z0-9][a-z0-9-]*\.mjs$/, `${basename}: exemption key must be a module basename`);
    assert.match(entry.baseSha256, /^[0-9a-f]{64}$/, `${basename}: baseSha256 must be a sha256 hex digest`);
    assert.match(entry.correctedSha256, /^[0-9a-f]{64}$/, `${basename}: correctedSha256 must be a sha256 hex digest`);
    assert.ok(entry.justification?.length > 0, `${basename}: justification is required`);
    assert.notEqual(entry.baseSha256, entry.correctedSha256, `${basename}: base and corrected digests must differ`);
    // The corrected digest must match the module as it ships in THIS tree —
    // the exemption never authorizes content that is not the reviewed fix
    // (and any later drift of the file would surface here immediately).
    const live = readFileSync(join(REPO_ROOT, "migrations", "core", basename), "utf8");
    assert.equal(
      contentDigest(live),
      entry.correctedSha256,
      `${basename}: the live module content does not match the recorded corrected digest`,
    );
  }
});

test("artifact: re-using a shipped seq (non-wrapper) or duplicating a seq in one diff is an integrity failure", () => {
  // seq 0001 is shipped, and this module is NOT the exact legacy wrapper
  // (core__0001_first.mjs) — it would trip the runner's duplicate-seq
  // preflight at boot once the real wrapper exists.
  const reused = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/core/core__0001_other-name.mjs", null, MODULE_0002_SRC)),
    readBase,
  );
  assert.ok(reused.integrity.some((p) => p.includes("already shipped")), reused.integrity.join("; "));
  assert.deepEqual(reused.artifactFiles, []);

  const duped = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff("migrations/core/core__0002_a.mjs", null, MODULE_0002_SRC) +
        fullReplaceDiff("migrations/core/core__0002_b.mjs", null, MODULE_0002_SRC),
    ),
    readBase,
  );
  assert.ok(duped.integrity.some((p) => p.includes("duplicate sequence number")), duped.integrity.join("; "));
});

test("runGate fails a tamper-only diff (no destructive schema change required)", () => {
  const r = runGate({
    diffText: fullReplaceDiff("migrations/core/core__0001_first.mjs", MODULE_0002_SRC, "export function up() {}"),
    readBaseFile: readBase,
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.artifact.integrity.length > 0);
});

test("artifact: a manifest-only rewrite (no module in the diff) is an integrity failure", () => {
  const r = runGate({
    diffText: fullReplaceDiff(
      MIGRATION_MANIFEST_PATH,
      BASE_MANIFEST,
      manifestWith([{ ...ENTRY_0001, summary: "REWRITTEN" }]),
    ),
    readBaseFile: readBase,
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.artifact.integrity.some((p) => p.includes("append-only")), r.artifact.integrity.join("; "));

  const deleted = runGate({
    diffText: fullReplaceDiff(MIGRATION_MANIFEST_PATH, BASE_MANIFEST, null),
    readBaseFile: readBase,
  });
  assert.equal(deleted.verdict, "fail");
  assert.ok(deleted.artifact.integrity.some((p) => p.includes("never be deleted")), deleted.artifact.integrity.join("; "));
});

test("artifact: renaming a shipped artifact OUT of migrations/ is an integrity failure", () => {
  const renameOut =
    "diff --git a/migrations/core/core__0001_first.mjs b/docs/core__0001_first.mjs\n" +
    "similarity index 100%\n" +
    "rename from migrations/core/core__0001_first.mjs\n" +
    "rename to docs/core__0001_first.mjs\n";
  const a = detectMigrationArtifact(parseUnifiedDiff(renameOut), readBase);
  assert.ok(a.integrity.some((p) => p.includes("renamed or moved")), a.integrity.join("; "));

  const sqlRenameOut =
    "diff --git a/migrations/0001_first.sql b/archive/0001_first.sql\n" +
    "similarity index 100%\n" +
    "rename from migrations/0001_first.sql\n" +
    "rename to archive/0001_first.sql\n";
  const b = detectMigrationArtifact(parseUnifiedDiff(sqlRenameOut), readBase);
  assert.ok(b.integrity.some((p) => p.includes("renamed or moved")), b.integrity.join("; "));
});

test("artifact: a runner-form backfill of an already-shipped seq needs no manifest entry (and is not a new artifact)", () => {
  // seq 0001 already exists in the base manifest (the legacy artifact);
  // adding core/core__0001_first.mjs is the wrapper-backfill case from
  // cinatra#116 — allowed without a manifest change, but it can never stand
  // in for the artifact a NEW destructive change must ship.
  const a = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/core/core__0001_first.mjs", null, MODULE_0002_SRC)),
    readBase,
  );
  assert.deepEqual(a.problems, []);
  assert.equal(a.complete, false);
  assert.deepEqual(a.artifactFiles, []);
});

test("artifact: rewriting a shipped ledger entry or regressing the sequence is rejected", () => {
  const rewritten = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
        fullReplaceDiff(
          MIGRATION_MANIFEST_PATH,
          BASE_MANIFEST,
          manifestWith([{ ...ENTRY_0001, summary: "REWRITTEN" }, { seq: "0002", file: "core/core__0002_drop-widgets-label.mjs", summary: "x", destructive: true, tables: [] }]),
        ),
    ),
    readBase,
  );
  assert.ok(rewritten.integrity.some((p) => p.includes("append-only")), rewritten.integrity.join("; "));

  // A fragment whose seq sits at/below the max shipped seq (duplicate of a
  // shipped legacy entry here) regresses the ledger head — rejected on both
  // the union-uniqueness and the monotonicity rule.
  const regressed = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff("migrations/core/core__0001_dupe.mjs", null, MODULE_0002_SRC) +
        fullReplaceDiff(fragmentPath("0001", "dupe"), null, fragmentSrc("0001", "dupe")),
    ),
    readBase,
  );
  assert.ok(regressed.problems.some((p) => p.includes("duplicate seq")), regressed.problems.join("; "));
  assert.ok(regressed.problems.some((p) => p.includes("strictly greater than the max shipped seq")), regressed.problems.join("; "));
});

test("artifact: a fragment-only entry (no module in the diff) and a seq/filename mismatch are rejected", () => {
  const fragmentOnly = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
        fullReplaceDiff(fragmentPath("0002", "drop-widgets-label"), null, fragmentSrc("0002", "drop-widgets-label")) +
        fullReplaceDiff(fragmentPath("0003", "phantom"), null, fragmentSrc("0003", "phantom")),
    ),
    readBase,
  );
  assert.equal(fragmentOnly.complete, false);
  assert.ok(fragmentOnly.problems.some((p) => p.includes("no matching migrations/core/ module")), fragmentOnly.problems.join("; "));

  // seq/filename mismatch: the fragment file claims seq 0003 in its name but
  // carries seq 0002 in the entry — the fragment contract binds them.
  const mismatched = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
        fullReplaceDiff(fragmentPath("0003", "drop-widgets-label"), null, fragmentSrc("0002", "drop-widgets-label")),
    ),
    readBase,
  );
  assert.ok(
    mismatched.problems.some((p) => p.includes("does not match the filename's sequence number")),
    mismatched.problems.join("; "),
  );
});

test("artifact: malformed migration filenames are rejected (legacy dir and core dir)", () => {
  const a = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/2_Bad_Name.sql", null, "ALTER TABLE x;")),
    readBase,
  );
  assert.ok(a.problems.some((p) => p.includes("NNNN_short-description")), a.problems.join("; "));

  const b = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff("migrations/core/0002_no-namespace.mjs", null, MODULE_0002_SRC)),
    readBase,
  );
  // Malformed core/ filenames are integrity-level: merged, they would brick
  // the runner's boot preflight on every subsequent boot.
  assert.ok(b.integrity.some((p) => p.includes("core__NNNN_short-description.mjs")), b.integrity.join("; "));
});

// ---------------------------------------------------------------------------
// 6. Unit tests — gate verdicts end to end (runGate)
// ---------------------------------------------------------------------------

test("runGate fails a destructive change whose artifact fragment is not labelled destructive", () => {
  const text =
    hunkDiff(IN_SCOPE_FILE, BASE, 21, 21, [
      `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
      `    { text: \`DROP TABLE IF EXISTS ${S}."widgets"\` },`,
    ]) +
    fullReplaceDiff("migrations/core/core__0002_drop-widgets.mjs", null, "export function up(pgm) { pgm.sql(`DROP TABLE IF EXISTS widgets;`); }\nexport function down(pgm) {}") +
    fullReplaceDiff(fragmentPath("0002", "drop-widgets"), null, fragmentSrc("0002", "drop-widgets", { destructive: false }));
  const readBaseFile = (p) => (p === IN_SCOPE_FILE ? BASE : p === MIGRATION_MANIFEST_PATH ? BASE_MANIFEST : null);

  const mislabelled = runGate({ diffText: text, readBaseFile });
  assert.equal(mislabelled.verdict, "fail");
  assert.ok(mislabelled.artifact.problems.some((p) => p.includes('"destructive": true')));

  const honest = runGate({
    diffText: text.replace('"destructive": false', '"destructive": true'),
    readBaseFile,
  });
  assert.equal(honest.verdict, "pass");
});

test("runGate fails closed when the schema file is deleted or renamed (including a pure rename with no hunks)", () => {
  const deleted = runGate({
    diffText: fullReplaceDiff(IN_SCOPE_FILE, BASE, null),
    readBaseFile: () => BASE,
  });
  assert.equal(deleted.verdict, "fail");
  assert.deepEqual(deleted.destructive.map((d) => d.rule), ["schema-file-moved"]);

  // A 100%-similarity rename emits only rename headers — no ---/+++, no hunks.
  const pureRename = runGate({
    diffText:
      `diff --git a/${IN_SCOPE_FILE} b/src/lib/store-schema.ts\n` +
      `similarity index 100%\n` +
      `rename from ${IN_SCOPE_FILE}\n` +
      `rename to src/lib/store-schema.ts\n`,
    readBaseFile: () => BASE,
  });
  assert.equal(pureRename.verdict, "fail");
  assert.deepEqual(pureRename.destructive.map((d) => d.rule), ["schema-file-moved"]);
});

test("runGate ignores out-of-scope auth/extension files entirely", () => {
  const r = runGate({
    diffText: fullReplaceDiff("src/lib/better-auth-schema.ts", "export const a = 1;", "export const a = 2;"),
    readBaseFile: () => null,
  });
  assert.equal(r.verdict, "pass");
  assert.equal(r.inScopeChanges, 0);
  assert.equal(r.ignored.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Fragment form (#1335) — shipped-fragment protection, base-directory
//    enumeration, and manifest.d hygiene
// ---------------------------------------------------------------------------

const SHIPPED_FRAGMENT_NAME = "core__0002_shipped.json";
const SHIPPED_FRAGMENT_SRC = fragmentSrc("0002", "shipped");
/** Base with ONE shipped fragment (seq 0002) alongside legacy entry 0001. */
const readBaseWithFragment = (p) => {
  if (p === MIGRATION_MANIFEST_PATH) return BASE_MANIFEST;
  if (p === `${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME}`) return SHIPPED_FRAGMENT_SRC;
  return null;
};
const listBaseWithFragment = (dir) => (dir === MIGRATION_FRAGMENT_DIR ? [SHIPPED_FRAGMENT_NAME] : null);

test("fragment: a new seq colliding with a SHIPPED fragment the diff never touches is caught (base manifest.d/ is enumerated)", () => {
  const a = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff("migrations/core/core__0002_other-claim.mjs", null, MODULE_0002_SRC) +
        fullReplaceDiff(fragmentPath("0002", "other-claim"), null, fragmentSrc("0002", "other-claim")),
    ),
    readBaseWithFragment,
    listBaseWithFragment,
  );
  assert.equal(a.complete, false);
  assert.ok(a.problems.some((p) => p.includes("duplicate seq 0002")), a.problems.join("; "));
});

test("fragment: max shipped seq comes from the UNION — a fragment above the legacy head but at/below a shipped fragment's seq is rejected", () => {
  // Legacy head is 0001; shipped fragment is 0002; a new 0002-gap does not
  // exist, so use a base where the shipped fragment is 0003 and claim 0002.
  const shipped = "core__0003_shipped.json";
  const a = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
        fullReplaceDiff(fragmentPath("0002", "drop-widgets-label"), null, fragmentSrc("0002", "drop-widgets-label")),
    ),
    (p) => (p === MIGRATION_MANIFEST_PATH ? BASE_MANIFEST : p === `${MIGRATION_FRAGMENT_DIR}/${shipped}` ? fragmentSrc("0003", "shipped") : null),
    (dir) => (dir === MIGRATION_FRAGMENT_DIR ? [shipped] : null),
  );
  assert.equal(a.complete, false);
  assert.ok(a.problems.some((p) => p.includes("strictly greater than the max shipped seq (0003)")), a.problems.join("; "));
});

test("fragment: editing or deleting a shipped fragment is an integrity failure; renaming it is too", () => {
  const edited = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff(`${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME}`, SHIPPED_FRAGMENT_SRC, fragmentSrc("0002", "shipped", { summary: "REWRITTEN" })),
    ),
    readBaseWithFragment,
    listBaseWithFragment,
  );
  assert.ok(edited.integrity.some((p) => p.includes("never be edited")), edited.integrity.join("; "));

  const deleted = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(`${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME}`, SHIPPED_FRAGMENT_SRC, null)),
    readBaseWithFragment,
    listBaseWithFragment,
  );
  assert.ok(deleted.integrity.some((p) => p.includes("never be deleted")), deleted.integrity.join("; "));

  const renamed = detectMigrationArtifact(
    parseUnifiedDiff(
      `diff --git a/${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME} b/${MIGRATION_FRAGMENT_DIR}/core__0002_renamed.json\n` +
        "similarity index 100%\n" +
        `rename from ${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME}\n` +
        `rename to ${MIGRATION_FRAGMENT_DIR}/core__0002_renamed.json\n`,
    ),
    readBaseWithFragment,
    listBaseWithFragment,
  );
  assert.ok(renamed.integrity.some((p) => p.includes("renamed or moved")), renamed.integrity.join("; "));
});

test("fragment: header-only diffs cannot slip past the parser (empty add, binary edit of a shipped fragment, symlink fragment)", () => {
  // An EMPTY added fragment emits ONLY headers — no ---/+++, no hunks. It
  // must still red (the union reader would refuse it post-merge).
  const emptyAdd = runGate({
    diffText:
      `diff --git a/${MIGRATION_FRAGMENT_DIR}/core__0002_empty.json b/${MIGRATION_FRAGMENT_DIR}/core__0002_empty.json\n` +
      "new file mode 100644\n" +
      "index 0000000..e69de29\n",
    readBaseFile: readBase,
  });
  assert.equal(emptyAdd.verdict, "fail", "empty added fragment must fail");

  // A BINARY rewrite of a shipped fragment also emits no ---/+++ — tampering.
  const binaryEdit = runGate({
    diffText:
      `diff --git a/${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME} b/${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME}\n` +
      "index 1111111..2222222 100644\n" +
      `Binary files a/${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME} and b/${MIGRATION_FRAGMENT_DIR}/${SHIPPED_FRAGMENT_NAME} differ\n`,
    readBaseFile: readBaseWithFragment,
    listBaseDir: listBaseWithFragment,
  });
  assert.equal(binaryEdit.verdict, "fail", "binary edit of a shipped fragment must fail");
  assert.ok(binaryEdit.artifact.integrity.some((p) => p.includes("never be edited")), binaryEdit.artifact.integrity.join("; "));

  // A SYMLINK whose target text parses as valid fragment JSON: the reader
  // refuses non-regular files at every consumer, so the gate must too.
  const symlink = runGate({
    diffText:
      fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
      `diff --git a/${fragmentPath("0002", "drop-widgets-label")} b/${fragmentPath("0002", "drop-widgets-label")}\n` +
      "new file mode 120000\n" +
      `--- /dev/null\n+++ b/${fragmentPath("0002", "drop-widgets-label")}\n@@ -0,0 +1,1 @@\n` +
      `+${fragmentSrc("0002", "drop-widgets-label").replaceAll("\n", " ")}\n`,
    readBaseFile: readBase,
  });
  assert.equal(symlink.verdict, "fail", "symlink fragment must fail");
  assert.ok(symlink.artifact.integrity.some((p) => p.includes("regular file")), symlink.artifact.integrity.join("; "));
});

test("fragment: adversarial paths cannot dodge the parser — ' b/' segments parse exactly; C-quoted names under migrations/ fail closed", () => {
  // A nested dir literally named "bad b" — the equal-split header parse
  // recovers the exact path, and the nested fragment name reds as
  // unrecognized (instead of the greedy misparse skipping the file).
  const evilPath = "migrations/manifest.d/bad b/core__0002_x.json";
  const nested = runGate({
    diffText: `diff --git a/${evilPath} b/${evilPath}\nnew file mode 100644\nindex 0000000..e69de29\n`,
    readBaseFile: readBase,
  });
  assert.equal(nested.verdict, "fail");
  assert.ok(nested.artifact.integrity.some((p) => p.includes("unrecognized file")), nested.artifact.integrity.join("; "));

  // A C-quoted (unusual-bytes) name under migrations/: unparseable paths
  // must fail closed, not become unprotected.
  const quoted = runGate({
    diffText: 'diff --git "a/migrations/manifest.d/core__0002_\\ty.json" "b/migrations/manifest.d/core__0002_\\ty.json"\nnew file mode 100644\nindex 0000000..e69de29\n',
    readBaseFile: readBase,
  });
  assert.equal(quoted.verdict, "fail");
  assert.ok(quoted.artifact.integrity.some((p) => p.includes("cannot reliably parse")), quoted.artifact.integrity.join("; "));

  // One parseable side must not vouch for both: `--- /dev/null` is plain
  // while the `+++` side is C-quoted — still fail closed.
  const halfQuoted = runGate({
    diffText:
      'diff --git "a/migrations/manifest.d/core__0002_\\ty.json" "b/migrations/manifest.d/core__0002_\\ty.json"\n' +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      '+++ "b/migrations/manifest.d/core__0002_\\ty.json"\n' +
      "@@ -0,0 +1,1 @@\n" +
      "+{}\n",
    readBaseFile: readBase,
  });
  assert.equal(halfQuoted.verdict, "fail");
  assert.ok(halfQuoted.artifact.integrity.some((p) => p.includes("cannot reliably parse")), halfQuoted.artifact.integrity.join("; "));
});

test("fragment: a base fragment that is listed but unreadable is a loud failure, not a silent drop", () => {
  const a = detectMigrationArtifact(
    [],
    (p) => (p === MIGRATION_MANIFEST_PATH ? BASE_MANIFEST : null), // fragment read fails
    (dir) => (dir === MIGRATION_FRAGMENT_DIR ? ["core__0002_shipped.json"] : null),
  );
  assert.ok(a.problems.some((p) => p.includes("unreadable")), a.problems.join("; "));
});

test("fragment: malformed and unrecognized files under manifest.d/ are errors, not skips", () => {
  const badName = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(`${MIGRATION_FRAGMENT_DIR}/NOTES.txt`, null, "notes")),
    readBase,
  );
  assert.ok(badName.integrity.some((p) => p.includes("unrecognized file")), badName.integrity.join("; "));

  const badJson = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(fragmentPath("0002", "broken"), null, "{ not json")),
    readBase,
  );
  assert.ok(badJson.problems.some((p) => p.includes("not parseable JSON")), badJson.problems.join("; "));

  // Fragment stem must equal the module stem referenced by entry.file.
  const stemMismatch = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
        fullReplaceDiff(fragmentPath("0002", "drop-widgets-label"), null, fragmentSrc("0002", "drop-widgets-label", { file: "core/core__0002_other-stem.mjs" })),
    ),
    readBase,
  );
  assert.ok(stemMismatch.problems.some((p) => p.includes("filename stem")), stemMismatch.problems.join("; "));
});

// ---------------------------------------------------------------------------
// 8. The #1335 collision ledger, replayed structurally: concurrent fragment
//    PRs produce NO textual conflict and need NO renumber; double-claims red
//    deterministically on the union instead of misreading shipped history.
// ---------------------------------------------------------------------------

test("collision ledger: two concurrent migration PRs (distinct seqs) apply to the same base with no conflict, and the later needs no renumber after the first lands", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema-migration-concurrent-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    mkdirSync(join(dir, "migrations", "core"), { recursive: true });
    mkdirSync(join(dir, MIGRATION_FRAGMENT_DIR), { recursive: true });
    writeFileSync(join(dir, MIGRATION_MANIFEST_PATH), BASE_MANIFEST);

    // PR A ships seq 0002, PR B ships seq 0003 — cut concurrently.
    // (git apply needs the `new file mode` header that fullReplaceDiff's
    // parser-oriented output omits.)
    const gitNewFileDiff = (path, content) => {
      const lines = content.split("\n");
      return (
        `diff --git a/${path} b/${path}\n` +
        `new file mode 100644\n` +
        `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map((l) => `+${l}`).join("\n") +
        "\n"
      );
    };
    const prA =
      gitNewFileDiff("migrations/core/core__0002_pr-a.mjs", MODULE_0002_SRC) +
      gitNewFileDiff(fragmentPath("0002", "pr-a"), fragmentSrc("0002", "pr-a"));
    const prB =
      gitNewFileDiff("migrations/core/core__0003_pr-b.mjs", MODULE_0002_SRC) +
      gitNewFileDiff(fragmentPath("0003", "pr-b"), fragmentSrc("0003", "pr-b"));
    writeFileSync(join(dir, "pr-a.patch"), prA);
    writeFileSync(join(dir, "pr-b.patch"), prB);

    // Both apply cleanly to the shared base…
    execFileSync("git", ["apply", "--check", "pr-a.patch"], { cwd: dir });
    execFileSync("git", ["apply", "--check", "pr-b.patch"], { cwd: dir });
    // …PR A lands…
    execFileSync("git", ["apply", "pr-a.patch"], { cwd: dir });
    // …and PR B STILL applies unchanged: no shared tail, no conflict, no
    // renumber (the exact churn class from the ledger in #1335).
    execFileSync("git", ["apply", "--check", "pr-b.patch"], { cwd: dir });
    execFileSync("git", ["apply", "pr-b.patch"], { cwd: dir });

    // The landed tree's union is valid and deterministic.
    const union = readManifestUnion(join(dir, "migrations"));
    assert.deepEqual(union.errors, []);
    assert.deepEqual(union.entries.map((e) => e.seq), ["0001", "0002", "0003"]);

    // Gate view of PR B AFTER A landed: A's fragment is shipped base state
    // (base manifest.d/ carries exactly it), and B passes UNCHANGED — no
    // renumber round, no dismissed approval.
    const afterA = runGate({
      diffText: prB,
      readBaseFile: (p) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null),
      listBaseDir: (d) => (d === MIGRATION_FRAGMENT_DIR ? ["core__0002_pr-a.json"] : null),
    });
    assert.equal(afterA.verdict, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collision ledger: a seq double-claim is a deterministic union red (different paths, so not a git add/add conflict)", () => {
  // Two PRs both cut at seq 0003 under different slugs: their diffs touch
  // DIFFERENT files, so git merges them silently — the union gate is what
  // reds, with a message naming both claimants.
  const claimA = fullReplaceDiff(fragmentPath("0003", "claim-a"), null, fragmentSrc("0003", "claim-a")) +
    fullReplaceDiff("migrations/core/core__0003_claim-a.mjs", null, MODULE_0002_SRC);
  const claimB = fullReplaceDiff(fragmentPath("0003", "claim-b"), null, fragmentSrc("0003", "claim-b")) +
    fullReplaceDiff("migrations/core/core__0003_claim-b.mjs", null, MODULE_0002_SRC);
  const merged = runGate({ diffText: claimA + claimB, readBaseFile: readBase });
  assert.equal(merged.verdict, "fail");
  assert.ok(
    merged.artifact.problems.some((p) => p.includes("duplicate seq 0003") && p.includes("claim-a") && p.includes("claim-b")),
    merged.artifact.problems.join("; "),
  );

  // The same double-claim where the FIRST claimant already shipped as a base
  // fragment: the late PR reds without any shipped-history misread.
  const late = runGate({
    diffText: claimB,
    readBaseFile: (p) =>
      p === MIGRATION_MANIFEST_PATH ? BASE_MANIFEST : p === `${MIGRATION_FRAGMENT_DIR}/core__0003_claim-a.json` ? fragmentSrc("0003", "claim-a") : null,
    listBaseDir: (dir) => (dir === MIGRATION_FRAGMENT_DIR ? ["core__0003_claim-a.json"] : null),
  });
  assert.equal(late.verdict, "fail");
  assert.ok(late.artifact.problems.some((p) => p.includes("duplicate seq 0003")), late.artifact.problems.join("; "));
  // The failure names the seq re-use precisely — never the 0021-style
  // positional misread ("existing entry N was rewritten") that hit #1304.
  assert.ok(
    late.artifact.integrity.every((p) => !p.includes("rewritten") && !p.includes("edited")),
    late.artifact.integrity.join("; "),
  );
});

// ---------------------------------------------------------------------------
// 9. The shared union reader — the contract every consumer computes through
// ---------------------------------------------------------------------------

const legacyPsql = (seq) => ({ seq, file: `${seq}_legacy.sql`, summary: "legacy", destructive: true, tables: ["t"] });
const runnerEntry = (seq, slug) => ({ seq, file: `core/core__${seq}_${slug}.mjs`, summary: "s", destructive: false, tables: ["t"] });

test("union reader: dual-form and split trees produce the identical sorted ledger", () => {
  const dual = buildManifestUnion({
    legacyEntries: [legacyPsql("0001"), legacyPsql("0002"), runnerEntry("0003", "c")],
    fragments: [{ name: "core__0004_d.json", raw: JSON.stringify(runnerEntry("0004", "d")) }],
  });
  const split = buildManifestUnion({
    legacyEntries: [legacyPsql("0001"), legacyPsql("0002")],
    fragments: [
      // Reverse order on purpose: the reader sorts deterministically.
      { name: "core__0004_d.json", raw: JSON.stringify(runnerEntry("0004", "d")) },
      { name: "core__0003_c.json", raw: JSON.stringify(runnerEntry("0003", "c")) },
    ],
  });
  assert.deepEqual(dual.errors, []);
  assert.deepEqual(split.errors, []);
  assert.deepEqual(dual.entries, split.entries);
  assert.deepEqual(dual.entries.map((e) => e.seq), ["0001", "0002", "0003", "0004"]);
});

test("union reader: never dedupes — a seq in both forms (or twice in fragments) is a hard error", () => {
  const acrossForms = buildManifestUnion({
    legacyEntries: [runnerEntry("0003", "c")],
    fragments: [{ name: "core__0003_x.json", raw: JSON.stringify(runnerEntry("0003", "x")) }],
  });
  assert.ok(acrossForms.errors.some((e) => e.includes("duplicate seq 0003")), acrossForms.errors.join("; "));

  const withinFragments = buildManifestUnion({
    legacyEntries: [],
    fragments: [
      { name: "core__0003_x.json", raw: JSON.stringify(runnerEntry("0003", "x")) },
      { name: "core__0003_y.json", raw: JSON.stringify(runnerEntry("0003", "y")) },
    ],
  });
  assert.ok(withinFragments.errors.some((e) => e.includes("duplicate seq 0003")), withinFragments.errors.join("; "));
});

test("union reader: fragment contract violations are errors, not skips", () => {
  const cases = [
    { name: "NOTES.txt", raw: "notes", needle: "unrecognized file" },
    { name: "core__0003_x.json", raw: "{ nope", needle: "not parseable JSON" },
    { name: "core__0003_x.json", raw: "[]", needle: "single JSON object" },
    { name: "core__0003_x.json", raw: JSON.stringify(runnerEntry("0004", "x")), needle: "does not match the filename's sequence number" },
    { name: "core__0003_x.json", raw: JSON.stringify(runnerEntry("0003", "OTHER")), needle: "filename stem" },
    { name: "core__0003_x.json", raw: JSON.stringify({ ...runnerEntry("0003", "x"), tables: "t" }), needle: "array of strings" },
    { name: "core__0003_x.json", raw: JSON.stringify({ ...runnerEntry("0003", "x"), extra: 1 }), needle: "unknown key" },
  ];
  for (const { name, raw, needle } of cases) {
    const { errors } = buildManifestUnion({ legacyEntries: [], fragments: [{ name, raw }] });
    assert.ok(errors.some((e) => e.includes(needle)), `${name}: expected "${needle}" in: ${errors.join("; ")}`);
  }
});

test("union reader (fs): reads a real tree; a missing manifest.d/ means no fragments; a subdirectory there is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-union-"));
  try {
    mkdirSync(join(dir, "migrations"), { recursive: true });
    writeFileSync(join(dir, MIGRATION_MANIFEST_PATH), JSON.stringify({ migrations: [runnerEntry("0003", "c")] }));
    const noDir = readManifestUnion(join(dir, "migrations"));
    assert.deepEqual(noDir.errors, []);
    assert.deepEqual(noDir.entries.map((e) => e.seq), ["0003"]);

    mkdirSync(join(dir, MIGRATION_FRAGMENT_DIR, "nested"), { recursive: true });
    writeFileSync(join(dir, MIGRATION_FRAGMENT_DIR, "core__0004_d.json"), JSON.stringify(runnerEntry("0004", "d")));
    const withDir = readManifestUnion(join(dir, "migrations"));
    assert.ok(withDir.errors.some((e) => e.includes("not a regular file")), withDir.errors.join("; "));
    assert.deepEqual(withDir.entries.map((e) => e.seq), ["0003", "0004"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("union reader: the LIVE repo ledger is a valid union", () => {
  const { entries, errors } = readManifestUnion(join(REPO_ROOT, "migrations"));
  assert.deepEqual(errors, []);
  assert.ok(entries.length >= 24, `expected the shipped ledger, got ${entries.length} entries`);
  const seqs = entries.map((e) => Number(e.seq));
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "entries must come back sorted by numeric seq");
});

// ---------------------------------------------------------------------------
// 10. DDL LEAF MODULES (cinatra#2625) — the executed DDL is COMPOSED, so a leaf
//     reached by a spread is an in-scope schema region: relocating deployed DDL
//     into one is a no-op move, and a drop inside one is still a drop.
// ---------------------------------------------------------------------------

test("resolveLeafSpecifier maps first-party specifiers and refuses bare packages", () => {
  assert.deepEqual(resolveLeafSpecifier("@/lib/trigger-schema"), ["src/lib/trigger-schema.ts", "src/lib/trigger-schema/index.ts"]);
  assert.deepEqual(resolveLeafSpecifier("./trigger-schema"), ["src/lib/trigger-schema.ts", "src/lib/trigger-schema/index.ts"]);
  assert.deepEqual(resolveLeafSpecifier("../artifacts/publication-operation-schema")[0], "src/artifacts/publication-operation-schema.ts");
  // A bare package can never be a first-party DDL leaf — no leaf, so the gate
  // keeps treating an unexplained removal as destructive.
  assert.deepEqual(resolveLeafSpecifier("drizzle-orm/pg-core"), []);
});

test("findDdlLeafModules resolves the REAL drizzle-store.ts spreads, and only spread-in imports", () => {
  const content = readFileSync(join(REPO_ROOT, IN_SCOPE_FILE), "utf8");
  const leaves = findDdlLeafModules(content);
  // A leaf that is genuinely spread into buildCreateStoreSchemaQueries today.
  assert.ok(leaves.has("src/lib/org-write-schema.ts"), `expected the org-write leaf; got ${[...leaves.keys()].slice(0, 8).join(", ")}`);
  assert.ok(leaves.get("src/lib/org-write-schema.ts").has("orgWriteSchemaQueries"));
  // Imported symbols that are NOT spread into the DDL region stay out of scope.
  for (const [path, names] of leaves) {
    assert.ok(names.size > 0, `${path}: a resolved leaf must name at least one export`);
    for (const n of names) assert.ok(content.includes(`...${n}(`), `${n} was resolved without a spread call site`);
  }
});

test("findDdlLeafModules ignores a COMMENTED-OUT spread (a decoy must not become a leaf)", () => {
  const store = [
    'import { realQueries } from "@/lib/real-schema";',
    'import { decoyQueries } from "@/lib/decoy-schema";',
    "function createStoreTables(schemaName: string) {",
    "  return {};",
    "}",
    "export function buildCreateStoreSchemaQueries(schemaName: string) {",
    "  return [",
    "    ...realQueries(schemaName),",
    "    // ...decoyQueries(schemaName),",
    "  ];",
    "}",
  ].join("\n");
  const leaves = findDdlLeafModules(store);
  assert.ok(leaves.has("src/lib/real-schema.ts"));
  assert.ok(!leaves.has("src/lib/decoy-schema.ts"), "a commented-out spread must not point the gate at an uncalled module");
});

test("schemaNameAliases only binds the ONE schema-escape expression, and drops AMBIGUOUS names", () => {
  const aliases = schemaNameAliases(
    [
      "  const s = schemaName.replaceAll('\"', '\"\"');",
      '  const shadow = "shadow_schema";',
      "  const t = other.trim();",
    ].join("\n"),
  );
  assert.deepEqual([...aliases], ["s"]);

  // Rebound later — the gate cannot tell which binding a `${s}` reads.
  assert.deepEqual(
    [...schemaNameAliases(["let s = schemaName.replaceAll('\"', '\"\"');", '  s = "shadow_schema";'].join("\n"))],
    [],
  );
  // COMPOUND mutation is a rebinding too (`s += "_shadow"`).
  assert.deepEqual(
    [...schemaNameAliases(["let s = schemaName.replaceAll('\"', '\"\"');", '  s += "_shadow";'].join("\n"))],
    [],
  );
  // Comparisons are NOT bindings — they must not disqualify the alias.
  assert.deepEqual(
    [...schemaNameAliases(["const s = schemaName.replaceAll('\"', '\"\"');", "  if (s !== '' && s >= 'a' && s === x) return [];"].join("\n"))],
    ["s"],
  );
  // Shadowed by a parameter default — the codex round-1/2 laundering shape.
  assert.deepEqual(
    [
      ...schemaNameAliases(
        ["const s = schemaName.replaceAll('\"', '\"\"');", 'export function queries(s = "shadow_schema") {', "  return [];", "}"].join("\n"),
      ),
    ],
    [],
  );
  // A commented-out declaration binds nothing.
  assert.deepEqual([...schemaNameAliases("// const s = schemaName.replaceAll('\"', '\"\"');")], []);

  // The site count the RELOCATION match depends on is exactly what it was before
  // the tracing verifier landed: the loop-rebinding scan and the
  // statement-terminated initializer feed the verifier ONLY, so no comparison
  // the gate already makes is loosened OR tightened. `for (s of …)` still leaves
  // the alias qualified here — the mutation is caught by the cancellation ban,
  // not by silently narrowing this set.
  assert.deepEqual([...schemaNameAliases("const s = schemaName.replaceAll('\"', '\"\"');\nfor (s of v) { void s; }")], ["s"]);
  // A WRAPPED declaration still does not qualify here (it never did) even though
  // the verifier now reads it whole.
  assert.deepEqual([...schemaNameAliases("const s = schemaName\n  .replaceAll('\"', '\"\"');")], []);
});

// --- The schema-name BINDING detector (codex round 3) -----------------------

/** A one-builder leaf whose DDL interpolates `${s}`, with the binding swapped in. */
const bindingLeaf = (...bind) =>
  [
    "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {",
    ...bind,
    "  return [",
    '    { text: `CREATE TABLE IF NOT EXISTS "${s}"."gadgets" (',
    "      id text PRIMARY KEY",
    "    )` },",
    "  ];",
    "}",
  ].join("\n");
const CLEAN_BIND = "  const s = schemaName.replaceAll('\"', '\"\"');";

test("mutatedSchemaBindings reports a schema name the scope MUTATES or re-binds", () => {
  // The clean binding — one declaration of the escape over the parameter.
  assert.deepEqual([...mutatedSchemaBindings(bindingLeaf(CLEAN_BIND))], []);

  // The reproduced laundering shape: a COMPOUND mutation of the alias.
  assert.deepEqual([...mutatedSchemaBindings(bindingLeaf("  let s = schemaName.replaceAll('\"', '\"\"');", '  s += "_shadow";'))], ["s"]);
  // A plain reassignment and a second declaration are the same defect.
  assert.deepEqual([...mutatedSchemaBindings(bindingLeaf("  let s = schemaName.replaceAll('\"', '\"\"');", '  s = "shadow_schema";'))], ["s"]);
  assert.deepEqual(
    [...mutatedSchemaBindings(bindingLeaf("  const s = schemaName.replaceAll('\"', '\"\"');", '  const s = "shadow_schema";'))],
    ["s"],
  );
  // The PARAMETER behind the alias counts too — mutating it redirects the alias
  // that reads it, however untouched the alias's own declaration looks.
  assert.deepEqual(
    [...mutatedSchemaBindings(bindingLeaf('  schemaName += "_shadow";', "  const s = schemaName.replaceAll('\"', '\"\"');"))],
    ["schemaName"],
  );
  // A comparison is not a mutation, and a commented-out one binds nothing.
  assert.deepEqual([...mutatedSchemaBindings(bindingLeaf(CLEAN_BIND, "  if (s !== '' && s >= 'a') return [];"))], []);
  assert.deepEqual([...mutatedSchemaBindings(bindingLeaf(CLEAN_BIND, '  // s += "_shadow";'))], []);

  // SCOPE-AWARENESS is what keeps an ordinary multi-builder leaf clean: every
  // exported builder declares its own alias over its own `schemaName` parameter,
  // and a file-wide site count would read that as ambiguous.
  const twoBuilders = [bindingLeaf(CLEAN_BIND), bindingLeaf(CLEAN_BIND).replace(/gadget/g, "widget").replace(/gadgets/g, "widgets")].join("\n\n");
  assert.deepEqual([...mutatedSchemaBindings(twoBuilders)], []);
  // …and one poisoned builder does not implicate its sibling.
  const scopes = schemaBindingScopes(twoBuilders);
  assert.deepEqual([...scopes.keys()], ["gadgetSchemaQueries", "widgetSchemaQueries", "#top"]);
  // Every real leaf in the repo binds its schema name cleanly — if this fails,
  // a leaf landed a mutation and its DDL no longer names the schema it reads.
  const storeSrc = readFileSync(join(REPO_ROOT, IN_SCOPE_FILE), "utf8");
  for (const p of findDdlLeafModules(storeSrc).keys()) {
    if (!existsSync(join(REPO_ROOT, p))) continue;
    assert.deepEqual([...mutatedSchemaBindings(readFileSync(join(REPO_ROOT, p), "utf8"))], [], `leaf ${p} mutates its schema-name binding`);
  }
});

test("unverifiedSchemaScopes refuses a schema the gate cannot TRACE to the escape", () => {
  // What the gate CAN vouch for: the escape written out, and a chain of plain
  // single-declaration aliases ending in it. The LITERAL-position escape counts
  // too — `'"${lit}"."t"'::regclass` in a catalogue lookup names the same schema.
  for (const [bind, expr] of [
    [CLEAN_BIND, "s"],
    ["  const raw = schemaName.replaceAll('\"', '\"\"');\n  const s = raw;", "s"],
    ["", "schemaName.replaceAll('\"', '\"\"')"],
  ]) {
    const leaf = bindingLeaf(bind).replace('"${s}"', `"\${${expr}}"`);
    assert.deepEqual([...unverifiedSchemaScopes(leaf)], [], `${bind} / ${expr}`);
  }

  {
    // The LITERAL-position escape names the same schema but doubles the STRING
    // quote, not the identifier one — so it belongs inside a SQL string literal
    // (`'"${lit}"."t"'::regclass`, a shipped catalogue lookup) and nowhere else.
    // A name containing the other quote comes out different (codex round 21).
    const LIT = "  const s = schemaName.replaceAll(\"'\", \"''\");";
    const inLiteral = bindingLeaf(LIT).replace(
      '{ text: `CREATE TABLE IF NOT EXISTS "${s}"."gadgets" (',
      "{ text: `DO $$ BEGIN IF to_regclass('\"${s}\".\"gadgets\"') IS NULL THEN CREATE TABLE \"x\" (",
    );
    assert.deepEqual([...unverifiedSchemaScopes(inLiteral)], []);
    // …and the same escape at an ordinary IDENTIFIER position does not trace.
    assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(LIT))], ["gadgetSchemaQueries"]);
    // The identifier escape at that literal position does not trace either.
    assert.deepEqual(
      [
        ...unverifiedSchemaScopes(
          bindingLeaf(CLEAN_BIND).replace(
            '{ text: `CREATE TABLE IF NOT EXISTS "${s}"."gadgets" (',
            "{ text: `DO $$ BEGIN IF to_regclass('\"${s}\".\"gadgets\"') IS NULL THEN CREATE TABLE \"x\" (",
          ),
        ),
      ],
      ["gadgetSchemaQueries"],
    );
  }

  // What it CANNOT: provenance that leaves the scope or the grammar it reads.
  // Each of these is a laundering shape codex round 4 reproduced — a redirect
  // can be planted where the builder itself never changes.
  {
    // A local wrapper is FOLLOWED, not refused — the real `quoteIdent(schemaName)`
    // shape a shipped leaf uses. One that hands the schema back with nothing but
    // quoting added vouches for the DDL; one that modifies it does not.
    // The POSITION decides which shape the wrapper must produce: a quoted
    // position needs the bare escaped name, an unquoted one needs a complete
    // quoted identifier. `${bare}` at an unquoted position is an UNQUOTED
    // identifier, which PostgreSQL case-folds into a different schema
    // (codex round 20), so the two are not interchangeable.
    const viaHelper = (body) => [`function pick(x: string) {`, `  ${body}`, "}", bindingLeaf(CLEAN_BIND).replace('"${s}"', '"${pick(s)}"')].join("\n");
    const viaHelperUnquoted = (body) => [`function pick(x: string) {`, `  ${body}`, "}", bindingLeaf(CLEAN_BIND).replace('"${s}"', "${pick(s)}")].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper("return x.replaceAll('\"', '\"\"');"))], []);
    // The RAW parameter is the name BEFORE escaping — a different value for any
    // name containing the identifier quote, so it satisfies no position
    // (codex round 22).
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper("return x;"))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(viaHelperUnquoted("return `\"${x.replaceAll('\"', '\"\"')}\"`;"))], []);
    // …and each at the OTHER position is refused.
    assert.deepEqual([...unverifiedSchemaScopes(viaHelperUnquoted("return x.replaceAll('\"', '\"\"');"))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper("return `\"${x.replaceAll('\"', '\"\"')}\"`;"))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper("return `${x}_shadow`;"))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper('return x + "_shadow";'))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper('return other;'))], ["gadgetSchemaQueries"]);
    // A wrapper whose returns disagree is refused on the strength of the worst.
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper('if (t) return x;\n  return "shadow_schema";'))], ["gadgetSchemaQueries"]);
    // The word `return` inside a STRING is not a return, and a wrapper holding a
    // NESTED function is refused — its returns could belong to either function.
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper('const note = "return x;";\n  return `${x}_shadow`;'))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper("const inner = () => { return x; };\n  return `${x}_shadow`;"))], ["gadgetSchemaQueries"]);
    // A nested callable of ANY shape could own the return the scan reads — a
    // method head is one, and the keyword scan cannot see it (codex round 17).
    assert.deepEqual(
      [...unverifiedSchemaScopes(viaHelper("const holder = {\n    quote() {\n      return x;\n    },\n  };\n  void holder;"))],
      ["gadgetSchemaQueries"],
    );
    // …including a COMPUTED-name method (codex round 19).
    assert.deepEqual(
      [...unverifiedSchemaScopes(`const key = "q";\n${viaHelper("const holder = {\n    [key]() {\n      return x;\n    },\n  };\n  void holder;")}`)],
      ["gadgetSchemaQueries"],
    );
    // Following a DECLARED body is only sound while the call reaches it: a
    // reassignment or a second declaration of the helper's name replaces it
    // wholesale (codex round 21).
    const stableHelper = viaHelper("return x.replaceAll('\"', '\"\"');");
    assert.deepEqual([...unverifiedSchemaScopes(`${stableHelper}\npick = () => "shadow";`)], ["gadgetSchemaQueries"]);
    assert.deepEqual(
      [...unverifiedSchemaScopes(`${stableHelper}\nfunction pick(x: string) { return "shadow"; }`)],
      ["gadgetSchemaQueries"],
    );
    // An ASYNC helper returns a promise and a GENERATOR an iterator; interpolating
    // either stringifies to something that is not a schema name, while the
    // `return` still reads as the schema (codex round 27).
    for (const decl of ["async function", "function*"]) {
      const helper = [
        `${decl} pick(x: string) {`,
        "  return x.replaceAll('\"', '\"\"');",
        "}",
        bindingLeaf("  const s = pick(schemaName);"),
      ].join("\n");
      assert.deepEqual([...unverifiedSchemaScopes(helper)], ["gadgetSchemaQueries"], decl);
    }
    // A wrapper the gate vouches for returns UNCONDITIONALLY: one that can fall
    // through returns `undefined`, and DDL would land in a schema of that name
    // while the caller's statements never changed (codex round 10).
    assert.deepEqual([...unverifiedSchemaScopes(viaHelper("if (on) {\n    return x.replaceAll('\"', '\"\"');\n  }"))], ["gadgetSchemaQueries"]);
    // …including a LABELED break, which jumps past the return without any of the
    // guarding keywords being the thing that does it (codex round 25).
    assert.deepEqual(
      [...unverifiedSchemaScopes(viaHelper("out: {\n    if (on) break out;\n    return x.replaceAll('\"', '\"\"');\n  }"))],
      ["gadgetSchemaQueries"],
    );
    assert.deepEqual(
      [...unverifiedSchemaScopes(viaHelper("if (on) return x.replaceAll('\"', '\"\"');\n  return x.replaceAll('\"', '\"\"');"))],
      ["gadgetSchemaQueries"],
    );
    // Handing the parameter straight back counts — but only while the wrapper
    // leaves it alone. A name comparison would wave the mutation through
    // (codex round 11).
    assert.deepEqual([...unverifiedSchemaScopes(viaHelperUnquoted('return `"${x.replaceAll(\'"\', \'""\')}"`;'))], []);
    assert.deepEqual(
      [...unverifiedSchemaScopes(viaHelperUnquoted('x += "_shadow";\n  return `"${x.replaceAll(\'"\', \'""\')}"`;'))],
      ["gadgetSchemaQueries"],
    );
    assert.deepEqual(
      [...unverifiedSchemaScopes(viaHelperUnquoted('[x] = ["other"];\n  return `"${x.replaceAll(\'"\', \'""\')}"`;'))],
      ["gadgetSchemaQueries"],
    );
    // Quoting a RAW value is not escaping it either (codex round 22).
    assert.deepEqual([...unverifiedSchemaScopes(viaHelperUnquoted('return `"${x}"`;'))], ["gadgetSchemaQueries"]);
    // `return` then a NEWLINE returns undefined — automatic semicolon insertion
    // ends the statement, so the next line is not the value (codex round 12).
    assert.deepEqual([...unverifiedSchemaScopes(viaHelperUnquoted("return\n  `\"${x.replaceAll('\"', '\"\"')}\"`;"))], ["gadgetSchemaQueries"]);
  }

  {
    // Two functions may share a name; keying scopes by name alone would drop the
    // earlier one out of the analysis (codex round 11).
    const dup = [
      "function pick(x: string) {",
      '  return `"${x}_shadow"`;',
      "}",
      "function pick(x: string) {",
      '  return `"${x}"`;',
      "}",
      bindingLeaf("  const s = pick(schemaName);").replace('"${s}"', "${s}"),
    ].join("\n");
    assert.deepEqual([...schemaBindingScopes(dup).keys()], ["pick", "pick#2", "gadgetSchemaQueries", "#top"]);
    assert.deepEqual([...unverifiedSchemaScopes(dup)], ["gadgetSchemaQueries"]);
  }

  {
    // The wrapper must hand back the parameter the ARGUMENT bound to. Returning
    // a SECOND parameter returns whatever the call site chose — codex round 6's
    // decisive bypass, and a perfect-looking escape at that.
    const twoParam = (returned) =>
      [
        "function quoteIdent(value: string, fallback: string) {",
        `  return \`"\${${returned}.replaceAll('"', '""')}"\`;`,
        "}",
        bindingLeaf('  const s = quoteIdent(schemaName, "shadow_schema");').replace('"${s}"', "${s}"),
      ].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(twoParam("value"))], []);
    assert.deepEqual([...unverifiedSchemaScopes(twoParam("fallback"))], ["gadgetSchemaQueries"]);
  }

  {
    // A wrapper may interpolate the schema EXACTLY once. `${v}${v}` traces in
    // every part and still returns a different schema — `corecore` (round 7).
    const twice = (body) =>
      [
        "function quoteIdent(value: string) {",
        `  return ${body};`,
        "}",
        bindingLeaf("  const s = quoteIdent(schemaName);").replace('"${s}"', "${s}"),
      ].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(twice("`\"${value.replaceAll('\"', '\"\"')}\"`"))], []);
    assert.deepEqual(
      [...unverifiedSchemaScopes(twice("`${value.replaceAll('\"', '\"\"')}${value.replaceAll('\"', '\"\"')}`"))],
      ["gadgetSchemaQueries"],
    );
  }

  // A DEFAULTED parameter holds what the CALLER passed only while the caller
  // passes it — omit the argument and the default decides the schema (round 7).
  assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND))], []);
  assert.deepEqual(
    [...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND).replace("(schemaName: string)", '(schemaName: string = "shadow_schema")'))],
    ["gadgetSchemaQueries"],
  );

  {
    // A CONCISE arrow wrapper has no `return` statement but is still faithful —
    // refusing it would red an ordinary refactor.
    const arrow = (body) =>
      [`const quote = (x: string) => ${body};`, bindingLeaf("  const s = quote(schemaName);").replace('"${s}"', "${s}")].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(arrow("`\"${x.replaceAll('\"', '\"\"')}\"`"))], []);
    assert.deepEqual([...unverifiedSchemaScopes(arrow("`${x}_shadow`"))], ["gadgetSchemaQueries"]);
    // The quoting a wrapper may add is EXACTLY one identifier quote each side.
    // `"""core"""` is the quoted identifier `"core"`, and `" core "` is a schema
    // whose name has spaces — both trace in every part and neither is the
    // schema the caller passed (codex round 13).
    // A wrapper that adds NO quoting hands back the bare escaped name, which
    // belongs inside quotes — at this UNQUOTED position it is an unquoted
    // identifier that PostgreSQL case-folds (codex round 20).
    assert.deepEqual([...unverifiedSchemaScopes(arrow("`${x.replaceAll('\"', '\"\"')}`"))], ["gadgetSchemaQueries"]);
    const arrowQuotedPosition = (body) =>
      [`const quote = (x: string) => ${body};`, bindingLeaf("  const s = quote(schemaName);")].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(arrowQuotedPosition("`${x.replaceAll('\"', '\"\"')}`"))], []);
    assert.deepEqual([...unverifiedSchemaScopes(arrow("`\"\"\"${x.replaceAll('\"', '\"\"')}\"\"\"`"))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(arrow("`\" ${x.replaceAll('\"', '\"\"')} \"`"))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(arrow("`\"pre${x.replaceAll('\"', '\"\"')}\"`"))], ["gadgetSchemaQueries"]);
    // DROPPING the quotes is the same defect from the other side: the DDL then
    // writes an UNQUOTED identifier, which PostgreSQL case-folds, so a
    // mixed-case schema silently becomes a different one (codex round 20).
    assert.deepEqual([...unverifiedSchemaScopes(arrow("x"))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(arrow("x.replaceAll('\"', '\"\"')"))], ["gadgetSchemaQueries"]);
  }

  {
    // A schema name ASSEMBLED from parts: only the last piece sits in schema
    // position, so a redirect parked in the piece before it would never be
    // looked at. Composed names do not trace (codex round 8).
    const named = (name) => bindingLeaf(CLEAN_BIND, '  const prefix = "";').replace('"${s}"', name);
    assert.deepEqual([...unverifiedSchemaScopes(named('"${s}"'))], [], "the plain one still traces");
    assert.deepEqual([...unverifiedSchemaScopes(named('"${prefix}${s}"'))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(named('"pre${s}"'))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(named('"${s}suffix"'))], ["gadgetSchemaQueries"]);
    // A composed name must be SEEN, not merely fall through the no-position
    // fallback — a sibling statement with a clean position would otherwise hide
    // it (codex round 9).
    const alongsideClean = named('"pre${s}"').replace("  ];", '    { text: `CREATE INDEX IF NOT EXISTS i ON "${s}"."other" (id)` },\n  ];');
    assert.deepEqual([...unverifiedSchemaScopes(alongsideClean)], ["gadgetSchemaQueries"]);
    // The UNQUOTED name can be part of a token too — literal text or a second
    // interpolation after the first, before the dot (codex round 10).
    for (const composed of ["${s}_tail", "pre${s}", "${prefix}${s}"]) {
      assert.deepEqual([...unverifiedSchemaScopes(named(composed))], ["gadgetSchemaQueries"], composed);
    }
    // An UNQUOTED position needs a value that already carries its quotes; the
    // bare escape belongs inside them (codex round 20).
    assert.deepEqual([...unverifiedSchemaScopes(named("${s}"))], ["gadgetSchemaQueries"], "the bare escape is not a quoted identifier");
    const quotedValue = [
      "function qi(x: string) { return `\"${x.replaceAll('\"', '\"\"')}\"`; }",
      bindingLeaf("  const s = qi(schemaName);", '  const prefix = "";').replace('"${s}"', "${s}"),
    ].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(quotedValue)], [], "a quoted identifier at an unquoted position traces");
  }

  {
    // A scope that WRITES schema-qualified DDL while showing the gate no schema
    // position has assembled the qualified name out of reach — vouching for it
    // would be vouching for nothing (codex round 8). A scope with no DDL at all
    // is not asked the question.
    const assembled = [
      "function qi(x: string) { return `\"${x.replaceAll('\"', '\"\"')}\"`; }",
      "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {",
      '  const qn = qi(schemaName) + "." + qi("gadgets");',
      "  return [{ text: `CREATE TABLE IF NOT EXISTS ${qn} (id text PRIMARY KEY)` }];",
      "}",
    ].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(assembled)], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes("export function helper(a: string) {\n  return a.trim();\n}\n")], []);
    // …and a builder whose OTHER statement showed a perfectly good position does
    // not get to hide an opaque target behind it (codex round 18).
    const mixed = [
      "function qi(x: string) { return `\"${x.replaceAll('\"', '\"\"')}\"`; }",
      "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {",
      "  const s = schemaName.replaceAll('\"', '\"\"');",
      '  const hidden = qi(schemaName) + "." + qi("other");',
      "  return [",
      '    { text: `CREATE TABLE IF NOT EXISTS "${s}"."gadgets" (id text)` },',
      "    { text: `CREATE INDEX IF NOT EXISTS i ON ${hidden} (id)` },",
      "  ];",
      "}",
    ].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(mixed)], ["gadgetSchemaQueries"]);
    // …in EVERY DDL form the gate recognises, with the optional IF [NOT] EXISTS
    // in between: `ALTER TABLE IF EXISTS ${t}` used to name `IF` as its target
    // (codex round 24).
    for (const stmt of [
      "ALTER TABLE IF EXISTS ${hidden} ADD COLUMN a text",
      "DROP VIEW IF EXISTS ${hidden}",
      "CREATE SEQUENCE ${hidden}",
    ]) {
      const withForm = mixed.replace("    { text: `CREATE INDEX IF NOT EXISTS i ON ${hidden} (id)` },", `    { text: \`${stmt}\` },`);
      assert.deepEqual([...unverifiedSchemaScopes(withForm)], ["gadgetSchemaQueries"], stmt);
    }

    // Binding the qualified name in a way the gate CAN read keeps it traceable —
    // the shipped buildEmailCorrelationIndexQueries shape.
    const bound = [
      "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {",
      "  const t = `\"${schemaName.replaceAll('\"', '\"\"')}\".\"gadgets\"`;",
      "  return [{ text: `CREATE INDEX IF NOT EXISTS gadgets_idx ON ${t} (id)` }];",
      "}",
    ].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(bound)], []);
  }

  // A brace inside a STRING argument must not end the interpolation early and
  // hide the schema position from the scan (codex round 6).
  assert.deepEqual(
    [
      ...unverifiedSchemaScopes(
        ['function select(x: string) { return "shadow_schema"; }', bindingLeaf("").replace('${s}', '${select("}")}')].join("\n"),
      ),
    ],
    ["gadgetSchemaQueries"],
  );

  {
    // A traced alias must be a `const`, declared once. That is the structural
    // guarantee behind every re-binding form — the ones the scanners model AND
    // the ones they do not: a `const` cannot be reassigned, destructured into,
    // rebound by a loop head, or shadowed without a second declaration the site
    // count sees (codex round 14).
    assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND))], []);
    assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND.replace("const", "let")))], ["gadgetSchemaQueries"]);
    assert.deepEqual(
      [...unverifiedSchemaScopes(bindingLeaf("  const raw = schemaName;", "  const s = raw.replaceAll('\"', '\"\"');"))],
      [],
    );
    assert.deepEqual(
      [...unverifiedSchemaScopes(bindingLeaf("  let raw = schemaName;", "  const s = raw.replaceAll('\"', '\"\"');"))],
      ["gadgetSchemaQueries"],
    );
    // The forms that rule covers even where the scanners would have missed them.
    for (const rebind of [
      '  for ([s] of [["shadow_schema"]]) { break; }',
      '  for ({ a: s } of [{ a: "shadow_schema" }]) { break; }',
      '  try { throw "x"; } catch (s) { void s; }',
    ]) {
      assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND, rebind))], ["gadgetSchemaQueries"], rebind);
    }
    // An unrelated loop is not a re-binding.
    assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND, "  for (const t of []) void t;"))], []);

    // The ROOT parameter can be SHADOWED by binding forms the parenthesised
    // parameter scan cannot see: a destructured catch, a bare arrow parameter, a
    // destructured parameter list (codex round 15).
    for (const shadow of [
      "  try { throw {}; } catch ({ schemaName }) { void schemaName; }",
      "  const f = (schemaName) => schemaName;\n  void f;",
      "  const g = ({ schemaName }) => schemaName;\n  void g;",
    ]) {
      assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND, shadow))], ["gadgetSchemaQueries"], shadow);
    }
    // An arrow over an UNRELATED name is ordinary code — a real leaf has one.
    assert.deepEqual(
      [...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND, "  const kinds = [\"a\"].map((k) => `'${k}'`).join(\", \");\n  void kinds;"))],
      [],
    );
    // A `function`/`class` DECLARATION binds its own name, and in a block that
    // shadows an outer alias of the same name (codex round 23).
    for (const decl of [
      "  function schemaName() { return 'shadow'; }",
      "  {\n    class schemaName {\n      static replaceAll() { return 'shadow'; }\n    }\n  }",
    ]) {
      assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(decl, CLEAN_BIND))], ["gadgetSchemaQueries"], decl);
    }
    // A METHOD's parameter list shadows too, and it is matched by SHAPE — a
    // `name(…) {` head — rather than by the keyword that declared it, so object
    // methods, class methods, getters and generators are covered without adding
    // one more entry to an enumeration of syntax (codex round 16).
    const method = [
      "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {",
      "  const emitter = {",
      "    make(schemaName) {",
      "      const s = schemaName.replaceAll('\"', '\"\"');",
      '      return [{ text: `CREATE TABLE IF NOT EXISTS "${s}"."gadgets" (id text)` }];',
      "    },",
      "  };",
      '  return emitter.make("shadow_schema");',
      "}",
    ].join("\n");
    assert.deepEqual([...unverifiedSchemaScopes(method)], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(`const key = "make";\n${method.replace("make(schemaName)", "[key](schemaName)")}`)], ["gadgetSchemaQueries"]);
    // …while an ordinary call, an `if` head and a `for` head are not parameter
    // lists and must not be read as bindings.
    assert.deepEqual(
      [...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND, '  const j = ["a"].join(", ");\n  if (s) { void j; }\n  for (const t of []) { void t; }'))],
      [],
    );
  }

  {
    // An identifier written with a UNICODE ESCAPE is the same name to JavaScript
    // and a different one to a source scan, so a re-binding could hide behind it
    // (codex round 26). The escape inside a STRING is ordinary data.
    const BS = String.fromCharCode(92);
    assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND, `  schem${BS}u0061Name = "other";`))], ["gadgetSchemaQueries"]);
    assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND, `  const note = "${BS}u0061";\n  void note;`))], []);
  }

  // The schema is what the CALLER passed, and the caller passes it FIRST
  // (`...gadgetSchemaQueries(schemaName),`). A builder that switches its DDL to
  // a second parameter is naming something else (codex round 12).
  const twoParams = (used) =>
    bindingLeaf(`  const s = ${used}.replaceAll('"', '""');`).replace("(schemaName: string)", "(schemaName: string, alternate: string)");
  assert.deepEqual([...unverifiedSchemaScopes(twoParams("schemaName"))], []);
  assert.deepEqual([...unverifiedSchemaScopes(twoParams("alternate"))], ["gadgetSchemaQueries"]);

  // The ROOT of the escape must itself be the schema the caller passed in —
  // codex round 5's decisive bypass, where the escape reads a local constant.
  assert.deepEqual(
    [...unverifiedSchemaScopes(bindingLeaf("  const raw = schemaName;", "  const s = raw.replaceAll('\"', '\"\"');"))],
    [],
    "a plain alias of the parameter is still the parameter",
  );
  assert.deepEqual(
    [...unverifiedSchemaScopes(bindingLeaf('  const raw = "shadow_schema";', "  const s = raw.replaceAll('\"', '\"\"');"))],
    ["gadgetSchemaQueries"],
    "the escape applied to a CONSTANT names a different schema",
  );

  // A WRAPPED declaration is read to its statement terminator, so reformatting
  // the binding is not mistaken for a redirect…
  assert.deepEqual([...unverifiedSchemaScopes(bindingLeaf("  const s = schemaName\n    .replaceAll('\"', '\"\"');"))], []);
  // …and a wrap that also appends is still caught.
  assert.deepEqual(
    [...unverifiedSchemaScopes(bindingLeaf("  const s = schemaName\n    .replaceAll('\"', '\"\"') + \"_shadow\";"))],
    ["gadgetSchemaQueries"],
  );

  // The schema position is found by BALANCED-brace scanning, so neither an
  // unquoted schema name nor a nested template hides one (codex round 5).
  assert.deepEqual(
    [...unverifiedSchemaScopes(bindingLeaf('  const s = "shadow_schema";').replace('"${s}"', "${s}"))],
    ["gadgetSchemaQueries"],
    "an UNQUOTED schema position is still a schema position",
  );
  assert.deepEqual(
    [...unverifiedSchemaScopes(bindingLeaf(CLEAN_BIND, "  const suffix = `_shadow`;").replace('"${s}"', "\"${`${s}${suffix}`}\""))],
    ["gadgetSchemaQueries"],
    "a NESTED template must not slip past the schema-position scan",
  );
  // A `for (s of …)` re-binds without an `=`, which the assignment scan alone
  // never sees.
  assert.deepEqual(
    [...mutatedSchemaBindings(bindingLeaf("  let s = schemaName.replaceAll('\"', '\"\"');", '  for (s of ["shadow_schema"]) break;'))],
    ["s"],
  );
  // …but a DECLARED loop variable is a binding of its own, not a mutation.
  assert.deepEqual([...mutatedSchemaBindings(bindingLeaf(CLEAN_BIND, "  for (const t of []) void t;"))], []);
  // A PATTERN assignment and an update expression re-bind without the plain
  // `id =` the assignment scan looks for (codex round 9).
  for (const mutation of [
    '  [s] = ["shadow_schema"];',
    '  ({ s } = { s: "shadow_schema" });',
    "  s++;",
    "  --s;",
    // NESTED patterns too — an enclosing block must not hide them (round 12).
    "  ({ database: { schema: s } } = config);",
    '  [[s]] = [["shadow_schema"]];',
  ]) {
    assert.deepEqual([...mutatedSchemaBindings(bindingLeaf("  let s = schemaName.replaceAll('\"', '\"\"');", mutation))], ["s"], mutation);
  }
  // An object LITERAL on the right of a declaration is not a pattern.
  assert.deepEqual([...mutatedSchemaBindings(bindingLeaf(CLEAN_BIND, "  const opts = { s: 1 };"))], []);

  // The scope scanner matches BRACES, not a column-0 `}`: a builder whose DDL
  // template carries a flush-left brace must not be cut in half (which would
  // strand the `schemaName` parameter its binding traces to).
  const flushBrace = bindingLeaf(CLEAN_BIND).replace("      id text PRIMARY KEY", "}\n      id text PRIMARY KEY");
  assert.deepEqual([...unverifiedSchemaScopes(flushBrace)], []);
  assert.deepEqual([...schemaBindingScopes(flushBrace).keys()], ["gadgetSchemaQueries", "#top"]);
  for (const [label, bind, expr] of [
    ["a concatenation", CLEAN_BIND, 's + "_shadow"'],
    ["a hardcoded constant", '  const s = "shadow_schema";', "s"],
    ["a parameter default", "", "s"],
    ["a destructured binding", "  const e = schemaName.replaceAll('\"', '\"\"');\n  const { value: s } = { value: e };", "s"],
    ["an imported constant", "", "IMPORTED_SCHEMA"],
  ]) {
    const leaf = bindingLeaf(bind).replace('"${s}"', `"\${${expr}}"`);
    assert.deepEqual([...unverifiedSchemaScopes(leaf)], ["gadgetSchemaQueries"], label);
  }

  // Every real leaf and the store's own executed-DDL region trace cleanly — if
  // this fails, a leaf started naming a schema the gate cannot follow and its
  // DDL will be compared verbatim until the binding is made traceable.
  const storeSrc = readFileSync(join(REPO_ROOT, IN_SCOPE_FILE), "utf8");
  for (const p of findDdlLeafModules(storeSrc).keys()) {
    if (!existsSync(join(REPO_ROOT, p))) continue;
    assert.deepEqual([...unverifiedSchemaScopes(readFileSync(join(REPO_ROOT, p), "utf8"))], [], `leaf ${p}`);
  }
  for (const h of findLocalDdlHelpers(storeSrc)) {
    assert.deepEqual([...unverifiedSchemaScopes(helperBody(storeSrc, h))], [], `local helper ${h.name}`);
  }
});

test("leaf: a redirect planted OUTSIDE the builder — the shapes provenance escapes through", () => {
  // codex round 4: `schemaBindingRedirects` alone follows initializers only
  // within one scope, so a redirect can sit in a helper the builder calls, in a
  // parameter default, or behind a destructuring — the builder's own body (and
  // every DDL line in it) never changes. Refusing to cancel DDL whose schema
  // cannot be TRACED is what closes all three at once.
  const store = LEAF_SPREAD_STORE;
  const readBase = (base) => (p) => (p === IN_SCOPE_FILE ? store : p === LEAF_PATH ? base : null);
  const leafWith = (head, bind, expr) =>
    [
      ...head,
      "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {",
      ...bind,
      "  return [",
      `    { text: \`CREATE TABLE IF NOT EXISTS "\${${expr}}"."gadgets" (`,
      "      id text PRIMARY KEY,",
      "      label text,",
      "    )` },",
      "  ];",
      "}",
    ].join("\n");

  for (const [label, base, final] of [
    [
      "the redirect lives in a helper the builder calls",
      leafWith(["function pick(x: string) {", "  return x;", "}"], [CLEAN_BIND], "pick(s)"),
      leafWith(["function pick(x: string) {", "  return `${x}_shadow`;", "}"], [CLEAN_BIND], "pick(s)"),
    ],
    [
      "the redirect lives in a parameter default",
      leafWith([], [], "s").replace("(schemaName: string)", "(schemaName: string, s = schemaName.replaceAll('\"', '\"\"'))"),
      leafWith([], [], "s").replace("(schemaName: string)", '(schemaName: string, s = "shadow_schema")'),
    ],
    [
      "the redirect lives in the ROOT the escape reads",
      leafWith(["function pick(x: string) {", "  return x;", "}"], ["  const raw = pick(schemaName);", "  const s = raw.replaceAll('\"', '\"\"');"], "s"),
      leafWith(["function pick(x: string) {", "  return `${x}_shadow`;", "}"], ["  const raw = pick(schemaName);", "  const s = raw.replaceAll('\"', '\"\"');"], "s"),
    ],
    [
      "the redirect lives behind a destructuring",
      leafWith([], ["  const e = schemaName.replaceAll('\"', '\"\"');", "  const { value: s } = { value: e };"], "s"),
      leafWith([], ["  const e = schemaName.replaceAll('\"', '\"\"');", '  const { value: s } = { value: e + "_shadow" };'], "s"),
    ],
  ]) {
    assert.notEqual(base, final, label);
    const r = runGate({ diffText: fullReplaceDiff(LEAF_PATH, base, final), readBaseFile: readBase(base) });
    assert.equal(r.verdict, "fail", `${label}: ${JSON.stringify(r.destructive)}`);
    assert.ok(r.destructive.some((d) => d.rule === "table-removed-from-ddl"), `${label}: ${JSON.stringify(r.destructive)}`);
    assert.ok(
      r.notices.some((n) => n.includes("cannot be traced") && n.includes("gadgetSchemaQueries")),
      `${label} must say WHY the DDL was compared verbatim: ${r.notices.join(" | ")}`,
    );
  }
});

test("schemaBindingRedirects reports a binding that STOPPED naming the verified schema", () => {
  const base = bindingLeaf(CLEAN_BIND);
  const redirect = (...bind) => schemaBindingRedirects(base, bindingLeaf(...bind));

  assert.deepEqual(redirect(CLEAN_BIND), [], "an identical revision is not a redirect");
  assert.deepEqual(
    redirect(CLEAN_BIND, '    { text: `CREATE INDEX IF NOT EXISTS gadgets_id_idx ON "${s}"."gadgets" (id)` },'),
    [],
    "an ordinary additive edit keeps its cancellation",
  );

  // Every laundering form names the scope that stopped vouching for its schema.
  for (const bind of [
    ["  let s = schemaName.replaceAll('\"', '\"\"');", '  s += "_shadow";'],
    ["  let s = schemaName.replaceAll('\"', '\"\"');", '  s = "shadow_schema";'],
    ['  const s = "shadow_schema";'],
    ["  const raw = schemaName.replaceAll('\"', '\"\"');", '  const s = raw + "_shadow";'],
    ["  const s = pickSchema(schemaName);"],
  ]) {
    const found = redirect(...bind);
    assert.equal(found.length, 1, JSON.stringify({ bind, found }));
    assert.equal(found[0].scope, "gadgetSchemaQueries");
  }

  // A leaf that GAINS a builder is not a redirect — the new scope has no base
  // revision to have drifted from.
  assert.deepEqual(
    schemaBindingRedirects(base, [base, bindingLeaf(CLEAN_BIND).replace(/gadget/g, "widget")].join("\n\n")),
    [],
  );
});

test("stripComments respects escapes, mixed quotes and block comments", () => {
  // The `//` sits inside a string that also contains an ESCAPED quote — a
  // quote-parity count would truncate real code here.
  assert.equal(stripComments("const u = 'a\\'b // not a comment'; // gone"), "const u = 'a\\'b // not a comment'; ");
  assert.equal(stripComments("keep(); /* ...decoyQueries(x) */ more();"), "keep();  more();");
  assert.equal(stripComments('const p = "https://x"; // tail'), 'const p = "https://x"; ');
  // Block-comment MARKERS inside strings must not open a comment and erase the
  // real code between them (codex round 3, finding 4).
  const smuggled = ['const open = "/*";', 'import { evilQueries } from "@/lib/evil-schema";', 'const close = "*/";'].join("\n");
  assert.ok(stripComments(smuggled).includes("evilQueries"), stripComments(smuggled));
  // A `//` inside a MULTI-LINE template literal survives.
  assert.ok(stripComments("const t = `line1\n// still text`;\nreal();").includes("// still text"));
});

test("findLocalDdlHelpers scopes the LOCAL helpers the DDL region spreads in (the real file has one)", () => {
  const content = readFileSync(join(REPO_ROOT, IN_SCOPE_FILE), "utf8");
  const helpers = findLocalDdlHelpers(content);
  assert.ok(
    helpers.some((h) => h.name === "buildEmailCorrelationIndexQueries"),
    `expected the live local helper; got ${helpers.map((h) => h.name).join(", ") || "none"}`,
  );
  for (const h of helpers) assert.ok(h.end > h.start, `${h.name}: region must span lines`);
});

test("leaf: a destructive edit inside a LOCAL spread-in helper reds (its body is outside both named regions)", () => {
  const withHelper = [
    "function createStoreTables(schemaName: string) {", // 1
    "  return {};", // 2
    "}", // 3
    "", // 4
    "function extraQueries(schemaName: string) {", // 5
    "  return [", // 6
    `    { text: \`CREATE TABLE IF NOT EXISTS ${INLINE_S}."extras" (`, // 7
    "      id text PRIMARY KEY,", // 8
    "      label text,", // 9
    "    )` },", // 10
    "  ];", // 11
    "}", // 12
    "", // 13
    "export function buildCreateStoreSchemaQueries(schemaName: string): QueryInput[] {", // 14
    "  return [", // 15
    "    ...extraQueries(schemaName),", // 16
    "  ];", // 17
    "}", // 18
  ].join("\n");
  const r = runGate({
    diffText: multiHunkDiff(IN_SCOPE_FILE, withHelper, [{ from: 9, to: 9, replacement: [] }]),
    readBaseFile: (p) => (p === IN_SCOPE_FILE ? withHelper : null),
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.destructive.some((d) => d.rule === "column-removed-from-ddl"), JSON.stringify(r.destructive));
});

test("normalizeDdlLine collapses ONLY a verified schema-name interpolation", () => {
  const inline = '   { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll(\'"\', \'""\')}"."t" (`';
  const leaf = '{ text: `CREATE TABLE IF NOT EXISTS "${s}"."t" (`';
  assert.equal(normalizeDdlLine(inline), normalizeDdlLine(leaf, new Set(["s"])));
  // Without the binding, `${s}` is just an unknown expression — no collapse, no
  // match, so a hardcoded/foreign schema can never pose as a relocation.
  assert.notEqual(normalizeDdlLine(inline), normalizeDdlLine(leaf));
  // Non-schema interpolations survive verbatim: a changed FK target or
  // predicate keeps the two lines distinct.
  assert.notEqual(
    normalizeDdlLine('REFERENCES "${s}"."${parent}"(id)', new Set(["s"])),
    normalizeDdlLine('REFERENCES "${s}"."${other}"(id)', new Set(["s"])),
  );
  // Different TABLES never normalize together.
  assert.notEqual(normalizeDdlLine('DROP TABLE "${s}"."a"'), normalizeDdlLine('DROP TABLE "${s}"."b"'));
});

test("leafDdlLines takes the whole file and carries the enclosing table", () => {
  const leaf = [
    "// helper-composed DDL lives outside the exported body — it is in scope too",
    "export function gadgetSchemaQueries(schemaName: string) {",
    "  const s = schemaName.replaceAll('\"', '\"\"');",
    '  return [{ text: `CREATE TABLE IF NOT EXISTS "${s}"."gadgets" (`, },',
    "    `  label text,`,",
    "  ];",
    "}",
  ].join("\n");
  const lines = leafDdlLines("src/lib/gadget-schema.ts", leaf);
  assert.equal(lines.length, 7, "every line of the leaf is in scope");
  assert.equal(lines[4].table, "gadgets", "the column line inherits its CREATE TABLE");
  assert.match(lines[3].norm, /\$\{SCHEMA\}/, "the bound schema alias normalizes");
  assert.deepEqual(leafDdlLines("x", ""), []);
});

// --- Synthetic relocation end to end ---------------------------------------

const LEAF_PATH = "src/lib/gadget-schema.ts";
const INLINE_S = '"${schemaName.replaceAll(\'"\', \'""\')}"';
const LEAF_S = '"${s}"';
const LEAF_BASE_STORE = [
  `import { gadgetSchemaQueries } from "@/lib/gadget-schema";`, // 1
  "", // 2
  "function createStoreTables(schemaName: string) {", // 3
  "  return {};", // 4
  "}", // 5
  "", // 6
  "export function buildCreateStoreSchemaQueries(schemaName: string): QueryInput[] {", // 7
  "  return [", // 8
  `    { text: \`CREATE TABLE IF NOT EXISTS ${INLINE_S}."gadgets" (`, // 9
  "      id text PRIMARY KEY,", // 10
  "      label text,", // 11
  "      amount numeric(12,8)", // 12
  "    )` },", // 13
  `    { text: \`CREATE INDEX IF NOT EXISTS gadgets_label_idx ON ${INLINE_S}."gadgets" (label)\` },`, // 14
  "  ];", // 15
  "}", // 16
].join("\n");

/** One file entry with several hunks (hunkDiff emits one header per call). */
function multiHunkDiff(path, base, edits, ctx = 2) {
  const lines = base.split("\n");
  let delta = 0;
  const hunks = [...edits]
    .sort((a, b) => a.from - b.from)
    .map(({ from, to, replacement }) => {
      const before = lines.slice(Math.max(0, from - 1 - ctx), from - 1);
      const removed = lines.slice(from - 1, to);
      const after = lines.slice(to, to + ctx);
      const oldStart = from - before.length;
      const oldCount = before.length + removed.length + after.length;
      const newCount = before.length + replacement.length + after.length;
      const newStart = oldStart + delta;
      delta += newCount - oldCount;
      return (
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n` +
        [...before.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...replacement.map((l) => `+${l}`), ...after.map((l) => ` ${l}`)].join("\n") +
        "\n"
      );
    });
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
}

/** The SAME store after the relocation has landed: the DDL is now the spread. */
const LEAF_SPREAD_STORE = LEAF_BASE_STORE.split("\n")
  .slice(0, 8)
  .concat(["    ...gadgetSchemaQueries(schemaName),", "  ];", "}"])
  .join("\n");

/** The gadgets DDL as it reads inside the leaf (the `${s}` spelling). */
const RELOCATED_DDL = [
  `    { text: \`CREATE TABLE IF NOT EXISTS ${LEAF_S}."gadgets" (`,
  "      id text PRIMARY KEY,",
  "      label text,",
  "      amount numeric(12,8)",
  "    )` },",
  `    { text: \`CREATE INDEX IF NOT EXISTS gadgets_label_idx ON ${LEAF_S}."gadgets" (label)\` },`,
];
const leafFile = (ddl) =>
  [
    "// Bootstrap DDL for the gadget tables — a pure-strings leaf.",
    "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {",
    "  const s = schemaName.replaceAll('\"', '\"\"');",
    "  return [",
    ...ddl,
    "  ];",
    "}",
    "",
  ].join("\n");

/** Store side of the relocation: the inline DDL becomes a spread. */
const RELOCATION_STORE_DIFF = multiHunkDiff(LEAF_PATH === "" ? "" : IN_SCOPE_FILE, LEAF_BASE_STORE, [
  { from: 9, to: 14, replacement: ["    ...gadgetSchemaQueries(schemaName),"] },
]);
const relocationDiff = (ddl) => RELOCATION_STORE_DIFF + fullReplaceDiff(LEAF_PATH, null, leafFile(ddl));
const readLeafBase = (p) => (p === IN_SCOPE_FILE ? LEAF_BASE_STORE : null);

test("leaf relocation: moving deployed DDL into a spread-in leaf is classified as no-data-impact", () => {
  const r = runGate({ diffText: relocationDiff(RELOCATED_DDL), readBaseFile: readLeafBase });
  assert.deepEqual(r.destructive, [], JSON.stringify(r.destructive));
  assert.equal(r.verdict, "pass");
  assert.ok(
    r.notices.some((n) => n.includes("relocated") && n.includes(IN_SCOPE_FILE) && n.includes(LEAF_PATH)),
    r.notices.join("; "),
  );
});

test("leaf relocation: a column the leaf never receives is still a dropped column", () => {
  const r = runGate({
    diffText: relocationDiff(RELOCATED_DDL.filter((l) => l.trim() !== "label text,")),
    readBaseFile: readLeafBase,
  });
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.destructive.map((d) => d.rule), ["column-removed-from-ddl"]);
  assert.match(r.destructive[0].line, /label text/);
});

test("leaf relocation: a table the leaf never receives is still a dropped table", () => {
  const r = runGate({
    diffText: relocationDiff([`    { text: \`CREATE INDEX IF NOT EXISTS gadgets_label_idx ON ${LEAF_S}."gadgets" (label)\` },`]),
    readBaseFile: readLeafBase,
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.destructive.some((d) => d.rule === "table-removed-from-ddl"), JSON.stringify(r.destructive));
});

test("leaf relocation: destructive DDL hidden INSIDE the leaf faces the same rules as inline DDL", () => {
  const dropTable = runGate({
    diffText: relocationDiff([...RELOCATED_DDL, `    { text: \`DROP TABLE IF EXISTS ${LEAF_S}."widgets"\` },`]),
    readBaseFile: readLeafBase,
  });
  assert.equal(dropTable.verdict, "fail");
  assert.ok(dropTable.destructive.some((d) => d.rule === "drop-table"), JSON.stringify(dropTable.destructive));

  // The relocated table must NOT earn the new-table carve-out: its CREATE was
  // cancelled as a move, so it is a table that exists on deployed databases.
  const dropRelocated = runGate({
    diffText: relocationDiff([...RELOCATED_DDL, `    { text: \`ALTER TABLE ${LEAF_S}."gadgets" ADD COLUMN IF NOT EXISTS note text NOT NULL\` },`]),
    readBaseFile: readLeafBase,
  });
  assert.equal(dropRelocated.verdict, "fail");
  assert.ok(
    dropRelocated.destructive.some((d) => d.rule === "not-null-column-on-existing-table"),
    JSON.stringify(dropRelocated.destructive),
  );
});

test("leaf: a destructive change to an EXISTING leaf fails even with drizzle-store.ts untouched", () => {
  const base = leafFile(RELOCATED_DDL);
  const r = runGate({
    diffText: fullReplaceDiff(LEAF_PATH, base, leafFile(RELOCATED_DDL.filter((l) => l.trim() !== "label text,"))),
    readBaseFile: (p) => (p === IN_SCOPE_FILE ? LEAF_SPREAD_STORE : p === LEAF_PATH ? base : null),
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.destructive.some((d) => d.rule === "column-removed-from-ddl"), JSON.stringify(r.destructive));
});

test("leaf relocation: a leaf pointing its DDL at a DIFFERENT schema is NOT a relocation", () => {
  // The classic laundering attempt: the CREATE text is line-for-line identical
  // except the schema comes from a hardcoded constant instead of the builder's
  // argument, so the deployed schema loses the table.
  const shadow = leafFile(RELOCATED_DDL).replace(
    "  const s = schemaName.replaceAll('\"', '\"\"');",
    '  const s = "shadow_schema";',
  );
  const r = runGate({
    diffText: RELOCATION_STORE_DIFF + fullReplaceDiff(LEAF_PATH, null, shadow),
    readBaseFile: readLeafBase,
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.destructive.some((d) => d.rule === "table-removed-from-ddl"), JSON.stringify(r.destructive));
});

test("leaf: MUTATING the schema-name binding under unchanged DDL is a redirect, not a no-op", () => {
  // The hole codex reproduced against round 3: `s += "_shadow"` drops the alias,
  // which stops the NORMALIZED relocation match — but every DDL line in the leaf
  // is untouched TEXT, so it cancelled against the leaf's own base revision
  // through the exact-text pass and the gate passed with no finding at all,
  // while every deployed table the builder owns quietly moved schema.
  const base = leafFile(RELOCATED_DDL);
  const shadowed = base
    .replace("  const s = schemaName.replaceAll('\"', '\"\"');", "  let s = schemaName.replaceAll('\"', '\"\"');\n  s += \"_shadow\";");
  const r = runGate({
    diffText: fullReplaceDiff(LEAF_PATH, base, shadowed),
    readBaseFile: (p) => (p === IN_SCOPE_FILE ? LEAF_SPREAD_STORE : p === LEAF_PATH ? base : null),
  });
  assert.equal(r.verdict, "fail");
  assert.ok(
    r.destructive.some((d) => d.rule === "schema-binding-redirected" && d.line.includes("gadgetSchemaQueries") && d.line.includes("s")),
    JSON.stringify(r.destructive),
  );
  // Verbatim comparison is what makes it a DESTRUCTIVE finding and not just a
  // notice: the DDL the leaf stops executing against the real schema reds as the
  // dropped table it is.
  assert.ok(r.destructive.some((d) => d.rule === "table-removed-from-ddl"), JSON.stringify(r.destructive));

  // The same mutation reached through the PARAMETER the alias reads.
  const viaParam = base.replace(
    "  const s = schemaName.replaceAll('\"', '\"\"');",
    "  schemaName += \"_shadow\";\n  const s = schemaName.replaceAll('\"', '\"\"');",
  );
  const p = runGate({
    diffText: fullReplaceDiff(LEAF_PATH, base, viaParam),
    readBaseFile: (q) => (q === IN_SCOPE_FILE ? LEAF_SPREAD_STORE : q === LEAF_PATH ? base : null),
  });
  assert.equal(p.verdict, "fail");
  assert.ok(p.destructive.some((d) => d.rule === "schema-binding-redirected"), JSON.stringify(p.destructive));
});

test("leaf: a redirect in ONE builder leaves its SIBLING builders' cancellation intact", () => {
  // The ban is scope-precise. A leaf holds several builders; poisoning the whole
  // FILE would bury the real finding under every sibling table's DDL.
  const sibling = leafFile(RELOCATED_DDL)
    .replace(/gadgetSchemaQueries/g, "widgetSchemaQueries")
    .replace(/gadgets/g, "widgets");
  const base = `${leafFile(RELOCATED_DDL)}\n${sibling}`;
  const final = base.replace(
    "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {\n  const s = schemaName.replaceAll('\"', '\"\"');",
    "export function gadgetSchemaQueries(schemaName: string): { text: string }[] {\n  let s = schemaName.replaceAll('\"', '\"\"');\n  s += \"_shadow\";",
  );
  assert.notEqual(base, final);
  const store = LEAF_SPREAD_STORE.replace(
    "    ...gadgetSchemaQueries(schemaName),",
    "    ...gadgetSchemaQueries(schemaName),\n    ...widgetSchemaQueries(schemaName),",
  );
  const r = runGate({
    diffText: fullReplaceDiff(LEAF_PATH, base, final),
    readBaseFile: (p) => (p === IN_SCOPE_FILE ? store : p === LEAF_PATH ? base : null),
  });
  assert.equal(r.verdict, "fail");
  const lines = r.destructive.map((d) => d.line).join("\n");
  assert.match(lines, /"gadgets"/);
  assert.doesNotMatch(lines, /"widgets"/, "the untouched sibling builder must keep its cancellation");
});

test("leaf relocation: a DUPLICATE copy of a relocated CREATE cannot launder the table into the new-table carve-out", () => {
  // One copy is consumed by the relocation match; without the pre-existing-table
  // subtraction the survivor would put a DEPLOYED table into `newTables` and
  // waive the DROP that follows it (codex round 1, finding B).
  const create = RELOCATED_DDL[0];
  const r = runGate({
    diffText: relocationDiff([...RELOCATED_DDL, create, `    { text: \`DROP TABLE IF EXISTS ${LEAF_S}."gadgets"\` },`]),
    readBaseFile: readLeafBase,
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.destructive.some((d) => d.rule === "drop-table"), JSON.stringify(r.destructive));
});

test("leaf: REMOVING a spread un-executes the leaf's DDL and reds, with the leaf file untouched", () => {
  // The store drops `...gadgetSchemaQueries(schemaName),` and nothing else. The
  // leaf file is not in the diff at all, yet its tables stop being created.
  const r = runGate({
    diffText: multiHunkDiff(IN_SCOPE_FILE, LEAF_SPREAD_STORE, [{ from: 9, to: 9, replacement: [] }]),
    readBaseFile: (p) => (p === IN_SCOPE_FILE ? LEAF_SPREAD_STORE : p === LEAF_PATH ? leafFile(RELOCATED_DDL) : null),
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.destructive.some((d) => d.rule === "table-removed-from-ddl"), JSON.stringify(r.destructive));
});

test("leaf: renaming a leaf together with its import is a pure move and passes", () => {
  const MOVED = "src/lib/moved-gadget-schema.ts";
  const leaf = leafFile(RELOCATED_DDL);
  const storeBase = LEAF_SPREAD_STORE;
  const storeFinal = storeBase.replace("@/lib/gadget-schema", "@/lib/moved-gadget-schema");
  const pureMove = runGate({
    diffText:
      multiHunkDiff(IN_SCOPE_FILE, storeBase, [
        { from: 1, to: 1, replacement: [`import { gadgetSchemaQueries } from "@/lib/moved-gadget-schema";`] },
      ]) +
      `diff --git a/${LEAF_PATH} b/${MOVED}\nsimilarity index 100%\nrename from ${LEAF_PATH}\nrename to ${MOVED}\n`,
    readBaseFile: (p) => (p === IN_SCOPE_FILE ? storeBase : p === LEAF_PATH ? leaf : null),
  });
  assert.equal(storeFinal.includes("moved-gadget-schema"), true);
  assert.deepEqual(pureMove.destructive, [], JSON.stringify(pureMove.destructive));
  assert.equal(pureMove.verdict, "pass");
});

test("leaf: an ADDED spread the resolver cannot pin fails closed", () => {
  // `import * as leaf` + `...leaf.queries(x)` composes executed DDL from a
  // module the classifier never sees — including a DROP it could hide.
  const base = LEAF_BASE_STORE;
  const r = runGate({
    diffText: multiHunkDiff(IN_SCOPE_FILE, base, [
      { from: 1, to: 1, replacement: [`import { gadgetSchemaQueries } from "@/lib/gadget-schema";`, `import * as extra from "@/lib/extra-schema";`] },
      { from: 14, to: 14, replacement: [base.split("\n")[13], "    ...extra.queries(schemaName),"] },
    ]),
    readBaseFile: readLeafBase,
  });
  assert.equal(r.verdict, "fail");
  assert.ok(r.destructive.some((d) => d.rule === "ddl-leaf-unresolved"), JSON.stringify(r.destructive));

  // The unresolvable spread set itself never reports a LOCAL spread — the real
  // file's `...queries.filter(…)` composition must stay silent.
  assert.deepEqual([...unresolvedLeafSpreads(readFileSync(join(REPO_ROOT, IN_SCOPE_FILE), "utf8"))], []);
});

test("leaf: an unreadable leaf revision fails closed rather than waiving its DDL", () => {
  const r = runGate({
    diffText: fullReplaceDiff(LEAF_PATH, "old", "new"),
    // The store resolves the leaf, but the leaf's own base cannot be read.
    readBaseFile: (p) => (p === IN_SCOPE_FILE ? LEAF_SPREAD_STORE : null),
  });
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.destructive.map((d) => d.rule), ["ddl-leaf-unreadable"]);
});

test("the relocation pass never cancels WITHIN one file — an inline drop is unaffected", () => {
  // Same text removed and re-added in drizzle-store.ts under DIFFERENT tables:
  // stage 1 (exact key, table-scoped) refuses it and the cross-file pass must
  // not rescue it, because both lines share one origin.
  const r = runGate({
    diffText: multiHunkDiff(IN_SCOPE_FILE, LEAF_BASE_STORE, [
      { from: 11, to: 11, replacement: [] },
      {
        from: 14,
        to: 14,
        replacement: [
          `    { text: \`CREATE INDEX IF NOT EXISTS gadgets_label_idx ON ${INLINE_S}."gadgets" (label)\` },`,
          `    { text: \`CREATE TABLE IF NOT EXISTS ${INLINE_S}."doodads" (`,
          "      label text,",
          "    )` },",
        ],
      },
    ]),
    readBaseFile: readLeafBase,
  });
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.destructive.map((d) => d.rule), ["column-removed-from-ddl"]);
});
