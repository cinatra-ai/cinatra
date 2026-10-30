// @vitest-environment jsdom
/**
 * THE SETTLED ROW STATES AN OUTCOME FOR EVERY SKILL IT ASKED ABOUT
 * (cinatra#2790, epic #2784 S9f).
 *
 * §V, character for character from the ratified drawing:
 *
 *   "SETTLED — ONE CHIP PER SKILL, EACH SHOWING WHAT IT RECORDED · The settled
 *    row is still the whole card: each chip states its own outcome in place.
 *    Nothing is summarised above it, and there is nothing left to press."
 *
 * and its own settled example draws three skills as `Enrich contacts ✓
 * Confirmed`, `Draft email ⇄ Adjusted`, `Schedule send ✕ Skipped` — the skipped
 * one in the skipped treatment, "the dashed edge and the muted ground, never a
 * status colour".
 *
 * WHAT WAS WRONG. The settled row drew one chip per DECISION ROW, and a skill
 * settled by pressing its own `Skip` leaves no decision row: the selection store
 * records what the run will use, and the rejected half is written only for a
 * candidate the scorer RECOMMENDED. On an offer where nothing scored over the
 * recommend threshold — every chip of a run started with no input params — a
 * skipped skill left no row at all and was simply absent from the card that
 * exists to state its outcome. Measured on the real widget run behind this
 * branch's cells: three chips for four decided skills.
 *
 * WHAT HOLDS IT NOW. The row draws one chip per skill of the HOLD'S OWN OFFER,
 * which is durable (cinatra#2906) and is carried on the settled state by the ONE
 * resolver both transports answer through. A candidate with no decision row
 * after the hold settled is SKIPPED.
 *
 * Run:
 *   cd packages/agents && npx vitest run src/__tests__/settled-row-draws-every-candidate.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

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
    ownKeys: () => ["Check", "SlidersHorizontal", "X", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../server-actions", () => ({ getRunRecommendedSkillsAction: vi.fn(async () => []) }));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));

afterEach(cleanup);

/**
 * THE FIXTURE IS THE REAL RUN'S SHAPE, not a convenient one: four skills were
 * offered, three of them left a decision row (confirm, adjust, confirm) and the
 * fourth was settled by a press on its OWN `Skip`, which writes nothing.
 */
const CANDIDATES = [
  { skillId: "@x/blog-post-matcher-skill:blog-post-matcher", name: "Blog Post Matcher Skill" },
  { skillId: "@x/blog-writing-skill:blog-writing", name: "Blog Writing Skill" },
  { skillId: "@x/brand-voice-matcher-skill:brand-voice-matcher", name: "Brand Voice Matcher Skill" },
  { skillId: "@x/web-research-skill:web-research", name: "Web Research Skill" },
].map((c, index) => ({
  // The offer's own presentation and decisive fields (cinatra#3047). This suite
  // measures the settled CHIPS on the widget, which read neither — they are
  // carried because the offer carries them, for the run page's own reading.
  ...c,
  vendorName: null,
  skillRevisionId: `${c.skillId}@1`,
  recommended: index !== 2,
}));
/** The SKIPPED one — the skill the card used to lose. */
const SKIPPED = CANDIDATES[2]!;
const DECISION_ROWS = [
  { skillId: CANDIDATES[0]!.skillId, name: CANDIDATES[0]!.name, mark: "confirmed" as const },
  { skillId: CANDIDATES[1]!.skillId, name: CANDIDATES[1]!.name, mark: "adjusted" as const },
  { skillId: CANDIDATES[3]!.skillId, name: CANDIDATES[3]!.name, mark: "confirmed" as const },
];

type Decision = Parameters<
  Awaited<typeof import("../run-recommendation-chip-row")>["RunRecommendationChipRow"]
>[0]["decision"];

/**
 * The widget's own declaration, in the one shape the provider mounts it in: a
 * credential built at the moment of the call, and cookies OMITTED. A
 * credential-declaring host with anything else is refused by the provider, so a
 * settled reading photographed on `site_widget` can only be reached this way.
 */
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_test" }),
  credentials: "omit" as const,
};

