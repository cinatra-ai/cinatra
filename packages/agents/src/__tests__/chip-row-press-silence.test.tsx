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
// DRIVEN ON §V's OWN CONTROLS (cinatra#3047 review point C, then cinatra#3062).
// Every declared host draws a checkbox per pill and one Continue beneath the
// list now — the run page and the review page moved with cinatra#3047, the chat
// and the widget with cinatra#3062 — so the per-chip Confirm / Adjust / Skip
// this file used to press exists on no host at all. NEITHER CRITERION IS ABOUT
// THAT AFFORDANCE: AC1 is about what a REJECTED decision draws, and AC2 is about
// presses that land with no intervening render each reading the same base map
// from their own render closure. Both live in the row's decision path, which
// both readings share, and both are taken here on the boxes and the Continue.
// AC2's hazard is reproduced the same way it always was — several changes inside
// ONE `act` scope, so React cannot re-render between them.
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
  { skillId: "skill-enrich", skillRevisionId: "rev-1", recommended: true, rank: 1, score: 0.9, scoredFeatures: [], name: "Enrich contacts", vendorName: "Northstar" },
  { skillId: "skill-draft", skillRevisionId: "rev-2", recommended: true, rank: 2, score: 0.8, scoredFeatures: [], name: "Draft email", vendorName: "Northstar" },
  { skillId: "skill-send", skillRevisionId: "rev-3", recommended: true, rank: 3, score: 0.7, scoredFeatures: [], name: "Schedule send", vendorName: null },
];

