// @vitest-environment jsdom
//
// The SITE WIDGET as a lifecycle-card host (cinatra#2577, epic #2564 S8d).
//
// S1 built the surface gate fail-closed — no declared host, no card DOM — and
// left the widget declaring nothing. This is the slice that declares it, so the
// assertions are about what the declaration does and, more importantly, what it
// still does NOT do:
//
//   · review and verification draw on the widget, and the request that
//     authorizes them carries the surface's OWN credential (the broker proof),
//     never an ambient cookie belonging to whoever else uses the browser;
//   · every lifecycle kind draws there — the widget resolves the SAME set as
//     first-party chat, because a signed-in widget reader is the same person
//     with the same rights (corrected 2026-08-11; the per-surface matrix that
//     withheld the schedule proposal and the recommendation hold is gone);
//   · a denial is still no DOM at all, on this host as on every other.
//
// The first-party hosts declare no credential and keep S1's exact same-origin
// cookie request, which is pinned here too — the seam must be additive.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import {
  LifecycleCard,
  LifecycleCardSurfaceProvider,
  LIFECYCLE_VIEW_RESOLVE_PATH,
} from "../renderable-views/lifecycle-card";
import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const REVIEW_VIEW = {
  viewType: "artifact_review_gate" as const,
  schemaVersion: 1,
  ref: "ref-abc",
};
const VERIFICATION_VIEW = {
  viewType: "verification_summary" as const,
  schemaVersion: 1,
  ref: "ref-def",
};

/** The embed's declaration: headers built at call time, cookies deliberately off. */
const WIDGET_AUTH = {
  headers: () => ({
    Authorization: "Bearer cit_site",
    "X-Cinatra-Widget-User-Token": "cwu_user",
    "X-Cinatra-Widget-Origin": "https://blog.example.com",
  }),
  credentials: "omit" as const,
};

/**
 * The resolve answer, in the per-kind envelope the card parses (epic S9, S9c).
 * The kind is ECHOED from the request the card issued, so a test that renders a
 * different viewType still gets an answer to its own question.
 */
function lifecycleEnvelope(state: LifecycleCardState, init?: RequestInit): unknown {
  let kind = "artifact_review_gate";
  try {
    kind = JSON.parse(String(init?.body ?? "{}")).viewType ?? kind;
  } catch {
    // A test that issued no body keeps the review kind.
  }
  return {
    kind,
    state,
    body: kind === "verification_summary" && state.state !== "absent"
      ? VERIFICATION_BODY
      : null,
  };
}

/** A §VII reading — the verification kind carries one on every drawn state, and
 *  a card that receives none fails closed rather than half-drawing. */
const VERIFICATION_BODY = {
  version: 1,
  outcome: "verified",
  reviewedRevisionId: "rev-base",
  repairedRevisionId: "rev-fixed",
  scopePaths: ["content.title"],
  fieldDiff: [{ field: "content.title", before: "old", after: "new" }],
};

function mockResolve(state: LifecycleCardState) {
  const fetchMock = vi.fn(
    async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(lifecycleEnvelope(state, _init)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The (url, init) pair the card actually issued. */
function firstCall(fetchMock: ReturnType<typeof mockResolve>) {
  const call = fetchMock.mock.calls[0];
  expect(call).toBeDefined();
  return { url: call![0], init: (call![1] ?? {}) as RequestInit };
}

/** The `viewType` the card actually ASKED the server about. */
function bodyViewType(fetchMock: ReturnType<typeof mockResolve>): string {
  const { init } = firstCall(fetchMock);
  return (JSON.parse(String(init.body)) as { viewType: string }).viewType;
}

function renderOnWidget(view: { viewType: string; schemaVersion: number; ref: string }) {
  return render(
    <LifecycleCardSurfaceProvider host="site_widget" auth={WIDGET_AUTH}>
      <LifecycleCard view={view as never} />
    </LifecycleCardSurfaceProvider>,
  );
}

describe("review + verification draw on the widget", () => {
  it("draws the verification card once the resolve authorizes it", async () => {
    mockResolve({ state: "advisory" });
    renderOnWidget(VERIFICATION_VIEW);
    await waitFor(() => expect(screen.getByText("Verification")).toBeTruthy());
  });

  it("resolves the review card against the server", async () => {
    const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
    renderOnWidget(REVIEW_VIEW);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(firstCall(fetchMock).url).toBe(LIFECYCLE_VIEW_RESOLVE_PATH);
  });
});

describe("the widget's request carries its OWN credential", () => {
  it("sends the broker proof headers and OMITS cookies", async () => {
    const fetchMock = mockResolve({ state: "advisory" });
    renderOnWidget(VERIFICATION_VIEW);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const { init } = firstCall(fetchMock);
    expect(init.credentials).toBe("omit");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer cit_site",
      "X-Cinatra-Widget-User-Token": "cwu_user",
    });
  });

  it("a host that declares NO credential keeps S1's same-origin cookie request", async () => {
    const fetchMock = mockResolve({ state: "advisory" });
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <LifecycleCard view={VERIFICATION_VIEW} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const { init } = firstCall(fetchMock);
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("SURFACE PARITY on the widget branch (corrected 2026-08-11)", () => {
  it.each(["artifact_review_gate", "verification_summary", "trigger_schedule_proposal"])(
    "'%s' resolves and draws on the widget, exactly as on first-party chat",
    async (viewType) => {
      const fetchMock = mockResolve({ state: "pending", canDecide: true, canComment: true });
      renderOnWidget({ ...REVIEW_VIEW, viewType, ref: "ref-x" });
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(bodyViewType(fetchMock)).toBe(viewType);
    },
  );

  it("resolves the SAME kinds on the widget as on the chat thread", async () => {
    // The parity property as a comparison rather than a list: whatever the chat
    // thread asks the server about, the widget asks about too. This is the exact
    // assertion the removed per-surface matrix used to make false.
    const asked = async (host: "site_widget" | "chat_thread") => {
      const seen: string[] = [];
      for (const viewType of [
        "artifact_review_gate",
        "verification_summary",
        "trigger_schedule_proposal",
      ] as const) {
        const fetchMock = mockResolve({ state: "advisory" });
        render(
          <LifecycleCardSurfaceProvider
            host={host}
            auth={host === "site_widget" ? WIDGET_AUTH : undefined}
          >
            <LifecycleCard view={{ ...REVIEW_VIEW, viewType, ref: "ref-x" }} />
          </LifecycleCardSurfaceProvider>,
        );
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        seen.push(bodyViewType(fetchMock));
        cleanup();
      }
      return seen.sort();
    };
    expect(await asked("site_widget")).toEqual(await asked("chat_thread"));
  });
});

describe("a denial is still no card at all", () => {
  it("draws NO DOM when the widget resolve answers `absent`", async () => {
    const fetchMock = mockResolve({ state: "absent" });
    const { container } = renderOnWidget(VERIFICATION_VIEW);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("draws NO DOM when the widget resolve is rejected (401 — token expired)", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { container } = renderOnWidget(VERIFICATION_VIEW);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
