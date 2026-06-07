/**
 * Tests for the external dispatch branch in sendAgentBuilderMessage.
 *
 * Branch ordering: the external branch must execute BEFORE the internal
 * `createInProcessA2AClient(...)` block. Internal-template behavior must
 * remain unchanged.
 *
 * Local run-record bridge: when dispatching externally, a local agent_runs row
 * MUST be inserted with a2aTaskId = externalTask.id before the function
 * returns. The SSE proxy subscribes to that bridge by runId.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — auth + store + nango + external-client + internal
// createInProcessA2AClient. The factories below read these closures, so each
// test can flip behaviour without reimporting the module under test.
// ---------------------------------------------------------------------------

const sess = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  // orgId is required for createAgentRun call sites. The action reads
  // `session.session?.activeOrganizationId` and returns
  // `{ ok: false, error: "no active organization" }` when missing.
  session: { activeOrganizationId: "test-org" } as
    | { activeOrganizationId: string | null }
    | null,
}));

const storeState = vi.hoisted(() => ({
  template: null as
    | {
        id: string;
        sourceType: "internal" | "external";
        agentUrl: string | null;
        connectorSlug: string | null;
        remoteAgentId: string | null;
      }
    | null,
  savedConn: null as
    | { providerConfigKey: string; connectionId: string }
    | null,
  createAgentRunCalls: [] as Array<Record<string, unknown>>,
  readAgentRunByTaskIdResult: null as { id: string } | null,
}));

const extState = vi.hoisted(() => ({
  lastOptions: null as Record<string, unknown> | null,
  sendTaskResult: { id: "ext-task-1", kind: "task" } as { id: string; kind: string },
  sendTaskShouldThrow: false,
}));

const nangoState = vi.hoisted(() => ({
  connection: null as { credentials?: { apiKey?: string } } | null,
}));

const internalState = vi.hoisted(() => ({
  sendMessageCalls: 0,
}));

// Runtime peeks the first event off client.streamTask() and hands the
// partially-consumed generator to startExternalSseProxyFromStream.
const proxyState = vi.hoisted(() => ({
  calls: [] as Array<{
    stream: AsyncGenerator<unknown, void, undefined>;
    initialStatus: string;
    runId: string;
    options?: {
      publishAgUiEvent?: (event: unknown) => void | Promise<void>;
      maxDurationMs?: number;
    };
  }>,
  delayMs: 0,
  shouldReject: false,
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => {
    if (!sess.user) throw new Error("unauthorized");
    return { user: sess.user, session: sess.session };
  },
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));

vi.mock("@/lib/a2a-server", () => ({
  getA2AMount: async () => ({ handle: async () => ({}) }),
}));

vi.mock("@cinatra-ai/nango-connector", () => ({
  getNangoConnection: async () => nangoState.connection,
  listSavedNangoConnections: () => [],
}));


vi.mock("../store", async () => ({
  readAgentTemplateByPackageName: async () => storeState.template,
  findSavedConnectionForAgentUrl: () => storeState.savedConn,
  createAgentRun: async (input: Record<string, unknown>) => {
    storeState.createAgentRunCalls.push(input);
    // Return the orgId argument so callers/assertions can verify the field was
    // wired through from session.session.activeOrganizationId.
    return { id: input.id, orgId: input.orgId ?? null };
  },
  readAgentRunByTaskId: async () => storeState.readAgentRunByTaskIdResult,
  readAgentRunById: async () => null,
  readAgentRunMessages: async () => [],
  readAgentTemplateById: async () => null,
  // Minimal types re-exported so the module imports don't fail.
  type: undefined,
}));

vi.mock("@cinatra-ai/a2a", async () => {
  return {
    createInProcessA2AClient: async () => ({
      sendMessage: async () => {
        internalState.sendMessageCalls += 1;
        return { id: "int-task-1" };
      },
    }),
    createExternalA2AClient: async (opts: Record<string, unknown>) => {
      extState.lastOptions = opts;
      return {
        sendTask: async () => {
          if (extState.sendTaskShouldThrow) throw new Error("ext send failed");
          return extState.sendTaskResult;
        },
        // The proxy calls streamTask on the returned client; we provide a
        // no-op generator so even an accidentally-awaited proxy wouldn't hang.
        streamTask: async function* () {
          yield { kind: "status-update", id: extState.sendTaskResult.id, status: { state: "completed" } };
        },
      };
    },
    // Runtime imports startExternalSseProxyFromStream from @cinatra-ai/a2a and
    // passes a pre-peeked AsyncGenerator (not a client + task pair).
    startExternalSseProxyFromStream: async (
      stream: AsyncGenerator<unknown, void, undefined>,
      initialStatus: string,
      runId: string,
      options?: {
        publishAgUiEvent?: (event: unknown) => void | Promise<void>;
        maxDurationMs?: number;
      },
    ) => {
      proxyState.calls.push({ stream, initialStatus, runId, options });
      if (proxyState.delayMs > 0) {
        await new Promise((r) => setTimeout(r, proxyState.delayMs));
      }
      if (proxyState.shouldReject) {
        throw new Error("proxy boom");
      }
    },
    // Types/values touched by the module under test — keep surface non-empty
    // so TypeScript doesn't complain at runtime.
    type: undefined,
  };
});

// ---------------------------------------------------------------------------
// Import module under test AFTER vi.mock
// ---------------------------------------------------------------------------

import { sendAgentBuilderMessage } from "../a2a-actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState() {
  sess.user = { id: "user-1" };
  sess.session = { activeOrganizationId: "test-org" };
  storeState.template = null;
  storeState.savedConn = null;
  storeState.createAgentRunCalls = [];
  storeState.readAgentRunByTaskIdResult = null;
  extState.lastOptions = null;
  extState.sendTaskResult = { id: "ext-task-1", kind: "task" };
  extState.sendTaskShouldThrow = false;
  nangoState.connection = null;
  internalState.sendMessageCalls = 0;
  proxyState.calls = [];
  proxyState.delayMs = 0;
  proxyState.shouldReject = false;
}

describe("sendAgentBuilderMessage — external branch", () => {
  beforeEach(() => {
    resetState();
  });

  it("dispatches externally via createExternalA2AClient when template.sourceType === 'external'", async () => {
    storeState.template = {
      id: "tpl-ext-1",
      sourceType: "external",
      agentUrl: "https://ext.test",
      connectorSlug: "ext",
      remoteAgentId: "skill-x",
    };
    storeState.savedConn = {
      providerConfigKey: "cinatra-a2a-server",
      connectionId: "conn-1",
    };
    nangoState.connection = { credentials: { apiKey: "secret-token" } };

    const result = await sendAgentBuilderMessage({
      packageName: "@ext/skill-x",
      inputParams: { q: "hi" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBe("ext-task-1");
      expect(typeof result.runId).toBe("string");
      expect(result.runId.length).toBeGreaterThan(0);
    }
    // createExternalA2AClient was called with the template URL + token
    expect(extState.lastOptions?.agentUrl).toBe("https://ext.test");
    // A local run record was inserted with a2aTaskId = externalTask.id (Pitfall 3)
    expect(storeState.createAgentRunCalls.length).toBe(1);
    expect(storeState.createAgentRunCalls[0].a2aTaskId).toBe("ext-task-1");
    // Internal dispatch must NOT fire
    expect(internalState.sendMessageCalls).toBe(0);
  });

  it("returns error 'no credentials for external A2A server' when no saved connection matches", async () => {
    storeState.template = {
      id: "tpl-ext-1",
      sourceType: "external",
      agentUrl: "https://ext.test",
      connectorSlug: "ext",
      remoteAgentId: "skill-x",
    };
    storeState.savedConn = null; // no match

    const result = await sendAgentBuilderMessage({
      packageName: "@ext/skill-x",
      inputParams: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no credentials for external A2A server");
    }
    // No run record created, no external dispatch
    expect(storeState.createAgentRunCalls.length).toBe(0);
    expect(extState.lastOptions).toBeNull();
  });

  it("returns error 'external template missing agentUrl' when agentUrl is null", async () => {
    storeState.template = {
      id: "tpl-ext-1",
      sourceType: "external",
      agentUrl: null, // blocker
      connectorSlug: "ext",
      remoteAgentId: "skill-x",
    };

    const result = await sendAgentBuilderMessage({
      packageName: "@ext/skill-x",
      inputParams: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("external template missing agentUrl");
    }
  });

  it("internal dispatch path is unchanged when template is internal or missing", async () => {
    // template is null — falls through to internal branch
    storeState.template = null;
    storeState.readAgentRunByTaskIdResult = { id: "run-local-1" };

    const result = await sendAgentBuilderMessage({
      packageName: "@cinatra/internal",
      inputParams: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBe("int-task-1");
      expect(result.runId).toBe("run-local-1");
    }
    expect(internalState.sendMessageCalls).toBe(1);
    expect(extState.lastOptions).toBeNull();
    // Proxy must NOT fire on internal dispatch.
    expect(proxyState.calls.length).toBe(0);
  });
});

describe("sendAgentBuilderMessage — external branch proxy wiring", () => {
  beforeEach(() => {
    resetState();
    storeState.template = {
      id: "tpl-ext-1",
      sourceType: "external",
      agentUrl: "https://ext.test",
      connectorSlug: "ext",
      remoteAgentId: "skill-x",
    };
    storeState.savedConn = {
      providerConfigKey: "cinatra-a2a-server",
      connectionId: "conn-1",
    };
    nangoState.connection = { credentials: { apiKey: "secret-token" } };
  });

  it("invokes startExternalSseProxyFromStream exactly once with (stream, initialStatus, runId, options)", async () => {
    const inputParams = { q: "hello", n: 42 };
    const result = await sendAgentBuilderMessage({
      packageName: "@ext/skill-x",
      inputParams,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Proxy fired exactly once.
    expect(proxyState.calls.length).toBe(1);
    const call = proxyState.calls[0];

    // runId matches the one returned to the caller (the bridge row contract).
    expect(call.runId).toBe(result.runId);

    // initialStatus comes from the peeked first event's status.state —
    // the streamTask mock yields { kind: "status-update", status: { state: "completed" } },
    // so the runtime sets initialStatus = "completed". Keep the assertion loose
    // (typeof string) so a future mock tweak doesn't break us.
    expect(typeof call.initialStatus).toBe("string");
    expect(call.initialStatus.length).toBeGreaterThan(0);

    // stream is the AsyncGenerator handed off by the runtime after peeking
    // the first event. Exercising it would consume events — only assert shape.
    expect(call.stream).toBeTruthy();
    expect(typeof (call.stream as AsyncGenerator<unknown>).next).toBe("function");

    // options.publishAgUiEvent must be wired — runtime always provides it.
    expect(call.options).toBeTruthy();
    expect(typeof call.options?.publishAgUiEvent).toBe("function");
  });

  it("is fire-and-forget: sendAgentBuilderMessage returns immediately even when the proxy takes 500ms", async () => {
    proxyState.delayMs = 500;
    const start = Date.now();
    const result = await sendAgentBuilderMessage({
      packageName: "@ext/skill-x",
      inputParams: { q: "hi" },
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    // Must return well before the proxy finishes (fire-and-forget).
    expect(elapsed).toBeLessThan(200);
    // Proxy was kicked off but the caller did not await it.
    expect(proxyState.calls.length).toBe(1);
  });

  it("does not propagate proxy rejections — server action stays { ok: true }", async () => {
    proxyState.shouldReject = true;
    // Spy on console.error to assert the defensive .catch() logs instead of
    // throwing. The log message is not part of the observable contract, but
    // the fact that we don't crash IS.
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const result = await sendAgentBuilderMessage({
        packageName: "@ext/skill-x",
        inputParams: {},
      });
      expect(result.ok).toBe(true);
      // Give the rejected microtask a chance to run.
      await new Promise((r) => setTimeout(r, 10));
      // Defensive .catch fired.
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
