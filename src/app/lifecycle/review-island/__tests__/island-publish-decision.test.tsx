// cinatra#4150 W4 C1b: THE ISLAND PAINTS A PUBLISH CARD'S ARTIFACTS ROW.
//
// The same document, the same panels and the same one empty answer; only the loader differs. Pinned here:
//   - the cookie branch: a publish-family ref goes to the publish loader with the row it names, and NEVER to the gate
//     loader; a gate ref still goes to the gate loader, unchanged;
//   - the credential branch: the row comes from the resolver (proven equal to the ref there), and a publish row names
//     no sealed road (the sealed byte serving re-proves a gate's set, which a publish row has not);
//   - a refusal from the publish loader is the one empty island; a ready answer draws its targets as panels, read as
//     decided or pending from the loader's own answer.
// Red first: at C1's head the page knows no publish ref (it draws the empty island and calls no publish loader).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const getAuthSession = vi.fn();
const signInRedirectTarget = vi.fn(async () => "/sign-in");
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const resolveReviewActorContext = vi.fn();
const loadReviewGateSurface = vi.fn();
const loadPublishDecisionIslandSurface = vi.fn();
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
vi.mock("@/lib/lifecycle/publish-decision-island", () => ({
  loadPublishDecisionIslandSurface: (args: unknown) => loadPublishDecisionIslandSurface(args),
}));
vi.mock("@/lib/lifecycle/review-island-serving", () => ({
  resolveIslandCredentialReader: (args: unknown) => resolveIslandCredentialReader(args),
}));
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

import { encodeLifecycleGateRef, encodePublishDecisionIslandRef } from "@/lib/lifecycle/lifecycle-card-ref";
import ReviewTargetIslandPage from "../page";

const ROW = { runId: "run-1", decisionId: "dec-1", input: "reviewTargets" };
// The publish ref is computed inside the tests (beforeEach), so before the fix this file loads and every test fails
// on the missing encoder.
// red-first-expect: encodePublishDecisionIslandRef
let PUBLISH_REF: string;
const GATE_REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;
const CREDENTIAL = "AAAA-sealed_value-BBBB";
const ACTOR = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};
const PRINCIPAL = { orgId: "org-1", widgetUserId: "cwu_1" };

function target(artifactId: string) {
  const prepared = { target: { artifactId, representationRevisionId: `${artifactId}-rev` }, props: null, mount: { kind: "floor" as const } };
  return { target: prepared.target, prepared: Promise.resolve(prepared), capturePair: Promise.resolve(null) };
}

async function renderIsland(ref: string, extra: Record<string, string> = {}) {
  return (await ReviewTargetIslandPage({ searchParams: Promise.resolve({ ref, ...extra }) })) as ReactElement;
}

const isEmptyIsland = (el: ReactElement) =>
  (el.props as { "data-conformance-id"?: string })["data-conformance-id"] === "review-target-island-empty";
const bodyProps = (el: ReactElement) => el.props as Record<string, unknown>;

beforeEach(() => {
  PUBLISH_REF = encodePublishDecisionIslandRef(ROW)!;
  vi.clearAllMocks();
  resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
  resolveIslandCredentialReader.mockResolvedValue(null);
  getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  resolveReviewActorContext.mockResolvedValue(ACTOR);
  mintPreview.mockReturnValue({ preview: "/sealed/preview", download: null });
  loadReviewGateSurface.mockResolvedValue({ kind: "ready", agentSummary: null, targets: [] });
  loadPublishDecisionIslandSurface.mockResolvedValue({ kind: "ready", decided: false, targets: [target("a1"), target("a2")] });
});

