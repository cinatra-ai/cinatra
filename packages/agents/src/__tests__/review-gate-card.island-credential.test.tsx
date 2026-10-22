// @vitest-environment jsdom
//
// THE CARD'S HALF OF THE ISLAND CREDENTIAL (cinatra#2754).
//
// The server mints; the card carries. What is pinned here is that it carries it
// on the arm that needs it, that the arm that does not need it is byte-identical
// to what it was, and that a perishable credential is never left to a clock the
// card cannot see:
//
//   1. WIDGET ARM — the framed `src` carries the server's `ic`, beside the ref
//      and the two frame selectors the island's wall is computed from.
//   2. COOKIE ARM — no credential arrives, and the `src` is exactly the one the
//      card composed before this slice.
//   3. THE CARD NEVER ADOPTS A URL. Only the `ic` VALUE is taken, and only from
//      an answer that names this card's own ref; the address is always rebuilt
//      from the card's own constant.
//   4. A CREDENTIALED FRAME IS FETCHED NOW, not on scroll — a URL that expires
//      cannot wait for an intersection.
//   5. A RETRY RE-RESOLVES, so the second attempt presents a FRESH credential
//      rather than remounting on the dead one.
//   6. OFF A COOKIE SESSION THE ISLAND IS FRAMED ONLY WITH ITS CREDENTIAL. A
//      broker card whose held address and current answer carry no credential
//      it accepts draws the target region empty: no frame, no target content
//      and no explanation. A later answer without one never moves a frame
//      that already holds one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

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

const REF = "ref-abc-123";
const VIEW = { viewType: "artifact_review_gate" as const, schemaVersion: 1, ref: REF };
const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const FRAME = { assistant: "wordpress", instanceId: "inst-1" };
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_user" }),
  credentials: "omit" as const,
};
const SEALED = "AAAA-sealed_credential-BBBB";

