// @vitest-environment jsdom
//
// THE IMMUTABLE HEADER IS ON SCREEN AT THE FIRST PAINT, IN EVERY LOAD STATE
// (cinatra#3051).
//
// THE DEFECT, measured on the real surface inside a third-party application. At
// the card's first render the island read `data-island-load-state="timed-out"`,
// the island's own `[data-conformance-id="review-target"]` count was 0, the card
// drew its floor line ([data-review-target-floor] = 1) — and NO header row
// ([data-review-target-header] = 0). The header appeared about twenty seconds
// later, once the island painted. For those twenty seconds the reader was
// offered Approve/Reject over a panel that named nothing.
//
// THE CAUSE. The header was drawn from the resolve answer's own rows and from
// nothing else, so an answer that carried no rows drew no header at all
// (`ReviewTargetRows`, the `rows.length === 0` arm). And the answer legitimately
// carries no rows: the server races the gate's target read against a two-second
// deadline (`REVIEW_TARGET_ROWS_DEADLINE_MS`) and answers with none when it
// loses — which on the widget's slower path is the ordinary case, not the
// exception.
//
// WHAT IS PINNED HERE. The header ANCHOR is present at the first paint in every
// state the card's own overlay draws — `loading` and `timed-out` — whether or
// not the answer carried rows; it carries the row's facts when there are rows
// and INVENTS NOTHING when there are not; and once the island paints, the
// card's overlay is gone and the island's own header is the only one on screen.
// Never nothing, and never both.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/review-gate-card.header-at-first-paint.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type {
  LifecycleCardHost,
  LifecycleCardState,
  ReviewTargetRow,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  ISLAND_BODY_ANCHOR,
  REVIEW_TARGET_ISLAND_PATH,
  ReviewGateCard,
} from "../review-gate-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const REF = "ref-3051-header-first-paint";
const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: REF };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const SEALED = "AAAA-sealed_credential-BBBB";
const WIDGET_ISLAND_SRC = `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SEALED}`;

const ROW: ReviewTargetRow = {
  artifactId: "artifact-1",
  representationRevisionId: "ea615d36-2ad7-4a11-9f0e-8c1b2d3e4f56",
  title: "Launch post draft",
  objectType: "@cinatra-ai/blog-post-artifact:post",
  ownerLevel: "organization",
  visibility: "organization",
  mime: "text/markdown",
  updatedAt: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
  packageName: "@cinatra-ai/blog-post-artifact",
};

/** Every host that draws this card — no host is a special case. */
const HOSTS: LifecycleCardHost[] = [
  "chat_thread",
  "run_card",
  "page_gate_region",
  "site_widget",
];

async function renderOn(
  host: LifecycleCardHost,
  targets: readonly ReviewTargetRow[] | null,
): Promise<HTMLElement> {
  const widget = host === "site_widget";
  const islandSrc = widget ? WIDGET_ISLAND_SRC : null;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: PENDING,
          body: null,
          ...(islandSrc ? { islandSrc } : {}),
          ...(targets ? { targets } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  const { container } = render(
    <LifecycleCardSurfaceProvider
      host={host}
      {...(widget
        ? {
            auth: {
              headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
              credentials: "omit" as const,
            },
            frame: { assistant: "wordpress", instanceId: "inst-1" },
          }
        : {})}
    >
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="review-gate-card"]')).not.toBeNull(),
  );
  return container;
}

function headers(root: HTMLElement): NodeListOf<Element> {
  return root.querySelectorAll("[data-review-target-header]");
}

function islandState(root: HTMLElement): string | null {
  return root
    .querySelector('[data-conformance-id="review-target-island"]')
    ?.getAttribute("data-island-load-state") ?? null;
}

describe("the header is present at the first paint, with or without rows", () => {
  it("draws the header while the island is still LOADING, on every host", async () => {
    for (const host of HOSTS) {
      const root = await renderOn(host, null);
      expect(islandState(root), `${host}: the frame has not painted`).toBe("loading");
      expect(
        headers(root).length,
        `${host}: the reader is told what is under review before the frame arrives`,
      ).toBe(1);
      cleanup();
    }
  });

  it("draws the header past the island's bound, beside the retry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const root = await renderOn("site_widget", null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    await waitFor(() => expect(islandState(root)).toBe("timed-out"));
    expect(
      headers(root).length,
      "the state the capture photographed: timed out, and still named",
    ).toBe(1);
    expect(
      root.querySelector("[data-review-target-floor]"),
      "the floor line is still there under it",
    ).not.toBeNull();
  });

  it("invents no fact it was not given", async () => {
    const root = await renderOn("site_widget", null);
    const header = headers(root)[0]!;
    expect(
      header.getAttribute("data-review-target-header-pending"),
      "the header says openly that its facts have not arrived",
    ).toBe("");
    expect(header.textContent).not.toContain("undefined");
    expect(header.textContent).not.toContain("null");
  });

  it("carries the row's own facts the moment the answer has them", async () => {
    const root = await renderOn("site_widget", [ROW]);
    const header = headers(root)[0]!;
    expect(header.getAttribute("data-review-target-header-pending")).toBeNull();
    expect(header.textContent).toContain("Launch post draft");
  });

  it("hands the header over to the island and never draws both", async () => {
    const root = await renderOn("site_widget", null);
    const frame = root.querySelector("iframe")!;
    const doc = frame.contentDocument!;
    doc.open();
    // The island paints its OWN header — so the count that matters is the one
    // across BOTH documents. Writing a target with no header inside it would
    // only have proved the overlay left, not that anything replaced it.
    doc.write(
      `<html><body><div data-conformance-id="${ISLAND_BODY_ANCHOR}"></div>` +
        '<div data-conformance-id="review-target">' +
        '<div data-review-target-header="">Launch post draft</div>' +
        "</div></body></html>",
    );
    doc.close();
    await act(async () => {
      fireEvent.load(frame);
    });
    await waitFor(() => expect(islandState(root)).toBe("loaded"));
    expect(
      headers(root).length,
      "the card's own overlay header is gone once the island paints",
    ).toBe(0);
    expect(
      doc.querySelectorAll("[data-review-target-header]").length,
      "and the island's own header is the one on screen — never nothing, never both",
    ).toBe(1);
  });
});
