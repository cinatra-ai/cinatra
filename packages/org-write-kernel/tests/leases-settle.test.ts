/**
 * cinatra#1940 P1 (Decision 4) — the per-run lease SETTLE shapes.
 *
 * `settleLeaseForRunStatement` (callback/drizzle world) and
 * `settleLeaseForRunQuery` ({text, values} fixed-batch world) both DELETE every
 * lease a run holds, keyed by (org_id, run_id) and deliberately EPOCH-AGNOSTIC —
 * so a terminal landing settles all of a run's windows across epochs in one
 * shot. No live DB: we assert the emitted SQL shape and schema safety.
 */
import { describe, it, expect } from "vitest";
import {
  settleLeaseForRunStatement,
  settleLeaseForRunQuery,
  ORG_ARCHIVE_LEASE_TABLE,
} from "../src/index";

/** Serialize a drizzle SQL object to plain text for content matching — the same
 *  approach the kernel's own testing helper uses. */
function sqlText(query: unknown): string {
  return JSON.stringify(query)?.replaceAll('\\"', '"') ?? "";
}

const KEY = { schema: "cinatra", orgId: "org-1", runId: "run-9" };

describe("settleLeaseForRunQuery ({text, values})", () => {
  it("is a per-run, epoch-agnostic DELETE with positional params", () => {
    const q = settleLeaseForRunQuery(KEY);
    expect(q.text).toBe(
      `DELETE FROM "cinatra"."${ORG_ARCHIVE_LEASE_TABLE}"` +
        ` WHERE org_id = $1 AND run_id = $2`,
    );
    expect(q.values).toEqual(["org-1", "run-9"]);
    // Epoch-agnostic by design (Decision 4): NEVER scoped by archive_epoch.
    expect(q.text).not.toContain("archive_epoch");
    expect(q.text).not.toContain("$3");
  });

  it("rejects an unsafe schema name (SQL-safety, fail-closed)", () => {
    expect(() => settleLeaseForRunQuery({ ...KEY, schema: "bad-schema; DROP" })).toThrow(
      /unsafe schema name/,
    );
  });
});

describe("settleLeaseForRunStatement (drizzle SQL)", () => {
  it("emits a per-run, epoch-agnostic DELETE against the lease table", () => {
    const text = sqlText(settleLeaseForRunStatement(KEY));
    expect(text).toContain("DELETE FROM");
    expect(text).toContain(ORG_ARCHIVE_LEASE_TABLE);
    expect(text).toContain("org_id");
    expect(text).toContain("run_id");
    // Epoch-agnostic: the per-run settle never references the epoch column.
    expect(text).not.toContain("archive_epoch");
  });

  it("rejects an unsafe schema name (SQL-safety, fail-closed)", () => {
    expect(() =>
      settleLeaseForRunStatement({ ...KEY, schema: 'evil"; DROP TABLE x' }),
    ).toThrow(/unsafe schema name/);
  });
});
