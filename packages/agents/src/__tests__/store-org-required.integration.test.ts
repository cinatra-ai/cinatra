/**
 * Regression coverage for the `createAgentRun` org ownership invariant.
 *
 * Asserts that `createAgentRun` requires a non-null `orgId` on insert:
 *
 *   - `CreateAgentRunInput.orgId` is a required `string`.
 *   - `agent_runs.org_id` is `NOT NULL`.
 *
 * The store must reject undefined / null rather than writing NULL. The
 * positive roundtrip cases lock the no-regression invariant.
 *
 * DB-gated tests skip when `SUPABASE_DB_URL` is unset (matches the pattern
 * established in version-pinning.test.ts and store-auth-policy.test.ts).
 *
 * NO BACKWARD COMPATIBILITY. Cinatra is PoC. The store MUST reject
 * `undefined` / `null` outright.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { CreateAgentRunInput } from "../store";

const TEST_ORG_ID = "org-test";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string"
  && dbUrl.length > 0
  && !dbUrl.includes("unused:unused@localhost:5432/unused");

describe.skipIf(!hasDb)("createAgentRun - orgId required", () => {
  it("rejects when orgId is undefined", async () => {
    const { createAgentRun, createAgentTemplate } = await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "test-org-required-undefined",
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const runId = `r_${randomUUID()}`;
    // orgId intentionally omitted - this MUST throw because
    // CreateAgentRunInput.orgId is a required string and the column is NOT NULL.
    let thrown: unknown = null;
    try {
      await createAgentRun({
        id: runId,
        templateId,
        inputParams: {},
        // no orgId
      } as CreateAgentRunInput);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
  });

  it("rejects when orgId is null", async () => {
    const { createAgentRun, createAgentTemplate } = await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "test-org-required-null",
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const runId = `r_${randomUUID()}`;
    let thrown: unknown = null;
    try {
      await createAgentRun({
        id: runId,
        templateId,
        inputParams: {},
        // Pass an explicit null via an unknown-cast to defeat the static check
        // and exercise the runtime PG NOT NULL constraint - this row insert
        // MUST throw.
        orgId: null,
      } as unknown as CreateAgentRunInput);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
  });

  it("accepts orgId and roundtrips it", async () => {
    const { createAgentRun, readAgentRunById, createAgentTemplate } = await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "test-org-required-roundtrip",
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const runId = `r_${randomUUID()}`;
    const created = await createAgentRun({
      id: runId,
      templateId,
      inputParams: {},
      orgId: TEST_ORG_ID,
    });
    expect(created.orgId).toBe(TEST_ORG_ID);

    const reread = await readAgentRunById(runId);
    expect(reread).not.toBeNull();
    expect(reread!.orgId).toBe(TEST_ORG_ID);
  });

  it("readAgentRunById returns the same orgId that was inserted", async () => {
    // This locks the column-level invariant: non-null inserts are unaffected by
    // the NOT NULL constraint and must keep roundtripping through reads.
    const { createAgentRun, readAgentRunById, createAgentTemplate } = await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "test-org-required-roundtrip-2",
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const runId = `r_${randomUUID()}`;
    const orgId = `${TEST_ORG_ID}-${randomUUID().slice(0, 8)}`;
    await createAgentRun({
      id: runId,
      templateId,
      inputParams: {},
      orgId,
    });
    const reread = await readAgentRunById(runId);
    expect(reread).not.toBeNull();
    expect(reread!.orgId).toBe(orgId);
  });
});
