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
import { Suspense, createElement, type ReactElement } from "react";

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
// cinatra#3334 — both stubs now draw a MARKER instead of nothing: the streaming
// assertion below has to be able to tell a target that is already in the
// document from one that is still behind its own boundary's fallback.
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel",
  () => ({
    ReviewTargetPanel: ({ prepared }: { prepared: { target: { artifactId: string } } }) =>
      createElement("div", null, `panel:${prepared.target.artifactId}`),
  }),
);
vi.mock("@cinatra-ai/agents/review-gate-states", () => ({
  ReviewGateLoading: () => createElement("div", null, "island-panel-loading"),
}));

import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { reviewTargetStreamKey } from "@cinatra-ai/agent-ui-protocol/renderable-views";

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

/**
 * One target of the STREAMING surface (cinatra#3334): the loader hands the page
 * the target's identity and the promises of its preparation and its pinned
 * capture, so the page can open a boundary per target the moment the preflight
 * is through instead of waiting for the whole set.
 */
function target(artifactId: string) {
  const prepared = {
    target: { artifactId, representationRevisionId: `${artifactId}-rev` },
    props: null,
    mount: { kind: "floor" as const },
  };
  return {
    target: prepared.target,
    prepared: Promise.resolve(prepared),
    capturePair: Promise.resolve(null),
  };
}

/** A target whose preparation is still running — it never settles. */
function pendingTarget(artifactId: string) {
  return {
    target: { artifactId, representationRevisionId: `${artifactId}-rev` },
    prepared: new Promise<never>(() => {}),
    capturePair: Promise.resolve(null),
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
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
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
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
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
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
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
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
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
    return { kind: "settled", agentSummary: null, targets };
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
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
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

  // cinatra#4129 — the widget frames one island per pinned target of a gate
  // that pins several, each at its own single-use address naming its target.
  it("a credentialed frame that names one pinned target draws that target alone", async () => {
    resolveIslandCredentialReader.mockResolvedValue({
      actorCtx: ACTOR,
      runId: "run-1",
      reviewTaskId: "task-1",
    });
    const targets = [target("a1"), target("a2")];
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets,
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
    });
    const el = await renderIsland(REF, {
      ic: CREDENTIAL,
      target: targets[0].target.representationRevisionId,
    });
    expect(resolveIslandCredentialReader).toHaveBeenCalledWith({ credential: CREDENTIAL, ref: REF });
    expect(isEmptyIsland(el)).toBe(false);
    expect((el.props as Record<string, unknown>)["data-target-count"]).toBe(1);
    const panels = panelProps(el);
    expect(panels).toHaveLength(1);
    expect(panels[0].prepared).toBe(targets[0].prepared);
    expect(panels.some((p) => p.prepared === targets[1].prepared)).toBe(false);
  });
});

