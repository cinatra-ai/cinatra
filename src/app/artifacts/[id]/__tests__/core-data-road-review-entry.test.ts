/**
 * THE DATA ROAD TRAVELS THE REVIEW ENTRY, BEHAVIOURALLY (cinatra#4311).
 *
 * `core-data-road-supply.test.ts` pins the binder and the named road; this file
 * drives the ENTRY points a review surface actually calls — the bound surface
 * loader's `beginReviewTargets` with the first-party roads, and the two
 * preparation entries `beginArtifactReviewTargets` / `prepareArtifactReviewTargets`
 * — and reads `props.data` off the snapshot the real binder builds.
 *
 * Only the preparation CORE is replaced (the gate, run-access and membership
 * reads it orchestrates have their own suites): the stand-in calls the ports it
 * is handed — the REAL binder's `buildProps` — once, and answers with the props.
 * So a road a surface named and the path dropped reads here exactly as it would
 * on the card: no `data` key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const { readPinnedSubstance } = vi.hoisted(() => ({ readPinnedSubstance: vi.fn() }));

vi.mock("@/lib/artifacts/artifact-content-substance-reader", () => ({
  createPinnedSubstanceReader: () => ({ readPinnedSubstance }),
}));
vi.mock("@/lib/lifecycle/review-island-byte-road", () => ({
  buildIslandArtifactByteMinter: () => () => null,
}));
vi.mock("@/lib/lifecycle/widget-capture-egress", () => ({
  buildBrokerCapturePair: () => null,
}));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readGatePinnedTargets: vi.fn(),
  readReviewGate: vi.fn(),
  readReviewGateState: vi.fn(),
  commitReviewDecision: vi.fn(),
  enforceReviewRunAccess: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/lifecycle-repair-store", () => ({
  readRepairBySuccessorGateId: vi.fn(),
}));
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({
  readPinnedPreviewCaptures: vi.fn(),
}));

const identity = { kind: "no-primary" } as const;
const ARTIFACT = {
  artifactId: "art_4311_entry",
  title: "Pipeline health",
  objectType: "document",
  mime: "text/markdown",
  size: 10,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  ownerLevel: "team",
  visibility: "private",
  sourceUrl: null,
  effectiveIdentity: identity,
  presentationIdentity: identity,
} as unknown as ArtifactSummary;

// THE CORE STAND-IN: one call of the ports' own buildProps at a version the
// test chooses, answered as the props it built.
const core = vi.hoisted(() => ({ version: 5 }));
vi.mock("@/lib/artifacts/artifact-review-preparation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/artifacts/artifact-review-preparation")>();
  const run = async (_input: unknown, ports: { buildProps: (i: unknown) => Promise<unknown> }) => ({
    ok: true,
    props: await ports.buildProps({
      artifact: ARTIFACT,
      representationRevisionId: "rev_4311_entry",
      mime: "text/markdown",
      propsApiVersion: core.version,
      member: { mime: "text/markdown", form: "file" },
    }),
  });
  return { ...actual, beginReviewTargetsCore: run, prepareReviewTargetsCore: run };
});

import { ARTIFACT_RENDERER_SESSION_DATA_ROAD } from "@/lib/artifacts/artifact-renderer-props";
import { beginReviewTargets, type ReviewActorContext } from "../review-gate-ports";
import { firstPartyReviewSurfaceRoads, islandReviewSurfaceRoads } from "../review-surface-roads";
import { beginArtifactReviewTargets, prepareArtifactReviewTargets } from "../review-target-prepare";

const ROAD = { road: "session", apiUrl: "/api/dashboards/cubejs-api/v1" } as const;
const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;
const actorCtx = {
  actor: { actorType: "human", userId: "u" },
  orgId: "org_4311_entry",
} as unknown as ReviewActorContext;
const input = { runId: "run_4311", reviewTaskId: "task_4311", targets: [] } as never;
const runGatePorts = {} as never;

type Built = { props: { data?: unknown; propsApiVersion: number } };

beforeEach(() => {
  core.version = 5;
  readPinnedSubstance.mockReset();
  readPinnedSubstance.mockResolvedValue({ class: "text", text: "ok" });
});

describe("the surface loader hands the first-party data road to the display", () => {
  it("beginReviewTargets with the first-party roads: props.data is the session road", async () => {
    const result = (await beginReviewTargets({
      input,
      actorCtx,
      roads: firstPartyReviewSurfaceRoads(),
    })) as unknown as Built;
    expect(result.props.data).toEqual(ROAD);
    expect(result.props.data).toEqual(ARTIFACT_RENDERER_SESSION_DATA_ROAD);
  });

  it("beginReviewTargets with the island roads: no data key (the display's no-series reading)", async () => {
    const roads = islandReviewSurfaceRoads({
      principal: {} as never,
      runId: "run_4311",
      reviewTaskId: "task_4311",
    });
    const result = (await beginReviewTargets({ input, actorCtx, roads })) as unknown as Built;
    expect(Object.prototype.hasOwnProperty.call(result.props, "data")).toBe(false);
  });

  it("beginReviewTargets with no roads: no data key", async () => {
    const result = (await beginReviewTargets({ input, actorCtx })) as unknown as Built;
    expect(Object.prototype.hasOwnProperty.call(result.props, "data")).toBe(false);
  });

  it("a display that declared version 2 gets no data key, even on the first-party roads", async () => {
    core.version = 2;
    const result = (await beginReviewTargets({
      input,
      actorCtx,
      roads: firstPartyReviewSurfaceRoads(),
    })) as unknown as Built;
    expect(result.props.propsApiVersion).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(result.props, "data")).toBe(false);
  });
});

describe("both preparation entries carry the named road to the binder", () => {
  for (const [name, entry] of [
    ["beginArtifactReviewTargets", beginArtifactReviewTargets],
    ["prepareArtifactReviewTargets", prepareArtifactReviewTargets],
  ] as const) {
    it(`${name} with a data road: props.data is that road`, async () => {
      const result = (await entry({
        input,
        orgId: "org_4311_entry",
        actor,
        runGatePorts,
        dataRoad: ROAD,
      } as Parameters<typeof entry>[0])) as unknown as Built;
      expect(result.props.data).toEqual(ROAD);
    });

    it(`${name} without one: no data key`, async () => {
      const result = (await entry({
        input,
        orgId: "org_4311_entry",
        actor,
        runGatePorts,
      } as Parameters<typeof entry>[0])) as unknown as Built;
      expect(Object.prototype.hasOwnProperty.call(result.props, "data")).toBe(false);
    });
  }
});
