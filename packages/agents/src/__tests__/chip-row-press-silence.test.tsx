// @vitest-environment jsdom
/**
 * NO PRESS PATH ENDS IN SILENCE (cinatra#2905, epic #2784).
 *
 * The observation behind #2905: on a parked hold, every chip's `Confirm` was
 * pressed and nothing at all followed — no selection was recorded, the hold
 * stayed parked, and the row said nothing about why. The issue named four
 * candidate mechanisms rather than asserting one. This file holds the two that
 * are verifiable from the client alone, each written to FAIL against the row as
 * it stood before the fix.
 *
 *   AC1 — candidate (a): a REJECTED action is silent. Both release branches
 *         `await` the submitter with no `try`/`catch`, so an action that
 *         rejects (a transport failure, a server-side throw surfaced as a
 *         rejection) reaches no `setError`, no `onDecided` and no refresh. The
 *         row is left exactly as it was: held, every control present, nothing
 *         drawn. PLAN: Agents Lifecycle (A) §6.4 step 7 says a refused press
 *         draws "one red line ... above the buttons and nothing has changed.
 *         Press again." — so the refusal is the row's EXISTING error line
 *         carrying a plain sentence, and the row stays operable. No new chrome,
 *         no new label, no summary text.
 *
 *   AC2 — candidate (b): batched presses overwrite each other. `decideChip`
 *         spread the `chips` value captured in the CURRENT render, so presses
 *         that land with no intervening render each start from the same base
 *         map, only the last survives, the all-decided predicate never becomes
 *         true, and the row never releases at all.
 *
 * The suite drives the shipped `RunRecommendationChipRow` directly, the way the
 * settled-face suite does, so what is under test is the row's own decision
 * behaviour and not a host's resolve machinery.
 *
 * Run:
 *   cd packages/agents && npx vitest run src/__tests__/chip-row-press-silence.test.tsx
 */
// THE §V CHIP-ROW IS THE CONVERSATION'S READING (cinatra#3047, review points C
// and E). The run page's own Skills step draws a checkbox per pill and one
// Continue beneath the list — pinned in `skills-step-checkbox-pills.test.tsx`
// and `skills-step-continue.test.tsx` — and the chat, the widget and the review
// page keep the three per-chip affordances this file is about until point E's
// own issue lands. So this suite is driven on `chat_thread`, which is where the
// drawing it asserts actually lives; nothing else about it changed.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import type { RecommendedSkillForChip } from "../server-actions";

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
    ownKeys: () => ["Check", "SlidersHorizontal", "X", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: routerRefresh }),
}));

// The row fetches candidates only when they are not prefetched; every case here
// hands them in, so this stub exists to keep the server-only graph out of jsdom.
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

const confirmMock = vi.fn(async (input?: unknown) => {
  void input;
  return { ok: true, dispatched: true } as { ok: boolean; error?: string };
});
const skipMock = vi.fn(async (input?: unknown) => {
  void input;
  return { ok: true, dispatched: true } as { ok: boolean; error?: string };
});

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: (input: unknown) => confirmMock(input),
  skipRunRecommendationAction: (input: unknown) => skipMock(input),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const THREE_SKILLS: RecommendedSkillForChip[] = [
  { skillId: "skill-enrich", skillRevisionId: "rev-1", recommended: true, rank: 1, score: 0.9, scoredFeatures: [], name: "Enrich contacts" },
  { skillId: "skill-draft", skillRevisionId: "rev-2", recommended: true, rank: 2, score: 0.8, scoredFeatures: [], name: "Draft email" },
  { skillId: "skill-send", skillRevisionId: "rev-3", recommended: true, rank: 3, score: 0.7, scoredFeatures: [], name: "Schedule send" },
];

async function mountRow() {
  const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  const out = render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <RunRecommendationChipRow
        runId="run-2905"
        agentPackageName="@cinatra-test/hold-fixture-agent"
        promptText="{}"
        initialRecommendations={THREE_SKILLS}
        holdRef="hold-ref-2905"
        decision={{ kind: "pending" }}
      />
    </LifecycleCardSurfaceProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return out;
}

const controls = (action: "confirm" | "adjust" | "skip") =>
  [...document.querySelectorAll(`[data-skill-action="${action}"]`)] as HTMLButtonElement[];

/** The row's ONE refusal line — §6.4 step 7's red line, nothing else. */
const refusalLine = () => document.querySelector('[role="alert"]');

/** One press, each landing with its own render in between (ordinary clicking). */
const press = async (skillId: string, action: "confirm" | "skip") => {
  const btn = document.querySelector(
    `[data-skill-action="${action}"][data-skill-id="${skillId}"]`,
  ) as HTMLButtonElement | null;
  if (!btn) throw new Error(`no ${action} affordance on ${skillId}`);
  await act(async () => {
    btn.click();
    await Promise.resolve();
  });
};