// cinatra#4129 — THE ISLAND'S OWN SELECTOR FAILS CLOSED. The island is
// addressable on its own (a direct, a stale or an older client's URL), so it
// never leans on the card's pairs rule: a present `target` draws a target only
// when it is ONE name within the key bound and EXACTLY ONE pinned target
// answers to it. Anything else is the one empty document, never the whole set.
describe("the island's target selector names exactly one pinned target, or draws nothing", () => {
  /** One target of the surface whose pinned revision id is `revision`. */
  function pinned(artifactId: string, revision: string) {
    const prepared = {
      target: { artifactId, representationRevisionId: revision },
      props: null,
      mount: { kind: "floor" as const },
    };
    return {
      target: prepared.target,
      prepared: Promise.resolve(prepared),
      capturePair: Promise.resolve(null),
    };
  }
  function surfaceOf(targets: Array<ReturnType<typeof pinned>>) {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets,
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
    });
  }

  it("a name that two pinned targets of different artifacts share draws NEITHER", async () => {
    surfaceOf([pinned("a1", "rev-shared"), pinned("a2", "rev-shared"), pinned("a3", "rev-own")]);
    expect(isEmptyIsland(await renderIsland(REF, { target: "rev-shared" }))).toBe(true);
    // The name only one pin carries still draws that one.
    const el = await renderIsland(REF, { target: "rev-own" });
    expect(isEmptyIsland(el)).toBe(false);
    expect(panelProps(el)).toHaveLength(1);
  });

  it("a REPEATED target parameter is invalid: the empty document, never the whole set", async () => {
    surfaceOf([pinned("a1", "rev-one"), pinned("a2", "rev-two")]);
    for (const repeated of [["rev-one", "rev-two"], ["rev-one", "rev-one"]]) {
      const el = (await ReviewTargetIslandPage({
        searchParams: Promise.resolve({ ref: REF, target: repeated }),
      })) as ReactElement;
      expect(isEmptyIsland(el), JSON.stringify(repeated)).toBe(true);
      expect(panelProps(el)).toHaveLength(0);
    }
    // An absent parameter still draws the gate's whole set.
    expect(panelProps(await renderIsland(REF))).toHaveLength(2);
  });

  it("an EMPTY target parameter is invalid", async () => {
    surfaceOf([pinned("a1", "rev-one"), pinned("a2", "rev-two")]);
    expect(isEmptyIsland(await renderIsland(REF, { target: "" }))).toBe(true);
  });

  it("a dot segment or ill-formed text is invalid, even where a pin carries exactly that id", async () => {
    for (const id of [".", "..", "rev_\uD800"]) {
      surfaceOf([pinned("a1", id), pinned("a2", "rev-two")]);
      const el = await renderIsland(REF, { target: id });
      expect(isEmptyIsland(el), JSON.stringify(id)).toBe(true);
      expect(panelProps(el), JSON.stringify(id)).toHaveLength(0);
    }
  });

  it("the selector is read within the key bound: 128 characters draw, 129 never do", async () => {
    const at = "r".repeat(128);
    const past = "s".repeat(129);
    surfaceOf([pinned("a1", at), pinned("a2", past)]);
    const drawnAt = await renderIsland(REF, { target: at });
    expect(isEmptyIsland(drawnAt)).toBe(false);
    expect(panelProps(drawnAt)).toHaveLength(1);
    expect(isEmptyIsland(await renderIsland(REF, { target: past }))).toBe(true);
  });

  it("each drawn target has its own boundary key, even where two capture keys read alike", async () => {
    // `artifactId:revision` reads "a:b:c" for both of these pins.
    surfaceOf([pinned("a:b", "c"), pinned("a", "b:c")]);
    const el = await renderIsland(REF);
    const keys: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (!node || typeof node !== "object") return;
      const element = node as { type?: unknown; key?: unknown; props?: { children?: unknown } };
      if (element.type === Suspense) keys.push(element.key);
      walk(element.props?.children);
    };
    walk(el);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // The keys are the section's own stream keys, never a key built here.
    expect(keys).toEqual([
      reviewTargetStreamKey(0, { artifactId: "a:b", representationRevisionId: "c" }),
      reviewTargetStreamKey(1, { artifactId: "a", representationRevisionId: "b:c" }),
    ]);
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
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
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
    expect(classOf(named)).toBe("flex min-w-0 flex-col gap-3 overflow-x-auto bg-surface p-3");
    expect(
      (named.props as { "data-island-color-scheme"?: string })["data-island-color-scheme"],
    ).toBeUndefined();
  });

  it("refuses an unknown palette word rather than putting it in a class", async () => {
    ready();
    for (const junk of ["", "DARK", "cinatra", "system", "dark ", "'/><script>"]) {
      expect(parseIslandColorScheme(junk)).toBeNull();
      const el = await renderIsland(REF, { scheme: junk });
      expect(classOf(el)).toBe("flex min-w-0 flex-col gap-3 overflow-x-auto bg-surface p-3");
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

// ---------------------------------------------------------------------------
// cinatra#3334 — EVERY TARGET STREAMS ON ITS OWN.
//
// The island used to await the whole prepared set before it built a single
// boundary, so the `Suspense` wrappers were decoration: nothing could ever be
// pending inside one. The loader now returns as soon as the authorization, gate
// and substitution preflight is through and hands the page one promise per
// target, so a target that is ready paints while its siblings are still being
// prepared — which is what keeps a multi-target gate inside the card's bounds.
// ---------------------------------------------------------------------------

/** The document's SHELL: everything React can emit before it has to wait for a
 *  boundary — the prepared panels, and the fallbacks of the unprepared ones. */
async function shellHtml(el: ReactElement): Promise<string> {
  const { renderToPipeableStream } = await import("react-dom/server");
  const { Writable } = await import("node:stream");
  return await new Promise<string>((resolve, reject) => {
    let html = "";
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        html += String(chunk);
        callback();
      },
    });
    sink.on("finish", () => resolve(html));
    const stream = renderToPipeableStream(el, {
      onShellReady() {
        stream.pipe(sink);
        // A target that never finishes preparing would keep the render open for
        // ever; the shell is what this asserts on, so the rest is abandoned.
        setTimeout(() => stream.abort(), 0);
      },
      onShellError: reject,
      onError() {},
    });
  });
}