describe("the cookie branch", () => {
  it("a publish ref goes to the publish loader with the row it names, never to the gate loader", async () => {
    const el = await renderIsland(PUBLISH_REF);
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
    expect(loadPublishDecisionIslandSurface).toHaveBeenCalledTimes(1);
    const args = loadPublishDecisionIslandSurface.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ runId: "run-1", decisionId: "dec-1", input: "reviewTargets", actorCtx: ACTOR });
    // The cookie reader's own roads, as a gate's cookie reader gets them.
    expect(Object.keys((args.roads as object) ?? {}).sort()).toEqual(["dashboardLiveAddress", "dataRoad"]);
    expect(isEmptyIsland(el)).toBe(false);
    expect(bodyProps(el)["data-target-count"]).toBe(2);
    expect(bodyProps(el)["data-review-reading"]).toBe("pending");
  });

  it("a decided publish row reads as decided", async () => {
    loadPublishDecisionIslandSurface.mockResolvedValue({ kind: "ready", decided: true, targets: [target("a1")] });
    const el = await renderIsland(PUBLISH_REF);
    expect(bodyProps(el)["data-review-reading"]).toBe("decided");
  });

  it("a refusal from the publish loader is the one empty island", async () => {
    loadPublishDecisionIslandSurface.mockResolvedValue({ kind: "refused" });
    expect(isEmptyIsland(await renderIsland(PUBLISH_REF))).toBe(true);
  });

  it("a gate ref still goes to the gate loader, and never to the publish loader", async () => {
    await renderIsland(GATE_REF);
    expect(loadReviewGateSurface).toHaveBeenCalledTimes(1);
    expect(loadReviewGateSurface.mock.calls[0][0]).toMatchObject({ runId: "run-1", reviewTaskId: "task-1" });
    expect(loadPublishDecisionIslandSurface).not.toHaveBeenCalled();
  });

  it("a ref of neither family is the empty island, and no loader runs", async () => {
    expect(isEmptyIsland(await renderIsland("bm90LWEtcmVm"))).toBe(true);
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
    expect(loadPublishDecisionIslandSurface).not.toHaveBeenCalled();
  });

  it("a publish ref with no session is sent to sign-in first-party, and is empty inside a widget", async () => {
    getAuthSession.mockResolvedValue(null);
    await expect(renderIsland(PUBLISH_REF)).rejects.toThrow("REDIRECT:/sign-in");
    resolveVerifiedWidgetFrameOrigin.mockReturnValue("https://cms.example");
    expect(isEmptyIsland(await renderIsland(PUBLISH_REF, { assistant: "a1", instanceId: "i1" }))).toBe(true);
    expect(loadPublishDecisionIslandSurface).not.toHaveBeenCalled();
  });
});

describe("the credential branch", () => {
  it("the row comes from the resolver, and a publish row names no sealed road", async () => {
    resolveIslandCredentialReader.mockResolvedValue({
      actorCtx: ACTOR,
      runId: "run-1",
      reviewTaskId: "publish-decision:sealed",
      publishDecision: { decisionId: "dec-1", input: "reviewTargets" },
      principal: PRINCIPAL,
    });
    const el = await renderIsland(PUBLISH_REF, { ic: CREDENTIAL });
    expect(resolveIslandCredentialReader).toHaveBeenCalledWith({ credential: CREDENTIAL, ref: PUBLISH_REF });
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
    const args = loadPublishDecisionIslandSurface.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ runId: "run-1", decisionId: "dec-1", input: "reviewTargets", actorCtx: ACTOR });
    expect(Object.prototype.hasOwnProperty.call(args, "roads")).toBe(false);
    expect(mintPreview).not.toHaveBeenCalled();
    expect(isEmptyIsland(el)).toBe(false);
  });

  it("a refused credential is the empty island, and no loader runs", async () => {
    expect(isEmptyIsland(await renderIsland(PUBLISH_REF, { ic: CREDENTIAL }))).toBe(true);
    expect(loadPublishDecisionIslandSurface).not.toHaveBeenCalled();
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
  });

  // pre-1 MUST-FIX 4: the reader's kind is read, never presumed. A reader that names neither a gate (null) nor a
  // publish row is not taken for a gate: it draws the one empty island. So a reader double without the field fails.
  it.each([
    ["no publishDecision field", {}],
    ["an undefined publishDecision", { publishDecision: undefined }],
    ["a publishDecision with no input", { publishDecision: { decisionId: "dec-1" } }],
    ["a publishDecision that is a string", { publishDecision: "dec-1" }],
  ])("a reader with %s draws the empty island, and no loader runs", async (_name, kind) => {
    resolveIslandCredentialReader.mockResolvedValue({
      actorCtx: ACTOR,
      runId: "run-1",
      reviewTaskId: "task-1",
      principal: PRINCIPAL,
      ...kind,
    });
    expect(isEmptyIsland(await renderIsland(GATE_REF, { ic: CREDENTIAL }))).toBe(true);
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
    expect(loadPublishDecisionIslandSurface).not.toHaveBeenCalled();
  });

  it("a gate credential reader (no publish row) keeps the gate loader and its sealed roads", async () => {
    resolveIslandCredentialReader.mockResolvedValue({
      actorCtx: ACTOR,
      runId: "run-1",
      reviewTaskId: "task-1",
      publishDecision: null,
      principal: PRINCIPAL,
    });
    await renderIsland(GATE_REF, { ic: CREDENTIAL });
    expect(loadPublishDecisionIslandSurface).not.toHaveBeenCalled();
    const args = loadReviewGateSurface.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof (args.roads as { byteMinter?: unknown }).byteMinter).toBe("function");
  });
});
