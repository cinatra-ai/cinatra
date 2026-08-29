// @vitest-environment jsdom
/**
 * cinatra#2906 AC-5 — a refused confirm reaches the reader and writes nothing.
 *
 * When the server refuses a confirm because the set the card offered can no
 * longer be honoured, the plan's §6.4 step 7 reading applies unchanged: ONE red
 * line above the buttons, nothing else has changed, the reader can press again.
 * No new chrome, no new labels, no summary text — the row already renders a
 * returned `error`; what this pins is that the refusal actually lands there,
 * that the chips keep their three operable affordances, that the row does NOT
 * settle, and that a refusal leaves no durable trace on the run.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/recommendation-offered-set-refusal.test.tsx
 */
// THE §V CHIP-ROW IS THE CONVERSATION'S READING (cinatra#3047, review points C
// and E). The run page's own Skills step draws a checkbox per pill and one
// Continue beneath the list — pinned in `skills-step-checkbox-pills.test.tsx`
// and `skills-step-continue.test.tsx` — and the chat, the widget and the review
// page keep the three per-chip affordances this file is about until point E's
// own issue lands. So this suite is driven on `chat_thread`, which is where the
// drawing it asserts actually lives; nothing else about it changed.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh }),
}));

const confirmMock = vi.fn(async (input?: unknown) => {
  void input;
  return { ok: true, dispatched: true } as { ok: boolean; error?: string; dispatched?: boolean };
});
const skipMock = vi.fn(async () => ({ ok: true, dispatched: true }));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: (input: unknown) => confirmMock(input),
  skipRunRecommendationAction: () => skipMock(),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * The refusal sentence, read out of the server module that OWNS it.
 *
 * Not imported: `recommendation-hold.ts` is `server-only`, and pulling it into a
 * jsdom render would drag the whole server graph in. Read structurally instead,
 * the way this suite\'s siblings check structural claims — so the row is proven
 * to draw the real sentence, from one source of truth, with no second copy of it
 * to drift.
 */
const RECOMMENDATION_OFFER_STALE_REFUSAL: string = (() => {
  const src = readFileSync(
    path.resolve(__dirname, "../recommendation-hold.ts"),
    "utf8",
  );
  const m = src.match(
    /export const RECOMMENDATION_OFFER_STALE_REFUSAL\s*=\s*\n?\s*"([^"]+)";/,
  );
  if (!m) throw new Error("RECOMMENDATION_OFFER_STALE_REFUSAL not found in recommendation-hold.ts");
  return m[1]!;
})();

const OFFERED = [
  {
    skillId: "skill-a",
    skillRevisionId: "rev-a",
    name: "Skill A",
    score: 0.9,
    rank: 1,
    recommended: true,
    scoredFeatures: [],
    vendorName: null,
  },
];

async function mountRow() {
  const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  // THE HOST THAT STILL DRAWS §V's PER-CHIP ROW (cinatra#3062). What this file
  // pins — a refused confirm draws the server's reason in place and leaves every
  // control operable — is a property of the chip row, and the chip row is drawn
  // on the review page's gate region now that the run page (cinatra#3047) and
  // the two conversation hosts (cinatra#3062) take §V's checklist reading. The
  // conversation's own refusal reading is pinned on its own hosts, in
  // `skills-card-on-the-conversation-hosts.test.tsx`.
  return render(
    <LifecycleCardSurfaceProvider host="page_gate_region">
      <RunRecommendationChipRow
        runId="run-2906"
        agentPackageName="@cinatra-test/hold-fixture-agent"
        promptText="{}"
        initialRecommendations={OFFERED}
        holdRef="hold-ref-2906"
        decision={{ kind: "pending" }}
      />
    </LifecycleCardSurfaceProvider>,
  );
}

describe("cinatra#2906 AC-5 — a refused confirm draws the reason in place", () => {
  it("renders the server's refusal as the row's one red line and stays HELD", async () => {
    confirmMock.mockResolvedValue({ ok: false, error: RECOMMENDATION_OFFER_STALE_REFUSAL });

    await mountRow();
    const confirmBtn = await screen.findByRole("button", { name: "Confirm" });
    await act(async () => {
      confirmBtn.click();
    });

    // ONE red line, carrying the server's own words — no new chrome beside it.
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toBe(RECOMMENDATION_OFFER_STALE_REFUSAL);

    // The hold stays parked: the row is still the HELD drawing, never settled.
    const root = document.querySelector("[data-run-recommendation-chip-row]");
    expect(root?.getAttribute("data-lifecycle-card-state")).toBe("held");
    expect(document.querySelector("[data-run-recommendation-settled]")).toBeNull();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("leaves every chip control operable so the reader can act on the reason", async () => {
    confirmMock.mockResolvedValue({ ok: false, error: RECOMMENDATION_OFFER_STALE_REFUSAL });

    await mountRow();
    const confirmBtn = await screen.findByRole("button", { name: "Confirm" });
    await act(async () => {
      confirmBtn.click();
    });
    await screen.findByRole("alert");

    for (const action of ["confirm", "adjust", "skip"]) {
      const btn = document.querySelector(`[data-skill-action="${action}"]`);
      expect(btn).not.toBeNull();
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("a REFUSED confirm writes no selection row and no rejected-recommendation evidence", async () => {
    // The refusal is raised BEFORE any write, so the durable-store seam the
    // confirm would have driven is never reached — proven at the confirm itself
    // in `recommendation-offered-set-snapshot.test.ts` (AC-2/AC-3). Here the
    // row's own contract: a refusal never reports a decision upward.
    const onDecided = vi.fn();
    confirmMock.mockResolvedValue({ ok: false, error: RECOMMENDATION_OFFER_STALE_REFUSAL });

    const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
    const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
    // Driven on the host that still draws the per-chip row (cinatra#3062) — see
    // the note on `mountRow` above.
    render(
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <RunRecommendationChipRow
          runId="run-2906"
          agentPackageName="@cinatra-test/hold-fixture-agent"
          promptText="{}"
          initialRecommendations={OFFERED}
          holdRef="hold-ref-2906"
          decision={{ kind: "pending" }}
          onDecided={onDecided}
        />
      </LifecycleCardSurfaceProvider>,
    );

    const confirmBtn = await screen.findByRole("button", { name: "Confirm" });
    await act(async () => {
      confirmBtn.click();
    });
    await screen.findByRole("alert");

    expect(onDecided).not.toHaveBeenCalled();
    await waitFor(() => expect(routerRefresh).not.toHaveBeenCalled());
  });
});
