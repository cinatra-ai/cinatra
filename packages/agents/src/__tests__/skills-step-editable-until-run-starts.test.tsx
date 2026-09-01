// @vitest-environment jsdom
//
// THE BOXES STAY EDITABLE UNTIL THE RUN STARTS (cinatra#3047, review point 1).
//
// The review, in its own words: Continue records the selection and releases the
// hold, but the selection is NOT frozen. As long as the agent run has not begun
// executing — it is still at its setup, at its schedule, or at any other
// pre-start moment — a person who selects the completed Skills step sees the
// same pills with their boxes EDITABLE and one control to save a changed
// selection. Once the run has started, the same page is read-only with no
// control at all.
//
// WHAT IS PINNED HERE:
//
//   1. THE BOUNDARY, named and pinned: a run has started once its status leaves
//      `PRE_EXECUTION_RUN_STATUSES` — `pending_input`, `pending_trigger`,
//      `armed`. The FIRST status on the other side is `queued`, which is the
//      dispatch CAS itself;
//   2. a settled step on a run that has NOT started draws editable boxes and the
//      Continue, with each box starting from what the RUN recorded (not from
//      what the scorer recommended);
//   3. the same step on a run that HAS started draws the same pills read-only,
//      with no control of any kind;
//   4. a caller that does not answer the question at all gets the read-only
//      reading — a step is never made editable by silence;
//   5. a CHANGED selection is recorded through the EXISTING decision path, bound
//      to the SAME hold the first decision was bound to (per skill: confirmed ↔
//      skipped), and the run's selected-skill rows therefore read back the
//      latest selection;
//   6. it is idempotent under a double press: two presses inside the in-flight
//      window are ONE decision;
//   7. AND THE PRESS ITSELF DOES NOT FREEZE THE CARD (cinatra#3062, the second
//      capture). §V: "Continue does not close the row." A decision that lands
//      while the run has NOT started leaves the drawing's editable reading on
//      screen — the same pills, the boxes still able to take a change, and
//      Continue still beneath them. The card in a conversation settles IN PLACE,
//      so a reading the authority never changes must still hand the row back.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-step-editable-until-run-starts.test.tsx
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

type ConfirmInput = {
  runId: string;
  agentPackageName: string;
  confirmedSkillIds: string[];
  promptText?: string;
  forcedRevisions?: Record<string, string>;
  adjustedSkillIds?: string[];
  holdRef?: string;
};
const confirmRunRecommendationAction = vi.fn(async (_input: ConfirmInput) => ({
  ok: true,
  dispatched: false,
}));
const skipRunRecommendationAction = vi.fn(async (_input: { runId: string; holdRef?: string }) => ({
  ok: true,
  dispatched: false,
}));
const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: (input: ConfirmInput) => confirmRunRecommendationAction(input),
  skipRunRecommendationAction: (input: { runId: string; holdRef?: string }) =>
    skipRunRecommendationAction(input),
}));

vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import {
  LEGAL_TRANSITIONS,
  PRE_EXECUTION_RUN_STATUSES,
  recommendationRunHasStarted,
  type AgentRunStatus,
} from "../run-status";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { RecommendationHoldCard } from "../run-recommendation-chip-row";

const RUN_ID = "run-3047-editable";
const PKG = "@cinatra-ai/blog-draft-writer-agent";
const HOLD_REF = "hold-ref-3047";

/** The hold's own offer: one skill it recommended, one it did not. */
const CANDIDATES = [
  {
    skillId: "@cinatra-ai/chat:blog-content",
    name: "Blog Content Skill",
    vendorName: "Northstar",
    skillRevisionId: "blog-content@7",
    recommended: true,
  },
  {
    skillId: "@cinatra-ai/chat:company-research",
    name: "Company Research Skill",
    vendorName: null,
    skillRevisionId: "company-research@2",
    recommended: false,
  },
];

/** The run recorded the recommended one and left the other out. */
function settled(runStarted: boolean | undefined) {
  return {
    state: "confirmed" as const,
    skillNames: ["Blog Content Skill"],
    decided: [
      {
        skillId: "@cinatra-ai/chat:blog-content",
        name: "Blog Content Skill",
        mark: "confirmed" as const,
      },
      {
        skillId: "@cinatra-ai/chat:company-research",
        name: "Company Research Skill",
        mark: "skipped" as const,
      },
    ],
    candidates: CANDIDATES,
    holdRef: HOLD_REF,
    canDecide: true,
    ...(runStarted === undefined ? {} : { runStarted }),
  };
}

