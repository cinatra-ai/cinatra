// EACH ARTIFACT IS ONE BLOCK: ITS HEADER DIRECTLY OVER ITS OWN BODY
// (cinatra#3080, the fix leg after the first proof round).
//
// THE RULING OF 2026-09-13, and the drawings behind it:
// `app-artifact-review.html` §IV — "Every target OPENS with a header that names
// what is under review and fixes it in place ... Beneath the header sits the
// representation slot" — and §III/§VI, "one artifact per review, one reference
// per gate". The first proof round found the opposite on a legacy gate that
// pinned several targets: every target's header was drawn as one block at the
// top of the run detail and every representation below it, so the review page
// grouped headers then bodies, and the run page's Review step showed three
// representations with no header on any of them.
//
// WHERE THE FIX LIVES. The gate's targets are server-rendered together in ONE
// island document — the card cannot interleave a header with a body it does not
// draw. So for a gate that pins MORE THAN ONE target the island opens each
// target with its own header, directly above that target's own panel, and the
// card draws no stacked block over it. A gate that pins ONE target — which is
// every gate minted from now on — keeps the card's own header above the island,
// where it survives the island's skeleton and its recovery panel (cinatra#3141
// item 7).

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
// The panel and the skeleton carry their own suites; here they are markers, so
// what is read is the ORDER the island composed, nothing about the renderer.
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel",
  () => ({
    ReviewTargetPanel: ({ prepared }: { prepared: { target: { artifactId: string } } }) => null,
  }),
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

function target(artifactId: string, title: string) {
  return {
    target: { artifactId, representationRevisionId: `${artifactId}-rev` },
    props: {
      propsApiVersion: 2,
      artifact: {
        id: artifactId,
        title,
        objectType: "@cinatra-ai/blog-post:draft",
        mime: "text/markdown",
        size: 120,
        createdAt: "2026-09-16T05:00:00.000Z",
        updatedAt: "2026-09-16T06:00:00.000Z",
        ownerLevel: "team",
        visibility: "private",
        sourceUrl: null,
      },
      representation: { revisionId: `${artifactId}-rev`, mime: "text/markdown" },
    },
    mount: { kind: "floor" as const },
  };
}

async function renderIsland() {
  return (await ReviewTargetIslandPage({
    searchParams: Promise.resolve({ ref: REF }),
  })) as ReactElement;
}

/** The island's composed children, flattened in DOM order, reduced to the one
 *  fact this file reads: which node it is, and which artifact it is about. */
function sequence(el: ReactElement): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const props = (node as { props?: Record<string, unknown> }).props;
    if (!props) return;
    if ("prepared" in props) {
      const prepared = props.prepared as { target: { artifactId: string } };
      out.push(`body:${prepared.target.artifactId}`);
      return;
    }
    if ("header" in props && props.header && typeof props.header === "object") {
      const header = props.header as { title?: string; revisionId?: string };
      out.push(`header:${String(header.revisionId ?? header.title)}`);
      return;
    }
    walk(props.children);
    walk(props.fallback);
  };
  walk(el);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
  resolveIslandCredentialReader.mockResolvedValue(null);
  getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  resolveReviewActorContext.mockResolvedValue(ACTOR);
  signInRedirectTarget.mockResolvedValue("/sign-in");
});

describe("cinatra#3080 — a legacy multi-target gate draws each header over its own body", () => {
  it("pairs header and body per target, in gate order — never all headers then all bodies", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1", "Blog idea one"), target("a2", "Blog idea two")],
      pinnedCapturePairs: {},
      permissions: { canDecide: true, canComment: true },
    });

    expect(sequence(await renderIsland())).toEqual([
      "header:a1-rev",
      "body:a1",
      "header:a2-rev",
      "body:a2",
    ]);
  });

  it("a SETTLED multi-target gate reads the same way — the reviewed work keeps its headers", async () => {
    loadReviewGateSurface.mockResolvedValue({
      kind: "settled",
      agentSummary: null,
      targets: [target("a1", "Blog idea one"), target("a2", "Blog idea two")],
      pinnedCapturePairs: {},
      permissions: { canDecide: false, canComment: false },
    });

    expect(sequence(await renderIsland())).toEqual([
      "header:a1-rev",
      "body:a1",
      "header:a2-rev",
      "body:a2",
    ]);
  });

  it("a ONE-TARGET gate draws no header here: the card's own header stands above the island", async () => {
    // cinatra#3141 item 7 — the header the CARD draws survives the island's
    // skeleton and its recovery panel, and a gate minted under one-review-per-
    // artifact always has exactly one target, so that is the ordinary reading.
    loadReviewGateSurface.mockResolvedValue({
      kind: "ready",
      agentSummary: null,
      targets: [target("a1", "Blog idea one")],
      pinnedCapturePairs: {},
      permissions: { canDecide: true, canComment: true },
    });

    expect(sequence(await renderIsland())).toEqual(["body:a1"]);
  });
});
