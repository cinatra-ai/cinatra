// @vitest-environment jsdom
//
// THE SKILLS CARD IN THE CHAT AND IN THE WIDGET IS §V's CHECKBOX ROW
// (cinatra#3062, epic #2926 §5/§6).
//
// The ratified drawing at the contract's pin, §V, on the reading this file
// drives — and it draws it IN A CHAT THREAD, which is why the two conversation
// hosts owe it:
//
//   "that same turn carries the chip-row beneath the line — one pill per skill,
//    each carrying a checkbox in front of its label. The label reads the skill's
//    name and then by its vendor, on one line … A checked box means that skill
//    is applied to the run; a box left clear leaves the skill out."
//   "The row and its Continue are the whole card. There is no heading plate
//    above the row, and a pill carries nothing to press — no Confirm, no Adjust,
//    no Skip. The reader sets the boxes and presses Continue beneath the list …
//    and the whole row is answered at once, every box together."
//   "One row, three readings. … For as long as the run has not started, a reader
//    who comes back to the Skills step is shown the same pills with the boxes
//    still able to take a change and Continue still beneath them … Once the run
//    has started the same pills are drawn with the state their boxes were left
//    in, read-only, and with no Continue."
//   "A row with every box clear is still the whole card. There is nothing to
//    skip and nothing that means skip … Nothing is summarised above the row, and
//    no panel stands in for it."
//
// and §IX: "Every card appears on every host, and it is the same card wherever
// it appears … Only the frame changes."
//
// EACH HOST IS DRIVEN THROUGH ITS OWN TRANSPORT, because that is the difference
// between the two conversation arms: `/chat` reads and decides through the
// cookie-bound server actions, and the site widget through the broker routes
// under its own credential with cookies omitted. One reading, two transports.
//
// Run:
//   cd packages/agents && npx vitest run \
//     src/__tests__/skills-card-on-the-conversation-hosts.test.tsx
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
  forcedRevisions?: Record<string, string>;
  adjustedSkillIds?: string[];
  holdRef?: string;
};
type DecisionResult = { ok: true; dispatched?: boolean } | { ok: false; error: string };

const confirmMock = vi.fn(async (_input: ConfirmInput): Promise<DecisionResult> => ({
  ok: true,
  dispatched: true,
}));
const skipMock = vi.fn(
  async (_input: { runId: string; holdRef?: string }): Promise<DecisionResult> => ({
    ok: true,
    dispatched: true,
  }),
);
const holdStateMock = vi.fn();

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: (input: { runId: string }) => holdStateMock(input),
  confirmRunRecommendationAction: (input: ConfirmInput) => confirmMock(input),
  skipRunRecommendationAction: (input: { runId: string; holdRef?: string }) => skipMock(input),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

import { VENDOR_BY_CONNECTIVE, VENDOR_MISSING_LABEL } from "@/lib/vendor-presentation";
import {
  LIFECYCLE_RECOMMENDATION_DECIDE_PATH,
  LIFECYCLE_RECOMMENDATION_HOLD_PATH,
  LifecycleCardSurfaceProvider,
} from "../lifecycle-card-runtime";
import {
  RecommendationHoldCard,
  RunRecommendationChipRow,
} from "../run-recommendation-chip-row";

const RUN_ID = "run-3062";
const PKG = "@cinatra-ai/blog-draft-writer-agent";

