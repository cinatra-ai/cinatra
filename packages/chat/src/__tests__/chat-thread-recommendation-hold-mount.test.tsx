// @vitest-environment jsdom
/**
 * THE §V RECOMMENDATION HOLD IS DECIDED IN THE CONVERSATION.
 *
 * A chat-started run can PARK on the run-start recommendation hold. The
 * decision then belongs where the person is — in the transcript — and a
 * sentence telling them to go somewhere else is a pointer standing in for an
 * implementation, not an implementation.
 *
 * So this file pins the mount STRUCTURALLY, in the shape the evidence for this
 * slice is read in, and every assertion is one a pointer cannot satisfy:
 *
 *   • the card is INSIDE `[data-conversation-list]`;
 *   • it sits in a wrapper marked `data-chat-thread-recommendation-hold`;
 *   • that wrapper IS the row, and carries the decision the drawing gives this
 *     host — a checkbox per skill and one Continue (cinatra#3062);
 *   • and the wrapper is OUTSIDE the inline run panel's subtree, because the
 *     panel is the separate `run_card` host and a card nested inside it would
 *     make "which host drew this" unanswerable.
 *
 * The card is mounted through the REAL transcript renderer on the REAL
 * conversation column. Only the cookie-bound state action and the run panel's
 * CHROME are replaced — the first because it reaches a server action, the
 * second because its own rendering is pinned in the agents package.
 *
 * The panel stub is not opaque, and that matters. It keeps the panel's own
 * mount RULE (`runCardOwnsLifecycleCopy`, called rather than re-expressed) and
 * mounts the same card the panel would, so this file can count how many cards a
 * turn actually shows. An opaque stub is why a duplicate settled card survived
 * a review round here: it hid the second mount instead of measuring it.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/chat-thread-recommendation-hold-mount.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, render, waitFor } from "@testing-library/react";

// The column loads the message list behind a lazy boundary. Alone that resolves
// in milliseconds; inside the full package run it competes with ~57 other files
// and can exceed testing-library's 1s default, which would fail the mount for a
// reason that has nothing to do with the card.
configure({ asyncUtilTimeout: 15_000 });

import type { UiMessage } from "../types";

// The composer this column mounts reads `window.localStorage` on mount. jsdom
// under Node 25 exposes the property without its methods, which throws before
// any assertion here runs — a runtime quirk, not a fact about the code under
// test. Installed ONLY when the environment is missing it, so a working
// localStorage (CI's Node 24) is untouched and this file is verifiable on both.
if (typeof globalThis.window !== "undefined" &&
    typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const RUN_ID = "764eb973-3f5f-4592-96c2-891f160a92d6";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

// The card's own authority. The REAL `RecommendationHoldCard` renders against
// whatever this returns, so the held/decided shapes below are the only stand-in.
const holdState = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  calls: [] as unknown[],
  /** When set, the read HANGS on this promise — the endpoint that never answers. */
  pending: null as Promise<Record<string, unknown> | null> | null,
}));
// The card imports these by relative path inside the agents package; vitest
// resolves a relative mock specifier to the same module id, so this replaces
// exactly the module the real component reaches.
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async (input: unknown) => {
    holdState.calls.push(input);
    if (holdState.pending) return holdState.pending;
    return holdState.current;
  },
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));
const hitlScreenStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
// The HITL screen card's own server-only entry, stubbed for the same reason
// (cinatra#2930, lifecycle-b W3): the column mounts that card beside the §V one
// now, and an unstubbed `"use server"` module fails the whole lazy chat chunk.
// The default answer is "no screen", so a suite that is not about this kind sees
// exactly what it saw before the card existed.
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: () => hitlScreenStateMock(),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
// The chip row prefetches the agent's assignable skills while a hold is live.
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: async () => [],
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
}));

