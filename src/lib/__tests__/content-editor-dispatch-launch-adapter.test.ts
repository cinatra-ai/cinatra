/**
 * THE WIDGET'S CONTENT-EDIT RUN LAUNCHES THROUGH THE COORDINATOR AND KEEPS ITS
 * BLOCKING REPLY (cinatra#2929, epic #2926 W2b).
 *
 * The acceptance's fourth fixture, widget half. This dispatch was the other
 * surface that bypassed the worker: it created its OBO-carrier run directly,
 * which is why the creation fence carried the file as owed. It now launches, and
 * the contract `HostContentEditorDispatchService` requires of it is unmoved:
 *
 *   · the answer is a `Promise<string>` — the agent's own reply text;
 *   · it comes back INSIDE the caller's `timeoutMs`, which is still what bounds
 *     the external client;
 *   · the carrier run is created `queued` and driven inline
 *     (queued -> running -> completed) because nothing ever enqueues it.
 *
 * The launch claims NO present human deliberately: a presence claim would have
 * the coordinator create the run parked so a moment could open, holding a
 * carrier at a card nobody is shown while the person at the other end of the
 * widget waits for a reply that could never arrive inside its timeout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ORG = "org-2929";
const RUN_BY = "user-2929";

const launchAgentRun = vi.fn();
const transitionRunStatus = vi.fn(async () => undefined);
const createAgentRun = vi.fn();
const sendTask = vi.fn();
const createExternalA2AClient = vi.fn(async () => ({ sendTask }));

vi.mock("@cinatra-ai/agents/lifecycle-coordinator", () => ({
  launchAgentRun: (...a: unknown[]) => launchAgentRun(...a),
}));
vi.mock("@cinatra-ai/agents", () => ({
  buildInitialMessagePayloadWithRunToken: vi.fn(async (payload: Record<string, unknown>, runId: string) => ({
    ...payload,
    cinatra_run_id: runId,
  })),
  createAgentRun: (...a: unknown[]) => createAgentRun(...a),
  readAgentTemplateByPackageName: vi.fn(async () => ({ id: "tmpl-cms" })),
  readLatestAgentVersionIdForTemplate: vi.fn(async () => "ver-cms"),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...(a as [])),
}));
vi.mock("@cinatra-ai/llm", () => ({ buildA2aBearerToken: vi.fn(async () => null) }));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: (...a: unknown[]) => createExternalA2AClient(...(a as [])),
}));
vi.mock("@/lib/content-editor-run-identity", () => ({
  resolveContentEditorIdentityForInstance: vi.fn(async () => ({ orgId: ORG, runBy: RUN_BY })),
}));
vi.mock("@/lib/widget-actor-frame", () => ({ resolveWidgetActorFromFrame: vi.fn(() => null) }));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser: vi.fn(async () => "member") }));
vi.mock("@/lib/org-write/agent-run-authority-mint", () => ({
  mintContentEditorDispatchAuthority: vi.fn(() => ({ kind: "system" })),
}));
vi.mock("@cinatra-ai/org-write-kernel", () => ({
  OrgWriteRefusedError: class OrgWriteRefusedError extends Error {
    reason = "capability-denied";
  },
}));
vi.mock("@/lib/org-write/dispatch-freeze", () => ({
  OrganizationArchivedDispatchError: class OrganizationArchivedDispatchError extends Error {},
}));

import { dispatchContentEditorViaA2A } from "../host-content-editor-dispatch";

const TIMEOUT_MS = 300_000;

function input(overrides: Record<string, unknown> = {}) {
  return {
    agentUrl: "https://cms.test/a2a",
    payload: { action: "update", title: "A draft" },
    timeoutMs: TIMEOUT_MS,
    packageName: "@cinatra-ai/wordpress-agent",
    instancesConfigKey: "wordpress",
    origin: "https://site.test",
    instanceId: "inst-1",
    ...overrides,
  } as Parameters<typeof dispatchContentEditorViaA2A>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  createExternalA2AClient.mockResolvedValue({ sendTask });
  sendTask.mockResolvedValue({
    history: [
      { role: "user", parts: [{ kind: "text", text: "{}" }] },
      { role: "agent", parts: [{ kind: "text", text: "{\"ok\":true}" }] },
    ],
  });
  launchAgentRun.mockImplementation(async (launch: { create: { input: { id: string } } }) => ({
    carrier: { kind: "run", run: { id: launch.create.input.id, status: "queued" } },
    status: "queued",
    moment: null,
  }));
});

describe("the widget's content-edit run", () => {
  it("is created through the coordinator, never around it", async () => {
    await dispatchContentEditorViaA2A(input());

    expect(createAgentRun).not.toHaveBeenCalled();
    expect(launchAgentRun).toHaveBeenCalledTimes(1);
    const launch = launchAgentRun.mock.calls[0]![0] as {
      producer: string;
      frame: unknown;
      dispatch: { kind: string; why?: string };
      create: { kind: string; input: Record<string, unknown> };
    };
    expect(launch.producer).toBe("widget_content_edit");
    expect(launch.dispatch.kind).toBe("caller_dispatches");
    expect(launch.dispatch.why ?? "").not.toEqual("");
    // Headless, so the coordinator creates it `queued` and parks nothing.
    expect(launch.frame).toBeNull();
    expect(launch.create.input).toMatchObject({
      templateId: "tmpl-cms",
      orgId: ORG,
      runBy: RUN_BY,
      sourceType: "content_editor_dispatch",
    });
  });

  it("HOLDS ITS BLOCKING REPLY WITHIN THE TIMEOUT", async () => {
    // The service contract in two assertions: the caller's budget is what bounds
    // the external client, and the answer arrives before that budget is spent.
    const timedOut = Symbol("timed-out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), TIMEOUT_MS);
    });

    const winner = await Promise.race([dispatchContentEditorViaA2A(input()), budget]);
    if (timer) clearTimeout(timer);

    expect(winner).not.toBe(timedOut);
    expect(winner).toBe('{"ok":true}');
    // …and it is the LAUNCHED run's reply. Without this the case would pass with
    // the adapter reverted, proving only that the dispatch still answers.
    expect(launchAgentRun).toHaveBeenCalledTimes(1);
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(createExternalA2AClient).toHaveBeenCalledWith(
      expect.objectContaining({ agentUrl: "https://cms.test/a2a", timeoutMs: TIMEOUT_MS }),
    );
  });

  it("drives the carrier's lifecycle inline, because nothing enqueues it", async () => {
    await dispatchContentEditorViaA2A(input());
    const runId = (launchAgentRun.mock.calls[0]![0] as { create: { input: { id: string } } })
      .create.input.id;

    expect(transitionRunStatus).toHaveBeenCalledWith(
      runId,
      "queued",
      "running",
      expect.anything(),
      expect.anything(),
    );
    expect(transitionRunStatus).toHaveBeenCalledWith(
      runId,
      "running",
      "completed",
      expect.anything(),
      expect.anything(),
    );
  });

  it("injects the launched run's own id into the message the agent receives", async () => {
    await dispatchContentEditorViaA2A(input());
    const runId = (launchAgentRun.mock.calls[0]![0] as { create: { input: { id: string } } })
      .create.input.id;

    const sent = sendTask.mock.calls[0]![0] as {
      message: { parts: Array<{ text: string }> };
    };
    expect(JSON.parse(sent.message.parts[0]!.text)).toMatchObject({
      cinatra_run_id: runId,
      action: "update",
    });
  });

  it("the per-user widget path launches under the same producer, with the person's own identity", async () => {
    await dispatchContentEditorViaA2A(
      input({
        actorOverride: {
          runBy: "widget-person",
          orgId: ORG,
          sourceType: "public_site_widget",
          instanceId: "inst-1",
        },
      }),
    );
    const launch = launchAgentRun.mock.calls[0]![0] as {
      producer: string;
      create: { input: Record<string, unknown> };
    };
    expect(launch.producer).toBe("widget_content_edit");
    expect(launch.create.input).toMatchObject({
      runBy: "widget-person",
      orgId: ORG,
      sourceType: "public_site_widget",
    });
  });

  it("a dispatch failure still lands the carrier, never leaving it queued with no job", async () => {
    sendTask.mockRejectedValue(new Error("peer unreachable"));
    await expect(dispatchContentEditorViaA2A(input())).rejects.toThrow("peer unreachable");
    const runId = (launchAgentRun.mock.calls[0]![0] as { create: { input: { id: string } } })
      .create.input.id;
    expect(transitionRunStatus).toHaveBeenCalledWith(
      runId,
      "running",
      "failed",
      expect.anything(),
      expect.anything(),
    );
  });
});