/** Two candidates: one the scorer RECOMMENDED, one it did not. */
const HELD = {
  state: "held" as const,
  agentPackageName: PKG,
  promptText: "{}",
  holdRef: "hold-ref-3062",
  canDecide: true,
  recommendations: [
    {
      skillId: "skill-blog",
      skillRevisionId: "skill-blog@1",
      name: "Blog content",
      vendorName: "Northstar",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
    {
      skillId: "skill-crm",
      skillRevisionId: "skill-crm@3",
      name: "CRM enrichment",
      vendorName: null,
      score: 0.2,
      rank: 2,
      recommended: false,
      scoredFeatures: [],
    },
  ],
};

const OFFER = [
  {
    skillId: "skill-blog",
    name: "Blog content",
    vendorName: "Northstar",
    skillRevisionId: "skill-blog@1",
    rank: 1,
    recommended: true,
  },
  {
    skillId: "skill-crm",
    name: "CRM enrichment",
    vendorName: null,
    skillRevisionId: "skill-crm@3",
    rank: 2,
    recommended: false,
  },
];

/** The settled hold, with the run's own answer and the offer it asked about. */
const settled = (runStarted: boolean) => ({
  state: "confirmed" as const,
  skillNames: ["Blog content"],
  holdRef: "hold-ref-3062",
  canDecide: true,
  runStarted,
  decided: [
    { skillId: "skill-blog", name: "Blog content", mark: "confirmed" as const },
    { skillId: "skill-crm", name: "CRM enrichment", mark: "skipped" as const },
  ],
  candidates: OFFER,
});

/** The all-clear settled hold — every recommendation left out. */
const allClear = (runStarted: boolean) => ({
  state: "skipped" as const,
  holdRef: "hold-ref-3062",
  canDecide: true,
  runStarted,
  decided: [],
  candidates: OFFER,
});

/** The widget's declaration: its own proof, cookies OMITTED. */
const WIDGET_AUTH = {
  headers: () => ({ "X-Cinatra-Widget-User-Token": "cwu_test" }),
  credentials: "omit" as const,
};

/**
 * The broker routes, answered exactly as the shipped ones answer — the read
 * returns the state itself, the decision returns `{ outcome }`. An unexpected
 * path or a request with no proof THROWS, so a transport that drops its
 * credential is caught here rather than reading as an empty card.
 */
function installBrokerStub(options: {
  hold: () => Record<string, unknown>;
  decide?: (body: Record<string, unknown>) => DecisionResult;
}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const i = init ?? {};
    const headers = (i.headers ?? {}) as Record<string, string>;
    if (i.method !== "POST") throw new Error(`POST-only route reached with ${String(i.method)}`);
    if (!headers["X-Cinatra-Widget-User-Token"]) {
      throw new Error(`${url} reached with no widget proof — the route answers 401`);
    }
    if (i.credentials !== "omit") throw new Error(`${url} was sent with ambient cookies`);
    const body = JSON.parse(String(i.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    const answer = (payload: unknown) =>
      ({ ok: true, json: async () => payload }) as unknown as Response;
    if (url === LIFECYCLE_RECOMMENDATION_HOLD_PATH) return answer(options.hold());
    if (url === LIFECYCLE_RECOMMENDATION_DECIDE_PATH) {
      return answer({
        outcome: options.decide ? options.decide(body) : { ok: true, dispatched: true },
      });
    }
    throw new Error(`unstubbed path: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, decisions: () => calls.filter((c) => c.url === LIFECYCLE_RECOMMENDATION_DECIDE_PATH) };
}

function mount(host: "chat_thread" | "site_widget" | "page_gate_region") {
  return render(
    <LifecycleCardSurfaceProvider
      host={host}
      {...(host === "site_widget" ? { auth: WIDGET_AUTH } : {})}
    >
      <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
    </LifecycleCardSurfaceProvider>,
  );
}

const row = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-run-recommendation-chip-row]");
const pills = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-recommendation-chip]"));
const boxes = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('[role="checkbox"]'));
const continueButton = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-skills-step-continue]");
const checkedState = (c: HTMLElement) =>
  Object.fromEntries(
    pills(c).map((p) => [
      p.getAttribute("data-skill-id"),
      p.querySelector('[role="checkbox"]')!.getAttribute("aria-checked"),
    ]),
  );

beforeEach(() => {
  holdStateMock.mockReset();
  holdStateMock.mockResolvedValue({ state: "none" });
  confirmMock.mockReset();
  confirmMock.mockResolvedValue({ ok: true, dispatched: true });
  skipMock.mockReset();
  skipMock.mockResolvedValue({ ok: true, dispatched: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// THE CHAT HOST (acceptance item 2)
// ---------------------------------------------------------------------------
describe("the chat host draws the checkbox row and one Continue", () => {
  beforeEach(() => holdStateMock.mockResolvedValue(HELD));

  it("draws one checkbox per skill, labelled by its name and vendor, and ONE Continue", async () => {
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(row(container)!.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    expect(row(container)!.getAttribute("data-run-recommendation-reading")).toBe(
      "skills-checklist",
    );
    expect(boxes(container)).toHaveLength(2);
    for (const pill of pills(container)) {
      // IN FRONT OF THE NAME: the box is the pill's first element child.
      const box = pill.querySelector<HTMLElement>('[role="checkbox"]')!;
      expect(pill.firstElementChild).toBe(box);
      const label = pill.querySelector(`#${CSS.escape(box.getAttribute("aria-labelledby")!)}`)!;
      // The accessible name is the SKILL's name, not the sentence about it.
      expect(label.textContent).toBe(
        pill.getAttribute("data-skill-id") === "skill-blog" ? "Blog content" : "CRM enrichment",
      );
    }
    // "<Skill name> by <vendor>", from the app's ONE byline resolver.
    const byline = (skillId: string) =>
      container
        .querySelector(`[data-skill-id="${skillId}"] [data-skills-step-vendor]`)!
        .textContent;
    expect(byline("skill-blog")).toBe(`${VENDOR_BY_CONNECTIVE} Northstar`);
    expect(byline("skill-crm")).toBe(`${VENDOR_BY_CONNECTIVE} ${VENDOR_MISSING_LABEL}`);
    // ONE Continue, beneath the list, and it is the only button that is not a box.
    expect(container.querySelectorAll("[data-skills-step-continue]")).toHaveLength(1);
    expect(continueButton(container)!.textContent).toContain("Continue");
  });

  it("carries NO Confirm / Adjust / Skip on any pill", async () => {
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Confirm");
    expect(container.textContent).not.toContain("Adjust");
    expect(container.textContent).not.toContain("Skip");
    // The row-level pair §V deleted long ago may not come back either.
    expect(container.querySelector('[data-action="confirm-run-recommendation"]')).toBeNull();
    expect(container.querySelector('[data-action="skip-run-recommendation"]')).toBeNull();
  });

  it("keeps the transcript's evidence marker on the card's own root", async () => {
    // The chat mount is identified by this marker, and the row IS the card — so
    // the marker rides the checklist root exactly as it rode the chip row.
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    const marked = container.querySelector("[data-chat-thread-recommendation-hold]");
    expect(marked).toBe(row(container));
    expect(marked!.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(marked!.getAttribute("data-lifecycle-card-state")).toBe("held");
  });

  it("releases the hold ONCE per run — a second press changes nothing", async () => {
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    fireEvent.click(continueButton(container)!);
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    // The screen states the refusal too: the whole reading is inert until the
    // settled reading replaces it.
    expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("true");
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    expect((continueButton(container) as HTMLButtonElement).disabled).toBe(true);
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(true);
    fireEvent.click(continueButton(container)!);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    // Checked in, unchecked out — decided in one act, through the shipped path.
    expect(confirmMock.mock.calls[0]![0].confirmedSkillIds).toEqual(["skill-blog"]);
    expect(confirmMock.mock.calls[0]![0].holdRef).toBe("hold-ref-3062");
  });

  it("draws the server's refusal when the run has moved on, and stays decidable", async () => {
    confirmMock.mockResolvedValue({ ok: false, error: "This run has already moved on." });
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    fireEvent.click(continueButton(container)!);
    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      if (!alert) throw new Error("no refusal drawn");
      expect(alert.textContent).toContain("This run has already moved on.");
    });
    // A refusal leaves the hold live: the boxes take a change again.
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true"),
    );
    expect((continueButton(container) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clearing every box is an ordinary answer — no outcome panel, no skip visuals", async () => {
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    const blog = pills(container).find((p) => p.getAttribute("data-skill-id") === "skill-blog")!;
    fireEvent.click(blog.querySelector('[role="checkbox"]')!);
    await waitFor(() => expect(checkedState(container)["skill-blog"]).toBe("false"));
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(skipMock).toHaveBeenCalledTimes(1));
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("the chat host's settled readings", () => {
  it("stays editable, with its Continue, while the run has NOT started", async () => {
    holdStateMock.mockResolvedValue(settled(false));
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    // The boxes start from the RUN's own record, not from the scorer's verdict.
    expect(checkedState(container)).toEqual({ "skill-blog": "true", "skill-crm": "false" });
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(false);
    expect(continueButton(container)).not.toBeNull();

    // A changed selection is recorded through the SAME hold.
    const crm = pills(container).find((p) => p.getAttribute("data-skill-id") === "skill-crm")!;
    fireEvent.click(crm.querySelector('[role="checkbox"]')!);
    await waitFor(() => expect(checkedState(container)["skill-crm"]).toBe("true"));
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect([...confirmMock.mock.calls[0]![0].confirmedSkillIds].sort()).toEqual([
      "skill-blog",
      "skill-crm",
    ]);
    expect(confirmMock.mock.calls[0]![0].holdRef).toBe("hold-ref-3062");
  });

  it("is read-only with no Continue once the run has started", async () => {
    holdStateMock.mockResolvedValue(settled(true));
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    expect(checkedState(container)).toEqual({ "skill-blog": "true", "skill-crm": "false" });
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(true);
    expect(continueButton(container)).toBeNull();
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
  });

  it("draws the all-clear answer as the row itself — no panel stands in for it", async () => {
    holdStateMock.mockResolvedValue(allClear(true));
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(container.querySelector("[data-recommendation-outcome-panel]")).toBeNull();
    expect(container.textContent).not.toContain("Skipped");
    expect(checkedState(container)).toEqual({ "skill-blog": "false", "skill-crm": "false" });
  });
});

describe("the card settles IN PLACE, and stays decidable until the run starts", () => {
  it("hands the step back the moment the authority answers, on the same mount", async () => {
    // THE CONVERSATION'S OWN CASE, and the convergence round's first finding.
    // On the run page a reader "comes back" to the Skills step by loading the
    // page, so a guard that lived as long as the mount was indistinguishable
    // from one that belongs to a decision. In a conversation the card settles IN
    // PLACE — same mount, same component — so §V's "Continue is not a lock"
    // reading was drawn with every box disabled and a Continue that did nothing.
    holdStateMock.mockResolvedValueOnce(HELD);
    holdStateMock.mockResolvedValue(settled(false));
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    // The authority answers, the row settles in place, and the run has not
    // started — so the same pills come back, still able to take a change.
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("decided"),
    );
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true"),
    );
    expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false");
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(false);
    expect((continueButton(container) as HTMLButtonElement).disabled).toBe(false);

    // …and the selection can really be changed again, against the SAME hold.
    const crm = pills(container).find((p) => p.getAttribute("data-skill-id") === "skill-crm")!;
    fireEvent.click(crm.querySelector('[role="checkbox"]')!);
    await waitFor(() => expect(checkedState(container)["skill-crm"]).toBe("true"));
    // TWO PRESSES INSIDE ONE DECISION ARE ONE DECISION, and the guard that says
    // so is `inFlightRef` / `releasedRef` — both written synchronously on the
    // press, before any render. The arm used to take this reading AFTER the
    // decision had landed, where it passed only because React's transition flag
    // still had the control disabled in the committed frame; cinatra#3047's
    // review point B took that flag out of the control's disabled reading,
    // because it clears in a later commit than the row's own `submitted` answer
    // and painted a decidable row with a dead control. Once the decision has
    // landed on a settled-but-not-started reading the step is decidable again
    // BY DESIGN (§V, "Continue is not a lock"), so the press that must be inert
    // is the one made while the first is still in flight, and that is the one
    // taken here.
    fireEvent.click(continueButton(container)!);
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(2));
    expect([...confirmMock.mock.calls[1]![0].confirmedSkillIds].sort()).toEqual([
      "skill-blog",
      "skill-crm",
    ]);
    expect(confirmMock.mock.calls[1]![0].holdRef).toBe("hold-ref-3062");
    // …and the second press really produced no third decision.
    expect(confirmMock).toHaveBeenCalledTimes(2);
  });

  it("gives two cards on one page their own label ids", async () => {
    // A TRANSCRIPT DRAWS ONE CARD PER HELD RUN, and two runs can be offered the
    // same skill. A label id derived from the skill would then sit on two
    // elements, and `aria-labelledby` would resolve to the first — the other
    // card's label, announced for this card's box. The convergence round's third
    // finding.
    holdStateMock.mockResolvedValue(HELD);
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <RecommendationHoldCard runId={RUN_ID} agentPackageName={PKG} wireRef={null} />
        <RecommendationHoldCard runId={`${RUN_ID}-b`} agentPackageName={PKG} wireRef={null} />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(pills(container)).toHaveLength(4));

    const ids = [...container.querySelectorAll("[data-skills-step-checkbox]")].map((b) =>
      b.getAttribute("aria-labelledby"),
    );
    expect(new Set(ids).size, "every box names its own label").toBe(4);
    // …and every one of them resolves INSIDE its own pill.
    for (const pill of pills(container)) {
      const box = pill.querySelector("[data-skills-step-checkbox]")!;
      const id = box.getAttribute("aria-labelledby")!;
      expect(container.querySelectorAll(`#${CSS.escape(id)}`)).toHaveLength(1);
      expect(pill.querySelector(`#${CSS.escape(id)}`)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// THE WIDGET HOST (acceptance item 3)
// ---------------------------------------------------------------------------
describe("the widget host draws the same card, under its own credential", () => {
  it("draws the checkbox row and decides through the broker", async () => {
    const broker = installBrokerStub({ hold: () => HELD });
    const { container } = mount("site_widget");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(row(container)!.getAttribute("data-lifecycle-card-host")).toBe("site_widget");
    expect(row(container)!.getAttribute("data-run-recommendation-reading")).toBe(
      "skills-checklist",
    );
    expect(boxes(container)).toHaveLength(2);
    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    expect(continueButton(container)).not.toBeNull();
    // The transcript's chat marker belongs to the OTHER conversation arm.
    expect(container.querySelector("[data-chat-thread-recommendation-hold]")).toBeNull();

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(broker.decisions()).toHaveLength(1));
    expect(broker.decisions()[0]!.body).toMatchObject({
      runId: RUN_ID,
      decision: "confirm",
      confirmedSkillIds: ["skill-blog"],
      holdRef: "hold-ref-3062",
    });
    // ONE release per run, on this transport too.
    fireEvent.click(continueButton(container)!);
    expect(broker.decisions()).toHaveLength(1);
    // …and no cookie-bound action was reached from this host.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(skipMock).not.toHaveBeenCalled();
  });

  it("draws the settled reading a reload lands on — read-only once the run runs", async () => {
    // A reload re-mounts the card, which re-reads the AUTHORITY: the reading is
    // durable state, so what a reader comes back to is what the run recorded.
    installBrokerStub({ hold: () => settled(true) });
    const { container } = mount("site_widget");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("decided");
    expect(checkedState(container)).toEqual({ "skill-blog": "true", "skill-crm": "false" });
    expect(continueButton(container)).toBeNull();
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the boxes editable before the run starts, and pins the same hold", async () => {
    const broker = installBrokerStub({ hold: () => settled(false) });
    const { container } = mount("site_widget");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(broker.decisions()).toHaveLength(1));
    expect(broker.decisions()[0]!.body.holdRef).toBe("hold-ref-3062");
  });
});

// ---------------------------------------------------------------------------
// THE HOST THIS ISSUE DOES NOT NAME (the deviation, pinned rather than implied)
// ---------------------------------------------------------------------------
describe("the review page's gate region draws the same card", () => {
  it("draws the checkbox pills and one Continue, and nothing per chip", async () => {
    // THE DEVIATION THIS ARM RECORDED IS CLOSED. It read "the review page's gate
    // region keeps §V's per-chip row", which was true while cinatra#3062 was the
    // only leg in flight: §IX rules the same card onto every host, this issue
    // named the chat and the widget, and the gate region was in neither issue's
    // scope. cinatra#3047's re-shoot round then moved it — the review page is
    // the run's OWN second page, and the change request names it beside the run
    // page — so the exception has no host. The arm keeps its job, which is to
    // state the fourth host's reading as a driven fact rather than leave it to
    // be discovered, and states the one it now draws.
    holdStateMock.mockResolvedValue(HELD);
    const { container } = mount("page_gate_region");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(container.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    expect(boxes(container)).toHaveLength(2);
    expect(continueButton(container)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE SECOND CONVERGENCE ROUND — the three defects a card that lives in a
// CONVERSATION has and a card on a page does not.
//
// All three come from the same root: on the run page a reader "comes back" by
// loading the page, so the mount and the decision had the same lifetime. In a
// transcript the card settles IN PLACE, from ANY reader's decision, on a mount
// that never went away — and every piece of state that was allowed to outlive
// its decision becomes a wrong reading.
// ---------------------------------------------------------------------------
describe("the conversation card is truthful when the authority answers underneath it", () => {
  /** A decision the test resolves by hand, so the in-flight window is real. */
  function deferredConfirm() {
    let resolve!: (r: DecisionResult) => void;
    confirmMock.mockImplementation(
      () =>
        new Promise<DecisionResult>((r) => {
          resolve = r;
        }),
    );
    return { land: (r: DecisionResult = { ok: true, dispatched: true }) => resolve(r) };
  }

  it("gives a reader who may not decide a box that does not move", async () => {
    // §V draws ONE reading for a reader without run access: the reason line, and
    // every control above it disabled. The per-chip row applied `canDecide` to
    // each chip's own buttons; the checklist applied it to Continue alone, so
    // the boxes stayed operable — an affordance that moves, changes the applied
    // set the card states, and decides nothing, over the sentence saying this
    // reader may not shape the run.
    holdStateMock.mockResolvedValue({ ...HELD, canDecide: false });
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    expect(container.querySelector("[data-run-recommendation-restricted]")).not.toBeNull();
    expect((continueButton(container) as HTMLButtonElement).disabled).toBe(true);
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false");
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(true);

    // …and the box does not move when it is pressed anyway.
    const before = checkedState(container);
    fireEvent.click(boxes(container)[0]!);
    expect(checkedState(container)).toEqual(before);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("drops an unsubmitted edit when the run's own answer arrives", async () => {
    // ANOTHER READER DECIDES. This reader had unchecked a skill and never
    // pressed Continue; the run then settles with that skill APPLIED and starts
    // running. The read-only card must state what the RUN recorded — a local
    // override that outlived the question makes the settled card say the run
    // applied a set it never applied.
    holdStateMock.mockResolvedValue(HELD);
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    fireEvent.click(boxes(container)[0]!);
    await waitFor(() => expect(checkedState(container)["skill-blog"]).toBe("false"));

    // The authority answers out of band, and the card re-reads it on the wake
    // the shipped card already listens for.
    holdStateMock.mockResolvedValue(settled(true));
    fireEvent(window, new Event("focus"));

    await waitFor(() =>
      expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("decided"),
    );
    await waitFor(() =>
      expect(checkedState(container)).toEqual({ "skill-blog": "true", "skill-crm": "false" }),
    );
    for (const box of boxes(container)) expect(box.hasAttribute("disabled")).toBe(true);
    expect(continueButton(container)).toBeNull();
    // Nothing was ever submitted from this mount.
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("never re-arms Continue underneath a decision that is still on the wire", async () => {
    // THE GUARDS BELONG TO ONE DECISION. Handing them back when the card settles
    // is right — except when the settle is somebody ELSE's and this reader's own
    // press has not come home. Re-arming there would let one reader hold two
    // decisions on one hold at once, and the server's binding is a
    // read-and-compare, not an atomic claim: both would write.
    const decision = deferredConfirm();
    holdStateMock.mockResolvedValue(HELD);
    const { container } = mount("chat_thread");
    await waitFor(() => expect(pills(container)).toHaveLength(2));

    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));

    // The card settles in place from another reader's decision, mid-flight.
    holdStateMock.mockResolvedValue(settled(false));
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("decided"),
    );

    // STILL SUBMITTED: this reader's press is on the wire, so nothing here is
    // pressable and a press is not a second decision.
    expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("true");
    expect((continueButton(container) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(continueButton(container)!);
    expect(confirmMock).toHaveBeenCalledTimes(1);

    // The decision comes home — and NOW the guards come back, because no change
    // of kind follows a card that has already settled.
    decision.land();
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false"),
    );
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    expect((continueButton(container) as HTMLButtonElement).disabled).toBe(false);

    // …and the step is genuinely decidable again, against the same hold.
    confirmMock.mockResolvedValue({ ok: true, dispatched: true });
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(2));
    expect(confirmMock.mock.calls[1]![0].holdRef).toBe("hold-ref-3062");
  });
});

// ---------------------------------------------------------------------------
// THE GUARDS AND THE BOXES BELONG TO THE AUTHORITY'S READING, NOT TO THE MOUNT
// (cinatra#3062, convergence round — findings 1 and 2).
//
// Both are driven on the ROW itself rather than through `RecommendationHoldCard`,
// because both need the authority's answer to change UNDERNEATH a live mount
// with no decision of the reader's in between — which on a shipped host is the
// wire's resume landing on a card already on the screen, and in a test is a
// re-render with the answer the resolver would then publish.
// ---------------------------------------------------------------------------
describe("a card whose authority changes underneath it", () => {
  const rowProps = {
    runId: RUN_ID,
    agentPackageName: PKG,
    holdRef: "hold-ref-3062",
    initialRecommendations: HELD.recommendations,
    variant: "inline" as const,
    submit: { confirm: confirmMock, skip: skipMock } as unknown as React.ComponentProps<typeof RunRecommendationChipRow>["submit"],
  };
  type RowDecision = React.ComponentProps<typeof RunRecommendationChipRow>["decision"];
  const rowTree = (decision: RowDecision) => (
    <LifecycleCardSurfaceProvider host="chat_thread">
      <RunRecommendationChipRow {...rowProps} decision={decision} />
    </LifecycleCardSurfaceProvider>
  );

  const SETTLED_NOT_STARTED = {
    kind: "confirmed" as const,
    skillNames: ["Blog content"],
    decided: settled(false).decided,
    runStarted: false,
    candidates: OFFER,
  };
  const SETTLED_STARTED = { ...SETTLED_NOT_STARTED, runStarted: true };

  it("drops an UNSUBMITTED box change when the run starts underneath it", async () => {
    // §V's settled-but-not-started reading is editable, so a reader can leave a
    // box moved and never press Continue. When the run starts, the same card
    // becomes the read-only record of what the run APPLIED — and an uncommitted
    // edit surviving into it would state a set the run never had. The kind does
    // not change across that moment (confirmed → confirmed), so nothing keyed on
    // the kind alone can see it.
    const { container, rerender } = render(rowTree(SETTLED_NOT_STARTED));
    await waitFor(() => expect(pills(container)).toHaveLength(2));
    expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("true");
    expect(checkedState(container)).toEqual({ "skill-blog": "true", "skill-crm": "false" });

    // The reader moves a box and does NOT press Continue.
    const crm = pills(container).find((p) => p.getAttribute("data-skill-id") === "skill-crm")!;
    fireEvent.click(crm.querySelector('[role="checkbox"]')!);
    await waitFor(() => expect(checkedState(container)["skill-crm"]).toBe("true"));
    expect(confirmMock).not.toHaveBeenCalled();

    // The run starts. The card is now the run's record.
    rerender(rowTree(SETTLED_STARTED));
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-skills-step-editable")).toBe("false"),
    );
    expect(continueButton(container)).toBeNull();
    expect(
      checkedState(container),
      "the read-only card states the RUN's applied set, not an unsent edit",
    ).toEqual({ "skill-blog": "true", "skill-crm": "false" });
  });

  it("hands a re-parked hold a Continue that works", async () => {
    // A guard cleared only on the way INTO a settled reading is never cleared on
    // the way back OUT of one. A hold that parks again on the same mount would
    // then inherit the previous decision's release, and its Continue would be
    // inert for ever.
    const { container, rerender } = render(rowTree({ kind: "pending" }));
    await waitFor(() => expect(pills(container)).toHaveLength(2));
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));

    rerender(rowTree(SETTLED_STARTED));
    await waitFor(() =>
      expect(row(container)!.getAttribute("data-lifecycle-card-state")).toBe("decided"),
    );

    // The run parks again on the same mount, with a new question.
    rerender(rowTree({ kind: "pending" }));
    await waitFor(() => expect(continueButton(container)).not.toBeNull());
    expect(row(container)!.getAttribute("data-skills-step-submitted")).toBe("false");
    expect((continueButton(container) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(continueButton(container)!);
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(2));
  });
});