// The run panel is the OTHER host, and it is the one that used to draw a SECOND
// copy of this card in the same turn.
//
// The stub is no longer opaque. An opaque one is exactly why the duplication
// went unseen here: it rendered a marked div, so the transcript could be
// asserted for the chat card while the panel's own mount stayed invisible to
// this file. Now the stub does what the panel does — it declares the `run_card`
// host and mounts the SAME card — but it takes the mount decision from
// `runCardOwnsLifecycleCopy`, the very function the panel calls, rather than
// from a second copy of the condition. So this file measures the real rule: if
// the panel ever starts drawing its copy inside a transcript again, the
// one-card assertions below go red.
//
// What stays stubbed is the panel's chrome and its data fetch, which belong to
// the agents package's own tests.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => {
    const ambientHost = useLifecycleCardHost();
    return (
      <div data-testid="inline-run-panel" data-run-card-host="" data-run-id={runId}>
        {runCardOwnsLifecycleCopy(ambientHost) ? (
          <LifecycleCardSurfaceProvider host="run_card">
            <RecommendationHoldCard runId={runId} wireRef={null} />
          </LifecycleCardSurfaceProvider>
        ) : null}
      </div>
    );
  },
}));

// The chip row refreshes the router after a decision.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => null,
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));

// The panel's OWN mount rule and the host declaration it uses, imported rather
// than re-expressed, so the stub above and the real panel cannot disagree.
import {
  LifecycleCardSurfaceProvider,
  runCardOwnsLifecycleCopy,
  useLifecycleCardHost,
} from "../../../agents/src/lifecycle-card-runtime";
import { RecommendationHoldCard } from "@cinatra-ai/agents/run-recommendation-card";

import {
  installWidgetServiceStub,
  mountSurface,
  surfaceElement,
} from "./conversation-column-harness";

/** The assistant turn a parked chat dispatch actually produces: one `agent_run`
 *  tool call with the server-pinned run id, and the dispatch line beside it. */
function dispatchTurn(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: `run cinatra_blog-draft-writer-agent for me` },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        {
          kind: "tool_call",
          id: "explicit_dispatch_pre_router",
          name: "agent_run",
          status: "completed",
          runId: RUN_ID,
          result: JSON.stringify({ runId: RUN_ID, status: "pending_input" }),
        },
        {
          kind: "text",
          content: `Dispatched \`${PACKAGE}\` (runId: \`${RUN_ID}\`, status: \`pending_input\`). The run is paused for your decision on the recommended skills.`,
        },
      ],
    } as unknown as UiMessage,
  ];
}

const HELD = {
  state: "held",
  runId: RUN_ID,
  agentPackageName: PACKAGE,
  promptText: "draft a blog post",
  recommendations: [
    { skillId: "@cinatra-ai/chat:blog-content", skillRevisionId: "rev-1", name: "blog-content", recommended: true },
  ],
  holdRef: "hold-ref-1",
};

beforeEach(() => {
  holdState.current = HELD;
  holdState.calls = [];
  holdState.pending = null;
});
afterEach(cleanup);

async function mountHeldTurn() {
  const result = await mountSurface("chat", { messages: dispatchTurn() });
  await waitFor(() => {
    if (!result.container.querySelector("[data-chat-thread-recommendation-hold]")) {
      throw new Error("no chat_thread recommendation-hold wrapper");
    }
  });
  return result;
}

