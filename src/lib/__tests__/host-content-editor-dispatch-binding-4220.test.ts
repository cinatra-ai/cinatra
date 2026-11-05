// cinatra#4220 — the two OBO-carrier run kinds the host content-editor dispatch
// creates (`content_editor_dispatch` and `public_site_widget`) bind themselves to
// their connector instance through the SAME host derivation the worker dispatch
// runs, from the carrier run's OWN start input `instanceId`, and record that
// binding write-once BEFORE the run token is minted and before the A2A client
// is opened or anything is sent. A refused derivation fails the still-queued
// carrier run with the gate's reason and sends nothing. No `instanceId`: no
// derivation, behavior unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- A2A + LLM runtime edges -------------------------------------------------
const sendTask = vi.fn();
const createExternalA2AClient = vi.fn(async () => ({ sendTask }));
const buildA2aBearerToken = vi.fn(async () => "bearer-token");
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: (...a: unknown[]) => createExternalA2AClient(...(a as [])),
}));
vi.mock("@cinatra-ai/llm", () => ({
  buildA2aBearerToken: (...a: unknown[]) => buildA2aBearerToken(...(a as [])),
}));

// --- agents store + coordinator ----------------------------------------------
const createCarrierRun = vi.fn<(input: { id: string }, authority?: unknown) => Promise<unknown>>();
vi.mock("@cinatra-ai/agents/lifecycle-coordinator", () => ({
  launchAgentRun: async (launch: { create: { input: { id: string } }; authority?: unknown }) => ({
    carrier: { kind: "run", run: await createCarrierRun(launch.create.input, launch.authority) },
    status: "queued",
    moment: null,
  }),
}));

const buildInitialMessagePayloadWithRunToken = vi.fn(
  async (inputParams: Record<string, unknown> | null | undefined, runId: string) => ({
    ...(inputParams ?? {}),
    cinatra_run_id: runId,
    __cinatra_run_token__: `raw-token-for-${runId}`,
  }),
);
const readAgentTemplateByPackageName = vi.fn<(pkg: string) => Promise<unknown>>();
const readLatestAgentVersionIdForTemplate = vi.fn<(id: string) => Promise<unknown>>();
const transitionRunStatus = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const setAgentRunConnectorInstanceBinding = vi.fn<(runId: string, binding: unknown) => Promise<void>>(
  async () => {},
);
vi.mock("@cinatra-ai/agents", () => ({
  buildInitialMessagePayloadWithRunToken: (inputParams: Record<string, unknown> | null | undefined, runId: string) =>
    buildInitialMessagePayloadWithRunToken(inputParams, runId),
  readAgentTemplateByPackageName: (pkg: string) => readAgentTemplateByPackageName(pkg),
  readLatestAgentVersionIdForTemplate: (id: string) => readLatestAgentVersionIdForTemplate(id),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
  setAgentRunConnectorInstanceBinding: (runId: string, binding: unknown) =>
    setAgentRunConnectorInstanceBinding(runId, binding),
}));

// --- the host derivation (its gates are pinned by agent-run-connector-instance-pin-4220.test.ts)
const deriveAgentRunConnectorInstanceBinding = vi.fn<(input: unknown) => Promise<unknown>>();
vi.mock("@/lib/connector-instance-write-authority", () => ({
  deriveAgentRunConnectorInstanceBinding: (input: unknown) => deriveAgentRunConnectorInstanceBinding(input),
}));

// --- identity seams -----------------------------------------------------------
const resolveContentEditorIdentityForInstance = vi.fn();
vi.mock("@/lib/content-editor-run-identity", () => ({
  resolveContentEditorIdentityForInstance: (...a: unknown[]) => resolveContentEditorIdentityForInstance(...a),
}));
vi.mock("@/lib/widget-actor-frame", () => ({ resolveWidgetActorFromFrame: () => null }));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser: vi.fn(async () => "member") }));

import { dispatchContentEditorViaA2A } from "@/lib/host-content-editor-dispatch";

const OVERRIDE = {
  runBy: "user-77",
  orgId: "org-9",
  instanceId: "site-1",
  sourceType: "public_site_widget" as const,
};

type Kind = "content_editor_dispatch" | "public_site_widget";
const KINDS: Array<{ kind: Kind; runBy: string; orgId: string; instanceId: string }> = [
  { kind: "content_editor_dispatch", runBy: "u_admin", orgId: "org_1", instanceId: "wp1" },
  { kind: "public_site_widget", runBy: OVERRIDE.runBy, orgId: OVERRIDE.orgId, instanceId: OVERRIDE.instanceId },
];

