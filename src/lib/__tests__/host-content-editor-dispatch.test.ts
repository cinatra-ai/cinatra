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
// cinatra#1940 P3: createAgentRun's creation perimeter is now guarded — it
// takes a REQUIRED trailing `authority` param. The mock forwards it so tests
// below can assert it was minted BEFORE the guarded create (Decision 1,
// content-editor row).
const createAgentRun = vi.fn<(input: { id: string }, authority?: unknown) => Promise<unknown>>();
const readAgentTemplateByPackageName = vi.fn<(pkg: string) => Promise<unknown>>();
const readLatestAgentVersionIdForTemplate = vi.fn<(id: string) => Promise<unknown>>();
const transitionRunStatus = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@cinatra-ai/agents", () => ({
  createAgentRun: (input: { id: string }, authority?: unknown) => createAgentRun(input, authority),
  readAgentTemplateByPackageName: (pkg: string) => readAgentTemplateByPackageName(pkg),
  readLatestAgentVersionIdForTemplate: (id: string) => readLatestAgentVersionIdForTemplate(id),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
}));

// --- per-instance (cinatra#274) identity resolver ----------------------------
// The dispatcher resolves identity through the per-install resolver, which
// internally falls back to single-tenant. We mock the per-install resolver and
// assert the install→org anchors (instancesConfigKey/origin/instanceId) reach it.
const resolveContentEditorIdentityForInstance = vi.fn();
vi.mock("@/lib/content-editor-run-identity", () => ({
  resolveContentEditorIdentityForInstance: (...a: unknown[]) =>
    resolveContentEditorIdentityForInstance(...a),
}));

import { dispatchContentEditorViaA2A } from "@/lib/host-content-editor-dispatch";
// Real (unmocked) — used to construct the exact rejection shape the guarded
// createAgentRun throws under an archived org, and to assert the typed
// refusal it must become (cinatra#1940 P3, Decision 1 content-editor row).
import { OrgWriteRefusedError } from "@cinatra-ai/org-write-kernel";

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
  resolveContentEditorIdentityForInstance.mockResolvedValue({
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
    // cinatra#1939 wave 2: the trailing arg is the D-HOST system dispatch authority.
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "queued", "running", expect.anything(), expect.anything());
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "running", "completed", expect.anything(), expect.anything());

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
    resolveContentEditorIdentityForInstance.mockResolvedValue(null);
    await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { postId: "7" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
    });
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("threads the install→org anchors (instancesConfigKey/origin/instanceId) into the per-install resolver (cinatra#274)", async () => {
    // A per-install binding resolves to a NON-default org/user.
    resolveContentEditorIdentityForInstance.mockResolvedValue({
      orgId: "org_tenantB",
      runBy: "u_tenantB_admin",
    });
    await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { instanceId: "wp-b", postId: "7", instructions: "edit" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
      instancesConfigKey: "wordpress",
      origin: "https://tenant-b.example",
      instanceId: "wp-b",
    });

    expect(resolveContentEditorIdentityForInstance).toHaveBeenCalledWith({
      instancesConfigKey: "wordpress",
      origin: "https://tenant-b.example",
      instanceId: "wp-b",
    });
    // The carrier run binds to THIS install's org/user, not the default.
    const runArg = createAgentRun.mock.calls[0][0] as Record<string, unknown>;
    expect(runArg.orgId).toBe("org_tenantB");
    expect(runArg.runBy).toBe("u_tenantB_admin");
  });

  it("passes empty anchors when the connector-side path supplies no install context (back-compat)", async () => {
    await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { postId: "7" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
      // no instancesConfigKey / origin / instanceId — single-tenant behavior.
    });
    expect(resolveContentEditorIdentityForInstance).toHaveBeenCalledWith({
      instancesConfigKey: "",
      origin: undefined,
      instanceId: undefined,
    });
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
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "running", "failed", expect.anything(), expect.anything());
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
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "queued", "failed", expect.anything(), expect.anything());
    expect(transitionRunStatus).not.toHaveBeenCalledWith(runArg.id, "queued", "running", expect.anything(), expect.anything());
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
    expect(transitionRunStatus).toHaveBeenCalledWith(runArg.id, "queued", "failed", expect.anything(), expect.anything());
    expect(createExternalA2AClient).not.toHaveBeenCalled();
  });
});

