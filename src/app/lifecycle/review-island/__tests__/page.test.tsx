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
// cinatra#2754 — the credential path's own ladder. It carries its own suite
// (`src/lib/lifecycle/__tests__/review-island-serving.test.ts`, which pins every
// refusal against live rows); what this suite pins is what the PAGE does with
// each of its two answers.
const resolveIslandCredentialReader = vi.fn();

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

import {
  islandBodyClassName,
  islandDocumentGroundCss,
  parseIslandColorScheme,
  REVIEW_ISLAND_COLOR_SCHEME_PARAM,
} from "../island-color-scheme";
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

/** Every target panel the island put in its tree, with the props it handed it.
 * cinatra#2931 W4: the panel's organization scope must come from the reader the
 * island just authorized, so the test reads what was actually passed. */
function panelProps(el: ReactElement): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const props = (node as { props?: Record<string, unknown> }).props;
    if (!props) return;
    if ("prepared" in props) found.push(props);
    walk(props.children);
    walk(props.fallback);
  };
  walk(el);
  return found;
}

/** The island's ONE empty answer, however it was reached. */
function isEmptyIsland(el: ReactElement): boolean {
  const props = el.props as { "data-conformance-id"?: string };
  return props["data-conformance-id"] === "review-target-island-empty";
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
  resolveIslandCredentialReader.mockResolvedValue(null);
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

  it("hands each panel the TRUSTED organization scope of the reader it authorized", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1"), target("a2")],
      pinnedCapturePairs: {},
      permissions: { canDecide: true, canComment: true },
    });
    const el = await renderIsland(REF);
    const panels = panelProps(el);
    expect(panels).toHaveLength(2);
    for (const p of panels) expect(p.orgId).toBe(ACTOR.orgId);
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