// WHAT THE DOM HALF READS (cinatra#3047, then cinatra#3062). The rule is
// unchanged — one pill per skill the hold ASKED ABOUT, each stating what the run
// recorded — and it is host-independent, which the pure-function half below
// asserts directly. What moved is how a host STATES it: every declared host
// draws §V's checklist now (the run page and the review page with cinatra#3047,
// the chat and the widget with cinatra#3062), so a settled pill states its
// outcome with a read-only box — ticked for a skill the run applied, clear for
// one it did not — instead of the retired per-chip face and its tint. Neither
// the set of pills nor their order changed with it, and those are what
// cinatra#2790 was about.
async function renderRow(
  decision: Decision,
  host: "page_gate_region" | "site_widget" | "run_card" = "page_gate_region",
) {
  const { RunRecommendationChipRow } = await import("../run-recommendation-chip-row");
  const { LifecycleCardSurfaceProvider } = await import("../lifecycle-card-runtime");
  const out = render(
    <LifecycleCardSurfaceProvider
      host={host}
      {...(host === "site_widget" ? { auth: WIDGET_AUTH } : {})}
    >
      <RunRecommendationChipRow
        runId="run-2790"
        agentPackageName="@x/blog-draft-writer-agent"
        decision={decision}
      />
    </LifecycleCardSurfaceProvider>,
  );
  await waitFor(() => expect(document.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull());
  return out;
}

const chips = () => [...document.querySelectorAll("[data-recommendation-chip]")];
const chipFor = (skillId: string) =>
  document.querySelector(`[data-recommendation-chip][data-skill-id="${CSS.escape(skillId)}"]`);
/** What a settled pill states: ticked = the run applied this skill. */
const appliedState = (skillId: string) =>
  document
    .querySelector(`[data-skills-step-checkbox][data-skill-id="${CSS.escape(skillId)}"]`)
    ?.getAttribute("aria-checked") ?? null;

describe("§V settled — one chip per skill the hold asked about (cinatra#2790)", () => {
  it("draws FOUR chips for four candidates with three decision rows, and the fourth is SKIPPED", async () => {
    await renderRow({ kind: "confirmed", skillNames: [], decided: DECISION_ROWS, candidates: CANDIDATES });

    expect(chips()).toHaveLength(4);

    // The three that recorded a row state exactly what they recorded: a row
    // whose mark is anything but `skipped` is a skill the run applied, and its
    // box says so.
    expect(appliedState(CANDIDATES[0]!.skillId)).toBe("true");
    expect(appliedState(CANDIDATES[1]!.skillId)).toBe("true");
    expect(appliedState(CANDIDATES[3]!.skillId)).toBe("true");

    // THE ONE THE CARD USED TO LOSE — present, named, and stating its outcome.
    const skipped = chipFor(SKIPPED.skillId);
    expect(skipped).not.toBeNull();
    expect(skipped!.textContent).toContain(SKIPPED.name);
    expect(appliedState(SKIPPED.skillId)).toBe("false");

    // AND NOTHING TO PRESS on it: the box is the statement, read-only, and the
    // retired per-chip face and its tint are drawn on no host at all.
    const box = document.querySelector(
      `[data-skills-step-checkbox][data-skill-id="${CSS.escape(SKIPPED.skillId)}"]`,
    ) as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    expect(skipped!.getAttribute("data-chip-mark")).toBeNull();
    expect(document.querySelectorAll("[data-skill-action]")).toHaveLength(0);
  });

  it("draws them in the order the hold OFFERED them — the held row, settled in place", async () => {
    await renderRow({ kind: "confirmed", skillNames: [], decided: DECISION_ROWS, candidates: CANDIDATES });
    expect(chips().map((c) => c.getAttribute("data-skill-id"))).toEqual(
      CANDIDATES.map((c) => c.skillId),
    );
  });

  it("MUTATION CONTROL: with the offer dropped, the row loses the skipped skill (the defect)", async () => {
    await renderRow({ kind: "confirmed", skillNames: [], decided: DECISION_ROWS });
    expect(chips()).toHaveLength(3);
    expect(chipFor(SKIPPED.skillId)).toBeNull();
  });

  it("a decided row the offer does not name is still drawn, after the offer's own chips", async () => {
    const extra = { skillId: "@x/other-skill:other", name: "Other Skill", mark: "confirmed" as const };
    await renderRow({
      kind: "confirmed",
      skillNames: [],
      decided: [...DECISION_ROWS, extra],
      candidates: CANDIDATES,
    });
    expect(chips()).toHaveLength(5);
    expect(chips().at(-1)?.getAttribute("data-skill-id")).toBe(extra.skillId);
  });

  it("a WHOLLY skipped offer states every skill it asked about, none of them applied", async () => {
    await renderRow({ kind: "skipped", decided: [], candidates: CANDIDATES });
    expect(chips()).toHaveLength(4);
    for (const c of CANDIDATES) expect(appliedState(c.skillId)).toBe("false");
    // Still the settled reading: nothing left to press.
    expect(document.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    expect(document.querySelector("[data-skills-step-continue]")).toBeNull();
  });

  it("no offer and no row draws the card and states its emptiness, not the retired panel", async () => {
    // THE ZERO-CHIP ROW, and the face it is stated with moved. cinatra#2893's
    // criterion is that this row draws its card and says something rather than
    // vanishing; the bordered outcome plate was how the per-chip hosts said it,
    // and no host draws that plate now. `zero-chip-settled-reading.test.tsx`
    // reads the criterion in full — what is pinned here is only that the wider
    // row left it alone.
    const { container } = await renderRow({ kind: "skipped", decided: [] });
    expect(chips()).toHaveLength(0);
    expect(document.querySelector("[data-recommendation-outcome-panel]")).toBeNull();
    const root = container.querySelector("[data-run-recommendation-chip-row]")!;
    expect(root.getAttribute("data-run-recommendation-decision")).toBe("skipped");
    expect(root.getAttribute("data-run-recommendation-settled")).toBe("true");
    expect(document.querySelector("[data-skills-step-list]")?.textContent?.trim()).toBeTruthy();
  });

  it("the HELD reading is untouched — an offer on a pending decision changes nothing", async () => {
    const { container } = await renderRow({ kind: "pending" });
    const root = container.querySelector("[data-run-recommendation-chip-row]");
    expect(root?.getAttribute("data-lifecycle-card-state")).toBe("held");
    expect(root?.getAttribute("data-can-decide")).toBe("true");
    expect(chips()).toHaveLength(0);
  });

  it("the card root's own declaration is unchanged by the wider row", async () => {
    const { container } = await renderRow({
      kind: "confirmed",
      skillNames: [],
      decided: DECISION_ROWS,
      candidates: CANDIDATES,
    });
    const root = container.querySelector("[data-run-recommendation-chip-row]")!;
    expect(root.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(root.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(root.getAttribute("data-lifecycle-card-host")).toBe("page_gate_region");
    // NOTHING IS OFFERED ON A SETTLED ROW, which the settled reading states as
    // its own two attributes: the step is not editable and it draws no control.
    // The arm used to read this off the ABSENCE of `data-can-decide`, which the
    // retired per-chip settled root omitted; §V's step publishes the reading
    // positively instead, and that is the stronger statement of the same thing.
    expect(root.getAttribute("data-skills-step-editable")).toBe("false");
    expect(document.querySelector("[data-skills-step-continue]")).toBeNull();
  });
});

describe("settledChipsForRow — the rule, as a function (cinatra#2790)", () => {
  it("marks every candidate with no decision row as SKIPPED, and keeps the rows it has", async () => {
    const { settledChipsForRow } = await import("../run-recommendation-chip-row");
    expect(settledChipsForRow(CANDIDATES, DECISION_ROWS)).toEqual([
      DECISION_ROWS[0],
      DECISION_ROWS[1],
      { skillId: SKIPPED.skillId, name: SKIPPED.name, mark: "skipped" },
      DECISION_ROWS[2],
    ]);
  });

  it("with NO offer it is the decided evidence, untouched — the pre-cinatra#2906 hold", async () => {
    const { settledChipsForRow } = await import("../run-recommendation-chip-row");
    expect(settledChipsForRow(undefined, DECISION_ROWS)).toEqual(DECISION_ROWS);
    expect(settledChipsForRow([], DECISION_ROWS)).toEqual(DECISION_ROWS);
  });

  /**
   * ONE CHIP PER SKILL is the drawing's own words, so a repeated id is one
   * skill. Neither durable source can repeat one today; these arms hold the
   * rule at the function's own edge rather than at its callers'.
   */
  it("a repeated OFFER entry is one skill, drawn once, in its first position", async () => {
    const { settledChipsForRow } = await import("../run-recommendation-chip-row");
    const doubled = [CANDIDATES[0]!, CANDIDATES[1]!, CANDIDATES[0]!];
    expect(settledChipsForRow(doubled, [DECISION_ROWS[0]!])).toEqual([
      DECISION_ROWS[0],
      { skillId: CANDIDATES[1]!.skillId, name: CANDIDATES[1]!.name, mark: "skipped" },
    ]);
  });

  it("a repeated DECISION row settles the chip once, and the FIRST row wins", async () => {
    const { settledChipsForRow } = await import("../run-recommendation-chip-row");
    const first = { skillId: CANDIDATES[0]!.skillId, name: CANDIDATES[0]!.name, mark: "confirmed" as const };
    const second = { ...first, mark: "adjusted" as const };
    expect(settledChipsForRow([CANDIDATES[0]!], [first, second])).toEqual([first]);
    // …and with no offer at all the same rule holds, so neither path can double.
    expect(settledChipsForRow(undefined, [first, second])).toEqual([first]);
  });

  it("a repeated decision row the offer does NOT name is appended once", async () => {
    const { settledChipsForRow } = await import("../run-recommendation-chip-row");
    const stray = { skillId: "@x/other-skill:other", name: "Other Skill", mark: "confirmed" as const };
    expect(settledChipsForRow([CANDIDATES[0]!], [stray, stray])).toEqual([
      { skillId: CANDIDATES[0]!.skillId, name: CANDIDATES[0]!.name, mark: "skipped" },
      stray,
    ]);
  });
});
