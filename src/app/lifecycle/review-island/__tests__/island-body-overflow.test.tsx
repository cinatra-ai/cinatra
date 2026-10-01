// @vitest-environment jsdom
//
// THE ISLAND BODY DOES NOT CLIP THE WORK (the fourteenth proof round's counted
// defect on cinatra#3143, 2026-09-10: "the json display's value-tree rows are
// cut hard at the container's right edge, mid-word, with no ellipsis and no
// visible scroll affordance").
//
// `specs/app-artifact-review.html` §III gives the reading this pins — "a wide
// representation scrolls inside its own container rather than widening the
// page". The first-party review-target panel already carries that road on its
// representation slot (`review-target-panel.overflow.test.tsx`, which stays).
// This document is the OTHER layer a pinned target's body is drawn on: the
// review card and the run page both frame this island, so the wrapper the
// island draws its panels in has to carry the same road, or a wide value tree
// reaches the edge of a document that has nowhere to scroll.
//
// jsdom implements no layout, so `scrollWidth` and `clientWidth` are both 0 on
// every element here and measuring them would assert nothing. What is measured
// instead is the contract that produces the scroll in a browser: the body
// wrapper is a horizontal scroll container, and it may shrink below its
// content. The live `scrollWidth` vs `clientWidth` reading is taken on the boot.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const getAuthSession = vi.fn();
const signInRedirectTarget = vi.fn(async () => "/sign-in");
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const resolveReviewActorContext = vi.fn();
const loadReviewGateSurface = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  signInRedirectTarget: () => signInRedirectTarget(),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/embed/frame-ancestors.server", () => ({
  resolveVerifiedWidgetFrameOrigin: () => null,
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", () => ({
  loadReviewGateSurface: (args: unknown) => loadReviewGateSurface(args),
}));
vi.mock("@/lib/lifecycle/review-island-serving", () => ({
  resolveIslandCredentialReader: vi.fn(),
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor",
  () => ({ resolveReviewActorContext: () => resolveReviewActorContext() }),
);
// A BODY WIDER THAN ITS CONTAINER. The real panel and the pack's json display
// are exercised by their own suites; what this one needs from a target is a
// representation whose rows do not wrap — the shape the round's frames drew.
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel",
  () => ({
    ReviewTargetPanel: () => (
      <div data-conformance-id="review-target">
        <div className="min-w-0 overflow-x-auto p-4" data-review-representation-slot="">
          <div style={{ whiteSpace: "pre", fontFamily: "monospace" }}>
            {`{ "aVeryLongKeyThatDoesNotWrap": "${"x".repeat(4000)}" }`}
          </div>
        </div>
      </div>
    ),
  }),
);
vi.mock("@cinatra-ai/agents/review-gate-states", () => ({ ReviewGateLoading: () => null }));
vi.mock("../island-height-reporter", () => ({ IslandHeightReporter: () => null }));

import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

import { islandBodyClassName } from "../island-color-scheme";
import ReviewTargetIslandPage from "../page";

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

const ACTOR = {
  actor: { actorType: "human", userId: "u1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue({ user: { id: "u1" } });
  resolveReviewActorContext.mockResolvedValue(ACTOR);
  loadReviewGateSurface.mockResolvedValue({
    kind: "ready",
    agentSummary: null,
    targets: [
      {
        target: { artifactId: "artifact-json", representationRevisionId: "rev-1" },
        props: null,
        mount: { kind: "floor" as const },
      },
    ],
    pinnedCapturePairs: {},
    permissions: { canDecide: true, canComment: true },
  });
});

/** The island body wrapper, as the document actually draws it. */
async function islandBody(scheme?: "light" | "dark"): Promise<Element> {
  const el = (await ReviewTargetIslandPage({
    searchParams: Promise.resolve(scheme ? { ref: REF, scheme } : { ref: REF }),
  })) as ReactElement;
  document.body.innerHTML = renderToStaticMarkup(el);
  const body = document.body.querySelector("[data-conformance-id='review-target-island-body']");
  if (!body) throw new Error("no island body");
  return body;
}

const classesOf = (el: Element): string[] => Array.from(el.classList);

describe("the island body is the container a wide representation scrolls inside", () => {
  it("the body wrapper is a horizontal scroll container", async () => {
    // "a wide representation scrolls inside its own container rather than
    // widening the page" (§III).
    expect(classesOf(await islandBody())).toContain("overflow-x-auto");
  });

  it("the body wrapper may shrink below its content", async () => {
    // Without this the wrapper takes its width from the widest row and the
    // overflow moves back out to the document, which has nowhere to put it:
    // the frame that holds this island is sized to the content and clips.
    expect(classesOf(await islandBody())).toContain("min-w-0");
  });

  it("carries the road in both palettes, and keeps everything it drew before", async () => {
    for (const scheme of ["light", "dark"] as const) {
      const classes = classesOf(await islandBody(scheme));
      expect(classes).toContain("overflow-x-auto");
      expect(classes).toContain("min-w-0");
      // The palette wave's own readings are untouched by this leg.
      expect(classes).toContain("min-h-dvh");
      expect(classes).toContain("text-foreground");
      expect(classes).toContain(scheme === "dark" ? "dark" : "cinatra");
    }
  });

  it("is the SAME road the first-party panel's representation slot carries", async () => {
    const body = await islandBody();
    const slot = document.body.querySelector("[data-review-representation-slot]");
    if (!slot) throw new Error("no representation slot");
    for (const road of ["min-w-0", "overflow-x-auto"]) {
      expect(classesOf(slot)).toContain(road);
      expect(classesOf(body)).toContain(road);
    }
  });

  it("nothing between the island body and the representation clips", async () => {
    const body = await islandBody();
    for (const el of [body, ...Array.from(body.querySelectorAll("*"))]) {
      expect(classesOf(el)).not.toContain("overflow-hidden");
    }
  });

  it("the class list the module states is the class list the document draws", async () => {
    expect((await islandBody()).className).toBe(islandBodyClassName(null));
    expect((await islandBody("dark")).className).toBe(islandBodyClassName("dark"));
  });
});
