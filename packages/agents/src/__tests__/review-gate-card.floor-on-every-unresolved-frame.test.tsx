// @vitest-environment jsdom
//
// §V — THE FLOOR IS DRAWN ON EVERY FRAME WHERE THE TARGET DOES NOT RESOLVE
// (cinatra#3051, fix leg 9).
//
// The ratified drawing, `app-artifact-review` §V, verbatim:
//
//   "The floor is never a blank. Whenever a target does not resolve to a type
//    renderer, it renders the floor — a sanitized, telemetry-safe one-line
//    diagnostic (package · slot · reason, never a raw error or manifest value) —
//    so the surface never shows an empty panel where a target should be. […] A
//    type-level floor […] still has an authorized representation, so its
//    diagnostic sits above the generic read-only structured-data view of that
//    representation."
//
// THE MEASUREMENT THIS FILE STANDS ON. The ninth proof round read the island as
// `loaded` and, in the SAME reading, the island's own document saying "No
// markdown is available to show for the revision being viewed" — the resolved
// display's own named floor, drawn instead of the work. The card treats a frame
// that painted as a target that resolved, so at that instant it drew no §V line
// at all: the reader was told nothing about why the panel under the header held
// no representation. The floor was on screen only where the frame failed to
// ARRIVE, which is one of the ways a target fails to resolve and not the only
// one.
//
// SO THE CARD'S READING OF THE FRAME BECOMES A THREE-WAY ONE. A painted island
// is asked what it is showing: the work, or a floor. It is asked on the island's
// OWN anchors and on nothing else — the representation slot the review target
// panel draws, and the `data-floor` a display sets when it draws its own named
// floor rather than the document. Nothing about any display changes here and
// nothing forks its floor: the card composes the reading a display already
// publishes, and puts §V's one line above the generic read-only view the display
// is drawing.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/review-gate-card.floor-on-every-unresolved-frame.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type {
  LifecycleCardHost,
  LifecycleCardState,
  LifecycleTargetHeader,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { REVIEW_TARGET_ISLAND_PATH, ReviewGateCard } from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const REF = "ref-3051-floor-every-frame";
const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: REF };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const FRAME = { assistant: "wordpress", instanceId: "inst-1" };
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};
const WIDGET_ISLAND_SRC = `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=sealed`;

const HEADER: LifecycleTargetHeader = {
  title: "A Sustainable Weekly Publishing Rhythm for Small Teams",
  typeLabel: "Blog Post Artifact",
  objectType: "@cinatra-ai/blog-post-artifact:post",
  revisionId: "49336ea0-067c-4a11-9f0e-8c1b2d3e4f56",
  facts: ["Organization", "Organization", "text/markdown", "updated 8 minutes ago"],
};

/** Every host that draws this card (§IX) — the rule is one code path and no host
 *  is a special case. */
const HOSTS: LifecycleCardHost[] = ["chat_thread", "run_card", "page_gate_region", "site_widget"];

function mockResolve(islandSrc: string | null): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: PENDING,
          body: null,
          targetHeaders: [HEADER],
          ...(islandSrc ? { islandSrc } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

async function renderOn(host: LifecycleCardHost): Promise<HTMLElement> {
  const widget = host === "site_widget";
  mockResolve(widget ? WIDGET_ISLAND_SRC : null);
  const { container } = render(
    <LifecycleCardSurfaceProvider
      host={host}
      {...(widget ? { auth: WIDGET_AUTH, frame: FRAME } : {})}
    >
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="review-gate-card"]')).not.toBeNull(),
  );
  return container;
}

const floor = (root: HTMLElement) => root.querySelector("[data-review-target-floor]");
const islandState = (root: HTMLElement) =>
  root
    .querySelector('[data-conformance-id="review-target-island"]')
    ?.getAttribute("data-island-load-state") ?? null;

/** Write a document into the framed island and report the load, the way a real
 *  navigation does. `body` is the island's own markup inside its body anchor. */
async function frameLoads(root: HTMLElement, body: string): Promise<void> {
  const frame = root.querySelector("iframe")!;
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(
    `<html><body><div data-conformance-id="review-target-island-body">${body}</div></body></html>`,
  );
  doc.close();
  await act(async () => {
    fireEvent.load(frame);
  });
}

