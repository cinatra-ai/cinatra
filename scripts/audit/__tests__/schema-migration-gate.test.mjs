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
import { readFileSync } from "node:fs";
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
  IN_SCOPE_FILE,
  MIGRATION_MANIFEST_PATH,
} from "../schema-migration-gate.mjs";

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
  for (const needle of ["destructive, no artifact", "destructive, has artifact", "additive", "out of scope"]) {
    assert.ok(categories.includes(needle), `corpus must keep a "${needle}" fixture (have: ${categories})`);
  }
});

for (const fixture of corpus.fixtures) {
  test(`fixture ${fixture.file} → ${fixture.expect} (${fixture.category})`, () => {
    const diffPath = join(FIXTURES_DIR, fixture.file);

    // The corpus contract: fixtures apply cleanly to the current tree, which
    // is what lets --diff-file mode classify them against the working tree
    // as base. If this throws, the schema moved under the fixtures — refresh
    // them (see the corpus manifest _doc).
    execFileSync("git", ["apply", "--check", "--end-of-options", diffPath], { cwd: REPO_ROOT });

    const run = spawnSync(process.execPath, [GATE, "--diff-file", diffPath], { cwd: REPO_ROOT, encoding: "utf8" });
    const output = `${run.stdout}\n${run.stderr}`;
    if (fixture.expect === "pass") {
      assert.equal(run.status, 0, `expected pass (exit 0), got ${run.status}:\n${output}`);
    } else {
      assert.equal(run.status, 1, `expected fail (exit 1), got ${run.status}:\n${output}`);
      assert.match(run.stderr, /migration artifact/i, "fail output must tell the author what to ship");
      assert.match(run.stderr, /migrations\/README\.md/, "fail output must cite the convention");
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

test("artifact: runner module + appended manifest entry is complete", () => {
  const text =
    fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
    fullReplaceDiff(
      MIGRATION_MANIFEST_PATH,
      BASE_MANIFEST,
      manifestWith([ENTRY_0001, { seq: "0002", file: "core/core__0002_drop-widgets-label.mjs", summary: "drop", destructive: true, tables: ["widgets"] }]),
    );
  const a = detectMigrationArtifact(parseUnifiedDiff(text), readBase);
  assert.deepEqual(a.problems, []);
  assert.equal(a.complete, true);
  assert.equal(a.newEntries.length, 1);
});

test("artifact: a runner module without a manifest entry is incomplete (both pieces, same PR)", () => {
  const a = detectMigrationArtifact(
    parseUnifiedDiff(fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC)),
    readBase,
  );
  assert.equal(a.complete, false);
  assert.ok(a.problems.some((p) => p.includes("manifest")), a.problems.join("; "));
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

  const regressed = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff("migrations/core/core__0002_dupe.mjs", null, MODULE_0002_SRC) +
        fullReplaceDiff(
          MIGRATION_MANIFEST_PATH,
          BASE_MANIFEST,
          manifestWith([ENTRY_0001, { seq: "0001", file: "core/core__0002_dupe.mjs", summary: "dupe", destructive: true, tables: [] }]),
        ),
    ),
    readBase,
  );
  assert.ok(regressed.problems.some((p) => p.includes("strictly increasing")), regressed.problems.join("; "));
});

test("artifact: a manifest-only entry (no module in the diff) and a seq/filename mismatch are rejected", () => {
  const manifestOnly = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
        fullReplaceDiff(
          MIGRATION_MANIFEST_PATH,
          BASE_MANIFEST,
          manifestWith([
            ENTRY_0001,
            { seq: "0002", file: "core/core__0002_drop-widgets-label.mjs", summary: "x", destructive: false, tables: [] },
            { seq: "0003", file: "core/core__0003_phantom.mjs", summary: "phantom", destructive: true, tables: [] },
          ]),
        ),
    ),
    readBase,
  );
  assert.equal(manifestOnly.complete, false);
  assert.ok(manifestOnly.problems.some((p) => p.includes("no matching migrations/core/ module")), manifestOnly.problems.join("; "));

  const mismatched = detectMigrationArtifact(
    parseUnifiedDiff(
      fullReplaceDiff(MODULE_0002, null, MODULE_0002_SRC) +
        fullReplaceDiff(
          MIGRATION_MANIFEST_PATH,
          BASE_MANIFEST,
          manifestWith([ENTRY_0001, { seq: "0003", file: "core/core__0002_drop-widgets-label.mjs", summary: "x", destructive: true, tables: [] }]),
        ),
    ),
    readBase,
  );
  assert.ok(mismatched.problems.some((p) => p.includes("does not match its filename")), mismatched.problems.join("; "));
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

test("runGate fails a destructive change whose artifact entry is not labelled destructive", () => {
  const text =
    hunkDiff(IN_SCOPE_FILE, BASE, 21, 21, [
      `    { text: \`CREATE INDEX IF NOT EXISTS widgets_label_idx ON ${S}."widgets" (label)\` },`,
      `    { text: \`DROP TABLE IF EXISTS ${S}."widgets"\` },`,
    ]) +
    fullReplaceDiff("migrations/core/core__0002_drop-widgets.mjs", null, "export function up(pgm) { pgm.sql(`DROP TABLE IF EXISTS widgets;`); }\nexport function down(pgm) {}") +
    fullReplaceDiff(
      MIGRATION_MANIFEST_PATH,
      BASE_MANIFEST,
      manifestWith([ENTRY_0001, { seq: "0002", file: "core/core__0002_drop-widgets.mjs", summary: "drop", destructive: false, tables: ["widgets"] }]),
    );
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