// "A resolved gate opens read-only: what was decided, and the reviewed
// target(s), kept for the run's audit trail." The decided card frames this same
// island, so this document draws a resolved gate's frozen set exactly as it
// draws a pending one's — with no decision chrome on either reading.
describe("a DECIDED gate keeps its reviewed target(s), read-only", () => {
  function settledSurface(targets: ReturnType<typeof target>[]) {
    return { kind: "settled", agentSummary: null, targets, pinnedCapturePairs: {} };
  }

  it("draws every pinned target the decision was taken on — never an empty document", async () => {
    loadReviewGateSurface.mockResolvedValue(settledSurface([target("a1"), target("a2")]));
    const el = await renderIsland(REF);
    expect(isEmptyIsland(el)).toBe(false);
    const props = el.props as Record<string, unknown>;
    expect(props["data-target-count"]).toBe(2);
    expect(props["data-review-reading"]).toBe("decided");
    expect(panelProps(el)).toHaveLength(2);
  });

  it("hands the decided panels the same TRUSTED organization scope", async () => {
    loadReviewGateSurface.mockResolvedValue(settledSurface([target("a1")]));
    const el = await renderIsland(REF);
    for (const p of panelProps(el)) expect(p.orgId).toBe(ACTOR.orgId);
  });

  it("carries NO decision chrome on the decided reading either", async () => {
    loadReviewGateSurface.mockResolvedValue(settledSurface([target("a1")]));
    const el = await renderIsland(REF);
    expect(JSON.stringify(el)).not.toMatch(/review-decision-bar|approve-review|reject-review/);
  });

  it("names the PENDING reading on a still-open gate", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1")],
      pinnedCapturePairs: {},
      permissions: { canDecide: true, canComment: true },
    });
    const el = await renderIsland(REF);
    expect((el.props as Record<string, unknown>)["data-review-reading"]).toBe("pending");
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

// ---------------------------------------------------------------------------
// cinatra#2754 — the credential the frame arrives with
// ---------------------------------------------------------------------------
//
// On a genuinely third-party page the frame load carries no cookie, so the
// credential travels in the URL. It AUTHENTICATES and nothing more: the gate
// comes from the credential rather than a second decode of the ref, and the
// reader's real access is still re-run through the same loader every other path
// here uses. Every refusal — forged, tampered, expired, revoked, bound to
// another gate — is the one empty island, never an error and never a redirect.

describe("a frame that presents an island credential", () => {
  const CREDENTIAL = "AAAA-sealed_value-BBBB";

  it("paints the gate the CREDENTIAL names, through the SAME loader", async () => {
    resolveIslandCredentialReader.mockResolvedValue({
      actorCtx: ACTOR,
      runId: "run-1",
      reviewTaskId: "task-1",
    });
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      targets: [target("a1")],
      pinnedCapturePairs: {},
      agentSummary: null,
    });
    const el = await renderIsland(REF, { ic: CREDENTIAL });
    expect(resolveIslandCredentialReader).toHaveBeenCalledWith({
      credential: CREDENTIAL,
      ref: REF,
    });
    expect(loadReviewGateSurface).toHaveBeenCalledWith({
      runId: "run-1",
      reviewTaskId: "task-1",
      actorCtx: ACTOR,
    });
    expect(isEmptyIsland(el)).toBe(false);
  });

  it("never consults the cookie session on this path", async () => {
    resolveIslandCredentialReader.mockResolvedValue({
      actorCtx: ACTOR,
      runId: "run-1",
      reviewTaskId: "task-1",
    });
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      targets: [],
      pinnedCapturePairs: {},
      agentSummary: null,
    });
    await renderIsland(REF, { ic: CREDENTIAL });
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(resolveReviewActorContext).not.toHaveBeenCalled();
  });

  it("a REFUSED credential (forged, tampered, expired, revoked) draws the empty island", async () => {
    resolveIslandCredentialReader.mockResolvedValue(null);
    const el = await renderIsland(REF, { ic: CREDENTIAL });
    expect(isEmptyIsland(el)).toBe(true);
    // It never reaches the gate loader, and it never redirects.
    expect(loadReviewGateSurface).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("is byte-identical to every other denial — a refused credential is no oracle", async () => {
    resolveIslandCredentialReader.mockResolvedValue(null);
    const refused = await renderIsland(REF, { ic: CREDENTIAL });
    loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    const notAuthorized = await renderIsland(REF);
    expect(JSON.stringify(refused.props)).toBe(JSON.stringify(notAuthorized.props));
  });

  it("does NOT redirect a credentialed request that has no session", async () => {
    getAuthSession.mockResolvedValue(null);
    resolveIslandCredentialReader.mockResolvedValue(null);
    const el = await renderIsland(REF, { ic: CREDENTIAL });
    expect(isEmptyIsland(el)).toBe(true);
    expect(redirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2931 (epic #2926 W4) — the island paints in its HOST's palette
// ---------------------------------------------------------------------------
//
// The card that frames this document names the palette the HOST is painting in,
// because a nested document cannot see the surface around it and the one it
// resolves for itself is right only where its theme state happens to be the
// app's. This is the server half: what the page does with what it was told,
// including for a refusal — a denial inside a dark card is a painted rectangle
// too, and every denial must still be the same one.

describe("the island paints in the palette the host named", () => {
  const ready = () =>
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1")],
      pinnedCapturePairs: {},
      permissions: { canDecide: true, canComment: true },
    });

  const classOf = (el: ReactElement): string | undefined =>
    (el.props as { className?: string }).className;

  it("reads the parameter the card writes", () => {
    expect(REVIEW_ISLAND_COLOR_SCHEME_PARAM).toBe("scheme");
  });

  it("carries the DARK palette onto the body it draws the ladder in", async () => {
    ready();
    const el = await renderIsland(REF, { scheme: "dark" });
    expect(classOf(el)).toBe(islandBodyClassName("dark"));
    expect(classOf(el)).toMatch(/(^| )dark( |$)/);
    expect((el.props as { "data-island-color-scheme"?: string })["data-island-color-scheme"]).toBe(
      "dark",
    );
  });

  // The RE-ANCHORED INK. `body` computes its colour from the token as the
  // DOCUMENT root sees it and every descendant inherits that computed value, so
  // redefining the token on a wrapper alone leaves the renderer's own unstyled
  // prose in the document's ink — dark text on a dark panel, which is a
  // different reading of the very defect this slice closes. The class is the
  // structural pin for that; a cascade cannot be measured here.
  it("re-anchors the ink inside the palette it painted", async () => {
    ready();
    for (const scheme of ["dark", "light"] as const) {
      const el = await renderIsland(REF, { scheme });
      expect(classOf(el)).toMatch(/(^| )text-foreground( |$)/);
      expect(classOf(el)).toMatch(/(^| )min-h-dvh( |$)/);
    }
  });

  // The document's own ground — the frame's scrollbar and the canvas an
  // overscroll exposes — is outside any wrapper, so the page states it. The
  // values come from the closed enum, never from the request's text.
  it("hands the document's own ground to the same palette", async () => {
    ready();
    const el = await renderIsland(REF, { scheme: "dark" });
    expect(JSON.stringify(el)).toContain(islandDocumentGroundCss("dark"));
    expect(islandDocumentGroundCss("dark")).toBe(
      ":root{color-scheme:dark}body{background:transparent}",
    );
    expect(islandDocumentGroundCss(null)).toBeNull();
  });

  it("states no ground rule at all when the host names no palette", async () => {
    ready();
    const el = await renderIsland(REF, {});
    expect(JSON.stringify(el)).not.toContain("color-scheme");
  });

  it("carries the LIGHT palette as the app's own light palette class", async () => {
    ready();
    const el = await renderIsland(REF, { scheme: "light" });
    expect(classOf(el)).toBe(islandBodyClassName("light"));
    expect(classOf(el)).toMatch(/(^| )cinatra( |$)/);
  });

  it("draws exactly what it drew before when the host names no palette", async () => {
    ready();
    const named = await renderIsland(REF, {});
    expect(classOf(named)).toBe("flex flex-col gap-3 bg-surface p-3");
    expect(
      (named.props as { "data-island-color-scheme"?: string })["data-island-color-scheme"],
    ).toBeUndefined();
  });

  it("refuses an unknown palette word rather than putting it in a class", async () => {
    ready();
    for (const junk of ["", "DARK", "cinatra", "system", "dark ", "'/><script>"]) {
      expect(parseIslandColorScheme(junk)).toBeNull();
      const el = await renderIsland(REF, { scheme: junk });
      expect(classOf(el)).toBe("flex flex-col gap-3 bg-surface p-3");
    }
  });

  it("paints a DENIAL in the same palette — and every denial in the same one", async () => {
    loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    const denials = [
      await renderIsland(REF, { scheme: "dark" }),
      await renderIsland("not-one-of-ours", { scheme: "dark" }),
      await renderIsland(undefined, { scheme: "dark" }),
    ];
    for (const el of denials) {
      expect(isEmptyIsland(el)).toBe(true);
      expect(classOf(el)).toMatch(/(^| )dark( |$)/);
    }
    const shapes = new Set(denials.map((el) => JSON.stringify(el.props)));
    expect(shapes.size).toBe(1);
  });
});
