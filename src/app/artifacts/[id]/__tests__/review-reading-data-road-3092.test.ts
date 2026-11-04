/**
 * EVERY DISPLAY IS HANDED THE REVIEW'S READING AND THE DATA ROAD
 * (cinatra#3092, acceptance 2 and 6, the application's half).
 *
 * Acceptance 2: the displays "draw over pinned revisions on the page and on the
 * review card, and the page's pre-dispatch interception of the dashboard row is
 * gone". Acceptance 6: the live navigation "is absent in the pending reading and
 * present in the continued one, asserted by a test over both".
 *
 * The application keeps the roads that serve every artifact alike, so this
 * suite drives the REAL binder, the REAL roads and the REAL surface loader over
 * a census of several types and forms, and asserts that every target on a
 * surface is handed the same reading and the same road whatever it is. The type
 * ids are fixtures under an owner outside the organisation.
 *
 * The artifact page is a server component; it is read as text, the way the
 * page's own suites read it (`w3-artifact-page-header-closed.test.ts`).
 *
 * Only the store and dispatch seams are stubbed, in the manner of
 * `review-gate-ports-repair-pair.test.ts`; the preparation core, the binder, the
 * props builder and the loader all run for real.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import type { ArtifactContentProjection } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

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
  readPinnedPreviewCaptures: vi.fn(() => []),
}));
vi.mock("@/lib/authz/build-actor-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz/build-actor-context")>()),
  buildActorContextFromPrimitive: vi.fn(() => ({})),
}));
vi.mock("@/lib/artifacts/artifact-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/artifact-service")>()),
  readArtifactForDetail: vi.fn(),
  readArtifactForSettledReview: vi.fn(),
}));
vi.mock("@/lib/artifacts/artifact-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/artifact-read")>()),
  resolveArtifactVersionForServe: vi.fn(),
  resolveNonFileArtifactRevision: vi.fn(() => null),
}));
vi.mock("@/lib/artifacts/system-artifact-renderer-registrar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/system-artifact-renderer-registrar")>()),
  ensureActivatedRepresentationProviders: vi.fn(async () => undefined),
}));
vi.mock("../renderer-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../renderer-resolution")>()),
  resolveArtifactDispatchInputs: vi.fn(() => ({})),
}));
vi.mock("../renderer-dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../renderer-dispatch")>()),
  pickArtifactRenderer: vi.fn(() => ({ kind: "fallback" })),
}));

import {
  enforceReviewRunAccess,
  readGatePinnedTargets,
  readReviewGate,
  readReviewGateState,
} from "@cinatra-ai/agents/artifact-review-gate-store";
import {
  readArtifactForDetail,
  readArtifactForSettledReview,
} from "@/lib/artifacts/artifact-service";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import {
  ARTIFACT_RENDERER_PROPS_REVIEW_READING_VERSION,
  absentArtifactContent,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";

import { bindArtifactReviewPorts } from "../review-target-prepare";
import { loadReviewGateSurface } from "../review-gate-ports";
import {
  firstPartyReviewSurfaceRoads,
  islandReviewSurfaceRoads,
  type ArtifactContentBuilder,
} from "../review-surface-roads";

/** The application's session data road, as the props contract names it. */
const SESSION_ROAD = { road: "session", apiUrl: "/api/dashboards/cubejs-api/v1" } as const;
const LIVE = "https://example.com/live/work-1";
const ORG = "org_3092";
const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;

const identity = { kind: "no-primary" } as const;
function summary(artifactId: string, objectType: string, sourceUrl: string | null): ArtifactSummary {
  return {
    artifactId,
    objectType,
    title: artifactId,
    mime: "application/octet-stream",
    size: 0,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ownerLevel: "organization",
    visibility: "organization",
    sourceUrl,
    effectiveIdentity: identity,
    presentationIdentity: identity,
  } as unknown as ArtifactSummary;
}

/** THE CENSUS: three types and three forms — a file text revision, a file image
 *  revision, and a revision that is not a file carrying a configuration. */
const CENSUS = [
  {
    artifact: summary("art_text", "@fixture/notes-artifact:note", LIVE),
    revision: "rev_text",
    mime: "text/markdown",
    member: { mime: "text/markdown", form: "file" as const },
  },
  {
    artifact: summary("art_image", "@fixture/picture-artifact:picture", null),
    revision: "rev_image",
    mime: "image/png",
    member: { mime: "image/png", form: "file" as const },
  },
  {
    artifact: summary("art_config", "@fixture/board-artifact:board", LIVE),
    revision: "rev_config",
    mime: "application/vnd.fixture.board+json",
    member: {
      mime: "application/vnd.fixture.board+json",
      form: "dashboard" as const,
      configuration: { layout: [{ id: "p1" }] },
      configurationDigest: "d".repeat(64),
    },
  },
];

const stubContent: ArtifactContentBuilder = async (input) =>
  absentArtifactContent(input.representationRevisionId, "absent") as ArtifactContentProjection;

type BinderCtx = Parameters<typeof bindArtifactReviewPorts>[0];

