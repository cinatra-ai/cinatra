/**
 * cinatra#2202 — the fail-closed actor precondition for in-process A2A
 * dispatch.
 *
 * `sendMessage` is the only in-process entry point that reaches
 * `InProcessAgentExecutor.execute()` (the run-CREATION path), and that executor
 * stamps the run's org, its `runBy` attribution and its OBO ceiling from the
 * ActorContext ALS frame. A dispatch with no frame therefore produces a run
 * with NO principal at all — an authority hole and an attribution orphan.
 *
 * Doctrine pinned here (roleless / silent-authz-drop class): a missing actor
 * FAILS LOUD. It is never treated as "unconfigured", never degraded to a system
 * principal, and never allowed through to the executor.
 *
 * The llm stub (tests/__stubs__/llm.ts) returns a default test context when no
 * frame is active, so the "no frame" case is modeled by vi.mock-ing the module
 * outright — the same technique agent-executor-org-required.test.ts uses.
 *
 * The precondition lives IN `client.ts` (the dispatch entry point) rather than in
 * a module of its own: a new first-party module grew every route reaching this
 * barrel by one and tripped the shrink-only route-graph ratchet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const alsState = vi.hoisted(() => ({
  actor: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@cinatra-ai/llm/actor-context", () => ({
  getActorContext: () => alsState.actor,
}));

vi.mock("@cinatra-ai/agents", () => ({
  readPublishedAgentTemplates: vi.fn(async () => [
    { id: "t-a", packageName: "pkg-a", name: "A" },
  ]),
  createAgentRun: vi.fn(async () => ({ id: "run-a", status: "queued" })),
  readAgentRunById: vi.fn(async () => ({
    id: "run-a",
    status: "completed",
    stepResults: ["ok"],
    error: null,
  })),
  readAgentTemplateById: vi.fn(async () => null),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
}));

import { createAgentRun } from "@cinatra-ai/agents";
import {
  requireInProcessDispatchActor,
  InProcessA2AActorMissingError,
  IN_PROCESS_ACTOR_MISSING_CODE,
  createInProcessA2AClient,
} from "../client";

const HUMAN_ACTOR = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: "org-1",
  authSource: "ui",
  policyVersion: "v2",
};

beforeEach(() => {
  alsState.actor = { ...HUMAN_ACTOR };
  (createAgentRun as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe("requireInProcessDispatchActor", () => {
  it("returns the ambient actor when a frame with an organization is active", () => {
    const actor = requireInProcessDispatchActor("pkg-a");
    expect(actor.principalId).toBe("user-1");
    expect(actor.organizationId).toBe("org-1");
  });

  it("THROWS (never returns a synthesized principal) when no frame is active", () => {
    alsState.actor = undefined;
    expect(() => requireInProcessDispatchActor("pkg-a")).toThrow(
      InProcessA2AActorMissingError,
    );
    try {
      requireInProcessDispatchActor("pkg-a");
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as InProcessA2AActorMissingError).code).toBe(
        IN_PROCESS_ACTOR_MISSING_CODE,
      );
      expect((err as InProcessA2AActorMissingError).reason).toBe("no-frame");
      // The message must name the package so the refusal is diagnosable.
      expect((err as Error).message).toContain("pkg-a");
    }
  });

  it("THROWS when the frame carries no organizationId", () => {
    alsState.actor = { ...HUMAN_ACTOR, organizationId: undefined };
    try {
      requireInProcessDispatchActor("pkg-a");
      expect.unreachable("expected a refusal");
    } catch (err) {
      expect((err as InProcessA2AActorMissingError).reason).toBe(
        "no-organization",
      );
    }
  });
});

describe("createInProcessA2AClient.sendMessage — fail-closed at the seam", () => {
  it("REFUSES to dispatch with no actor frame, and creates no run", async () => {
    const client = await createInProcessA2AClient({
      packageName: "pkg-a",
      enqueueJob: vi.fn(async () => undefined),
      createRunWithAuthority: vi.fn(async () => ({ id: "run-a" })) as never,
    });

    alsState.actor = undefined;

    await expect(client.sendMessage({ text: "hello" })).rejects.toThrow(
      /no ActorContext frame is active/,
    );
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("REFUSES to dispatch when the frame carries no organizationId", async () => {
    const client = await createInProcessA2AClient({
      packageName: "pkg-a",
      enqueueJob: vi.fn(async () => undefined),
      createRunWithAuthority: vi.fn(async () => ({ id: "run-a" })) as never,
    });

    alsState.actor = { ...HUMAN_ACTOR, organizationId: undefined };

    await expect(client.sendMessage({ text: "hello" })).rejects.toThrow(
      /carries no organizationId/,
    );
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("dispatches normally when the frame is present (the guard is not a blanket block)", async () => {
    const createRunWithAuthority = vi.fn(async () => ({ id: "run-a" }));
    const client = await createInProcessA2AClient({
      packageName: "pkg-a",
      enqueueJob: vi.fn(async () => undefined),
      createRunWithAuthority: createRunWithAuthority as never,
    });

    const task = await client.sendMessage({ text: "hello" });
    expect(task.kind).toBe("task");
    expect(createRunWithAuthority).toHaveBeenCalled();
  });
});
