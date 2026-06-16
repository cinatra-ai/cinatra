// cinatra#246 — host content-editor A2A dispatch carries a REAL agent_run OBO
// identity to /api/mcp (production OBO path, NOT the dev-admin bypass).
//
// Asserts:
//  - dispatch pre-creates an agent_run bound to the resolved {orgId, runBy}
//    with the template resolved from packageName,
//  - cinatra_run_id is injected into the A2A message text (mirrors execution.ts),
//  - the carrier run is driven queued→running→completed inline (never enqueued),
//  - absent packageName / unresolved identity / non-object payload all fall back
//    to anonymous dispatch (no run, no id) — fail-closed, never elevate.

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

// --- agents store ------------------------------------------------------------
const createAgentRun = vi.fn<(input: { id: string }) => Promise<unknown>>();
const readAgentTemplateByPackageName = vi.fn<(pkg: string) => Promise<unknown>>();
const readLatestAgentVersionIdForTemplate = vi.fn<(id: string) => Promise<unknown>>();
const transitionRunStatus = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@cinatra-ai/agents", () => ({
  createAgentRun: (input: { id: string }) => createAgentRun(input),
  readAgentTemplateByPackageName: (pkg: string) => readAgentTemplateByPackageName(pkg),
  readLatestAgentVersionIdForTemplate: (id: string) => readLatestAgentVersionIdForTemplate(id),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
}));

// --- single-tenant identity resolver ----------------------------------------
const resolveSingleTenantContentEditorIdentity = vi.fn();
vi.mock("@/lib/content-editor-run-identity", () => ({
  resolveSingleTenantContentEditorIdentity: () => resolveSingleTenantContentEditorIdentity(),
}));

import { dispatchContentEditorViaA2A } from "@/lib/host-content-editor-dispatch";

function lastSentText(): string {
  const call = sendTask.mock.calls.at(-1)?.[0] as {
    message: { parts: Array<{ kind: string; text: string }> };
  };
  return call.message.parts[0].text;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path: a resolved identity + installed template + agent reply.
  buildA2aBearerToken.mockResolvedValue("bearer-token");
  createExternalA2AClient.mockResolvedValue({ sendTask });
  resolveSingleTenantContentEditorIdentity.mockResolvedValue({
    orgId: "org_1",
    runBy: "u_admin",
  });
  readAgentTemplateByPackageName.mockResolvedValue({ id: "tmpl_wp" });
  readLatestAgentVersionIdForTemplate.mockResolvedValue("ver_1");
  createAgentRun.mockImplementation(async (input: { id: string }) => ({
    id: input.id,
    inputParams: {},
  }));
  sendTask.mockResolvedValue({
    history: [{ role: "agent", parts: [{ kind: "text", text: '{"postId":"7"}' }] }],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatchContentEditorViaA2A — production OBO identity (cinatra#246)", () => {
  it("creates an agent_run bound to {orgId, runBy} + template, and injects cinatra_run_id", async () => {
    const reply = await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { instanceId: "wp1", postId: "7", instructions: "do it" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
    });

    expect(readAgentTemplateByPackageName).toHaveBeenCalledWith("@cinatra-ai/wordpress-agent");
    expect(createAgentRun).toHaveBeenCalledTimes(1);
    const runArg = createAgentRun.mock.calls[0][0] as Record<string, unknown>;
    expect(runArg.orgId).toBe("org_1");
    expect(runArg.runBy).toBe("u_admin");
    expect(runArg.templateId).toBe("tmpl_wp");
    expect(runArg.versionId).toBe("ver_1");
    expect(runArg.sourceType).toBe("content_editor_dispatch");
    expect(runArg.inputParams).toMatchObject({ instanceId: "wp1", postId: "7" });

    // cinatra_run_id injected into the A2A message text (alongside the payload).
    const sent = JSON.parse(lastSentText());
    expect(sent.cinatra_run_id).toBe(runArg.id);
    expect(sent.postId).toBe("7");

    // Lifecycle: queued→running before dispatch, running→completed after.
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "queued", "running", expect.anything());
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "running", "completed", expect.anything());

    expect(reply).toBe('{"postId":"7"}');
  });

  it("parses a pre-serialized (Drupal) string payload and still injects cinatra_run_id", async () => {
    readAgentTemplateByPackageName.mockResolvedValue({ id: "tmpl_drupal" });
    await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3020",
      payload: JSON.stringify({ instanceId: "d1", nodeId: "42" }),
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/drupal-agent",
    });
    expect(createAgentRun).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastSentText());
    expect(sent.nodeId).toBe("42");
    expect(typeof sent.cinatra_run_id).toBe("string");
  });

  it("falls back to anonymous dispatch (no run) when packageName is absent", async () => {
    await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { postId: "7" },
      timeoutMs: 300_000,
      // packageName omitted (pre-#246 connector)
    });
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(transitionRunStatus).not.toHaveBeenCalled();
    const sent = JSON.parse(lastSentText());
    expect(sent.cinatra_run_id).toBeUndefined();
  });

  it("falls back to anonymous dispatch when identity cannot be resolved", async () => {
    resolveSingleTenantContentEditorIdentity.mockResolvedValue(null);
    await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { postId: "7" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
    });
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("falls back to anonymous dispatch when the template is not installed", async () => {
    readAgentTemplateByPackageName.mockResolvedValue(null);
    await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { postId: "7" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
    });
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("marks the carrier run failed when the A2A dispatch throws", async () => {
    sendTask.mockRejectedValue(new Error("a2a boom"));
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://localhost:3021",
        payload: { postId: "7" },
        timeoutMs: 300_000,
        packageName: "@cinatra-ai/wordpress-agent",
      }),
    ).rejects.toThrow("a2a boom");
    const runArg = createAgentRun.mock.calls[0][0] as { id: string };
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "running", "failed", expect.anything());
  });

  it("marks the carrier run queued→failed (never orphaned in queued) when client creation throws", async () => {
    // The carrier run is created BEFORE buildA2aBearerToken + createExternalA2AClient.
    // If the eager agent-card fetch throws, the still-`queued` run must be
    // transitioned →failed before the error propagates — never left orphaned.
    createExternalA2AClient.mockRejectedValue(new Error("card fetch boom"));
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://localhost:3021",
        payload: { postId: "7" },
        timeoutMs: 300_000,
        packageName: "@cinatra-ai/wordpress-agent",
      }),
    ).rejects.toThrow("card fetch boom");

    const runArg = createAgentRun.mock.calls[0][0] as { id: string };
    // The failure happens before queued→running, so the carrier run transitions
    // FROM queued (not running) to failed — and never reaches sendTask.
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "queued", "failed", expect.anything());
    expect(transitionRunStatus).not.toHaveBeenCalledWith(runArg.id, "queued", "running", expect.anything());
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("marks the carrier run queued→failed when token-build throws", async () => {
    buildA2aBearerToken.mockRejectedValue(new Error("token mint boom"));
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://localhost:3021",
        payload: { postId: "7" },
        timeoutMs: 300_000,
        packageName: "@cinatra-ai/wordpress-agent",
      }),
    ).rejects.toThrow("token mint boom");

    const runArg = createAgentRun.mock.calls[0][0] as { id: string };
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "queued", "failed", expect.anything());
    expect(createExternalA2AClient).not.toHaveBeenCalled();
  });
});
