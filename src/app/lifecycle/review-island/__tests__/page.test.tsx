// The REVIEW-TARGET ISLAND (cinatra#2566, epic #2564 S2). Design:
// design@6c20871b4108176c1d0193f19ecd2947f6c6355f `specs/app-lifecycle-cards.html` §III.
//
// The island is the only reason §III's ladder can appear on a client-rendered
// host, so what it must never do is become a softer version of the review page's
// access path. These assertions pin exactly that: it re-decodes the ref itself,
// re-runs the reader's access through the SAME loader the page uses, draws every
// pinned target with the SAME panel, and answers every denial — no access, no
// gate, a garbage ref — with one indistinguishable empty document.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const getAuthSession = vi.fn();
const signInRedirectTarget = vi.fn(async () => "/sign-in");
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const resolveReviewActorContext = vi.fn();
const loadReviewGateSurface = vi.fn();
const resolveVerifiedWidgetFrameOrigin = vi.fn<(input: unknown) => string | null>(() => null);

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
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  () => ({ resolveReviewActorContext: () => resolveReviewActorContext() }),
);
// The target panel and the shipped skeleton are rendered, not exercised, here —
// they carry their own suites. Stubbed so this test does not drag the whole
// renderer-resolution graph into a node environment.
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel",
  () => ({ ReviewTargetPanel: () => null }),
);
vi.mock("@cinatra-ai/agents/review-gate-states", () => ({ ReviewGateLoading: () => null }));

import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

import ReviewTargetIslandPage from "../page";

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

const ACTOR = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};

function target(artifactId: string) {
  return {
    target: { artifactId, representationRevisionId: `${artifactId}-rev` },
    props: null,
    mount: { kind: "floor" as const },
  };
}

async function renderIsland(
  ref: string | undefined,
  extra: Record<string, string> = {},
) {
  return (await ReviewTargetIslandPage({
    searchParams: Promise.resolve(ref === undefined ? { ...extra } : { ref, ...extra }),
  })) as ReactElement;
}

/** The island's ONE empty answer, however it was reached. */
function isEmptyIsland(el: ReactElement): boolean {
  const props = el.props as { "data-conformance-id"?: string };
  return props["data-conformance-id"] === "review-target-island-empty";
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
  getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  resolveReviewActorContext.mockResolvedValue(ACTOR);
  signInRedirectTarget.mockResolvedValue("/sign-in");
});

describe("the island draws §III's ladder for the gate the ref names", () => {
  it("re-runs the reader's access through the SAME loader the page uses", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1")],
      pinnedCapturePairs: {},
      permissions: { canDecide: true, canComment: true },
    });
    await renderIsland(REF);
    expect(loadReviewGateSurface).toHaveBeenCalledWith({
      runId: "run-1",
      reviewTaskId: "task-1",
      actorCtx: ACTOR,
    });
  });

  it("renders EVERY pinned target as a sibling panel — the gate's whole set", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1"), target("a2"), target("a3")],
      pinnedCapturePairs: {},
      permissions: { canDecide: true, canComment: true },
    });
    const el = await renderIsland(REF);
    const props = el.props as { "data-target-count"?: number };
    expect(props["data-target-count"]).toBe(3);
  });

  it("carries NO decision chrome — the floor belongs to the card outside the frame", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: "drafted against the Q3 list",
      targets: [target("a1")],
      pinnedCapturePairs: {},
      permissions: { canDecide: true, canComment: true },
    });
    const el = await renderIsland(REF);
    expect(JSON.stringify(el)).not.toMatch(/review-decision-bar|approve-review|reject-review/);
  });
});