describe("dispatchContentEditorViaA2A — per-user actorOverride (cinatra#408)", () => {
  it("uses the override {runBy, orgId, sourceType} and SKIPS the install resolver entirely", async () => {
    const reply = await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { instanceId: "wp-1", postId: "7", instructions: "edit" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
      // The route passes the install anchors AND the override; the override wins.
      instancesConfigKey: "wordpress",
      origin: "https://wp.test",
      instanceId: "wp-1",
      actorOverride: {
        runBy: "u_enduser",
        orgId: "org_1",
        instanceId: "wp-1",
        sourceType: "public_site_widget",
      },
    });

    // The install/single-tenant resolver MUST NOT be consulted on this path.
    expect(resolveContentEditorIdentityForInstance).not.toHaveBeenCalled();

    expect(createAgentRun).toHaveBeenCalledTimes(1);
    const runArg = createAgentRun.mock.calls[0][0] as Record<string, unknown>;
    // runBy is the END USER, never the install's service identity (org admin).
    expect(runArg.runBy).toBe("u_enduser");
    expect(runArg.orgId).toBe("org_1");
    expect(runArg.sourceType).toBe("public_site_widget");
    expect(runArg.templateId).toBe("tmpl_wp");

    const sent = JSON.parse(lastSentText());
    expect(sent.cinatra_run_id).toBe(runArg.id);
    expect(reply).toBe('{"postId":"7"}');
  });

  it("does NOT downgrade to anonymous when the template is missing (throws instead — no fallback)", async () => {
    readAgentTemplateByPackageName.mockResolvedValue(null);
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://localhost:3021",
        payload: { postId: "7" },
        timeoutMs: 300_000,
        packageName: "@cinatra-ai/wordpress-agent",
        actorOverride: {
          runBy: "u_enduser",
          orgId: "org_1",
          instanceId: "wp-1",
          sourceType: "public_site_widget",
        },
      }),
    ).rejects.toThrow(/no agent template installed/);
    // No carrier run, but crucially NO anonymous dispatch either.
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(resolveContentEditorIdentityForInstance).not.toHaveBeenCalled();
  });

  it("HEADLESS path (cinatra#405): NO actorOverride / NO user token is still ALLOWED under install identity", async () => {
    // Regression guard for the #408 fail-closed-by-default route change: that
    // change lives ONLY in the widget-stream ROUTE. The headless content-editor
    // dispatch (cinatra#405 cinatra_run_id/agent_run_id) is host-initiated and
    // calls THIS helper directly (via the contentEditorDispatch service), with
    // NO actorOverride and NO user token — it legitimately runs under the
    // install/single-tenant identity and MUST NOT be denied. Proves the route
    // fail-closed default did not leak into / regress this path.
    const reply = await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { instanceId: "wp1", postId: "7", instructions: "headless edit" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
      // NOTE: no actorOverride — this is the headless install-identity path.
    });

    // The install resolver IS consulted (no override), and a carrier run is
    // created under the install identity with the content_editor_dispatch
    // discriminator (NOT public_site_widget) — i.e. allowed, not denied.
    expect(resolveContentEditorIdentityForInstance).toHaveBeenCalledTimes(1);
    expect(createAgentRun).toHaveBeenCalledTimes(1);
    const runArg = createAgentRun.mock.calls[0][0] as Record<string, unknown>;
    expect(runArg.runBy).toBe("u_admin");
    expect(runArg.orgId).toBe("org_1");
    expect(runArg.sourceType).toBe("content_editor_dispatch");
    const sent = JSON.parse(lastSentText());
    expect(sent.cinatra_run_id).toBe(runArg.id);
    expect(reply).toBe('{"postId":"7"}');
  });
});