async function buildCensus(
  extra: Partial<BinderCtx>,
  version: number = ARTIFACT_RENDERER_PROPS_REVIEW_READING_VERSION,
  census = CENSUS,
): Promise<ArtifactRendererProps[]> {
  const { buildProps } = bindArtifactReviewPorts({
    orgId: ORG,
    actor,
    buildContent: stubContent,
    ...extra,
  } as BinderCtx);
  const out: ArtifactRendererProps[] = [];
  for (const target of census) {
    out.push(
      await buildProps({
        artifact: target.artifact,
        representationRevisionId: target.revision,
        mime: target.mime,
        propsApiVersion: version,
        member: target.member,
      }),
    );
  }
  return out;
}

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.doUnmock("@cinatra-ai/agents/artifact-review-gate-store");
  vi.doUnmock("@cinatra-ai/agents/lifecycle-repair-store");
  vi.doUnmock("@/lib/artifacts/cms-preview-capture-store");
  vi.doUnmock("@/lib/authz/build-actor-context");
  vi.doUnmock("@/lib/artifacts/artifact-service");
  vi.doUnmock("@/lib/artifacts/artifact-read");
  vi.doUnmock("@/lib/artifacts/system-artifact-renderer-registrar");
  vi.doUnmock("../renderer-resolution");
  vi.doUnmock("../renderer-dispatch");
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

describe("(a) every display alike — the review card's binder", () => {
  it("hands every target of the census the pending reading with no live address, and the same data road", async () => {
    const snapshots = await buildCensus({ reading: "pending", dataRoad: SESSION_ROAD } as Partial<BinderCtx>);
    expect(snapshots).toHaveLength(3);
    for (const props of snapshots) {
      expect(props.propsApiVersion).toBe(ARTIFACT_RENDERER_PROPS_REVIEW_READING_VERSION);
      // Pending: no live link, whatever the record carries.
      expect(props.review).toEqual({ reading: "pending", openLive: null });
      expect(props.data).toEqual(SESSION_ROAD);
    }
  });
});

describe("(b) the continued reading carries the record's own live address", () => {
  it("carries the record's https address as the live navigation", async () => {
    const [props] = await buildCensus(
      { reading: "continued", dataRoad: SESSION_ROAD } as Partial<BinderCtx>,
      ARTIFACT_RENDERER_PROPS_REVIEW_READING_VERSION,
      [CENSUS[0]],
    );
    expect(props.review).toEqual({ reading: "continued", openLive: LIVE });
  });

  it("carries no live address where the record names none", async () => {
    const [props] = await buildCensus(
      { reading: "continued", dataRoad: SESSION_ROAD } as Partial<BinderCtx>,
      ARTIFACT_RENDERER_PROPS_REVIEW_READING_VERSION,
      [CENSUS[1]],
    );
    expect(props.review).toEqual({ reading: "continued", openLive: null });
  });
});

describe("(c) no reading, no road", () => {
  it("a binder given neither writes neither key", async () => {
    for (const props of await buildCensus({})) {
      expect("review" in props).toBe(false);
      expect("data" in props).toBe(false);
    }
  });

  it("a display that declared version 2 gets neither key", async () => {
    const snapshots = await buildCensus(
      { reading: "continued", dataRoad: SESSION_ROAD } as Partial<BinderCtx>,
      ARTIFACT_RENDERER_PROPS_REVIEW_READING_VERSION - 1,
    );
    for (const props of snapshots) {
      expect(props.propsApiVersion).toBe(2);
      expect("review" in props).toBe(false);
      expect("data" in props).toBe(false);
    }
  });
});

describe("(d) the roads", () => {
  it("a first-party surface carries the session data road", () => {
    const roads = firstPartyReviewSurfaceRoads();
    expect(roads.dataRoad).toEqual(SESSION_ROAD);
  });

  it("the island carries no data road", () => {
    const roads = islandReviewSurfaceRoads({
      principal: {
        orgId: ORG,
        userId: "u",
        jti: "jti-1",
        siteId: "site-1",
        client: "client-1",
        instanceId: "instance-1",
        agentSlug: "agent-1",
      },
      runId: "run-1",
      reviewTaskId: "review-1",
    } as Parameters<typeof islandReviewSurfaceRoads>[0]);
    expect(roads.dataRoad).toBeUndefined();
  });
});

