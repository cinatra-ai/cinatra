// THE ISLAND'S DATA ROAD, BRANCH BY BRANCH (cinatra#4311).
//
// The lifecycle card's cookie-session hosts (the chat thread, the run card and
// the page gate region) frame this island with NO credential, so its reader
// there is a session-cookie reader, exactly like the review page's. That reader
// is handed the session data road. The credential reader (the widget) holds no
// cookie, so its branch names none: its sealed data road is a later leg, and
// its display draws its own no-series reading.
//
// Every assertion reads the roads the REAL page hands the REAL road builders'
// output to the gate loader; only the loader, the session and the credential
// resolver are stubbed (they carry their own suites).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const getAuthSession = vi.fn();
const signInRedirectTarget = vi.fn(async () => "/sign-in");
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const resolveReviewActorContext = vi.fn();
const loadReviewGateSurface = vi.fn();
const resolveVerifiedWidgetFrameOrigin = vi.fn<(input: unknown) => string | null>(() => null);
const resolveIslandCredentialReader = vi.fn();
const mintPreview = vi.fn<(input: unknown) => { preview: string | null; download: string | null } | null>();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  signInRedirectTarget: () => signInRedirectTarget(),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/embed/frame-ancestors.server", () => ({
  resolveVerifiedWidgetFrameOrigin: (input: unknown) => resolveVerifiedWidgetFrameOrigin(input),
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  loadReviewGateSurface: (args: unknown) => loadReviewGateSurface(args),
}));
vi.mock("@/lib/lifecycle/review-island-serving", () => ({
  resolveIslandCredentialReader: (args: unknown) => resolveIslandCredentialReader(args),
}));
// The island's capability minter: what this suite reads is WHICH roads the page
// names, so the minter answers the page's one probe and nothing is sealed.
vi.mock("@/lib/lifecycle/review-island-byte-road", () => ({
  buildIslandArtifactByteMinter: () => (input: unknown) => mintPreview(input),
}));
vi.mock("@/lib/lifecycle/widget-capture-egress", () => ({
  buildBrokerCapturePair: () => null,
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  () => ({ resolveReviewActorContext: () => resolveReviewActorContext() }),
);
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel",
  () => ({ ReviewTargetPanel: () => createElement("div", null, "panel") }),
);
vi.mock("@cinatra-ai/agents/review-gate-states", () => ({
  ReviewGateLoading: () => createElement("div", null, "island-panel-loading"),
}));

import { ARTIFACT_RENDERER_SESSION_DATA_ROAD } from "@/lib/artifacts/artifact-renderer-props";
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import ReviewTargetIslandPage from "../page";

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;
const CREDENTIAL = "AAAA-sealed_value-BBBB";
const ACTOR = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};
const PRINCIPAL = { orgId: "org-1", widgetUserId: "cwu_1" };

async function renderIsland(extra: Record<string, string> = {}) {
  return ReviewTargetIslandPage({ searchParams: Promise.resolve({ ref: REF, ...extra }) });
}

/** The roads argument the page handed the gate loader, and whether the key was present at all. */
function loaderRoads(): { present: boolean; roads: Record<string, unknown> | undefined } {
  expect(loadReviewGateSurface).toHaveBeenCalledTimes(1);
  const args = loadReviewGateSurface.mock.calls[0][0] as Record<string, unknown>;
  return {
    present: Object.prototype.hasOwnProperty.call(args, "roads"),
    roads: args.roads as Record<string, unknown> | undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
  resolveIslandCredentialReader.mockResolvedValue(null);
  getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  resolveReviewActorContext.mockResolvedValue(ACTOR);
  mintPreview.mockReturnValue({ preview: "/sealed/preview", download: null });
  loadReviewGateSurface.mockResolvedValue({ kind: "ready", agentSummary: null, targets: [] });
});

describe("the COOKIE branch hands the session data road (the card's cookie-session hosts)", () => {
  it("a first-party frame with no credential: the loader is handed the session data road", async () => {
    await renderIsland();
    const { present, roads } = loaderRoads();
    expect(present).toBe(true);
    expect(roads?.dataRoad).toEqual(ARTIFACT_RENDERER_SESSION_DATA_ROAD);
  });

  it("names the data road and NOTHING else: bytes, content and the capture pair stay as they were", async () => {
    await renderIsland();
    const { roads } = loaderRoads();
    expect(Object.keys(roads ?? {})).toEqual(["dataRoad"]);
  });

  it("a same-site widget frame that sends no credential reads by its cookie too, and is handed the road", async () => {
    resolveVerifiedWidgetFrameOrigin.mockReturnValue("https://cms.example");
    await renderIsland({ assistant: "a1", instanceId: "i1" });
    const { roads } = loaderRoads();
    expect(roads?.dataRoad).toEqual(ARTIFACT_RENDERER_SESSION_DATA_ROAD);
  });

  it("a decided gate is loaded with the same road (the settled reading draws the same panels)", async () => {
    loadReviewGateSurface.mockResolvedValue({ kind: "settled", agentSummary: null, targets: [] });
    await renderIsland();
    const { roads } = loaderRoads();
    expect(roads?.dataRoad).toEqual(ARTIFACT_RENDERER_SESSION_DATA_ROAD);
  });
});

describe("the CREDENTIAL branch names no data road (no cookie; the sealed road is a later leg)", () => {
  it("a sealable credential reader: the island's sealed roads, and no dataRoad key", async () => {
    resolveIslandCredentialReader.mockResolvedValue({
      actorCtx: ACTOR,
      runId: "run-1",
      reviewTaskId: "task-1",
      principal: PRINCIPAL,
    });
    await renderIsland({ ic: CREDENTIAL });
    const { present, roads } = loaderRoads();
    expect(present).toBe(true);
    expect(typeof roads?.byteMinter).toBe("function");
    expect(Object.prototype.hasOwnProperty.call(roads ?? {}, "dataRoad")).toBe(false);
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("an unsealable credential reader: no roads at all, so no data road", async () => {
    mintPreview.mockReturnValue(null);
    resolveIslandCredentialReader.mockResolvedValue({
      actorCtx: ACTOR,
      runId: "run-1",
      reviewTaskId: "task-1",
      principal: PRINCIPAL,
    });
    await renderIsland({ ic: CREDENTIAL });
    expect(loaderRoads().present).toBe(false);
  });

  it("a credential reader with no principal: no roads at all, so no data road", async () => {
    resolveIslandCredentialReader.mockResolvedValue({ actorCtx: ACTOR, runId: "run-1", reviewTaskId: "task-1" });
    await renderIsland({ ic: CREDENTIAL });
    expect(loaderRoads().present).toBe(false);
  });
});