/** The resolve answer, with or without the server's island URL. */
function mockResolve(islandSrc: string | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: PENDING,
          body: null,
          ...(islandSrc ? { islandSrc } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderWidget(islandSrc: string | null) {
  mockResolve(islandSrc);
  return render(
    <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={FRAME}>
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

function renderCookieHost(islandSrc: string | null) {
  mockResolve(islandSrc);
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

async function frameSrc(container: HTMLElement): Promise<URL> {
  await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  return new URL(container.querySelector("iframe")!.getAttribute("src")!, "https://app.example");
}

describe("the widget arm frames the CREDENTIALED island", () => {
  it("carries the server's credential beside the ref and the frame selectors", async () => {
    const { container } = renderWidget(
      `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SEALED}`,
    );
    const url = await frameSrc(container);
    expect(url.pathname).toBe(REVIEW_TARGET_ISLAND_PATH);
    expect(url.searchParams.get("ref")).toBe(REF);
    expect(url.searchParams.get("ic")).toBe(SEALED);
    expect(url.searchParams.get("assistant")).toBe("wordpress");
    expect(url.searchParams.get("instanceId")).toBe("inst-1");
    expect([...url.searchParams.keys()].sort()).toEqual(["assistant", "ic", "instanceId", "ref"]);
  });

  it("stays a RELATIVE first-party path — the island is never fetched cross-origin", async () => {
    const { container } = renderWidget(
      `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SEALED}`,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector("iframe")!.getAttribute("src")!.startsWith("/")).toBe(true);
  });

  it("fetches a perishable credential NOW, never on scroll", async () => {
    const { container } = renderWidget(
      `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SEALED}`,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector("iframe")!.getAttribute("loading")).toBe("eager");
  });
});

describe("the cookie arm is byte-identical to the pre-credential card", () => {
  it("frames the ref and nothing else when no credential arrived", async () => {
    const { container } = renderCookieHost(null);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector("iframe")!.getAttribute("src")).toBe(
      `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}`,
    );
  });

  it("keeps `lazy` — a cookie-authenticated frame has no clock to race", async () => {
    const { container } = renderCookieHost(null);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector("iframe")!.getAttribute("loading")).toBe("lazy");
  });
});

describe("the card takes a CREDENTIAL, never a URL", () => {
  it("drops an island URL minted for ANOTHER ref, and frames no island without it", async () => {
    const { container } = renderWidget(`${REVIEW_TARGET_ISLAND_PATH}?ref=other-ref&ic=${SEALED}`);
    const region = await targetRegion(container);
    expect(container.querySelector("iframe")).toBeNull();
    expect(region.getAttribute("data-island-load-state")).toBe("empty");
  });

  it("drops an answer that points somewhere else entirely, and frames no island without it", async () => {
    const { container } = renderWidget(`/somewhere/else?ref=${encodeURIComponent(REF)}&ic=${SEALED}`);
    const region = await targetRegion(container);
    expect(container.querySelector("iframe")).toBeNull();
    expect(region.getAttribute("data-island-load-state")).toBe("empty");
  });

  it("REFUSES the whole answer that names a foreign origin — no card at all", async () => {
    // One layer out from the composer: an island URL that is not a root-relative
    // path on this origin is refused by the envelope PARSE, so the card is left
    // exactly where it is before its first resolve lands — drawing no DOM. The
    // composer's own drop is the second wall, pinned in `review-island-src`.
    const { container } = renderWidget(
      `https://evil.example${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${SEALED}`,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.innerHTML).toBe("");
  });
});

describe("a retry asks for a FRESH credential", () => {
  it("re-resolves before it remounts the frame", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=first-value`;
    const second = `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=second-value`;
    let issued = 0;
    const fetchMock = vi.fn(async () => {
      issued += 1;
      return new Response(
        JSON.stringify({
          kind: "artifact_review_gate",
          state: PENDING,
          body: null,
          islandSrc: issued === 1 ? first : second,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(
      <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={FRAME}>
        <ReviewGateCard view={VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector("iframe")!.getAttribute("src")).toContain("ic=first-value");

    // Cross the island's own load bound without ever firing `load`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-conformance-id="review-target-island-timeout"] button',
    );
    expect(retry).not.toBeNull();

    const before = fetchMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(retry!);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    await waitFor(() =>
      expect(container.querySelector("iframe")!.getAttribute("src")).toContain("ic=second-value"),
    );
  });
});

// ---------------------------------------------------------------------------
// Off a cookie session, the island is framed only with its credential
// ---------------------------------------------------------------------------
//
// On a broker host the server-minted credential is the only proof of the reader
// the island receives, so a broker card frames the island only with it. The
// matrix walks the three readings that draw the island and every answer that
// carries no credential the card accepts; each must leave the target region in
// place and empty once the answer has landed and the card has drawn it; inside
// the one-target panel the empty region, like the island, draws no frame of
// its own. The positive arms stay beside it: a broker card with a credential
// frames it, each cookie host frames the island without one, a card later
// answered with a credential frames it then, and a frame that holds a
// credential is kept when later answers bring none.

const RESTRICTED: LifecycleCardState = {
  state: "restricted",
  canDecide: false,
  canComment: true,
  reason: "Approving or rejecting needs approve access on this run.",
};
const SETTLED_WITH_OUTCOME: LifecycleCardState = { state: "settled", outcome: "approved" };

/** The three readings that draw the island. */
const ISLAND_READINGS: Array<[string, LifecycleCardState]> = [
  ["pending", PENDING],
  ["restricted", RESTRICTED],
  ["settled with an outcome", SETTLED_WITH_OUTCOME],
];

/** Every answer that carries no credential this card accepts. */
const NO_ACCEPTED_CREDENTIAL: Array<[string, string | null]> = [
  ["no island URL at all", null],
  ["an island URL for another ref", `${REVIEW_TARGET_ISLAND_PATH}?ref=other-ref&ic=${SEALED}`],
  ["an island URL on another path", `/somewhere/else?ref=${encodeURIComponent(REF)}&ic=${SEALED}`],
  ["an island URL with an empty credential", `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=`],
];

const COOKIE_HOSTS = ["chat_thread", "run_card", "page_gate_region"] as const;

const credentialedSrc = (value: string): string =>
  `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}&ic=${value}`;

/** One pinned target's header, so the card draws its one-target panel. */
const ONE_HEADER = {
  title: "Q3 cohort brief",
  typeLabel: "Document",
  objectType: "@cinatra-ai/doc:brief",
  revisionId: "rev_11223344556677",
  facts: ["team", "private", "text/markdown", "updated 3 minutes ago"],
};

/** Answer each successive resolve with the next reading and island URL. */
function mockAnswers(
  answers: Array<{
    state: LifecycleCardState;
    islandSrc: string | null;
    targetHeaders?: Array<typeof ONE_HEADER>;
  }>,
): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    return new Response(
      JSON.stringify({
        kind: "artifact_review_gate",
        state: answer.state,
        body: null,
        ...(answer.islandSrc !== null ? { islandSrc: answer.islandSrc } : {}),
        // Beside its headers the route says whether they are the gate's whole
        // pinned set; every gate here pins only the targets it names.
        ...(answer.targetHeaders
          ? { targetHeaders: answer.targetHeaders, targetHeadersComplete: true }
          : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mountWidget() {
  return render(
    <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH} frame={FRAME}>
      <ReviewGateCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

/** Let a landed answer finish rendering without crossing the island's load bound. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** The target region, once the answer has landed and the card has drawn it. */
async function targetRegion(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() =>
    expect(container.querySelector('[data-conformance-id="review-target-island"]')).not.toBeNull(),
  );
  await settle();
  return container.querySelector<HTMLElement>('[data-conformance-id="review-target-island"]')!;
}

describe("off a cookie session the island is framed only with its credential", () => {
  afterEach(() => {
    document.documentElement.className = "";
  });

  describe.each(ISLAND_READINGS)("the %s reading", (_reading, state) => {
    it.each(NO_ACCEPTED_CREDENTIAL)("draws the target region empty for %s", async (_answer, islandSrc) => {
      mockAnswers([{ state, islandSrc }]);
      const { container } = mountWidget();
      const region = await targetRegion(container);
      expect(container.querySelector("iframe")).toBeNull();
      expect(region.getAttribute("data-island-load-state")).toBe("empty");
      expect(region.childElementCount).toBe(0);
      expect(region.textContent).toBe("");
      expect(region.className).toBe(
        "relative overflow-hidden rounded-control border border-line bg-surface-strong",
      );
    });

    it("frames the island with the credential the answer carries", async () => {
      mockAnswers([{ state, islandSrc: credentialedSrc(SEALED) }]);
      const { container } = mountWidget();
      const url = await frameSrc(container);
      expect(url.searchParams.get("ref")).toBe(REF);
      expect(url.searchParams.get("ic")).toBe(SEALED);
      expect(container.querySelector("iframe")!.getAttribute("loading")).toBe("eager");
    });

    it.each(COOKIE_HOSTS)("frames the island without a credential on the %s host", async (host) => {
      mockAnswers([{ state, islandSrc: null }]);
      const { container } = render(
        <LifecycleCardSurfaceProvider host={host}>
          <ReviewGateCard view={VIEW} />
        </LifecycleCardSurfaceProvider>,
      );
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      expect(container.querySelector("iframe")!.getAttribute("src")).toBe(
        `${REVIEW_TARGET_ISLAND_PATH}?ref=${encodeURIComponent(REF)}`,
      );
      expect(container.querySelector("iframe")!.getAttribute("loading")).toBe("lazy");
    });
  });

  it("frames the island once a later answer brings the credential", async () => {
    const fetchMock = mockAnswers([
      { state: PENDING, islandSrc: null },
      { state: PENDING, islandSrc: credentialedSrc("later-value") },
    ]);
    const { container } = mountWidget();
    await targetRegion(container);
    expect(container.querySelector("iframe")).toBeNull();

    const before = fetchMock.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    const url = await frameSrc(container);
    expect(url.searchParams.get("ic")).toBe("later-value");
    expect(container.querySelector("iframe")!.getAttribute("loading")).toBe("eager");
  });

  it("draws the empty region inside the one-target panel without a frame of its own", async () => {
    mockAnswers([{ state: PENDING, islandSrc: null, targetHeaders: [ONE_HEADER] }]);
    const { container } = mountWidget();
    const region = await targetRegion(container);
    const panel = container.querySelector<HTMLElement>("[data-review-target-frame]");
    expect(panel).not.toBeNull();
    expect(region.parentElement).toBe(panel);
    expect(container.querySelector("iframe")).toBeNull();
    expect(region.getAttribute("data-island-load-state")).toBe("empty");
    expect(region.childElementCount).toBe(0);
    expect(region.className).toBe("relative overflow-hidden bg-surface-strong");
  });

  it("keeps the credentialed frame when later answers bring none, across a palette change", async () => {
    document.documentElement.className = "cinatra";
    const fetchMock = mockAnswers([
      { state: PENDING, islandSrc: credentialedSrc("first-value") },
      { state: PENDING, islandSrc: null },
    ]);
    const { container } = mountWidget();
    const url = await frameSrc(container);
    expect(url.searchParams.get("ic")).toBe("first-value");
    const frame = container.querySelector("iframe")!;
    const src = frame.getAttribute("src");

    const afterFirst = fetchMock.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst));
    await settle();
    expect(container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(src);

    const afterSecond = fetchMock.mock.calls.length;
    await act(async () => {
      document.documentElement.className = "dark";
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(afterSecond));
    await settle();
    expect(container.querySelector("iframe")).toBe(frame);
    expect(frame.getAttribute("src")).toBe(src);
  });
});
