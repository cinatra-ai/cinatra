// @vitest-environment jsdom
//
// EVERY OPEN COLUMN SETTLES IN PLACE (cinatra#3051).
//
// THE DEFECT, measured on the real surface. Two third-party pages were open on
// the same review gate. Approve was pressed in one of them; the gate row moved
// to `approve` and the deciding column settled at once. Six minutes later the
// OTHER column still read `data-lifecycle-card-state="pending"` with its
// decision bar drawn — a terminal control live on a gate the store had already
// resolved — and it only settled after that page was reloaded.
//
// THE CAUSE. `useLifecycleCardResolve` refreshed on MOUNT and on the window's
// `focus` event and nothing else. The deciding column settles from its own
// decide answer; a second column that never regains focus is never told
// anything, so it holds the pending reading it mounted with for as long as the
// page stays open.
//
// WHAT IS PINNED HERE. A card whose reading is still OPEN keeps looking, on its
// own bounded cadence, so a decision taken anywhere reaches every column that
// draws the gate — with no focus event and no reload. And a card whose reading
// is SETTLED stops looking, because a terminal answer cannot change.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/review-gate-card.open-columns-settle.test.tsx

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

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

const REF = "ref-3051-two-open-columns";
const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: REF };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const SETTLED: LifecycleCardState = { state: "settled", outcome: "approved" };

/** The gate as the STORE holds it — one row, read by every column. */
let gate: LifecycleCardState = PENDING;

function mountResolveEndpoint(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ kind: "artifact_review_gate", state: gate, body: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** One open column on a third-party page: its own provider, its own card. */
function column(): { container: HTMLElement } {
  return render(
    <LifecycleCardSurfaceProvider
      host="site_widget"
      auth={{
        headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
        credentials: "omit" as const,
      }}
      frame={{ assistant: "wordpress", instanceId: "inst-1" }}
    >
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

function cardState(root: HTMLElement): string | null {
  return root
    .querySelector('[data-conformance-id="review-gate-card"]')
    ?.getAttribute("data-lifecycle-card-state") ?? null;
}

describe("a decision reaches every open column, not only the one it was taken in", () => {
  it("settles the column the decision was NOT taken in, with no focus and no reload", async () => {
    gate = PENDING;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mountResolveEndpoint();

    // TWO pages open on the same gate, both mounted while it is pending.
    const deciding = column();
    const other = column();
    await waitFor(() => {
      expect(cardState(deciding.container), "the deciding column mounts pending").toBe("pending");
      expect(cardState(other.container), "the second column mounts pending").toBe("pending");
    });

    // The decision lands — pressed in the deciding column, written to the one
    // gate row every column reads. The deciding column learns from its own
    // answer; nothing is dispatched to the second one.
    gate = SETTLED;

    // No focus event, no reload — only time passing on the open page.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    await waitFor(() =>
      expect(
        cardState(other.container),
        "the column the decision was not taken in settles in place",
      ).toBe("settled"),
    );
    expect(
      other.container.querySelector('[data-conformance-id="review-decision-bar"]'),
      "and its decision bar is gone — nothing terminal is left to press",
    ).toBeNull();
  });

  // THE HAZARD THE LOOKING CREATES, pinned so it cannot come back. Every resolve
  // mints a FRESH island credential, and `ReviewTargetIsland` keys its iframe on
  // the `src` string — so a card that adopted every credential it was handed
  // would remount the frame on every look and the island would never finish
  // painting. The address moves only when the card ASKED for a new one.
  it("does not remount the island while it keeps looking", async () => {
    gate = PENDING;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let issued = 0;
    globalThis.fetch = vi.fn(async () => {
      issued += 1;
      return new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: gate,
          body: null,
          // A fresh, single-use grant on every answer — as the real resolve mints.
          islandSrc: `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=grant-${issued}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { container } = column();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const framed = container.querySelector("iframe")!;
    const framedAt = framed.getAttribute("src");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
      "the card did keep looking",
    ).toBeGreaterThan(1);
    expect(
      container.querySelector("iframe")!.getAttribute("src"),
      "and the island stayed at the address it was framed at",
    ).toBe(framedAt);
    // The address alone is too weak a pin: a frame torn down and rebuilt at the
    // SAME url loses its load just as completely. The NODE is what must survive.
    expect(
      container.querySelector("iframe"),
      "and it is the same frame, not a new one at the same address",
    ).toBe(framed);
  });

  // THE CHAIN MUST NOT HAVE A BREAK IN IT.
  //
  // Every further look was armed by the PREVIOUS look reaching state. A look
  // that answered nothing — a 5xx, an offline moment, a body that did not parse
  // — reached no state, changed no dependency, and armed nothing: the column
  // went quiet for the rest of the page's life on one bad answer, which is the
  // defect this poll exists to close, merely made rarer.
  it("keeps looking after a look that answered nothing", async () => {
    gate = PENDING;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    globalThis.fetch = vi.fn(async () => {
      reads += 1;
      // The FIRST further look fails outright; the reading is unchanged by it.
      if (reads === 2) return new Response("nope", { status: 503 });
      return new Response(
        JSON.stringify({ kind: "artifact_review_gate", state: gate, body: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { container } = column();
    await waitFor(() => expect(cardState(container)).toBe("pending"));

    // The decision lands while this column's last look was the failed one.
    gate = SETTLED;
    // Advanced in steps on purpose: a look re-arms the next one through React
    // state, and state committed inside one `act` is not seen by the timer run
    // that is already in flight. Real time has no such seam.
    for (let step = 0; step < 8; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }

    await waitFor(() =>
      expect(
        cardState(container),
        "one bad answer does not end the looking — the column still settles",
      ).toBe("settled"),
    );
  });

  // An `absent` reading draws NO CARD AT ALL — it is every denial path's answer
  // and the answer for a ref that resolves to nothing. An invisible card that
  // keeps asking is pure cost, so the looking ends there too.
  it("stops looking on a reading that draws nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            kind: "artifact_review_gate",
            state: { state: "absent" },
            body: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = column();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(
      container.querySelector('[data-conformance-id="review-gate-card"]'),
      "nothing is on screen to keep current",
    ).toBeNull();
    expect(
      fetchMock.mock.calls.length,
      "and an invisible card does not spend the belt asking",
    ).toBe(1);
  });

  it("stops looking once the reading is terminal", async () => {
    gate = SETTLED;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mountResolveEndpoint();

    const settled = column();
    await waitFor(() => expect(cardState(settled.container)).toBe("settled"));
    const readsAfterSettling = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(
      fetchMock.mock.calls.length,
      "a settled card does not keep polling a gate that cannot change",
    ).toBe(readsAfterSettling);
  });
});