describe("dispatchContentEditorViaA2A — preCreateAuthorize at the run-creation boundary (widget-stream runtime trust, slice 2)", () => {
  const overrideInput = {
    agentUrl: "http://localhost:3021",
    payload: { instanceId: "wp-1", postId: "7", instructions: "edit" },
    timeoutMs: 300_000,
    packageName: "@cinatra-ai/wordpress-agent",
    actorOverride: {
      runBy: "u_enduser",
      orgId: "org_1",
      instanceId: "wp-1",
      sourceType: "public_site_widget" as const,
    },
  };

  it("invokes the re-assert AFTER template/version reads and BEFORE createAgentRun (override path)", async () => {
    const order: string[] = [];
    readLatestAgentVersionIdForTemplate.mockImplementation(async () => {
      order.push("version-read");
      return "ver_1";
    });
    createAgentRun.mockImplementation(async (input: { id: string }) => {
      order.push("create-run");
      return { id: input.id, inputParams: {} };
    });
    const preCreateAuthorize = vi.fn(async () => {
      order.push("re-assert");
      return true;
    });
    await dispatchContentEditorViaA2A({ ...overrideInput, preCreateAuthorize });
    expect(preCreateAuthorize).toHaveBeenCalledTimes(1);
    // The re-assert is the LAST relay-path observation before the bounded
    // store operation is initiated — no relay-path reads between them.
    expect(order).toEqual(["version-read", "re-assert", "create-run"]);
  });

  it("REFUSES with NO run created when the re-assert returns false (revoked-mid-serve)", async () => {
    const preCreateAuthorize = vi.fn(async () => false);
    await expect(
      dispatchContentEditorViaA2A({ ...overrideInput, preCreateAuthorize }),
    ).rejects.toThrow(/point-of-use authorization re-assert failed/);
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a THROWING re-assert refuses exactly like false (fail closed), no run created", async () => {
    const preCreateAuthorize = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(
      dispatchContentEditorViaA2A({ ...overrideInput, preCreateAuthorize }),
    ).rejects.toThrow(/point-of-use authorization re-assert failed/);
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("guards the install-identity path's run creation too", async () => {
    const preCreateAuthorize = vi.fn(async () => false);
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://localhost:3021",
        payload: { postId: "7" },
        timeoutMs: 300_000,
        packageName: "@cinatra-ai/wordpress-agent",
        instancesConfigKey: "wordpress",
        origin: "https://wp.test",
        preCreateAuthorize,
      }),
    ).rejects.toThrow(/point-of-use authorization re-assert failed/);
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("an ABSENT hook keeps existing callers unchanged (baked-trust paths)", async () => {
    await dispatchContentEditorViaA2A(overrideInput);
    expect(createAgentRun).toHaveBeenCalledTimes(1);
  });
});

// cinatra#1940 P3 (Decision 1, content-editor row; Decision 8 acceptance
// map) — the archived-org typed refusal. CRITICAL semantics: this must NOT
// degrade to the anonymous fallback — anonymous dispatch would still fire
// the A2A task against the CMS agent (real external work) with the write
// only failing later, silently, at the MCP boundary. Both creation sites
// (actorOverride + install-identity) wrap the guarded create and re-throw a
// typed `OrganizationArchivedDispatchError`, fail-loud to the connector.
describe("dispatchContentEditorViaA2A — archived-org typed refusal (cinatra#1940 P3)", () => {
  it("install-identity path: an archived-org capability-denied refusal becomes OrganizationArchivedDispatchError — NO anonymous fallback, NO A2A client opened", async () => {
    createAgentRun.mockRejectedValue(new OrgWriteRefusedError("capability-denied"));
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://localhost:3021",
        payload: { instanceId: "wp1", postId: "7", instructions: "do it" },
        timeoutMs: 300_000,
        packageName: "@cinatra-ai/wordpress-agent",
      }),
    ).rejects.toMatchObject({
      name: "OrganizationArchivedDispatchError",
      code: "ORG_ARCHIVED_DISPATCH_REFUSED",
      surface: "content-editor",
    });
    expect(createExternalA2AClient).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
    expect(buildA2aBearerToken).not.toHaveBeenCalled();
  });

  it("actorOverride (per-user widget) path: the same typed refusal, no anonymous fallback", async () => {
    createAgentRun.mockRejectedValue(new OrgWriteRefusedError("capability-denied"));
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://localhost:3021",
        payload: { instanceId: "wp-1", postId: "7", instructions: "edit" },
        timeoutMs: 300_000,
        packageName: "@cinatra-ai/wordpress-agent",
        actorOverride: {
          runBy: "u_enduser",
          orgId: "org_1",
          instanceId: "wp-1",
          sourceType: "public_site_widget",
        },
      }),
    ).rejects.toMatchObject({
      name: "OrganizationArchivedDispatchError",
      surface: "content-editor",
    });
    expect(createExternalA2AClient).not.toHaveBeenCalled();
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a non-archive createAgentRun failure is NOT reinterpreted as an archive refusal (only capability-denied maps)", async () => {
    createAgentRun.mockRejectedValue(new Error("db connection reset"));
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://localhost:3021",
        payload: { postId: "7" },
        timeoutMs: 300_000,
        packageName: "@cinatra-ai/wordpress-agent",
      }),
    ).rejects.toThrow("db connection reset");
  });

  it("threads a real authority (not undefined) into createAgentRun for both creation sites", async () => {
    await dispatchContentEditorViaA2A({
      agentUrl: "http://localhost:3021",
      payload: { instanceId: "wp1", postId: "7", instructions: "do it" },
      timeoutMs: 300_000,
      packageName: "@cinatra-ai/wordpress-agent",
    });
    const [, authority] = createAgentRun.mock.calls[0] as [unknown, { orgId?: string } | undefined];
    expect(authority).toBeDefined();
    expect(authority?.orgId).toBe("org_1");
  });
});
