// cinatra#4150 W4 C1b: THE PUBLISH-DECISION ISLAND LOADER.
//
// The island draws a publish card's artifacts row through the one review core. A publish decision has no gate, so the
// loader is the authorization a gate would have supplied. Pinned here, rung by rung, each with its refusal:
//   1. the row is proven by the subject read (run access, the newest decision, the declared artifacts row, the frozen
//      target list); nothing below runs when it refuses;
//   2. the reader's organization is the run's;
//   3. every target was made by this run, in this organization: one that was not refuses the whole set;
//   4. the one core prepares exactly the proven set, with the gate binder's run check and the proven set as the pinned
//      set; a core refusal refuses;
//   and any port that throws refuses. Red first: at C1's head the module under test does not exist (import fails).
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const subjectModule = vi.hoisted(() => ({
  readPublishDecisionIslandSubject: vi.fn(),
  readRevisionsMadeByRun: vi.fn(),
}));
// The subject module by its relative source path (the package export resolves to this same file), so this file
// loads before the fix, when the package does not export it yet.
vi.mock("../../../../packages/agents/src/publish-decision-island-subject", () => subjectModule);

const verifyRunAccess = vi.fn();
const gatePorts = vi.hoisted(() => ({
  bindReviewRunGatePorts: vi.fn(),
  streamReviewTargets: vi.fn(),
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => gatePorts);

const prepare = vi.hoisted(() => ({ beginArtifactReviewTargets: vi.fn() }));
vi.mock("@/app/artifacts/[id]/review-target-prepare", () => prepare);

vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: (actor: unknown, orgId: string) => ({ kernel: true, actor, orgId }),
}));

import { publishDecisionIslandSubjectKey } from "../lifecycle-card-ref";
// The module under test is loaded inside the tests (beforeEach), so before the fix this file loads and every test
// fails on the missing module.
// red-first-expect: publish-decision-island
import type * as IslandModule from "../publish-decision-island";
import type { PublishDecisionIslandPorts } from "../publish-decision-island";
let PUBLISH_DECISION_ISLAND_PORTS: typeof IslandModule.PUBLISH_DECISION_ISLAND_PORTS;
let loadPublishDecisionIslandSurface: typeof IslandModule.loadPublishDecisionIslandSurface;
let loadPublishDecisionIslandSurfaceWith: typeof IslandModule.loadPublishDecisionIslandSurfaceWith;

const ACTOR = {
  actor: { actorType: "human" as const, source: "ui" as const, userId: "user-a" },
  orgId: "org-1",
  roleHints: { orgRole: "member" as const, actorOrganizationId: "org-1" },
};
const TARGETS = [
  { artifactId: "art-1", representationRevisionId: "rev-1" },
  { artifactId: "art-2", representationRevisionId: "rev-2" },
];
const ARGS = { runId: "run-1", decisionId: "dec-1", input: "reviewTargets", actorCtx: ACTOR };
const SUBJECT = { runId: "run-1", orgId: "org-1", decided: false, targets: TARGETS };
const STARTED = TARGETS.map((target) => ({ target, prepared: Promise.resolve({}) }));
const STREAMS = [{ stream: 1 }, { stream: 2 }];

function ports(over: Partial<PublishDecisionIslandPorts> = {}) {
  const p = {
    readSubject: vi.fn(async () => SUBJECT),
    revisionsMadeByRun: vi.fn(async () => true),
    begin: vi.fn(async () => ({ ok: true as const, targets: STARTED })),
    stream: vi.fn(() => STREAMS),
    ...over,
  };
  return p as unknown as PublishDecisionIslandPorts & { [K in keyof typeof p]: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  ({ PUBLISH_DECISION_ISLAND_PORTS, loadPublishDecisionIslandSurface, loadPublishDecisionIslandSurfaceWith } = await import(
    "../publish-decision-island"
  ));
  vi.clearAllMocks();
  gatePorts.bindReviewRunGatePorts.mockReturnValue({ verifyRunAccess });
});