function dispatchFor(kind: Kind, payload: Record<string, unknown>) {
  return dispatchContentEditorViaA2A({
    agentUrl: "http://agent",
    payload,
    timeoutMs: 1000,
    packageName: "@cinatra-ai/wordpress-agent",
    ...(kind === "public_site_widget" ? { actorOverride: OVERRIDE } : {}),
  });
}

function createdRunId(): string {
  return (createCarrierRun.mock.calls[0][0] as { id: string }).id;
}

beforeEach(() => {
  vi.clearAllMocks();
  buildA2aBearerToken.mockResolvedValue("bearer-token");
  createExternalA2AClient.mockResolvedValue({ sendTask });
  resolveContentEditorIdentityForInstance.mockResolvedValue({ orgId: "org_1", runBy: "u_admin" });
  readAgentTemplateByPackageName.mockResolvedValue({ id: "tmpl_wp" });
  readLatestAgentVersionIdForTemplate.mockResolvedValue("ver_1");
  createCarrierRun.mockImplementation(async (input: { id: string }) => ({ id: input.id, inputParams: {} }));
  sendTask.mockResolvedValue({
    history: [{ role: "agent", parts: [{ kind: "text", text: '{"postId":"7"}' }] }],
  });
});
afterEach(() => vi.clearAllMocks());

describe("cinatra#4220 — carrier runs carry their connector-instance binding", () => {
  for (const k of KINDS) {
    it(`${k.kind}: derives from the carrier run's own start input and records it before the token, the client and the send`, async () => {
      const payload = { instanceId: k.instanceId, postId: "7" };
      const binding = { connectorKey: "wordpress", instanceId: k.instanceId };
      deriveAgentRunConnectorInstanceBinding.mockResolvedValue(binding);

      await dispatchFor(k.kind, payload);

      expect(createCarrierRun).toHaveBeenCalledTimes(1);
      expect((createCarrierRun.mock.calls[0][0] as { sourceType?: string }).sourceType).toBe(k.kind);
      const runId = createdRunId();
      expect(deriveAgentRunConnectorInstanceBinding).toHaveBeenCalledTimes(1);
      expect(deriveAgentRunConnectorInstanceBinding).toHaveBeenCalledWith({
        runId,
        runBy: k.runBy,
        orgId: k.orgId,
        inputParams: payload,
      });
      expect(setAgentRunConnectorInstanceBinding).toHaveBeenCalledTimes(1);
      expect(setAgentRunConnectorInstanceBinding).toHaveBeenCalledWith(runId, binding);
      const recordedAt = setAgentRunConnectorInstanceBinding.mock.invocationCallOrder[0];
      expect(recordedAt).toBeLessThan(buildInitialMessagePayloadWithRunToken.mock.invocationCallOrder[0]);
      expect(recordedAt).toBeLessThan(createExternalA2AClient.mock.invocationCallOrder[0]);
      expect(recordedAt).toBeLessThan(sendTask.mock.invocationCallOrder[0]);
    });

    it(`${k.kind}: a refused derivation fails the queued carrier run with the gate's reason and sends nothing`, async () => {
      deriveAgentRunConnectorInstanceBinding.mockRejectedValue(
        new Error("connector instance write denied: instance_org_mismatch"),
      );

      await expect(dispatchFor(k.kind, { instanceId: "wp-other", postId: "7" })).rejects.toThrow(
        "connector instance write denied: instance_org_mismatch",
      );

      expect(createCarrierRun).toHaveBeenCalledTimes(1);
      const runId = createdRunId();
      expect(setAgentRunConnectorInstanceBinding).not.toHaveBeenCalled();
      expect(buildInitialMessagePayloadWithRunToken).not.toHaveBeenCalled();
      expect(createExternalA2AClient).not.toHaveBeenCalled();
      expect(sendTask).not.toHaveBeenCalled();
      const failed = transitionRunStatus.mock.calls.filter((c) => c[1] === "queued" && c[2] === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0][0]).toBe(runId);
      expect(failed[0][3]).toMatchObject({ error: "connector instance write denied: instance_org_mismatch" });
    });

    it(`${k.kind}: no instanceId in the start input — no derivation, the run is sent as before`, async () => {
      await dispatchFor(k.kind, { postId: "7" });

      expect(deriveAgentRunConnectorInstanceBinding).not.toHaveBeenCalled();
      expect(setAgentRunConnectorInstanceBinding).not.toHaveBeenCalled();
      expect(sendTask).toHaveBeenCalledTimes(1);
    });
  }
});
