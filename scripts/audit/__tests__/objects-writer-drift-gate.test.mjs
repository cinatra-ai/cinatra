// Fixture tests for the canonical-writer drift gate.
//
// Validates the regex shape: the gate must catch real DML against
// cinatra.objects without false-positives on identifier collisions like
// `objectsUpdateSchema`.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We exercise the gate by writing tiny test files into a synthetic
// directory tree and running the gate via `node` against it. Because
// the gate enumerates via `git ls-files`, it ignores files outside the
// repo — so instead we exercise it by running it against the repo
// itself and asserting the current tree is clean. The fixture tests
// validate the regex patterns directly.

function lineMatchesObjectsDml(line) {
  // Replicate the gate's logic at the JS level so we can fixture-test
  // it without spawning a child process. Keep in sync with
  // scripts/audit/objects-writer-drift-gate.mjs.
  const TABLE_TOKENS = [/"objects"/, /\."objects"/];
  const DML_PATTERNS = [
    { label: "INSERT INTO", re: /\bINSERT\s+INTO\b/i },
    { label: "UPDATE", re: /\bUPDATE\s+["`]/i },
    { label: "DELETE FROM", re: /\bDELETE\s+FROM\b/i },
  ];
  for (const { re } of DML_PATTERNS) {
    if (!re.test(line)) continue;
    for (const tokenRe of TABLE_TOKENS) {
      if (tokenRe.test(line)) return true;
    }
  }
  return false;
}

describe("objects-writer-drift-gate matcher", () => {
  it("catches a quoted UPDATE against cinatra.objects", () => {
    expect(
      lineMatchesObjectsDml(
        'text: `UPDATE "${schema}"."objects" SET data = $1 WHERE id = $2`',
      ),
    ).toBe(true);
  });

  it("catches schema-qualified UPDATE", () => {
    expect(
      lineMatchesObjectsDml(
        '`UPDATE "${q()}"."objects" SET deleted_at = now()`',
      ),
    ).toBe(true);
  });

  it("catches INSERT INTO ... objects", () => {
    expect(
      lineMatchesObjectsDml(
        'INSERT INTO "${schema}"."objects" (id, type, data) VALUES ($1, $2, $3)',
      ),
    ).toBe(true);
  });

  it("does NOT match identifier collisions like objectsUpdateSchema", () => {
    expect(
      lineMatchesObjectsDml(
        '"objects_update": { description: "Update an object", inputSchema: schemas.objectsUpdateSchema }',
      ),
    ).toBe(false);
  });

  it("does NOT match Zod schema references with UPDATE in their name", () => {
    expect(
      lineMatchesObjectsDml("const input = schemas.objectsUpdateSchema.parse(request.input);"),
    ).toBe(false);
  });

  it("does NOT match SELECT statements", () => {
    expect(
      lineMatchesObjectsDml(
        'text: `SELECT id, type, data FROM "${schema}"."objects" WHERE id = $1`',
      ),
    ).toBe(false);
  });

  it("does NOT match the 'objects' word in a comment", () => {
    expect(
      lineMatchesObjectsDml('// upserts a row into the objects table'),
    ).toBe(false);
  });

  it("catches DELETE FROM ... objects", () => {
    expect(
      lineMatchesObjectsDml('DELETE FROM "${schema}"."objects" WHERE id = $1'),
    ).toBe(true);
  });
});

describe("objects-writer-drift-gate executes cleanly on current tree", () => {
  it("exits 0 against the current repo", () => {
    const result = spawnSync("node", [
      "scripts/audit/objects-writer-drift-gate.mjs",
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});
