/**
 * THE EXTERNAL AGENT'S RUN LAUNCHES THROUGH THE COORDINATOR AND KEEPS ITS
 * REMOTE TASK STREAM (cinatra#2929, epic #2926 W2b).
 *
 * The acceptance's fourth fixture, remote half. This action was one of the two
 * surfaces that bypassed the worker: it created its run directly, which is why
 * the creation fence carried the file as owed. It now launches — and the whole
 * point of the adapter is that nothing the caller depends on moved:
 *
 *   · the run is created `queued` and NOTHING is enqueued: the remote peer is
 *     already running the task, and a second dispatch would run it twice;
 *   · the task stream survives the launch — the event peeked to learn the task
 *     id is re-injected at the head, and the SAME iterator continues into the
 *     proxy, so no frame is lost between the peek and the hand-off;
 *   · the caller still gets `{ ok: true, taskId, runId }`.
 *
 * The run is launched HEADLESS on purpose. A presence claim would have the
 * coordinator create it parked so a moment could open before dispatch — holding
 * a run whose execution belongs to a remote peer, with no card able to release
 * it. This slice changes no screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const USER = "user-2929";
const ORG = "org-2929";

const launchAgentRun = vi.fn();
const startExternalSseProxyFromStream = vi.fn<
  (
    stream: AsyncGenerator<unknown>,
    initialStatus: string,
    runId: string,
    hooks: unknown,
  ) => Promise<void>
>(async () => undefined);
const streamTask = vi.fn();
const createAgentRun = vi.fn();

vi.mock("../lifecycle-coordinator", () => ({
  launchAgentRun: (...a: unknown[]) => launchAgentRun(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: USER },
    session: { activeOrganizationId: ORG },
  })),
  getActorContext: vi.fn(async () => null),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({ kind: "member" })),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "member" })),
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/nango-system", () => ({ getNangoConnection: vi.fn(async () => null) }));
vi.mock("@/lib/a2a-server", () => ({ getA2AMount: vi.fn(async () => null) }));
vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: vi.fn(async () => undefined) }));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({ publishAgUiEvent: vi.fn() }));
vi.mock("../hitl-context", () => ({ deriveRunHitlContext: vi.fn(() => null) }));
vi.mock("../store", () => ({
  readAgentRunById: vi.fn(async () => null),
  readAgentRunByTaskId: vi.fn(async () => null),
  readAgentRunMessages: vi.fn(async () => []),
  readAgentTemplateByPackageName: vi.fn(async () => ({
    id: "tmpl-2929",
    sourceType: "external",
    agentUrl: "https://peer.test/a2a",
  })),
  findSavedConnectionForAgentUrl: vi.fn(() => ({
    providerConfigKey: "peer",
    connectionId: "conn-1",
  })),
  createAgentRun: (...a: unknown[]) => createAgentRun(...a),
  updateAgentRunStreamedText: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({ streamTask })),
  createInProcessA2AClient: vi.fn(async () => ({ sendMessage: vi.fn() })),
  startExternalSseProxyFromStream: (
    stream: AsyncGenerator<unknown>,
    initialStatus: string,
    runId: string,
    hooks: unknown,
  ) => startExternalSseProxyFromStream(stream, initialStatus, runId, hooks),
}));

import { sendAgentBuilderMessage } from "../a2a-actions";

/** The peer's own stream: the task frame first, then two live updates. */
function peerStream() {
  return (async function* () {
    yield { kind: "task", id: "task-remote-1" };
    yield { kind: "status-update", id: "task-remote-1", status: { state: "working" } };
    yield { kind: "status-update", id: "task-remote-1", status: { state: "completed" } };
  })();
}

beforeEach(() => {
  vi.clearAllMocks();
  streamTask.mockImplementation(() => peerStream());
  launchAgentRun.mockImplementation(async (input: { create: { input: { id: string } } }) => ({
    carrier: { kind: "run", run: { id: input.create.input.id, status: "queued" } },
    status: "queued",
    moment: null,
  }));
});

describe("the external agent's run", () => {
  it("is created through the coordinator, never around it", async () => {
    const result = await sendAgentBuilderMessage({
      packageName: "@peer/agent",
      inputParams: { prompt: "go" },
    });

    expect(createAgentRun).not.toHaveBeenCalled();
    expect(launchAgentRun).toHaveBeenCalledTimes(1);
    const launch = launchAgentRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(launch.producer).toBe("external_agent_message");
    expect(result).toMatchObject({ ok: true, taskId: "task-remote-1" });
  });

  it("enqueues NOTHING — the peer is already running the task", async () => {
    await sendAgentBuilderMessage({ packageName: "@peer/agent", inputParams: {} });
    const launch = launchAgentRun.mock.calls[0]![0] as {
      dispatch: { kind: string; why?: string };
      frame: unknown;
    };
    expect(launch.dispatch.kind).toBe("caller_dispatches");
    expect(launch.dispatch.why ?? "").not.toEqual("");
    // Headless: no presence claim, so the coordinator creates it `queued` and
    // opens no moment that would park a run the peer is already executing.
    expect(launch.frame).toBeNull();
  });

  it("carries the run's local identity onto the launch", async () => {
    await sendAgentBuilderMessage({
      packageName: "@peer/agent",
      inputParams: { prompt: "go" },
    });
    const launch = launchAgentRun.mock.calls[0]![0] as {
      create: { kind: string; input: Record<string, unknown> };
    };
    expect(launch.create.kind).toBe("full");
    expect(launch.create.input).toMatchObject({
      templateId: "tmpl-2929",
      runBy: USER,
      orgId: ORG,
      a2aTaskId: "task-remote-1",
      sourceType: "agent_builder",
      projectId: null,
    });
  });

  it("KEEPS THE REMOTE TASK STREAM: the peeked frame is re-injected and the rest follows", async () => {
    // The task id can only be learned by consuming the first event. What the
    // proxy must receive is the WHOLE stream all the same — the peeked frame at
    // the head and the live iterator behind it — or the run's first state
    // change is lost between the launch and the hand-off.
    const result = await sendAgentBuilderMessage({
      packageName: "@peer/agent",
      inputParams: {},
    });
    expect(result).toMatchObject({ ok: true });

    expect(startExternalSseProxyFromStream).toHaveBeenCalledTimes(1);
    const [stream, initialStatus, runId] = startExternalSseProxyFromStream.mock.calls[0]!;
    expect(stream).toBeDefined();
    expect(initialStatus).toBe("submitted");
    expect(runId).toBe((result as { runId: string }).runId);

    const seen: unknown[] = [];
    for await (const event of stream) seen.push(event);
    expect(seen).toEqual([
      { kind: "task", id: "task-remote-1" },
      { kind: "status-update", id: "task-remote-1", status: { state: "working" } },
      { kind: "status-update", id: "task-remote-1", status: { state: "completed" } },
    ]);
  });

  it("a refused launch is reported, and no stream is proxied for a run that does not exist", async () => {
    launchAgentRun.mockRejectedValue(new Error("run-creation authority refused"));
    const result = await sendAgentBuilderMessage({
      packageName: "@peer/agent",
      inputParams: {},
    });
    expect(result).toMatchObject({ ok: false });
    expect(startExternalSseProxyFromStream).not.toHaveBeenCalled();
  });
});