describe("every denial is the SAME empty document", () => {
  it("no ref", async () => {
    expect(isEmptyIsland(await renderIsland(undefined))).toBe(true);
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
  });

  it("a ref that does not decode never reaches the gate loader", async () => {
    expect(isEmptyIsland(await renderIsland("not-one-of-ours"))).toBe(true);
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
  });

  it("a ref minted under a different key does not decode", async () => {
    const original = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "another-secret";
    const foreign = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;
    process.env.BETTER_AUTH_SECRET = original;
    expect(isEmptyIsland(await renderIsland(foreign))).toBe(true);
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
  });

  it("not authorized draws the same emptiness as a gate that is not there", async () => {
    loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    const denied = await renderIsland(REF);
    loadReviewGateSurface.mockResolvedValue({ kind: "blocked", reason: "no-longer-pending" });
    const gone = await renderIsland(REF);
    expect(isEmptyIsland(denied)).toBe(true);
    expect(isEmptyIsland(gone)).toBe(true);
    // Byte-identical: the reader cannot tell which happened.
    expect(JSON.stringify(gone)).toBe(JSON.stringify(denied));
  });

  it("names nothing about the gate on any denial path", async () => {
    loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    const el = await renderIsland(REF);
    expect(JSON.stringify(el)).not.toMatch(/run-1|task-1|no-longer-pending/);
  });
});

describe("a session is required", () => {
  it("redirects an unauthenticated frame to sign-in rather than rendering blank forever", async () => {
    getAuthSession.mockResolvedValue(null);
    await expect(renderIsland(REF)).rejects.toThrow(/REDIRECT:\/sign-in/);
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
  });

  it("redirects when the actor context cannot be resolved", async () => {
    resolveReviewActorContext.mockResolvedValue(null);
    await expect(renderIsland(REF)).rejects.toThrow(/REDIRECT:\/sign-in/);
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2577 — inside a VERIFIED widget frame, a missing session draws the
// empty island instead of redirecting.
//
// Codex round 1, finding 4: `frame-ancestors` on a 307 is not inherited by the
// document the browser fetches next, and /sign-in declares no framing policy of
// its own — so the redirect put Cinatra's interactive sign-in form inside chrome
// a third-party site controls, which a reader cannot tell from the real thing.
// It is also pointless there: the widget reader signs in through the hosted
// popup, never a form in a nested frame.
// ---------------------------------------------------------------------------
describe("a widget frame is never sent to an interactive sign-in", () => {
  const WIDGET = { assistant: "wordpress", instanceId: "inst-1" };

  beforeEach(() => {
    resolveVerifiedWidgetFrameOrigin.mockReturnValue("https://site.example");
  });

  it("no session → the SAME empty island every other denial draws", async () => {
    getAuthSession.mockResolvedValue(null);
    const el = await renderIsland(REF, WIDGET);
    expect(isEmptyIsland(el)).toBe(true);
    expect(redirect).not.toHaveBeenCalled();
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
  });

  it("an unresolvable actor (expired / revoked / no standing) draws the same emptiness", async () => {
    resolveReviewActorContext.mockResolvedValue(null);
    const el = await renderIsland(REF, WIDGET);
    expect(isEmptyIsland(el)).toBe(true);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("is byte-identical to the not-authorized denial — no oracle", async () => {
    getAuthSession.mockResolvedValue(null);
    const noSession = await renderIsland(REF, WIDGET);
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    const denied = await renderIsland(REF, WIDGET);
    expect(JSON.stringify(noSession)).toBe(JSON.stringify(denied));
  });

  it("resolves the frame from the SERVER's binding, not from the query", async () => {
    getAuthSession.mockResolvedValue(null);
    await renderIsland(REF, WIDGET);
    expect(resolveVerifiedWidgetFrameOrigin).toHaveBeenCalledWith({
      assistant: "wordpress",
      instanceId: "inst-1",
    });
  });

  it("an UNVERIFIED frame keeps the first-party sign-in redirect", async () => {
    // The selectors are present but the server does not vouch for them.
    resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
    getAuthSession.mockResolvedValue(null);
    await expect(renderIsland(REF, WIDGET)).rejects.toThrow(/REDIRECT:\/sign-in/);
  });
});