describe("the §V card is mounted in the conversation transcript", () => {
  it("renders the wrapper INSIDE the conversation list", async () => {
    const { container } = await mountHeldTurn();

    const list = container.querySelector("[data-conversation-list]");
    expect(list).not.toBeNull();
    // The marker rides the card's OWN root, so it exists exactly when the card
    // draws — there is no wrapper of the transcript's to find when unheld.
    const wrapper = list?.querySelector("[data-chat-thread-recommendation-hold]");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
  });

  it("puts the row and ITS decision controls on that marker root", async () => {
    // RE-ANCHORED TWICE, same guarantee. This pinned "the marked element really
    // carries the decidable row, not a pointer to it". §V's redraw
    // (cinatra#2841) made the row the CARD, so the row is the marker's own
    // element rather than a descendant; and cinatra#3062 gives this host §V's
    // checklist, so the decision controls it carries are a checkbox per skill
    // and one Continue. Both halves are still asserted — the row, and real
    // pressable decision controls inside it — so a pointer still cannot satisfy
    // this test.
    const { container } = await mountHeldTurn();
    const wrapper = container.querySelector("[data-chat-thread-recommendation-hold]");

    await waitFor(() => {
      if (!wrapper?.querySelector("[data-recommendation-chip]")) {
        throw new Error("no pill drawn on the marked row");
      }
    });
    expect(wrapper?.hasAttribute("data-run-recommendation-chip-row")).toBe(true);
    expect(wrapper?.getAttribute("data-run-recommendation-reading")).toBe("skills-checklist");
    expect(wrapper?.querySelector("[data-skills-step-checkbox]")).not.toBeNull();
    const cont = wrapper?.querySelector<HTMLButtonElement>("[data-skills-step-continue]");
    expect(cont).not.toBeNull();
    expect(cont!.disabled).toBe(false);
    // Nothing to press on a pill, and the row-level pair §V deleted long ago may
    // not come back on this host either.
    expect(wrapper?.querySelector("[data-skill-action]")).toBeNull();
    expect(wrapper?.querySelector('[data-action="confirm-run-recommendation"]')).toBeNull();
    expect(wrapper?.querySelector('[data-action="skip-run-recommendation"]')).toBeNull();
  });

  it("TAKES THE DRAWING the run page took (cinatra#3062, and #3047's point E)", async () => {
    // THE PIN THAT WAS INVERTED, and it is the red-first proof of this change.
    // It read "KEEPS TODAY'S DRAWING while the run page changes": the three
    // per-chip affordances present, and neither of the run page's two controls
    // on this host — because cinatra#3047's point E gave the chat and the widget
    // their own issue. This is that issue, so the same four assertions are made
    // the other way round, on the same mounted card.
    const { container } = await mountHeldTurn();
    const wrapper = container.querySelector("[data-chat-thread-recommendation-hold]");
    await waitFor(() => {
      if (!wrapper?.querySelector("[data-recommendation-chip]")) {
        throw new Error("no pill drawn on the marked row");
      }
    });

    expect(wrapper?.querySelectorAll("[data-skill-action]")).toHaveLength(0);
    // §V's reading, drawn here now: a real checkbox per pill and one Continue.
    expect(wrapper?.querySelectorAll("[data-skills-step-checkbox]").length).toBeGreaterThan(0);
    expect(wrapper?.querySelectorAll("[data-skills-step-continue]")).toHaveLength(1);
    expect(wrapper?.querySelector('[role="checkbox"]')).not.toBeNull();
    expect(wrapper?.getAttribute("data-run-recommendation-reading")).toBe("skills-checklist");
    // …and the host that decided which reading is drawn is this one.
    expect(wrapper?.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("takes the THREE REFINEMENTS with it (cinatra#3062; #3047 points 1-4)", async () => {
    // THE SECOND INVERTED PIN. It read "keeps it while the run page's three
    // refinements land too" and stated four absences: no editable-until-started
    // reading, no checklist pills, no vendor byline, and the card root as it
    // was. The refinements apply to every host — the issue says so in its own
    // words — so the same four are now stated as presences, on the same card.
    const { container } = await mountHeldTurn();
    const wrapper = container.querySelector("[data-chat-thread-recommendation-hold]");
    await waitFor(() => {
      if (!wrapper?.querySelector("[data-recommendation-chip]")) {
        throw new Error("no pill drawn on the marked row");
      }
    });

    // 1. the editable-until-started reading, stated on the row itself.
    expect(wrapper?.getAttribute("data-skills-step-editable")).toBe("true");
    expect(wrapper?.getAttribute("data-skills-step-submitted")).toBe("false");
    // 2. the checklist pills, in their list.
    expect(wrapper?.querySelector("[data-skills-step-pill]")).not.toBeNull();
    expect(wrapper?.querySelector("[data-skills-step-list]")).not.toBeNull();
    // 3. every pill went through the app's own byline resolver, which states
    //    what it resolved on the pill root. This fixture's candidates declare no
    //    vendor, so the resolved state is `missing` and — per the ratified
    //    drawing, which gives the pill a vendor and no stand-in for one — the
    //    pill draws the skill's name alone, with no byline element.
    expect(wrapper?.querySelector("[data-skills-step-pill]")?.getAttribute(
      "data-skills-step-vendor-state",
    )).toBe("missing");
    expect(wrapper?.querySelector("[data-skills-step-vendor]")).toBeNull();
    // 4. and the card root is still the row itself, declaring what it is.
    expect(wrapper?.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(wrapper?.getAttribute("data-lifecycle-card-state")).toBe("held");
  });

  it("keeps the card OUTSIDE the inline run panel's subtree", async () => {
    // The panel is the `run_card` host and mounts its own copy of the same
    // component. A card nested inside it would be that host's card, not this
    // one, and the evidence for this slice could not tell them apart.
    //
    // MEASURED IN THE DECIDED STATE, and that is the ruling rather than a
    // convenience: while the skills can still be chosen the turn draws NO run
    // panel at all (the block below pins that), so the held turn has no second
    // subtree to be outside of. The moment the decision lands both are on
    // screen together, which is where "one is not inside the other" is a
    // question with an answer.
    holdState.current = { state: "confirmed", runId: RUN_ID, skillNames: ["blog-content"] };
    const { container } = await mountSurface("chat", { messages: dispatchTurn() });
    await waitFor(() => {
      if (!container.querySelector("[data-run-card-host]")) {
        throw new Error("no inline run panel after the decision");
      }
    });

    const panel = container.querySelector("[data-run-card-host]");
    const wrapper = container.querySelector("[data-chat-thread-recommendation-hold]");
    expect(panel).not.toBeNull();
    expect(wrapper).not.toBeNull();
    expect(panel?.contains(wrapper as Node)).toBe(false);
    expect(wrapper?.contains(panel as Node)).toBe(false);
  });

  it("carries the three §V root attributes, host-correct for THIS mount", async () => {
    // The identity lives on the CARD's own root, not on either mount's wrapper,
    // so both authorized mounts get host-correct values by construction. Here
    // the declared host is the transcript's, so the card must say so itself.
    const { container } = await mountHeldTurn();
    // The marker and the identity are the SAME element: the card's root.
    const root = container.querySelector("[data-chat-thread-recommendation-hold]");

    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-lifecycle-card")).toBe("recommendation_hold");
    expect(root?.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    expect(root?.getAttribute("data-lifecycle-card-state")).toBe("held");
    // RE-ANCHORED (cinatra#2841): the chip row used to sit INSIDE this root, so
    // the pin looked for it as a descendant. §V made THE ROW THE CARD, so the
    // row and the identity are now the same element — which is the stronger
    // reading of what this always guarded: the anchor set reads as ONE card.
    expect(root?.hasAttribute("data-run-recommendation-chip-row")).toBe(true);
  });

  it("moves the root's state attribute with the decision", async () => {
    // RE-ANCHORED (cinatra#2841), same behaviour: the root's state attribute
    // still MOVES when the hold settles, and the host stays this mount's. Only
    // the settled vocabulary changed — §V's row draws `held` while live and
    // `decided` once released, and says WHICH way it went on
    // `data-run-recommendation-decision` rather than by spelling the outcome
    // into the lifecycle state. Both are asserted, so this pins strictly more
    // than the single attribute it used to read.
    holdState.current = { state: "confirmed", runId: RUN_ID, skillNames: ["blog-content"] };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!result.container.querySelector('[data-lifecycle-card-state="decided"]')) {
        throw new Error("root state did not settle to decided");
      }
    });
    const root = result.container.querySelector('[data-lifecycle-card="recommendation_hold"]');
    expect(root?.getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
    expect(root?.getAttribute("data-run-recommendation-decision")).toBe("confirmed");
    // It really MOVED: the live reading is gone from this turn.
    expect(
      result.container.querySelector('[data-lifecycle-card-state="held"]'),
    ).toBeNull();
  });

  it("asks the card's own authority for THIS run", async () => {
    await mountHeldTurn();
    expect(holdState.calls).toContainEqual({ runId: RUN_ID });
  });

  it("FAILS OPEN: an unheld turn adds no node at all", async () => {
    // The load-bearing negative control. Every `agent_run` turn mounts the card,
    // so a run that is NOT held must leave the transcript byte-identical to what
    // it drew before this mount existed. If the marker were a wrapper the
    // transcript rendered, it would sit in every such turn as an empty fixture
    // and every DOM-shape pin on this column would move.
    holdState.current = { state: "none" };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (holdState.calls.length === 0) throw new Error("hold state not resolved");
    });
    expect(result.container.querySelector("[data-chat-thread-recommendation-hold]")).toBeNull();
    expect(result.container.querySelector('[data-lifecycle-card="recommendation_hold"]')).toBeNull();
    expect(result.container.querySelector("[data-run-recommendation-chip-row]")).toBeNull();
  });
});

describe("the decided card settles in the same conversation", () => {
  it("shows the confirmed summary in place, still inside the wrapper", async () => {
    holdState.current = {
      state: "confirmed",
      runId: RUN_ID,
      skillNames: ["blog-content"],
    };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!result.container.querySelector('[data-run-recommendation-decision="confirmed"]')) {
        throw new Error("settled summary not drawn");
      }
    });
    const wrapper = result.container.querySelector("[data-chat-thread-recommendation-hold]");
    // RE-ANCHORED (cinatra#2841): the settled row IS the marked root, so the
    // decision it recorded is read off that element instead of a descendant.
    expect(wrapper?.getAttribute("data-run-recommendation-decision")).toBe("confirmed");
    // §V: "Once the run has started the same pills are drawn with the state
    // their boxes were left in, read-only, and with no Continue." The settled
    // reading is still in the same turn, with no navigation — and each pill
    // states in its own box that the skill was applied.
    const applied = wrapper?.querySelector(
      '[data-recommendation-chip][data-skill-applied="true"]',
    );
    expect(applied).not.toBeNull();
    expect(applied?.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    // Settled means settled: nothing left to press. The Continue is gone, the
    // boxes are disabled, and both retired drawings stay retired.
    expect(wrapper?.querySelector("[data-skills-step-continue]")).toBeNull();
    expect(
      wrapper?.querySelector<HTMLButtonElement>("[data-skills-step-checkbox]")?.disabled,
    ).toBe(true);
    expect(wrapper?.querySelector("[data-skill-action]")).toBeNull();
    expect(wrapper?.querySelector('[data-action="confirm-run-recommendation"]')).toBeNull();
    expect(wrapper?.querySelector('[data-action="skip-run-recommendation"]')).toBeNull();
  });

  it("shows the skipped summary in place", async () => {
    // FIXTURE RE-ANCHORED (cinatra#2841), same pin. §V's settled row states each
    // skill's own outcome, so it draws from the hold's per-skill evidence; a
    // skipped hold naming no skill at all has nothing per-skill to say and §V
    // draws no chip-less settled reading. The fixture therefore carries the
    // `decided` evidence a real skipped hold carries. The behaviour pinned is
    // unchanged: the skipped reading settles IN this conversation.
    holdState.current = {
      state: "skipped",
      runId: RUN_ID,
      decided: [{ skillId: "@cinatra-ai/chat:blog-content", name: "blog-content", mark: "skipped" }],
    };
    const result = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!result.container.querySelector('[data-run-recommendation-decision="skipped"]')) {
        throw new Error("skipped summary not drawn");
      }
    });
    const wrapper = result.container.querySelector("[data-chat-thread-recommendation-hold]");
    expect(wrapper?.getAttribute("data-run-recommendation-decision")).toBe("skipped");
    // §V: a skill the run did not take is a pill with its box CLEAR — there is
    // no outcome word beside it, and no panel stands in for the row.
    expect(
      wrapper?.querySelector('[data-recommendation-chip][data-skill-applied="false"]'),
    ).not.toBeNull();
    expect(wrapper?.querySelector("[data-recommendation-outcome-panel]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ONE CARD PER TURN, IN EVERY STATE.
//
// The transcript mount and the inline run panel are siblings resolving the SAME
// run, so an unconditional mount on both draws the card TWICE in one turn. The
// defect survived a review round because it showed only in the SETTLED states:
// the held card self-gated to one turn, which made the duplication read as a
// settled-only quirk rather than the missing rule it was.
//
// The rule is that inside a `chat_thread` the chat card owns this run's
// recommendation and the panel withholds its copy — held and settled alike.
// These pins count card roots, so a second mount cannot come back quietly.
// ---------------------------------------------------------------------------
describe("the turn shows exactly one recommendation card", () => {
  async function countCardRoots(state: Record<string, unknown>) {
    holdState.current = state;
    const result = await mountSurface("chat", { messages: dispatchTurn() });
    await waitFor(() => {
      if (!result.container.querySelector('[data-lifecycle-card="recommendation_hold"]')) {
        throw new Error("no recommendation card drawn at all");
      }
    });
    return result.container.querySelectorAll('[data-lifecycle-card="recommendation_hold"]');
  }

  it("draws one HELD card, on the chat_thread host", async () => {
    const roots = await countCardRoots(HELD);

    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("draws one CONFIRMED summary, not one per host", async () => {
    const roots = await countCardRoots({
      state: "confirmed",
      runId: RUN_ID,
      skillNames: ["blog-content"],
    });

    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("draws one SKIPPED summary — the state the duplication showed up in", async () => {
    // Same fixture re-anchor as the skipped pin above (cinatra#2841): §V's
    // settled row needs the per-skill evidence to have a card to draw at all,
    // and this pin is about HOW MANY cards that turn shows, not how few.
    const roots = await countCardRoots({
      state: "skipped",
      runId: RUN_ID,
      decided: [{ skillId: "@cinatra-ai/chat:blog-content", name: "blog-content", mark: "skipped" }],
    });

    expect(roots).toHaveLength(1);
    expect(roots[0].getAttribute("data-lifecycle-card-host")).toBe("chat_thread");
  });

  it("reads the ambient-host rule the panel still holds its HITL screen to", async () => {
    // The recommendation card is no longer one of the panel's mounts at all
    // (cinatra#3047) — the run page draws the row in one place, its own rail
    // step. The RULE survives for the kind that still has two possible hosts in
    // one turn (the HITL screen card), and it is the same function this
    // transcript's mount is written against, so the values stay pinned here.
    expect(runCardOwnsLifecycleCopy(null)).toBe(true);
    expect(runCardOwnsLifecycleCopy("run_card")).toBe(true);
    expect(runCardOwnsLifecycleCopy("chat_thread")).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// THE RUN PROGRESS CARD WAITS FOR THE SKILLS DECISION.
//
// Plan sentences, verbatim (PLAN: Agents Lifecycle (A), section 6.2 step 2 and
// section 6.4 step 2):
//
//   "An agentic run progress card is not visible while the recommended skills
//    can be selected, because they are being chosen before the agent actually
//    runs."
//
// and section 6.2 step 3 / section 6.4 step 4:
//
//   "The agentic run progress card appears once the skills are decided; no
//    skill inside it can be selected."
//
// So the turn's shape is decided by the ROW'S STATE, not by the presence of an
// `agent_run` part: held draws the chip row alone, and the decision is what
// brings the run card in. Both conversation hosts are measured, because one
// column serves `/chat` and the widget and a rule that holds on only one of
// them is not the rule.
// ---------------------------------------------------------------------------
describe("the agentic run progress card waits for the skills decision", () => {
  it("draws the chip row and NO run card while the hold is open", async () => {
    const { container } = await mountHeldTurn();

    expect(container.querySelector("[data-chat-thread-recommendation-hold]")).not.toBeNull();
    expect(container.querySelector('[data-recommendation-chip]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inline-run-panel"]')).toBeNull();
  });

  it("draws no run card on the widget host either", async () => {
    // The widget reads the SAME hold through its own broker transport, so the
    // rule has to hold against that read rather than against the cookie one.
    const stub = installWidgetServiceStub({
      lifecycle: () => null,
      recommendationHold: () => HELD,
    });
    try {
      const RUN_PANEL = '[data-testid="inline-run-panel"]';
      const result = render(surfaceElement("widget", { messages: dispatchTurn() }));
      // RECORDED FROM THE FIRST FRAME, exactly as the chat arm records it: the
      // widget's broker read has its own unresolved window, and a card that
      // appears inside it and vanishes after is still a card the person saw.
      let everSeen = result.container.querySelector(RUN_PANEL) !== null;
      const observer = new MutationObserver(() => {
        if (result.container.querySelector(RUN_PANEL)) everSeen = true;
      });
      observer.observe(result.container, { childList: true, subtree: true });
      try {
        await waitFor(() => {
          if (!result.container.querySelector('[data-lifecycle-card="recommendation_hold"]')) {
            throw new Error("no recommendation card on the widget host");
          }
        });
        await waitFor(() => {
          if (!result.container.querySelector("[data-recommendation-chip]")) {
            throw new Error("no chip drawn on the widget host");
          }
        });
      } finally {
        observer.disconnect();
      }
      expect(everSeen, "the run progress card was on screen on the widget host").toBe(false);
      expect(result.container.querySelector(RUN_PANEL)).toBeNull();
    } finally {
      stub.restore();
    }
  });

  it("brings the run card in once the decision has landed", async () => {
    holdState.current = { state: "confirmed", runId: RUN_ID, skillNames: ["blog-content"] };
    const { container } = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!container.querySelector('[data-run-recommendation-decision="confirmed"]')) {
        throw new Error("settled row not drawn");
      }
    });
    await waitFor(() => {
      if (!container.querySelector('[data-testid="inline-run-panel"]')) {
        throw new Error("no run card after the decision");
      }
    });
    // The settled chips are ABOVE it, in the same container, exactly as before.
    const slot = container.querySelector('[data-testid="inline-run-panel"]')?.parentElement;
    expect(slot?.querySelector("[data-chat-thread-recommendation-hold]")).not.toBeNull();
  });

  it("brings the run card in for a skipped decision too", async () => {
    holdState.current = {
      state: "skipped",
      runId: RUN_ID,
      decided: [{ skillId: "@cinatra-ai/chat:blog-content", name: "blog-content", mark: "skipped" }],
    };
    const { container } = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!container.querySelector('[data-testid="inline-run-panel"]')) {
        throw new Error("no run card after the skip");
      }
    });
  });

  it("FAILS OPEN: a run that was never held keeps its run card", async () => {
    // The negative control this rule is paid for with. A run with no
    // recommendation at all — and a hold read that answers "none" — must draw
    // exactly what it drew before this gate existed.
    holdState.current = { state: "none" };
    const { container } = await mountSurface("chat", { messages: dispatchTurn() });

    await waitFor(() => {
      if (!container.querySelector('[data-testid="inline-run-panel"]')) {
        throw new Error("an unheld run lost its run card");
      }
    });
    expect(container.querySelector("[data-chat-thread-recommendation-hold]")).toBeNull();
  });


  it("never draws the run card at ANY point of a held turn — not even for a frame", async () => {
    // THE ARM THAT CATCHES THE FLICKER, and the reason the rule waits on an
    // unresolved read instead of failing open on it. A host that reads "no
    // answer yet" as "not held" mounts the run progress card, discovers the hold
    // a moment later and takes it away again — and every assertion written after
    // `waitFor` passes while the person still SAW the card the plan forbids.
    //
    // So this watches instead of sampling: it renders synchronously, records
    // every DOM change from the first frame, and only then lets the resolve
    // land. The run panel must appear in none of them.
    const RUN_PANEL = '[data-testid="inline-run-panel"]';
    const result = render(surfaceElement("chat", { messages: dispatchTurn() }));
    let everSeen = result.container.querySelector(RUN_PANEL) !== null;
    const observer = new MutationObserver(() => {
      if (result.container.querySelector(RUN_PANEL)) everSeen = true;
    });
    observer.observe(result.container, { childList: true, subtree: true });
    try {
      await waitFor(() => {
        if (!result.container.querySelector("[data-chat-thread-recommendation-hold]")) {
          throw new Error("the held card never resolved");
        }
      });
      // Let anything queued behind the resolve run, then read the recorder.
      await waitFor(() => {
        if (!result.container.querySelector("[data-recommendation-chip]")) {
          throw new Error("no chip drawn");
        }
      });
    } finally {
      observer.disconnect();
    }
    expect(everSeen, "the run progress card was on screen while the hold was open").toBe(false);
    expect(result.container.querySelector(RUN_PANEL)).toBeNull();
  });

  it("FAILS OPEN when the hold cannot be read at all", async () => {
    // The other side of the same boundary. The authority never answers here — it
    // returns nothing, which is a failed read rather than a state — so after the
    // card's own bounded retries it reports the question unreadable and the turn
    // goes back to drawing what it drew before this rule existed. A dead endpoint
    // must not empty every conversation of its run cards.
    vi.useFakeTimers();
    try {
      holdState.current = null;
      const result = render(surfaceElement("chat", { messages: dispatchTurn() }));
      // Drive the card's whole failure budget (400ms, 1.5s, 4s) plus slack.
      await act(async () => {
        for (let i = 0; i < 12; i += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
      });
      expect(
        result.container.querySelector('[data-testid="inline-run-panel"]'),
        "an unreadable hold withheld the run card for ever",
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops withholding when the read never answers at all", async () => {
    // THE HANG, which the failure budget alone cannot see: a request that never
    // settles never fails, so it never spends a retry and never reports itself
    // unreadable. Without a deadline on the whole read the run card would be
    // withheld for as long as the tab stays open, with nothing on screen saying
    // why. The card's own deadline is what ends that.
    vi.useFakeTimers();
    try {
      let settle: ((value: Record<string, unknown> | null) => void) | null = null;
      holdState.pending = new Promise<Record<string, unknown> | null>((resolve) => {
        settle = resolve;
      });
      const result = render(surfaceElement("chat", { messages: dispatchTurn() }));
      // Well inside the deadline: nothing is known, so nothing is drawn.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(result.container.querySelector('[data-testid="inline-run-panel"]')).toBeNull();
      // Past it: the question is unreadable and the turn draws what it always did.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(
        result.container.querySelector('[data-testid="inline-run-panel"]'),
        "a read that never answers withheld the run card for ever",
      ).not.toBeNull();
      expect(settle).not.toBeNull();
    } finally {
      holdState.pending = null;
      vi.useRealTimers();
    }
  });

  it("keeps withholding when a REFRESH fails after an answered hold", async () => {
    // THE PRECEDENCE, pinned. Fail-open is for a question that was never
    // answered. Once this run's authority has said HELD, the run really is
    // parked, and a refresh that fails changes nothing about it — drawing its
    // progress card on the strength of a failed request would show a person a
    // running run that is not running. So the last authorized answer stands and
    // the card stays withheld, for as long as the failures last.
    const { container } = await mountHeldTurn();
    expect(container.querySelector('[data-testid="inline-run-panel"]')).toBeNull();

    vi.useFakeTimers();
    try {
      // Every read from here on FAILS (an answer of nothing is a failed read).
      holdState.current = null;
      // The wake channel the card listens on — a reader coming back to the tab.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      // Past the whole failure budget AND the read deadline.
      await act(async () => {
        for (let i = 0; i < 15; i += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
      });
      expect(
        container.querySelector('[data-testid="inline-run-panel"]'),
        "a failed refresh drew the run progress card over a run that is still parked",
      ).toBeNull();
      // And the person still has the question in front of them.
      expect(container.querySelector("[data-chat-thread-recommendation-hold]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-projects the same shape after a reload of the held turn", async () => {
    // THE DURABLE ARM (S9j). A reload rebuilds the turn from the persisted
    // parts and re-resolves the hold; what comes back must be what was there —
    // the chip row, and no run card. Mounted twice from the same durable
    // transcript, with the first mount torn down, which is what a reload is
    // from this column's point of view.
    const first = await mountHeldTurn();
    expect(first.container.querySelector('[data-testid="inline-run-panel"]')).toBeNull();
    cleanup();

    const { container } = await mountHeldTurn();
    expect(container.querySelector("[data-chat-thread-recommendation-hold]")).not.toBeNull();
    expect(container.querySelector('[data-testid="inline-run-panel"]')).toBeNull();
  });
});