describe("(e) the surface loader sets the reading from the gate", () => {
  const RUN = "run_3092";
  const TASK = "review_3092";
  const TARGETS = [
    { artifactId: "art_text", representationRevisionId: "rev_text" },
    { artifactId: "art_image", representationRevisionId: "rev_image" },
  ];
  const BY_ID: Record<string, ArtifactSummary> = {
    art_text: CENSUS[0].artifact,
    art_image: CENSUS[1].artifact,
  };
  const MIME: Record<string, string> = { rev_text: "text/markdown", rev_image: "image/png" };

  function wireGate(status: "pending" | "resolved", disposition: string | null | undefined) {
    vi.mocked(enforceReviewRunAccess).mockResolvedValue({ ok: true, orgId: ORG } as never);
    vi.mocked(readReviewGateState).mockResolvedValue(
      (status === "pending"
        ? { status: "pending", targets: TARGETS }
        : { status: "resolved", fingerprint: "f".repeat(64) }) as never,
    );
    vi.mocked(readGatePinnedTargets).mockResolvedValue({ status, targets: TARGETS } as never);
    vi.mocked(readReviewGate).mockResolvedValue({
      id: "gate_3092",
      ...(disposition === undefined ? {} : { disposition }),
      pinnedTargets: TARGETS,
    } as never);
    const read = (({ artifactId }: { artifactId: string }) => ({
      kind: "ok",
      artifact: BY_ID[artifactId],
    })) as never;
    vi.mocked(readArtifactForDetail).mockImplementation(read);
    vi.mocked(readArtifactForSettledReview).mockImplementation(read);
    vi.mocked(resolveArtifactVersionForServe).mockImplementation(
      (({ representationRevisionId }: { representationRevisionId: string }) => ({
        storageKey: `k/${representationRevisionId}`,
        mime: MIME[representationRevisionId],
        sizeBytes: 10,
        originKind: "upload",
      })) as never,
    );
  }

  async function load(): Promise<ArtifactRendererProps[]> {
    const surface = await loadReviewGateSurface({
      runId: RUN,
      reviewTaskId: TASK,
      actorCtx: { actor: { actorType: "human", userId: "u" } as never, orgId: ORG },
      roads: { buildContent: stubContent, dataRoad: SESSION_ROAD } as never,
    });
    expect(surface.kind === "ready" || surface.kind === "settled").toBe(true);
    const targets = (
      surface as { targets: { prepared: Promise<{ props: ArtifactRendererProps | null }> }[] }
    ).targets;
    expect(targets).toHaveLength(2);
    const prepared = await Promise.all(targets.map((t) => t.prepared));
    return prepared.map((t) => {
      expect(t.props).not.toBeNull();
      return t.props as ArtifactRendererProps;
    });
  }

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("a pending gate hands its targets the pending reading", async () => {
    wireGate("pending", null);
    for (const props of await load()) {
      expect(props.review).toEqual({ reading: "pending", openLive: null });
      expect(props.data).toEqual(SESSION_ROAD);
    }
  });

  it("a gate resolved with approve hands its targets the continued reading", async () => {
    wireGate("resolved", "approve");
    const [text, image] = await load();
    expect(text.review).toEqual({ reading: "continued", openLive: LIVE });
    expect(image.review).toEqual({ reading: "continued", openLive: null });
  });

  // No reading means no review stands, and a display then offers the live link.
  it.each(["reject", "comment"])("a gate resolved with %s hands its targets the pending reading", async (disposition) => {
    wireGate("resolved", disposition);
    for (const props of await load()) {
      expect(props.review).toEqual({ reading: "pending", openLive: null });
    }
  });

  // A readable settled row whose disposition is null or missing. This is not a
  // row that cannot be read: `loadReviewGateSurface` answers blocked where the
  // settled gate's pinned set is gone, and a read that throws rejects the load.
  it.each([
    ["null", null],
    ["missing", undefined],
  ])("a settled gate whose disposition is %s hands its targets the pending reading", async (_label, disposition) => {
    wireGate("resolved", disposition);
    for (const props of await load()) {
      expect(props.review).toEqual({ reading: "pending", openLive: null });
    }
  });
});

describe("(f) the artifact page dispatches every admitted row and hands every display the data road", () => {
  const PAGE = readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
  const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("carries no type check, no pointer resolver and no pointer boundary, and nothing of the pointer before the dispatch", () => {
    expect(CODE).not.toMatch(/isDashboardArtifactType/);
    expect(CODE).not.toMatch(/resolveDashboardArtifactPointer/);
    expect(CODE).not.toMatch(/DashboardPointerBoundary/);
    expect(CODE).not.toMatch(/DashboardPointerLoading|DashboardPointerError/);
    const dispatchAt = CODE.indexOf("resolveArtifactDisplayMount(");
    expect(dispatchAt).toBeGreaterThan(-1);
    // The pointer (cinatra#4311 deletes it) is drawn only after the dispatch, on its floor.
    for (const pointer of ["<DashboardPointerDetail", '"dashboard-pointer"', "typeGate.dashboardPointer"]) {
      expect(CODE.indexOf(pointer), pointer).toBeGreaterThan(dispatchAt);
    }
  });

  // What the reading holds is proven on the rendered page
  // (`core-data-road-artifact-page.test.tsx`); this pins that one snapshot carries both.
  it("its props snapshot passes the data road and the page's review reading", () => {
    const call = CODE.match(/const rendererProps = buildArtifactRendererProps\(\{[\s\S]*?\}\);/);
    expect(call).not.toBeNull();
    expect(call?.[0]).toMatch(/\bdata:/);
    expect(call?.[0]).toMatch(/\breview,/);
  });
});
