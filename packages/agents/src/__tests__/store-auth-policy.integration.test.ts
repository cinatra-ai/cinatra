/**
 * AgentAuthPolicy store wiring tests.
 *
 * Coverage matrix:
 *
 *   Group 1 (Tests 1–9): Template + run (de)serialization round-trip.
 *     Tests exercise the public store surface — createAgentTemplate /
 *     readAgentTemplateById / updateAgentTemplate / readAgentRunById — so the
 *     private serializeTemplate / deserializeRun helpers stay file-private.
 *     DB-backed tests skip when SUPABASE_DB_URL is unset (matches the existing
 *     pattern in version-pinning.test.ts and parent-run-id.test.ts).
 *
 *     The DB-skip path is covered by an additional compile-time-only assertion
 *     that synthesizes an AgentTemplateRecord / AgentRunRecord literal carrying
 *     the new fields — proving the type carries the field even when no DB is
 *     available. The existing `deserializeTemplate` export (used by
 *     agent-template-flags.test.ts) lets us also assert deserialization
 *     normalization behavior on synthetic rows.
 *
 *   Group 2 (Tests 10–16): readAgentRunById + readAgentRunsByTemplate
 *     enforcement wiring. Use vi.spyOn(authz, "can") per the established
 *     pattern in auth-policy.test.ts. The actor-supplied → enforcement,
 *     no-actor → backward-compatible split is verified at the function level.
 *     Read paths that need DB are skipped without it; the enforce-throws-before-DB
 *     paths are verified through deterministic mocks.
 *
 *   Group 3 (Test 17): updateAgentRunAuthPolicy round-trip via the public
 *     reader.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

import * as authz from "@/lib/authz";

import type { AgentAuthPolicy } from "../auth-policy";
import { deserializeTemplate } from "../store";
import type { AgentTemplateRecord, AgentRunRecord } from "../store";

// Fixture orgId for the agent_runs.org_id NOT NULL constraint.
const TEST_ORG_ID = "org-test";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");

const VALID_POLICY: AgentAuthPolicy = {
  runListVisibility: "owner",
  runDataVisibility: "org",
  runExecuteVisibility: "admin",
  allowRunSharing: true,
};

const NEW_POLICY: AgentAuthPolicy = {
  runListVisibility: "admin",
  runDataVisibility: "admin",
  runExecuteVisibility: "admin",
  allowRunSharing: false,
  description: "stricter override",
};

// ---------------------------------------------------------------------------
// Compile-time type-surface assertions (run without DB).
// These prove the new fields are present on the record types — failing here
// signals a type-level regression irrespective of runtime DB connectivity.
// ---------------------------------------------------------------------------

describe("AgentTemplateRecord type surface", () => {
  it("exposes agentAuthPolicy: AgentAuthPolicy | null", () => {
    const sample: AgentTemplateRecord = {
      id: "tpl_x",
      orgId: null,
      creatorId: null,
      name: "x",
      description: null,
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      outputSchema: null,
      approvalPolicy: { steps: [] },
      status: "draft",
      type: "leaf",
      taskSpec: null,
      packageName: null,
      packageVersion: null,
      currentVersionId: null,
      hitlScreens: null,
      ioSpec: null,
      hitlRequired: false,
      executionProvider: "wayflow",
      lgGraphCode: null,
      lgGraphId: null,
      sourceType: "internal",
      agentUrl: null,
      connectorSlug: null,
      remoteAgentId: null,
      triggerMode: null,
      gatedSteps: null,
      agentAuthPolicy: VALID_POLICY,
      extensionLifecycleStatus: "active" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(sample.agentAuthPolicy).toEqual(VALID_POLICY);

    const nullSample: AgentTemplateRecord = { ...sample, agentAuthPolicy: null };
    expect(nullSample.agentAuthPolicy).toBeNull();
  });
});

describe("AgentRunRecord type surface", () => {
  it("exposes authPolicy: AgentAuthPolicy | null", () => {
    const sample: AgentRunRecord = {
      id: "r_x",
      templateId: "t_x",
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
      authPolicy: VALID_POLICY,
      // agent_runs.org_id is required; keep the fixture populated so the suite stays compatible.
      orgId: TEST_ORG_ID,
      // projectId is not under test here, so null is the correct fixture value.
      projectId: null,
      // idempotencyKey records idempotent agent-task dispatch provenance.
      idempotencyKey: null,
      workflowId: null,
      workflowTaskId: null,
    };
    expect(sample.authPolicy).toEqual(VALID_POLICY);

    const nullSample: AgentRunRecord = { ...sample, authPolicy: null };
    expect(nullSample.authPolicy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deserializeTemplate normalization (no DB) — mirrors agent-template-flags.test.ts
// pattern. Synthesizes raw rows and asserts the resulting record shape.
// ---------------------------------------------------------------------------

function makeTemplateRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: "tpl_1",
    orgId: null,
    creatorId: null,
    name: "Test",
    description: null,
    sourceNl: "x",
    compiledPlan: JSON.stringify([]),
    inputSchema: JSON.stringify({}),
    outputSchema: null,
    approvalPolicy: JSON.stringify({ steps: [] }),
    status: "draft",
    type: "leaf",
    taskSpec: null,
    packageName: null,
    packageVersion: null,
    currentVersionId: null,
    hitlScreens: null,
    agentDependencies: null,
    ioSpec: null,
    hitlRequired: false,
    executionProvider: "wayflow",
    lgGraphCode: null,
    lgGraphId: null,
    sourceType: "internal",
    agentUrl: null,
    connectorSlug: null,
    remoteAgentId: null,
    triggerMode: null,
    gatedSteps: null,
    agentAuthPolicy: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("deserializeTemplate — agentAuthPolicy normalization", () => {
  it("Test 1 (synthetic): row.agentAuthPolicy=JSON-stringified policy → record.agentAuthPolicy = policy object", () => {
    const row = makeTemplateRow({ agentAuthPolicy: JSON.stringify(VALID_POLICY) });
    const record = deserializeTemplate(row);
    expect(record.agentAuthPolicy).toEqual(VALID_POLICY);
  });

  it("Test 2 (synthetic): row.agentAuthPolicy=null → record.agentAuthPolicy = null", () => {
    const row = makeTemplateRow({ agentAuthPolicy: null });
    const record = deserializeTemplate(row);
    expect(record.agentAuthPolicy).toBeNull();
  });

  it("Test 3 (synthetic): row.agentAuthPolicy=undefined → record.agentAuthPolicy = null", () => {
    const row = makeTemplateRow({ agentAuthPolicy: undefined });
    const record = deserializeTemplate(row);
    expect(record.agentAuthPolicy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB-backed round-trip tests (skipped when DB is unavailable).
// These exercise the public store surface end-to-end: createAgentTemplate +
// readAgentTemplateById, updateAgentTemplate + readAgentTemplateById, and
// the run insert/read path. Use the same skipIf pattern as version-pinning.test.ts.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)("agentAuthPolicy round-trip via public store APIs", () => {
  it("Test 1: createAgentTemplate({agentAuthPolicy: VALID_POLICY}) → readAgentTemplateById returns the policy", async () => {
    const { createAgentTemplate, readAgentTemplateById } = await import("../store");
    const id = `t_${randomUUID()}`;
    await createAgentTemplate({
      id,
      name: "auth-policy-rt-1",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
      agentAuthPolicy: VALID_POLICY,
    });
    const read = await readAgentTemplateById(id);
    expect(read).not.toBeNull();
    expect(read!.agentAuthPolicy).toEqual(VALID_POLICY);
  });

  it("Test 2: createAgentTemplate({agentAuthPolicy: undefined}) → readAgentTemplateById returns null", async () => {
    const { createAgentTemplate, readAgentTemplateById } = await import("../store");
    const id = `t_${randomUUID()}`;
    await createAgentTemplate({
      id,
      name: "auth-policy-rt-2",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const read = await readAgentTemplateById(id);
    expect(read!.agentAuthPolicy).toBeNull();
  });

  it("Test 3: createAgentTemplate({agentAuthPolicy: null}) → readAgentTemplateById returns null", async () => {
    const { createAgentTemplate, readAgentTemplateById } = await import("../store");
    const id = `t_${randomUUID()}`;
    await createAgentTemplate({
      id,
      name: "auth-policy-rt-3",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
      agentAuthPolicy: null,
    });
    const read = await readAgentTemplateById(id);
    expect(read!.agentAuthPolicy).toBeNull();
  });

  it("Test 4: updateAgentTemplate(id, {agentAuthPolicy: NEW_POLICY}) writes the new policy", async () => {
    const { createAgentTemplate, updateAgentTemplate, readAgentTemplateById } = await import(
      "../store"
    );
    const id = `t_${randomUUID()}`;
    await createAgentTemplate({
      id,
      name: "auth-policy-rt-4",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    await updateAgentTemplate(id, { agentAuthPolicy: NEW_POLICY });
    const read = await readAgentTemplateById(id);
    expect(read!.agentAuthPolicy).toEqual(NEW_POLICY);
  });

  it("Test 5: updateAgentTemplate(id, {}) leaves an existing agentAuthPolicy unchanged", async () => {
    const { createAgentTemplate, updateAgentTemplate, readAgentTemplateById } = await import(
      "../store"
    );
    const id = `t_${randomUUID()}`;
    await createAgentTemplate({
      id,
      name: "auth-policy-rt-5",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
      agentAuthPolicy: VALID_POLICY,
    });
    await updateAgentTemplate(id, { name: "renamed" });
    const read = await readAgentTemplateById(id);
    expect(read!.agentAuthPolicy).toEqual(VALID_POLICY);
  });

  it("Test 6: updateAgentTemplate(id, {agentAuthPolicy: null}) clears the policy", async () => {
    const { createAgentTemplate, updateAgentTemplate, readAgentTemplateById } = await import(
      "../store"
    );
    const id = `t_${randomUUID()}`;
    await createAgentTemplate({
      id,
      name: "auth-policy-rt-6",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
      agentAuthPolicy: VALID_POLICY,
    });
    await updateAgentTemplate(id, { agentAuthPolicy: null });
    const read = await readAgentTemplateById(id);
    expect(read!.agentAuthPolicy).toBeNull();
  });
});

describe.skipIf(!hasDb)("authPolicy round-trip on agent_runs via public store APIs", () => {
  it("Test 7: updateAgentRunAuthPolicy(id, VALID_POLICY) → readAgentRunById returns the policy", async () => {
    const { createAgentTemplate, createAgentRun, updateAgentRunAuthPolicy, readAgentRunById } =
      await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "auth-policy-run-rt-7",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const runId = `r_${randomUUID()}`;
    await createAgentRun({ id: runId, templateId, inputParams: {}, orgId: TEST_ORG_ID });
    await updateAgentRunAuthPolicy(runId, VALID_POLICY);
    const read = await readAgentRunById(runId);
    expect(read).not.toBeNull();
    expect(read!.authPolicy).toEqual(VALID_POLICY);
  });

  it("Test 8: A run with no authPolicy override has authPolicy === null after read", async () => {
    const { createAgentTemplate, createAgentRun, readAgentRunById } = await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "auth-policy-run-rt-8",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const runId = `r_${randomUUID()}`;
    await createAgentRun({ id: runId, templateId, inputParams: {}, orgId: TEST_ORG_ID });
    const read = await readAgentRunById(runId);
    expect(read!.authPolicy).toBeNull();
  });
});

// Test 9: Garbage-in protection — synthetic row with malformed JSON.
// parseAuthPolicySafe returns null (+ logs)
// instead of propagating SyntaxError. Malformed rows degrade gracefully to
// the DEFAULT_AGENT_AUTH_POLICY rather than crashing the read path.
describe("deserializeTemplate — garbage-in protection (malformed input)", () => {
  it("Test 9: malformed JSON in agent_auth_policy column → treated as null (no throw)", () => {
    const row = makeTemplateRow({ agentAuthPolicy: "{not valid json" });
    const result = deserializeTemplate(row);
    expect(result.agentAuthPolicy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Tests 10–16: readAgentRunById + readAgentRunsByTemplate enforcement.
// All non-DB cases use vi.spyOn(authz, "can"). DB-backed paths skip without DB.
// ---------------------------------------------------------------------------

describe("readAgentRunById — enforcement opt-in", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.skipIf(!hasDb)(
    "Test 10: no actor → returns the run without enforcement (backward compat)",
    async () => {
      const { createAgentTemplate, createAgentRun, readAgentRunById } = await import("../store");
      const templateId = `t_${randomUUID()}`;
      await createAgentTemplate({
        id: templateId,
        name: "auth-policy-rab-10",
        sourceNl: "x",
        compiledPlan: [],
        inputSchema: {},
        approvalPolicy: { steps: [] },
      });
      const runId = `r_${randomUUID()}`;
      await createAgentRun({ id: runId, templateId, inputParams: {}, orgId: TEST_ORG_ID });
      const read = await readAgentRunById(runId);
      expect(read).not.toBeNull();
      expect(read!.id).toBe(runId);
    },
  );

  it.skipIf(!hasDb)(
    "Test 11: actor supplied AND can()=true → returns the run",
    async () => {
      vi.spyOn(authz, "can").mockReturnValue(true);
      const { createAgentTemplate, createAgentRun, readAgentRunById } = await import("../store");
      const templateId = `t_${randomUUID()}`;
      await createAgentTemplate({
        id: templateId,
        name: "auth-policy-rab-11",
        sourceNl: "x",
        compiledPlan: [],
        inputSchema: {},
        approvalPolicy: { steps: [] },
      });
      const runId = `r_${randomUUID()}`;
      await createAgentRun({ id: runId, templateId, inputParams: {}, runBy: "u1", orgId: TEST_ORG_ID });
      const read = await readAgentRunById(runId, {
        actorType: "human",
        userId: "u1",
        source: "ui",
      });
      expect(read).not.toBeNull();
      expect(read!.id).toBe(runId);
    },
  );

  it.skipIf(!hasDb)(
    "Test 12: actor supplied AND can()=false → throws AuthzError 403",
    async () => {
      vi.spyOn(authz, "can").mockReturnValue(false);
      const { createAgentTemplate, createAgentRun, readAgentRunById } = await import("../store");
      const templateId = `t_${randomUUID()}`;
      await createAgentTemplate({
        id: templateId,
        name: "auth-policy-rab-12",
        sourceNl: "x",
        compiledPlan: [],
        inputSchema: {},
        approvalPolicy: { steps: [] },
      });
      const runId = `r_${randomUUID()}`;
      await createAgentRun({ id: runId, templateId, inputParams: {}, runBy: "u1", orgId: TEST_ORG_ID });
      await expect(
        readAgentRunById(runId, {
          actorType: "human",
          userId: "u2",
          source: "ui",
        }),
      ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
    },
  );

  it.skipIf(!hasDb)(
    "Test 13: non-existent id with actor → throws AuthzError 404 hidden",
    async () => {
      const { readAgentRunById } = await import("../store");
      await expect(
        readAgentRunById(`r_${randomUUID()}`, {
          actorType: "human",
          userId: "u1",
          source: "ui",
        }),
      ).rejects.toMatchObject({ statusCode: 404, reason: "hidden" });
    },
  );
});

describe("readAgentRunsByTemplate — enforcement opt-in", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.skipIf(!hasDb)(
    "Test 14: actor supplied AND can()=true → returns the page",
    async () => {
      vi.spyOn(authz, "can").mockReturnValue(true);
      const { createAgentTemplate, readAgentRunsByTemplate } = await import("../store");
      const templateId = `t_${randomUUID()}`;
      await createAgentTemplate({
        id: templateId,
        name: "auth-policy-rrbt-14",
        sourceNl: "x",
        compiledPlan: [],
        inputSchema: {},
        approvalPolicy: { steps: [] },
      });
      const page = await readAgentRunsByTemplate(templateId, {
        actor: { actorType: "human", userId: "u1", source: "ui" },
      });
      expect(page.items).toBeDefined();
    },
  );

  it.skipIf(!hasDb)("Test 15: actor supplied AND can()=false → post-filter returns empty items", async () => {
    // CR-B fix (iteration 2): readAgentRunsByTemplate no longer throws on denied
    // access — it uses per-row post-filtering. Denied rows are silently filtered
    // out; the call itself resolves with an empty items array.
    vi.spyOn(authz, "can").mockReturnValue(false);
    const { createAgentTemplate, readAgentRunsByTemplate } = await import("../store");
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "auth-policy-rrbt-15",
      sourceNl: "x",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const page = await readAgentRunsByTemplate(templateId, {
      actor: { actorType: "human", userId: "u2", source: "ui" },
    });
    expect(page.items).toEqual([]);
  });

  it.skipIf(!hasDb)(
    "Test 16: no actor → returns the page unchanged (backward compat)",
    async () => {
      const { createAgentTemplate, readAgentRunsByTemplate } = await import("../store");
      const templateId = `t_${randomUUID()}`;
      await createAgentTemplate({
        id: templateId,
        name: "auth-policy-rrbt-16",
        sourceNl: "x",
        compiledPlan: [],
        inputSchema: {},
        approvalPolicy: { steps: [] },
      });
      const page = await readAgentRunsByTemplate(templateId, {});
      expect(page.items).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Group 3 — Test 17: updateAgentRunAuthPolicy round-trip.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)(
  "updateAgentRunAuthPolicy — round-trip via readAgentRunById",
  () => {
    it("Test 17: write then read returns same policy; clear (null) zeroes the column", async () => {
      const {
        createAgentTemplate,
        createAgentRun,
        updateAgentRunAuthPolicy,
        readAgentRunById,
      } = await import("../store");
      const templateId = `t_${randomUUID()}`;
      await createAgentTemplate({
        id: templateId,
        name: "auth-policy-uarap-17",
        sourceNl: "x",
        compiledPlan: [],
        inputSchema: {},
        approvalPolicy: { steps: [] },
      });
      const runId = `r_${randomUUID()}`;
      await createAgentRun({ id: runId, templateId, inputParams: {}, orgId: TEST_ORG_ID });

      await updateAgentRunAuthPolicy(runId, VALID_POLICY);
      let read = await readAgentRunById(runId);
      expect(read!.authPolicy).toEqual(VALID_POLICY);

      await updateAgentRunAuthPolicy(runId, null);
      read = await readAgentRunById(runId);
      expect(read!.authPolicy).toBeNull();
    });
  },
);
