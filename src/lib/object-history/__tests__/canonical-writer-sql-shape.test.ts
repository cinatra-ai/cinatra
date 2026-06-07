// Fixture test for the canonical writer's SQL shape.
//
// The cas_assert CTE must be on the OUTER side of the final LEFT JOIN so
// that Postgres is forced to evaluate it even when the write CTE returns
// zero rows.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WRITER_PATH = join(__dirname, "..", "canonical-writer.ts");

const SOURCE = readFileSync(WRITER_PATH, "utf8");

describe("canonical-writer SQL shape (DSUV-CAPTURE-02)", () => {
  it("ALL write CTE final selects use FROM cas_assert LEFT JOIN <alias>", () => {
    for (const alias of ["inserted", "updated", "deleted", "undeleted"]) {
      const goodPattern = new RegExp(`FROM cas_assert LEFT JOIN ${alias} ON TRUE`);
      const badPattern = new RegExp(`FROM ${alias}, cas_assert`);
      expect(SOURCE).toMatch(goodPattern);
      expect(SOURCE).not.toMatch(badPattern);
    }
  });

  it("cas_assert CTE divides by zero when the write alias is empty", () => {
    expect(SOURCE).toMatch(
      /SELECT 1 \/ CASE WHEN EXISTS \(SELECT 1 FROM inserted\) THEN 1 ELSE 0 END/,
    );
    expect(SOURCE).toMatch(
      /SELECT 1 \/ CASE WHEN EXISTS \(SELECT 1 FROM updated\) THEN 1 ELSE 0 END/,
    );
    expect(SOURCE).toMatch(
      /SELECT 1 \/ CASE WHEN EXISTS \(SELECT 1 FROM deleted\) THEN 1 ELSE 0 END/,
    );
    expect(SOURCE).toMatch(
      /SELECT 1 \/ CASE WHEN EXISTS \(SELECT 1 FROM undeleted\) THEN 1 ELSE 0 END/,
    );
  });

  it("UPDATE writers carry strict CAS in WHERE clause (DSUV-EVENT-02)", () => {
    // Parameter numbering has no $13/$14 reserved holes;
    // historyAwareUpsert CAS is at $32 and the soft-delete /
    // undelete CAS is at $2.
    expect(SOURCE).toMatch(/UPDATE [^]*WHERE id = \$1\s+AND version = \$32/);
    expect(SOURCE).toMatch(/WHERE id = \$1\s+AND version = \$2\s+AND \(org_id = \$3 OR \$3 IS NULL OR org_id IS NULL\)/);
  });

  // Regression guard. The Confirm-restore path surfaced "could not
  // determine data type of parameter $13":
  // buildCreateStatement + buildUpdateStatement skipped $13/$14 in the SQL
  // string while still binding `null, // $N reserved` in the values array.
  // Postgres cannot infer the type of an unreferenced/untyped null parameter
  // → query failed with a raw type-resolution error. The fix renumbered both
  // builders to remove the holes. These guards keep the hole from coming back.
  it("no `// $N reserved` placeholder holes in any builder (DSUV-CAPTURE-03, F3)", () => {
    expect(SOURCE).not.toMatch(/null,\s*\/\/\s*\$\d+\s+reserved/i);
    expect(SOURCE).not.toMatch(/\/\*\s*\$\d+\s+reserved\s*\*\//i);
  });

  it("buildCreateStatement + buildUpdateStatement bind exactly the parameters their SQL references (F3)", () => {
    // For each builder block ending in `values: [...]`, parse the `// $N` end-of-line
    // comments out of the values array, derive the binding range, then parse the
    // immediately-preceding SQL template literal for every `$N` reference. The two
    // sets must match exactly (i.e. no $N in values is unreferenced in SQL, and
    // no $N in SQL is unbound in values).
    const builderRegex =
      /function (buildCreateStatement|buildUpdateStatement)\b[\s\S]*?text:\s*`([\s\S]*?)`,\s*values:\s*\[([\s\S]*?)\],\s*\};\s*\}/g;
    let matchCount = 0;
    for (const match of SOURCE.matchAll(builderRegex)) {
      matchCount += 1;
      const [, name, sqlText, valuesBlock] = match;
      const sqlParams = new Set<number>();
      for (const m of sqlText.matchAll(/\$(\d+)/g)) sqlParams.add(Number(m[1]));
      const valueParams = new Set<number>();
      for (const m of valuesBlock.matchAll(/\/\/\s*\$(\d+)\b/g)) valueParams.add(Number(m[1]));
      // Every bound value must be referenced in SQL — this is the F3 invariant.
      for (const n of valueParams) {
        expect.soft(sqlParams.has(n), `${name}: $${n} bound but never referenced in SQL`).toBe(true);
      }
      // Every SQL reference must be bound in values — symmetric invariant
      // (excludes regex artifacts like `$1` inside a JSONPath literal — none expected here).
      for (const n of sqlParams) {
        expect.soft(valueParams.has(n), `${name}: $${n} referenced in SQL but never bound`).toBe(true);
      }
      // Binding indexes should be sequential 1..N with no gaps (defense in depth
      // against re-introducing reserved-hole layout). Allow $1..max being a
      // contiguous range, given the SQL+values match above.
      const sorted = [...valueParams].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        expect.soft(sorted[i], `${name}: expected sequential $${i + 1}, got $${sorted[i]} at index ${i}`).toBe(i + 1);
      }
    }
    expect(matchCount, "expected to match exactly buildCreateStatement + buildUpdateStatement").toBe(2);
  });

  it("CREATE writer uses ON CONFLICT DO NOTHING (create-only)", () => {
    expect(SOURCE).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it("event_row INSERT lives inside the same CTE chain as the object write", () => {
    // No post-update of event_checksum/before_snapshot allowed.
    expect(SOURCE).not.toMatch(/checksum-pending/);
    expect(SOURCE).not.toMatch(/UPDATE\s+"\$\{schema\}"\."object_change_event"/);
  });
});