/** The island as it painted in the ninth proof round: the panel and its slot are
 *  there, the resolved display drew its OWN named floor instead of the work. */
const SLOT_WITH_A_DISPLAY_FLOOR = `
  <div data-conformance-id="review-target">
    <div data-review-representation-slot="">
      <article data-artifact-renderer="markdown" data-slot="detail" data-floor="content-absent">
        No markdown is available to show for the revision being viewed.
      </article>
    </div>
  </div>`;

/** The same island with the work actually on screen. */
const SLOT_WITH_THE_WORK = `
  <div data-conformance-id="review-target">
    <div data-review-representation-slot="">
      <article data-artifact-renderer="markdown" data-slot="detail" data-revision="49336ea0">
        <div data-markdown-body=""><h1>A Sustainable Weekly Publishing Rhythm</h1></div>
      </article>
    </div>
  </div>`;

/** The island where the HOST resolved no renderer at all and drew its own floor
 *  region over the generic read-only structured-data view. */
const HOST_RESOLVED_NO_RENDERER = `
  <div data-conformance-id="review-target">
    <div data-conformance-id="review-target-floor">Floor · structured data</div>
    <div data-review-representation-slot="">
      <dl><dt>type</dt><dd>@cinatra-ai/blog-post-artifact:post</dd></dl>
    </div>
  </div>`;

describe("§V — a painted frame that is not showing the work still draws the floor", () => {
  it.each(HOSTS)(
    "%s: the display's own floor keeps §V's one line above it",
    async (host) => {
      const root = await renderOn(host);
      await frameLoads(root, SLOT_WITH_A_DISPLAY_FLOOR);
      const line = floor(root);
      expect(line, `${host}: the §V diagnostic`).not.toBeNull();
      expect(line!.getAttribute("data-review-target-floor")).toBe("representation-unavailable");
      // §V's own shape, and the two parts that are TRUE of a card-drawn reading:
      // the slot and the reason. The package half stays dropped rather than
      // invented — "the resolution is host-derived, never a claim the client or
      // the model can forge".
      expect(line!.textContent).toContain('slot "detail"');
      expect(line!.textContent).toContain('reason "representation-unavailable"');
      expect(line!.getAttribute("data-review-floor-package")).toBe("");
    },
  );

  it.each(HOSTS)(
    "%s: the frame stays on screen under it — the diagnostic sits ABOVE the generic view",
    async (host) => {
      const root = await renderOn(host);
      await frameLoads(root, SLOT_WITH_A_DISPLAY_FLOOR);
      const frame = root.querySelector("iframe")!;
      expect(frame.className, `${host}: the representation view is not hidden`).toContain(
        "opacity-100",
      );
      // …and the reader is NOT told the preview failed to arrive: it arrived.
      expect(
        root.querySelector('[data-conformance-id="review-target-island-timeout"]'),
        `${host}: no retry panel over a frame that painted`,
      ).toBeNull();
    },
  );

  it.each(HOSTS)("%s: a host that resolved no renderer says so in its own words", async (host) => {
    const root = await renderOn(host);
    await frameLoads(root, HOST_RESOLVED_NO_RENDERER);
    const line = floor(root);
    expect(line, `${host}: the §V diagnostic`).not.toBeNull();
    expect(line!.getAttribute("data-review-target-floor")).toBe("renderer-unresolved");
  });

  it.each(HOSTS)("%s: the work on screen draws no floor at all", async (host) => {
    const root = await renderOn(host);
    await frameLoads(root, SLOT_WITH_THE_WORK);
    expect(islandState(root), `${host}: the island painted the work`).toBe("loaded");
    expect(floor(root), `${host}: nothing to diagnose`).toBeNull();
  });
});

// A frame that never ARRIVED keeps the reading it already had — the
// `preview-unavailable` line beside the retry — and that arm is pinned where it
// was written, in `review-gate-card.target-header-floor.test.tsx` ("still there
// past the island's bound"). It is not restated here: one measurement, one home.