async function mountRow() {
  const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  const out = render(
    // ANY DECLARED HOST DRAWS THE SAME READING NOW — see the note at the head of
    // this file. The run page is taken because it is the host §V's checklist
    // reached first; the other three draw the identical card, which
    // `recommendation-hold-card.test.tsx` compares byte for byte.
    <LifecycleCardSurfaceProvider host="run_card">
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

/** Every box §V draws, one per pill. */
const boxes = () =>
  [...document.querySelectorAll("[data-skills-step-checkbox]")] as HTMLButtonElement[];

/** One named box. */
const box = (skillId: string) => {
  const el = document.querySelector(
    `[data-skills-step-checkbox][data-skill-id="${skillId}"]`,
  ) as HTMLButtonElement | null;
  if (!el) throw new Error(`no checkbox on ${skillId}`);
  return el;
};

/** §V's one control, beneath the list. */
const continueControl = () =>
  document.querySelector("[data-skills-step-continue]") as HTMLButtonElement | null;

/** The row's ONE refusal line — §6.4 step 7's red line, nothing else. */
const refusalLine = () => document.querySelector('[role="alert"]');

/** One box change, landing with its own render in between (ordinary clicking). */
const toggle = async (skillId: string) => {
  const el = box(skillId);
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
};

/** The decision itself. */
const submit = async () => {
  const btn = continueControl();
  if (!btn) throw new Error("the row drew no Continue");
  await act(async () => {
    btn.click();
    await Promise.resolve();
  });
};

describe("AC1 — a REJECTED decision draws a refusal and leaves the row operable", () => {
  it("a decision that REJECTS draws the row's red line instead of nothing", async () => {
    confirmMock.mockRejectedValueOnce(new Error("transport failed"));
    await mountRow();

    // Every skill here is recommended, so the boxes come up checked and one
    // Continue carries the whole set — the same decision the three Confirms used
    // to make between them.
    await submit();

    // The action was reached — this is a REJECTION path, not a no-release path.
    expect(confirmMock).toHaveBeenCalledTimes(1);
    // §6.4 step 7: one red line, and it says something a reader can act on.
    const line = refusalLine();
    expect(line).not.toBeNull();
    expect(line!.textContent?.trim()).toBeTruthy();
    // …drawn in the row's EXISTING error line, not new chrome.
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(line!.className).toContain("text-destructive");
    // "…and nothing has changed. Press again." — the row is still operable, and
    // on this reading that means every box and the one Continue.
    expect(boxes()).toHaveLength(3);
    for (const b of boxes()) expect(b.disabled).toBe(false);
    expect(continueControl()).not.toBeNull();
    expect(continueControl()!.disabled).toBe(false);
    expect(document.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    // Nothing was reported as decided: no settle, no refresh.
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(
      document.querySelector("[data-run-recommendation-chip-row]")!
        .getAttribute("data-lifecycle-card-state"),
    ).toBe("held");
  });

  it("a rejected decision can be PRESSED AGAIN, and a second press that lands settles the row", async () => {
    confirmMock.mockRejectedValueOnce(new Error("transport failed"));
    await mountRow();

    await submit();
    expect(refusalLine()).not.toBeNull();

    // Press again — §6.4 step 7's own instruction to the reader. This is the
    // half of the criterion the row's `submitted` guard has to get right: it is
    // written on the press and cleared, with the refusal message, in ONE commit.
    await submit();
    expect(confirmMock).toHaveBeenCalledTimes(2);
    const second = confirmMock.mock.calls[1]![0] as { confirmedSkillIds: string[] };
    expect([...second.confirmedSkillIds].sort()).toEqual(
      THREE_SKILLS.map((s) => s.skillId).sort(),
    );
    expect(refusalLine()).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("an all-clear decision that REJECTS draws the row's red line instead of nothing", async () => {
    skipMock.mockRejectedValueOnce(new Error("transport failed"));
    await mountRow();

    // Nothing kept — every box cleared, so the release takes the skip branch.
    for (const s of THREE_SKILLS) await toggle(s.skillId);
    await submit();

    expect(skipMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
    const line = refusalLine();
    expect(line).not.toBeNull();
    expect(line!.textContent?.trim()).toBeTruthy();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(boxes()).toHaveLength(3);
    for (const b of boxes()) expect(b.disabled).toBe(false);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("a returned ok:false still draws ITS OWN message — the rejection path added no second line", async () => {
    confirmMock.mockResolvedValueOnce({ ok: false, error: "Refused: that hold is not this run's." });
    await mountRow();

    await submit();

    const alerts = [...document.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toContain("Refused: that hold is not this run's.");
  });
});

describe("AC2 — box changes with NO intervening render still release ONCE, with the full kept set", () => {
  it("two boxes cleared in one batch are BOTH cleared — the last change does not win", async () => {
    await mountRow();

    expect(boxes()).toHaveLength(3);
    // ONE act scope, two changes to DIFFERENT boxes: React has no chance to
    // re-render between them, so both handlers read the selection from the SAME
    // render closure. That is candidate (b) exactly, on the control that ships —
    // a base map spread from a stale closure keeps only the last change, and the
    // decision then carries a skill the reader had cleared.
    await act(async () => {
      box("skill-enrich").click();
      box("skill-draft").click();
      await Promise.resolve();
    });
    await submit();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const payload = confirmMock.mock.calls[0]![0] as { confirmedSkillIds: string[] };
    expect([...payload.confirmedSkillIds].sort()).toEqual(["skill-send"]);
    // The hold was released, and nothing was drawn as a refusal.
    expect(refusalLine()).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("the untouched batch releases once and carries every skill", async () => {
    await mountRow();

    await submit();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const payload = confirmMock.mock.calls[0]![0] as { confirmedSkillIds: string[] };
    expect([...payload.confirmedSkillIds].sort()).toEqual(
      THREE_SKILLS.map((s) => s.skillId).sort(),
    );
    expect(refusalLine()).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("a MIXED batch releases once and keeps only what stayed checked", async () => {
    await mountRow();

    // One box cleared inside the same act scope as two that are left alone.
    await act(async () => {
      box("skill-draft").click();
      await Promise.resolve();
    });
    await submit();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(skipMock).not.toHaveBeenCalled();
    const payload = confirmMock.mock.calls[0]![0] as { confirmedSkillIds: string[] };
    expect([...payload.confirmedSkillIds].sort()).toEqual(["skill-enrich", "skill-send"]);
  });

  it("a batch that clears every box releases once through the skip branch", async () => {
    await mountRow();

    await act(async () => {
      for (const s of THREE_SKILLS) box(s.skillId).click();
      await Promise.resolve();
    });
    await submit();

    expect(skipMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(refusalLine()).toBeNull();
  });

  it("changes that DO render in between are unchanged — one release, full kept set", async () => {
    await mountRow();

    for (const s of THREE_SKILLS) await toggle(s.skillId);
    for (const s of THREE_SKILLS) await toggle(s.skillId);
    await submit();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const payload = confirmMock.mock.calls[0]![0] as { confirmedSkillIds: string[] };
    expect([...payload.confirmedSkillIds].sort()).toEqual(
      THREE_SKILLS.map((s) => s.skillId).sort(),
    );
  });
});