describe("the loader's rungs", () => {
  it("a proven row of the reader's organization, made by the run, is READY with the streamed targets", async () => {
    const p = ports();
    const surface = await loadPublishDecisionIslandSurfaceWith(ARGS, p);
    expect(surface).toEqual({ kind: "ready", decided: false, targets: STREAMS });
    expect(p.readSubject).toHaveBeenCalledWith({
      runId: "run-1",
      decisionId: "dec-1",
      input: "reviewTargets",
      who: { actor: ACTOR.actor, roleHints: ACTOR.roleHints },
    });
    expect(p.revisionsMadeByRun).toHaveBeenCalledWith({ orgId: "org-1", runId: "run-1", targets: TARGETS });
    expect(p.begin).toHaveBeenCalledWith({
      runId: "run-1",
      subjectKey: publishDecisionIslandSubjectKey({ decisionId: "dec-1", input: "reviewTargets" }),
      targets: TARGETS,
      actorCtx: ACTOR,
      roads: null,
    });
    expect(p.stream).toHaveBeenCalledWith({ orgId: "org-1", started: STARTED, roads: null });
  });

  it("a settled decision draws the same targets, read as decided", async () => {
    const p = ports({ readSubject: vi.fn(async () => ({ ...SUBJECT, decided: true })) });
    expect(await loadPublishDecisionIslandSurfaceWith(ARGS, p)).toMatchObject({ kind: "ready", decided: true });
  });

  it("1. a row the subject read refuses reaches nothing below", async () => {
    const p = ports({ readSubject: vi.fn(async () => null) });
    expect(await loadPublishDecisionIslandSurfaceWith(ARGS, p)).toEqual({ kind: "refused" });
    expect(p.revisionsMadeByRun).not.toHaveBeenCalled();
    expect(p.begin).not.toHaveBeenCalled();
  });

  it("1. a subject for another run, or with no target, refuses", async () => {
    for (const subject of [{ ...SUBJECT, runId: "run-2" }, { ...SUBJECT, targets: [] }]) {
      const p = ports({ readSubject: vi.fn(async () => subject) });
      expect(await loadPublishDecisionIslandSurfaceWith(ARGS, p)).toEqual({ kind: "refused" });
      expect(p.begin).not.toHaveBeenCalled();
    }
  });

  it("2. a run of another organization than the reader's refuses before any target is read", async () => {
    const p = ports({ readSubject: vi.fn(async () => ({ ...SUBJECT, orgId: "org-2" })) });
    expect(await loadPublishDecisionIslandSurfaceWith(ARGS, p)).toEqual({ kind: "refused" });
    expect(p.revisionsMadeByRun).not.toHaveBeenCalled();
    expect(p.begin).not.toHaveBeenCalled();
  });

  it("3. a target the run did not make refuses the WHOLE set, and the core never runs", async () => {
    const p = ports({ revisionsMadeByRun: vi.fn(async () => false) });
    expect(await loadPublishDecisionIslandSurfaceWith(ARGS, p)).toEqual({ kind: "refused" });
    expect(p.begin).not.toHaveBeenCalled();
  });

  it("3. only a literal true admits: a truthy non-boolean answer refuses", async () => {
    const p = ports({ revisionsMadeByRun: vi.fn(async () => "yes" as unknown as boolean) });
    expect(await loadPublishDecisionIslandSurfaceWith(ARGS, p)).toEqual({ kind: "refused" });
  });

  it("4. a core refusal (run access, substitution) refuses", async () => {
    const p = ports({ begin: vi.fn(async () => ({ ok: false as const, error: { kind: "run-access-denied" as const, status: 403 } })) });
    expect(await loadPublishDecisionIslandSurfaceWith(ARGS, p)).toEqual({ kind: "refused" });
    expect(p.stream).not.toHaveBeenCalled();
  });

  it("any port that throws refuses", async () => {
    for (const over of [
      { readSubject: vi.fn(async () => Promise.reject(new Error("db down"))) },
      { revisionsMadeByRun: vi.fn(async () => Promise.reject(new Error("db down"))) },
      { begin: vi.fn(async () => Promise.reject(new Error("db down"))) },
      { stream: vi.fn(() => { throw new Error("boom"); }) },
    ]) {
      expect(await loadPublishDecisionIslandSurfaceWith(ARGS, ports(over as Partial<PublishDecisionIslandPorts>))).toEqual({
        kind: "refused",
      });
    }
  });

  it("the roads a surface named travel to the core and the stream", async () => {
    const roads = { dataRoad: { kind: "session" } } as never;
    const p = ports();
    await loadPublishDecisionIslandSurfaceWith({ ...ARGS, roads }, p);
    expect(p.begin).toHaveBeenCalledWith(expect.objectContaining({ roads }));
    expect(p.stream).toHaveBeenCalledWith(expect.objectContaining({ roads }));
  });
});

describe("the bound ports", () => {
  it("the core is handed the proven set as the pinned set, the gate binder's run check and the reader's org", async () => {
    prepare.beginArtifactReviewTargets.mockResolvedValue({ ok: true, targets: [] });
    const subjectKey = publishDecisionIslandSubjectKey({ decisionId: "dec-1", input: "reviewTargets" });
    await PUBLISH_DECISION_ISLAND_PORTS.begin({ runId: "run-1", subjectKey, targets: TARGETS, actorCtx: ACTOR, roads: null });
    expect(gatePorts.bindReviewRunGatePorts).toHaveBeenCalledWith(ACTOR);
    const call = prepare.beginArtifactReviewTargets.mock.calls[0][0];
    expect(call.input).toEqual({ runId: "run-1", reviewTaskId: subjectKey, targets: TARGETS });
    expect(call.orgId).toBe("org-1");
    expect(call.runGatePorts.verifyRunAccess).toBe(verifyRunAccess);
    expect(await call.runGatePorts.readGatePinnedTargets("run-1", subjectKey)).toEqual({ status: "pending", targets: TARGETS });
    expect(call.reading).toBe("pending");
  });

  it("the stream hands the started targets on, and reads no capture pair for them", async () => {
    // cinatra#3862 leg 8: no surface draws a stored capture pair, so the stream takes the started targets alone: no
    // organization to read pictures in, no pairing and no road for them.
    gatePorts.streamReviewTargets.mockReturnValue(STREAMS);
    expect(PUBLISH_DECISION_ISLAND_PORTS.stream({ orgId: "org-1", started: STARTED as never, roads: null })).toBe(STREAMS);
    expect(gatePorts.streamReviewTargets.mock.calls).toEqual([[STARTED]]);
  });

  it("the default loader runs the real subject and revision reads", async () => {
    subjectModule.readPublishDecisionIslandSubject.mockResolvedValue(SUBJECT);
    subjectModule.readRevisionsMadeByRun.mockResolvedValue(false);
    expect(await loadPublishDecisionIslandSurface(ARGS)).toEqual({ kind: "refused" });
    expect(subjectModule.readRevisionsMadeByRun).toHaveBeenCalledWith({ orgId: "org-1", runId: "run-1", targets: TARGETS });
    expect(prepare.beginArtifactReviewTargets).not.toHaveBeenCalled();
  });
});
