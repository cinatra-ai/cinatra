/**
 * packageVersion roundtrip on agent_runs.
 *
 * Validates:
 *   - createAgentRun({ packageVersion: "1.2.3" }) persists the value
 *   - readAgentRunById returns a record carrying packageVersion
 *   - Omitted packageVersion serializes to null
 *   - AgentRunRecord TypeScript type includes `packageVersion: string | null`
 *
 * Skipped when SUPABASE_DB_URL is unset — the package's other tests (mcp-contract,
 * compile-smoke, ref-resolver) are pure and do not require a DB. This file
 * intentionally touches the real store and so gates on a real connection.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { AgentRunRecord, CreateAgentRunInput } from "../store";

// Fixture orgId so the NOT NULL DDL does not break this suite.
const TEST_ORG_ID = "org-test";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string"
  && dbUrl.length > 0
  && !dbUrl.includes("unused:unused@localhost:5432/unused"); // align with parent-run-id.test.ts:21 and AGENTS.md

describe.skipIf(!hasDb)("agent_runs.packageVersion roundtrip", () => {
  it("persists packageVersion when provided", async () => {
    const { createAgentRun, readAgentRunById, createAgentTemplate } = await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "test-version-pinning",
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const runId = `r_${randomUUID()}`;
    const input: CreateAgentRunInput = {
      id: runId,
      templateId,
      inputParams: {},
      packageVersion: "1.2.3",
      orgId: TEST_ORG_ID,
    };
    const created = await createAgentRun(input);
    expect(created.packageVersion).toBe("1.2.3");

    const reread = await readAgentRunById(runId);
    expect(reread).not.toBeNull();
    expect(reread!.packageVersion).toBe("1.2.3");
  });

  it("returns null packageVersion when omitted", async () => {
    const { createAgentRun, readAgentRunById, createAgentTemplate } = await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "test-version-pinning-null",
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const runId = `r_${randomUUID()}`;
    const created = await createAgentRun({ id: runId, templateId, inputParams: {}, orgId: TEST_ORG_ID });
    expect(created.packageVersion).toBeNull();

    const reread = await readAgentRunById(runId);
    expect(reread!.packageVersion).toBeNull();
  });
});

// Compile-time-only assertion (runs without DB) — verifies AgentRunRecord carries the field.
describe("AgentRunRecord type surface", () => {
  it("exposes packageVersion: string | null", () => {
    const sample: AgentRunRecord = {
      id: "x",
      templateId: "t",
      versionId: null,
      runBy: null,
      status: "queued",
      inputParams: {},
      stepResults: null,
      startedAt: null,
      completedAt: null,
      error: null,
      title: null,
      createdAt: new Date(),
      sourceType: "agent_builder",
      sourceId: null,
      packageVersion: null,
      a2aTaskId: null,
      a2aContextId: null,
      parentRunId: null,
      agUiEnabled: null,
      lgThreadId: null,
      traceId: null,
      timeoutSeconds: null,
      streamedText: null,
      // Per-run AgentAuthPolicy override (null = inherit).
      authPolicy: null,
      // org id is required (non-null) on every new run.
      orgId: TEST_ORG_ID,
      // projectId is present on AgentRunRecord; null is the correct fixture value because project scoping is not under test here.
      projectId: null,
      // Idempotent agent-task dispatch provenance.
      idempotencyKey: null,
      workflowId: null,
      workflowTaskId: null,
    };
    expect(sample.packageVersion).toBeNull();

    const pinned: AgentRunRecord = { ...sample, packageVersion: "2.0.1" };
    expect(pinned.packageVersion).toBe("2.0.1");
  });
});