describe("each target streams under its OWN boundary (cinatra#3334)", () => {
  it("draws a prepared target's panel while an unprepared one is still showing its fallback", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1"), pendingTarget("a2")],
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
    });

    const html = await shellHtml(await renderIsland(REF));

    // The prepared one is in the document …
    expect(html).toContain("panel:a1");
    // … the unprepared one is its own boundary's fallback, not the document's …
    expect(html).toContain("island-panel-loading");
    // … and it has not painted anything of its own yet.
    expect(html).not.toContain("panel:a2");
  });

  it("draws the decided reading the same way — one boundary per reviewed target", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "settled",
      agentSummary: null,
      targets: [target("a1"), pendingTarget("a2")],
    });

    const html = await shellHtml(await renderIsland(REF));
    expect(html).toContain("panel:a1");
    expect(html).toContain("island-panel-loading");
    expect(html).not.toContain("panel:a2");
  });
});

// cinatra#3441 — a document that draws ONE target is framed by the CARD: that
// target's header over this document inside one border
// (specs/app-artifact-review.html §IV). So the island hands its one panel no
// frame — on a gate that pins one target, and on each frame of a gate the card
// draws as pairs, which names its one target (cinatra#4129) — and frames each
// panel only on a document that still draws several.
describe("cinatra#3441 — the island frames a panel only on a document that draws several", () => {
  it("a pending gate over ONE target hands its panel no frame", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1")],
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
    });
    const panels = panelProps(await renderIsland(REF));
    expect(panels.map((p) => p.framed)).toEqual([false]);
  });

  it("a decided gate over ONE target hands its panel no frame either", async () => {
    loadReviewGateSurface.mockResolvedValue({ kind: "settled", agentSummary: null, targets: [target("a1")] });
    const panels = panelProps(await renderIsland(REF));
    expect(panels.map((p) => p.framed)).toEqual([false]);
  });

  it("a gate that still pins several targets frames each of its panels", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1"), target("a2")],
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
    });
    const panels = panelProps(await renderIsland(REF));
    expect(panels.map((p) => p.framed)).toEqual([true, true]);
  });

  it("a frame of that gate that names ONE pinned target hands its panel no frame (cinatra#4129)", async () => {
    const targets = [target("a1"), target("a2")];
    for (const [i, kind] of [
      [0, "ready"],
      [1, "ready"],
      [1, "settled"],
    ] as const) {
      loadReviewGateSurface.mockResolvedValue({
        kind,
        agentSummary: null,
        targets,
        ...(kind === "ready"
          ? { permissions: Promise.resolve({ canDecide: true, canComment: true }) }
          : {}),
      });
      const panels = panelProps(
        await renderIsland(REF, { target: targets[i]!.target.representationRevisionId }),
      );
      expect(panels).toHaveLength(1);
      expect(panels[0]!.prepared).toBe(targets[i]!.prepared);
      // The card's pair panel is this target's one frame.
      expect(panels[0]!.framed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// cinatra#4129 — ONE TARGET PER FRAME, for a gate that pins several.
//
// A gate opened before reviews became one per artifact, and still pending, can
// pin several targets. The card draws each target's header directly above its
// own frame, and each frame names the ONE pinned target it draws, by its pinned
// revision. The name is a closed selector over the gate's own frozen set: it
// authorizes nothing, and a name the gate does not pin draws the one empty
// document every denial draws.
// ---------------------------------------------------------------------------

describe("cinatra#4129 — a frame that names one pinned target draws that target alone", () => {
  it("draws only the target the frame names", async () => {
    const targets = [target("a1"), target("a2"), target("a3")];
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets,
      permissions: Promise.resolve({ canDecide: true, canComment: true }),
    });
    const el = await renderIsland(REF, { target: targets[1].target.representationRevisionId });
    expect(isEmptyIsland(el)).toBe(false);
    expect((el.props as Record<string, unknown>)["data-target-count"]).toBe(1);
    const panels = panelProps(el);
    expect(panels).toHaveLength(1);
    expect(panels[0].prepared).toBe(targets[1].prepared);
  });

  it("a frame naming a target the gate does not pin draws the same empty document every denial draws", async () => {
    loadReviewGateSurface.mockResolvedValue({ kind: "not-authorized" });
    const denied = await renderIsland(REF);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // The gate's targets, each of whose preparation FAILS: a frame that draws
      // none of them must still leave no rejection unhandled.
      const failing = (artifactId: string) => ({
        target: { artifactId, representationRevisionId: `${artifactId}-rev` },
        prepared: Promise.reject(new Error(`prepare failed: ${artifactId}`)),
        capturePair: Promise.reject(new Error(`capture failed: ${artifactId}`)),
      });
      loadReviewGateSurface.mockResolvedValue({
        kind: "ready",
        agentSummary: null,
        targets: [failing("a1"), failing("a2")],
        permissions: Promise.resolve({ canDecide: true, canComment: true }),
      });
      const el = await renderIsland(REF, { target: "rev_not_pinned" });
      // One turn of the event loop, so the runtime reports any rejection that
      // nothing handled.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(isEmptyIsland(el)).toBe(true);
      expect(JSON.stringify(el)).toBe(JSON.stringify(denied));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
