/**
 * THE ADAPTERS' LAUNCH SHAPE, THROUGH THE REAL COORDINATOR (cinatra#2929).
 *
 * The two adapter suites next door stub `launchAgentRun` so they can assert what
 * the adapter ASKS FOR. That proves the call and not the consequence: a stub
 * that answers "queued" would agree with the adapter however the coordinator
 * really behaved. So this suite closes the other half, in two steps that are
 * only worth anything together:
 *
 *   1. the SHAPE each adapter passes is read off the adapter's own source — the
 *      producer key, the dispatch kind and the absent frame — so the fixture
 *      cannot drift away from the call site while staying green;
 *   2. that exact shape is put through the REAL `launchAgentRun`, with only the
 *      store and the queue stubbed, and what the coordinator does with it is
 *      asserted: the run is created `queued`, it carries no presence stamp, no
 *      moment is opened, and NOTHING is enqueued.
 *
 * The second step is what the acceptance's two contracts rest on. A carrier
 * created parked would never reach the widget's blocking reply inside its
 * timeout, and a second enqueue would run an external peer's task twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const createAgentRun = vi.fn();
const enqueueAgentRun = vi.fn(async () => undefined);
const recordRunLifecycleMoment = vi.fn(async () => undefined);
const readAgentRunById = vi.fn(async () => null);

vi.mock("../store", () => ({
  createAgentRun: (...a: unknown[]) => createAgentRun(...a),
  createAgentRunPendingInput: vi.fn(),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...(a as [])),
  recordRunLifecycleMoment: (...a: unknown[]) => recordRunLifecycleMoment(...(a as [])),
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {
    code = "stale_from_status";
  },
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...(a as [])),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));

import { launchAgentRun } from "../lifecycle-coordinator";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/** The two adapters, and the module each one's launch lives in. */
const ADAPTERS = [
  {
    what: "the widget's content-edit run",
    module: "src/lib/host-content-editor-dispatch.ts",
    producer: "widget_content_edit",
  },
  {
    what: "a run of an external agent",
    module: "packages/agents/src/a2a-actions.ts",
    producer: "external_agent_message",
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  createAgentRun.mockImplementation(async (input: { id: string; initialStatus?: string }) => ({
    id: input.id,
    orgId: "org-2929",
    status: input.initialStatus ?? "queued",
  }));
});

describe.each(ADAPTERS)("$what", (adapter) => {
  it("launches under its own producer key, with the caller dispatching and no frame", () => {
    const source = read(adapter.module);
    const at = source.indexOf(`producer: "${adapter.producer}"`);
    expect(at, `${adapter.module} does not launch as ${adapter.producer}`).toBeGreaterThan(-1);
    // The shape, read within the launch call this producer names.
    const call = source.slice(at, at + 900);
    expect(call).toContain('kind: "caller_dispatches"');
    expect(call).toContain("frame: null");
    expect(call).not.toContain("interactive:");
  });

  it("that shape, through the REAL coordinator: created queued, unparked, unenqueued", async () => {
    const answer = await launchAgentRun({
      producer: adapter.producer,
      frame: null,
      authority: { orgId: "org-2929" } as never,
      dispatch: { kind: "caller_dispatches", why: "the adapter owns the dispatch" },
      create: {
        kind: "full",
        input: {
          id: "run-2929",
          templateId: "tmpl-2929",
          orgId: "org-2929",
          runBy: "user-2929",
          inputParams: {},
        },
      },
    });

    expect(createAgentRun).toHaveBeenCalledTimes(1);
    const [created] = createAgentRun.mock.calls[0]! as [Record<string, unknown>, unknown];
    // QUEUED, not parked: the carrier is ready for the caller's own dispatch.
    expect(created.initialStatus).toBe("queued");
    // NO PRESENCE STAMP. `runBy` alone is not a person sitting in front of the
    // run — the coordinator derives presence, and neither adapter offers it a
    // verified interactive surface to derive one from.
    expect(created.humanPresent).toBeUndefined();
    // NO MOMENT, so no card is opened on any host by the launch itself.
    expect(recordRunLifecycleMoment).not.toHaveBeenCalled();
    expect(answer.moment).toBeNull();
    expect(answer.status).toBe("queued");
    // AND NOTHING ENQUEUED — the contract both adapters depend on.
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe("what would break if the launch claimed a present human", () => {
  it("an interactive claim parks the run instead — which is why neither adapter makes one", () => {
    // The negative control for the two cases above. Stated as the coordinator's
    // own documented behaviour rather than run against it, because running it
    // would assert W2a's parking rule a third time; what matters here is that
    // the adapters do not take that branch, which the source check above pins.
    const coordinator = read("packages/agents/src/lifecycle-coordinator.ts");
    expect(coordinator).toContain(
      'const parkOnCreate = dispatch.kind === "await_trigger" || humanPresent;',
    );
  });
});