/**
 * The hold as the authority answers it while the run is still parked at the
 * gate — the reading the second capture measured BEFORE and AFTER the press,
 * because this card's own resolve is not what moves when the run leaves the
 * recommendation gate for its next one.
 */
function held() {
  return {
    state: "held" as const,
    agentPackageName: PKG,
    promptText: "Write the Q3 post.",
    recommendations: CANDIDATES.map((c) => ({
      ...c,
      score: c.recommended ? 0.9 : 0.2,
      rank: 1,
      scoredFeatures: [],
    })),
    holdRef: HOLD_REF,
    canDecide: true,
  };
}

function mount(host: "run_card" | "chat_thread" | "page_gate_region") {
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

const row = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const boxes = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('[role="checkbox"]'));
const boxFor = (c: HTMLElement, skillId: string) =>
  c.querySelector<HTMLElement>(`[data-skills-step-checkbox][data-skill-id="${skillId}"]`)!;
const continueButton = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-skills-step-continue]");

beforeEach(() => {
  holdStateMock.mockReset();
  confirmRunRecommendationAction.mockClear();
  skipRunRecommendationAction.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the boundary — which moment freezes the selection", () => {
  it("names the pre-start statuses, and nothing else", () => {
    // The platform's own set, read rather than re-listed: the three statuses a
    // run holds before it has ever run.
    expect([...PRE_EXECUTION_RUN_STATUSES].sort()).toEqual([
      "armed",
      "pending_input",
      "pending_trigger",
    ]);
    for (const status of ["pending_input", "pending_trigger", "armed"] as AgentRunStatus[]) {
      expect(recommendationRunHasStarted(status)).toBe(false);
    }
  });

  it("keeps `pending_trigger` pre-start on BOTH of its entry edges", () => {
    // The trigger step is reached from `pending_input` (the reader opened the
    // form) AND from `queued` (setup finished with no trigger chosen yet), so a
    // `pending_trigger` run may have been queued before. It has still not
    // EXECUTED: it leaves for execution through `pending_trigger->queued`, and
    // the work begins at the `queued->running` CAS after that. Both edges are
    // real transitions in the shipped table, and the pre-start answer is the
    // same on both.
    expect(LEGAL_TRANSITIONS.has("pending_input->pending_trigger")).toBe(true);
    expect(LEGAL_TRANSITIONS.has("queued->pending_trigger")).toBe(true);
    expect(LEGAL_TRANSITIONS.has("pending_trigger->queued")).toBe(true);
    expect(recommendationRunHasStarted("pending_trigger")).toBe(false);
    // …and the state it leaves for is on the far side, which is what makes the
    // boundary a boundary rather than a preference.
    expect(recommendationRunHasStarted("queued")).toBe(true);
  });

  it("treats every other status as started — `queued` first among them", () => {
    // `queued` IS the dispatch CAS (`pending_input->queued`, `armed->queued`),
    // so it is the first moment on the far side of the boundary.
    for (const status of [
      "queued",
      "running",
      "pending_approval",
      "waiting_trigger",
      "completed",
      "failed",
      "stopped",
    ] as AgentRunStatus[]) {
      expect(recommendationRunHasStarted(status)).toBe(true);
    }
  });

  it("reads an unknown or absent status as NOT started, which is the decidable side", () => {
    expect(recommendationRunHasStarted(null)).toBe(false);
    expect(recommendationRunHasStarted(undefined)).toBe(false);
    expect(recommendationRunHasStarted("")).toBe(false);
  });
});

