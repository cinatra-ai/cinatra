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

  it("is unchanged even on the widget host when the answer carried no credential", async () => {
    const { container } = renderWidget(null);
    const url = await frameSrc(container);
    expect([...url.searchParams.keys()].sort()).toEqual(["assistant", "instanceId", "ref"]);
    expect(container.querySelector("iframe")!.getAttribute("loading")).toBe("lazy");
  });
});

describe("the card takes a CREDENTIAL, never a URL", () => {
  it("drops an island URL minted for ANOTHER ref", async () => {
    const { container } = renderWidget(`${REVIEW_TARGET_ISLAND_PATH}?ref=other-ref&ic=${SEALED}`);
    const url = await frameSrc(container);
    expect(url.searchParams.get("ic")).toBeNull();
    expect(url.searchParams.get("ref")).toBe(REF);
  });

  it("drops an answer that points somewhere else entirely", async () => {
    const { container } = renderWidget(`/somewhere/else?ref=${encodeURIComponent(REF)}&ic=${SEALED}`);
    const url = await frameSrc(container);
    expect(url.pathname).toBe(REVIEW_TARGET_ISLAND_PATH);
    expect(url.searchParams.get("ic")).toBeNull();
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