describe("AC1 — a REJECTED decision draws a refusal and leaves the row operable", () => {
  it("a confirm that REJECTS draws the row's red line instead of nothing", async () => {
    confirmMock.mockRejectedValueOnce(new Error("transport failed"));
    await mountRow();

    for (const s of THREE_SKILLS) await press(s.skillId, "confirm");

    // The action was reached — this is a REJECTION path, not a no-release path.
    expect(confirmMock).toHaveBeenCalledTimes(1);
    // §6.4 step 7: one red line, and it says something a reader can act on.
    const line = refusalLine();
    expect(line).not.toBeNull();
    expect(line!.textContent?.trim()).toBeTruthy();
    // …drawn in the row's EXISTING error line, not new chrome.
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(line!.className).toContain("text-destructive");
    // "…and nothing has changed. Press again." — the row is still operable.
    expect(controls("confirm")).toHaveLength(3);
    expect(controls("adjust")).toHaveLength(3);
    expect(controls("skip")).toHaveLength(3);
    for (const b of [...controls("confirm"), ...controls("adjust"), ...controls("skip")]) {
      expect(b.disabled).toBe(false);
    }
    // Nothing was reported as decided: no settle, no refresh.
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(
      document.querySelector("[data-run-recommendation-chip-row]")!
        .getAttribute("data-lifecycle-card-state"),
    ).toBe("held");
  });

  it("a rejected confirm can be PRESSED AGAIN, and a second press that lands settles the row", async () => {
    confirmMock.mockRejectedValueOnce(new Error("transport failed"));
    await mountRow();

    for (const s of THREE_SKILLS) await press(s.skillId, "confirm");
    expect(refusalLine()).not.toBeNull();

    // Press again — §6.4 step 7's own instruction to the reader.
    await press("skill-enrich", "confirm");
    expect(confirmMock).toHaveBeenCalledTimes(2);
    const second = confirmMock.mock.calls[1]![0] as { confirmedSkillIds: string[] };
    expect([...second.confirmedSkillIds].sort()).toEqual(
      THREE_SKILLS.map((s) => s.skillId).sort(),
    );
    expect(refusalLine()).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("a skip that REJECTS draws the row's red line instead of nothing", async () => {
    skipMock.mockRejectedValueOnce(new Error("transport failed"));
    await mountRow();

    // Nothing kept — the release takes the skip branch.
    for (const s of THREE_SKILLS) await press(s.skillId, "skip");

    expect(skipMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
    const line = refusalLine();
    expect(line).not.toBeNull();
    expect(line!.textContent?.trim()).toBeTruthy();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(controls("skip")).toHaveLength(3);
    for (const b of controls("skip")) expect(b.disabled).toBe(false);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("a returned ok:false still draws ITS OWN message — the rejection path added no second line", async () => {
    confirmMock.mockResolvedValueOnce({ ok: false, error: "Refused: that hold is not this run's." });
    await mountRow();

    for (const s of THREE_SKILLS) await press(s.skillId, "confirm");

    const alerts = [...document.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toContain("Refused: that hold is not this run's.");
  });
});

describe("AC2 — every chip's Confirm with NO intervening render still releases ONCE, with the full kept set", () => {
  it("three Confirms in one batch release once and carry every skill", async () => {
    await mountRow();

    const buttons = controls("confirm");
    expect(buttons).toHaveLength(3);
    // ONE act scope, three presses: React has no chance to re-render between
    // them, so every handler that reads state from its own render closure reads
    // the SAME base map. That is candidate (b), reproduced deterministically.
    await act(async () => {
      for (const b of buttons) b.click();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const payload = confirmMock.mock.calls[0]![0] as { confirmedSkillIds: string[] };
    expect([...payload.confirmedSkillIds].sort()).toEqual(
      THREE_SKILLS.map((s) => s.skillId).sort(),
    );
    // The hold was released, and nothing was drawn as a refusal.
    expect(refusalLine()).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("a batch of MIXED marks releases once and keeps only what was confirmed", async () => {
    await mountRow();

    await act(async () => {
      (document.querySelector(
        '[data-skill-action="confirm"][data-skill-id="skill-enrich"]',
      ) as HTMLButtonElement).click();
      (document.querySelector(
        '[data-skill-action="skip"][data-skill-id="skill-draft"]',
      ) as HTMLButtonElement).click();
      (document.querySelector(
        '[data-skill-action="confirm"][data-skill-id="skill-send"]',
      ) as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(skipMock).not.toHaveBeenCalled();
    const payload = confirmMock.mock.calls[0]![0] as { confirmedSkillIds: string[] };
    expect([...payload.confirmedSkillIds].sort()).toEqual(["skill-enrich", "skill-send"]);
  });

  it("a batch where every chip is SKIPPED releases once through the skip branch", async () => {
    await mountRow();

    const buttons = controls("skip");
    await act(async () => {
      for (const b of buttons) b.click();
      await Promise.resolve();
    });

    expect(skipMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(refusalLine()).toBeNull();
  });

  it("presses that DO render in between are unchanged — one release, full kept set", async () => {
    await mountRow();

    for (const s of THREE_SKILLS) await press(s.skillId, "confirm");

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const payload = confirmMock.mock.calls[0]![0] as { confirmedSkillIds: string[] };
    expect([...payload.confirmedSkillIds].sort()).toEqual(
      THREE_SKILLS.map((s) => s.skillId).sort(),
    );
  });
});