describe("the settled Skills step BEFORE the run starts", () => {
  beforeEach(() => holdStateMock.mockResolvedValue(settled(false)));

  it("draws the same pills with their boxes EDITABLE, and a control to save", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(false);
    expect(continueButton(container)).not.toBeNull();
  });

  it("starts each box from what the RUN recorded, not from what the scorer said", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    // The kept one reads checked; the one left out reads clear — even though the
    // scorer's own default for the second is also "unchecked", the FIRST one is
    // the discriminating case: it is checked because the run recorded it.
    expect(boxFor(container, CANDIDATES[0].skillId).getAttribute("aria-checked")).toBe("true");
    expect(boxFor(container, CANDIDATES[1].skillId).getAttribute("aria-checked")).toBe("false");
  });

  it("hands a CHANGED selection to the existing decision action, bound to the SAME hold", async () => {
    // WHAT THIS MEASURES, exactly: the ARGUMENTS the step submits. What the run's
    // durable rows then become — the replace within the hold's offer, and its
    // refusal on a started run — is the server's half and is pinned where it can
    // actually be read, in `skills-step-selection-reads-back-latest.test.ts`.
    const { container } = mount("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));

    // Take the recorded skill out, and put the other one in.
    fireEvent.click(boxFor(container, CANDIDATES[0].skillId));
    fireEvent.click(boxFor(container, CANDIDATES[1].skillId));
    fireEvent.click(continueButton(container)!);

    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    const call = confirmRunRecommendationAction.mock.calls[0]![0];
    expect(call.confirmedSkillIds).toEqual([CANDIDATES[1].skillId]);
    // The SAME hold the first decision was bound to — an idempotent retry the
    // decision path already accepts, not a new hold.
    expect(call.holdRef).toBe(HOLD_REF);
    // A kept skill the scorer did not recommend is pinned at the revision the
    // offer recorded, exactly as a first decision pins it.
    expect(call.forcedRevisions).toEqual({
      [CANDIDATES[1].skillId]: CANDIDATES[1].skillRevisionId,
    });
    // No adjusted mark can come from a checkbox.
    expect(call.adjustedSkillIds).toBeUndefined();
  });

  it("is idempotent under a double press — two presses are ONE call to the decision action", async () => {
    const { container } = mount("run_card");
    await waitFor(() => expect(continueButton(container)).not.toBeNull());
    fireEvent.click(continueButton(container)!);
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    expect(skipRunRecommendationAction).not.toHaveBeenCalled();
  });
});

