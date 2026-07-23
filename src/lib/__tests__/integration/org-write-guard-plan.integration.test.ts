/**
 * cinatra#1938 — CI-tier guard-plan proof: the guarded-batch refusal arm must
 * survive Postgres PLANNING. The planner constant-folds an inline
 * ('message')::int cast and raises it before any row is read — even for
 * allowed batches — so only a live planner can prove the guard's refusal
 * arm stays dormant until runtime. Read-only: EXPLAIN plus a rolled-back
 * transaction probing a nonexistent org id.
 *
 * Runs only under CINATRA_DB_INTEGRATION_TESTS=1 with a real SUPABASE_DB_URL
 * (the extension-lifecycle-db-tests CI job); self-skips otherwise.
 */
import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { guardQueryFor } from "@cinatra-ai/org-write-kernel";

const dbUrl = process.env.SUPABASE_DB_URL ?? "";
const enabled =
  process.env.CINATRA_DB_INTEGRATION_TESTS === "1" &&
  dbUrl !== "" &&
  !dbUrl.includes("unused:unused");

const NO_SUCH_ORG = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!enabled)("org-write guard on live Postgres (#1938)", () => {
  it("plans without raising, and refuses with the message only at runtime", async () => {
    const guard = guardQueryFor({
      orgId: NO_SUCH_ORG,
      capability: "content.write",
      authority: { orgId: NO_SUCH_ORG, can: () => true },
    });
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    try {
      // Planning must succeed: an inline constant refusal cast raises HERE
      // (EXPLAIN plans without executing), refusing even allowed batches.
      await client.query({ text: `EXPLAIN ${guard.text}`, values: guard.values });

      // Runtime refusal: nonexistent org → allow-subquery yields NULL → the
      // refusal arm reads the tx-local message and fails the cast with it.
      await client.query("BEGIN");
      try {
        await client.query({
          text: "SELECT set_config('cinatra.org_write_refusal', $1, true)",
          values: [
            "org-write-kernel refused: content.write not permitted for this organization's lifecycle state",
          ],
        });
        await expect(
          client.query({ text: guard.text, values: guard.values }),
        ).rejects.toThrow(/org-write-kernel refused: content\.write not permitted/);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      await client.end();
    }
  });
});