describe("the settled Skills step ONCE the run has started", () => {
  it("is read-only, with no control at all", async () => {
    holdStateMock.mockResolvedValue(settled(true));
    const { container } = mount("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(true);
    expect(continueButton(container)).toBeNull();
    // …and nothing else to press either.
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    expect(container.querySelectorAll("button:not([role='checkbox'])")).toHaveLength(0);
  });

  it("still states what the run recorded, box by box", async () => {
    holdStateMock.mockResolvedValue(settled(true));
    const { container } = mount("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    expect(boxFor(container, CANDIDATES[0].skillId).getAttribute("aria-checked")).toBe("true");
    expect(boxFor(container, CANDIDATES[1].skillId).getAttribute("aria-checked")).toBe("false");
  });

  it("falls to the read-only reading when the resolver did not answer the question", async () => {
    holdStateMock.mockResolvedValue(settled(undefined));
    const { container } = mount("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    expect(continueButton(container)).toBeNull();
  });
});

describe("the conversation takes the SAME reading (cinatra#3062)", () => {
  it("keeps the chat's settled step editable while the run has not started", async () => {
    // §V, at the contract's pin: "For as long as the run has not started, a
    // reader who comes back to the Skills step is shown the same pills with the
    // boxes still able to take a change and Continue still beneath them." The
    // boundary is the ONE shipped predicate, so the chat cannot disagree with
    // the run page about when a run has started.
    holdStateMock.mockResolvedValue(settled(false));
    const { container } = mount("chat_thread");
    await waitFor(() => expect(row(container)).not.toBeNull());
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    expect(boxes(container).length).toBeGreaterThan(0);
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(false);
    expect(continueButton(container)).not.toBeNull();
  });

  it("freezes it once the run has started, with no Continue left", async () => {
    holdStateMock.mockResolvedValue(settled(true));
    const { container } = mount("chat_thread");
    await waitFor(() => expect(row(container)).not.toBeNull());
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(true);
    expect(continueButton(container)).toBeNull();
  });
});

describe("the reading has reached every host", () => {
  it("the review page's gate region is editable pre-start and frozen after", async () => {
    // THE LAST EXCEPTION IS GONE. This arm read "the one host this reading has
    // not reached" and pinned the review page's gate region to its own settled
    // chips; cinatra#3047's re-shoot round moved that host onto §V, so the
    // run-start boundary — the one shipped predicate the chat cannot disagree
    // with either — now governs all four hosts alike. The arm keeps measuring
    // the fourth host, on both sides of the boundary rather than one.
    holdStateMock.mockResolvedValue(settled(false));
    const { container } = mount("page_gate_region");
    await waitFor(() => expect(row(container)).not.toBeNull());
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    expect(boxes(container).length).toBeGreaterThan(0);
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(false);
    expect(continueButton(container)).not.toBeNull();

    cleanup();
    holdStateMock.mockResolvedValue(settled(true));
    const frozen = mount("page_gate_region");
    await waitFor(() => expect(row(frozen.container)).not.toBeNull());
    expect(row(frozen.container)!.getAttribute("data-skills-step-editable")).toBe("false");
    for (const box of boxes(frozen.container)) expect(box.hasAttribute("disabled")).toBe(true);
    expect(continueButton(frozen.container)).toBeNull();
  });
});

describe("Continue is not a lock — a decision that lands while the run has not started", () => {
  // THE DEFECT THE SECOND CAPTURE MEASURED, driven here. In the chat the card
  // settles IN PLACE, and the authority's re-read can still answer `held` after
  // the decision has landed. The row's submit latch was handed back only by a
  // CHANGE in the authority's reading, so a reading that never changed left the
  // boxes disabled and the Continue greyed for good — a card frozen at
  // `stepSubmitted=true` / `stepEditable=false` with a disabled Continue, for a
  // reader who may decide, on a run that has not started.
  //
  // §V draws exactly three readings and that is none of them: the boxes take a
  // change and Continue stands beneath them while the run has not started; the
  // pills are read-only with NO Continue once it has; and the disabled floor
  // belongs to the reader who may not shape the run at all. The guards are
  // therefore handed back when the decision comes HOME, whichever way it went.
  beforeEach(() => holdStateMock.mockResolvedValue(held()));

  it("hands the row back to the drawing's editable reading, with a LIVE Continue", async () => {
    const { container } = mount("chat_thread");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false"),
    );
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(false);
    expect(continueButton(container)!.hasAttribute("disabled")).toBe(false);
  });

  it("takes a CHANGED selection on the next press, bound to the same hold", async () => {
    // "…and may change the selection." The second press is the same question
    // asked again, against the same hold — the idempotent-retry case the
    // decision path already accepts.
    const { container } = mount("chat_thread");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(continueButton(container)!.hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(boxFor(container, CANDIDATES[1].skillId));
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(2));
    const second = confirmRunRecommendationAction.mock.calls[1]![0];
    expect(second.confirmedSkillIds).toEqual([CANDIDATES[0].skillId, CANDIDATES[1].skillId]);
    expect(second.holdRef).toBe(HOLD_REF);
  });

  it("is still ONE decision under a double press inside the in-flight window", async () => {
    // Handing the guards back on the outcome must not re-open the window the
    // press itself closes: `inFlightRef` is written synchronously, and it is
    // what makes two presses in one tick one decision.
    let settle: (v: { ok: true; dispatched: boolean }) => void = () => {};
    confirmRunRecommendationAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve as typeof settle;
        }),
    );
    const { container } = mount("chat_thread");
    await waitFor(() => expect(continueButton(container)).not.toBeNull());
    fireEvent.click(continueButton(container)!);
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    // …and while it is in flight the step states that it is, which is the whole
    // window `data-skills-step-submitted` names.
    expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("true");
    settle({ ok: true, dispatched: false });
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false"),
    );
    expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1);
  });

  it("draws the same reading on the run page host", async () => {
    // The card chrome travels: the run page host takes the same
    // reading, and the capture measured the same freeze there.
    const { container } = mount("run_card");
    await waitFor(() => expect(boxes(container)).toHaveLength(2));
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmRunRecommendationAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true"),
    );
    expect(continueButton(container)!.hasAttribute("disabled")).toBe(false);
  });
});
