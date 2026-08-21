// The values the S9k flow, its fixtures and its probes must agree on, named ONCE
// (chat-hitl S9k, cinatra#2824).
//
// Every one of these is load-bearing in a way a reader cannot guess from the
// literal, so each carries the reason it is what it is rather than something else.

/**
 * THE AGENT THE BROWSER DISPATCHES, and the three constraints that leave exactly
 * one candidate. Each was learned by watching a dispatch be refused.
 *
 *  1. It must be INSTALLED, not merely registered. Most agents ship with Cinatra
 *     as opt-in extensions: they get an `agent_templates` row at boot and are still
 *     refused with "Agent is not installed … Install it from the marketplace".
 *     Only the REQUIRED closure is installed on a bare instance, and the required
 *     closure is the one set every boot materializes — which is what makes this
 *     choice reproducible on a CI runner rather than dependent on which dev
 *     extensions somebody happened to sync.
 *  2. It must NOT be a creation-flow package (`getAgentCreationFlowPackages()` =
 *     the reviewer lanes `agent-security-reviewer` / `agent-code-reviewer` /
 *     `agent-planner`, plus the author lane). Those take an extra Anthropic-pin
 *     preflight before dispatch, which would make this flow's green depend on
 *     catalog-sync state that has nothing to do with a recommendation hold.
 *  3. It must have no REQUIRED connector dependencies, or
 *     `assertAgentRunReadyByPackage` refuses the dispatch as unconfigured.
 *
 * `lint-policy-agent` is the one agent satisfying all three — it is installed by the
 * required closure, it is deliberately EXCLUDED from the creation-flow set (it is
 * the deterministic skill-free scanner, not a lane), and it declares no connector
 * or agent dependencies at all.
 *
 * Its own skill-free-ness costs this flow nothing: the recommendation scorer offers
 * whatever is in `agent_assigned_skills` for the package, and the fixture puts one
 * row there.
 */
export const HELD_TURN_AGENT_PACKAGE = "@cinatra-ai/lint-policy-agent";

/**
 * The one skill assigned to that agent, which is what gives the recommendation
 * scorer a candidate to offer. `@cinatra-ai/chat:*` is the privileged carve-out
 * namespace (`deriveSkillRegistration`), which is why the id is not
 * `@cinatra-ai/blog-content-skill:blog-content`.
 */
export const HELD_TURN_SKILL_ID = "@cinatra-ai/chat:blog-content";

/** `created_by` on the assignment row. A fixture actor, named as one. */
export const HELD_TURN_FIXTURE_ACTOR = "chat-hitl-s9k-e2e-fixture";

/**
 * THE DRIVING MESSAGE. Every part of its shape is load-bearing.
 *
 * · A dispatch VERB and a package reference in the LAST user message is what
 *   `detectExplicitDispatchPackage` needs to take the hard pre-router path at all.
 *
 * · The LEGACY `cinatra_<slug>` form rather than the canonical `@cinatra-ai/<slug>`
 *   one, on purpose: two or more `@` mention tokens flip the thread into the Slack
 *   layout, which suppresses `parts` — and the §V card mounts at a PART
 *   (`part.kind === "tool_call" && part.name === "agent_run"`). A canonically
 *   mentioned package therefore risks proving nothing, with no error to read. Zero
 *   `@` tokens removes the question entirely.
 *
 * · The embedded `inputParams` is what makes the turn FULLY deterministic. Without
 *   it the dispatch boundary asks the model to produce the input params through a
 *   structured-output round trip; with it, `tryParseEmbeddedInputParams` takes the
 *   brace-matched fast path and NO model is consulted for anything. `oasJson` is
 *   this agent's one visible required field, and its value is never executed here —
 *   the run parks before it dispatches, which is the whole point.
 */
export const HELD_TURN_MESSAGE =
  'run cinatra_lint-policy-agent with inputParams: {"oasJson": "{}"}';

/**
 * The pre-router's own HELD-branch sentence (`explicit-dispatch-server.ts`). The
 * flow asserts it verbatim: it is the server saying the run parked, in the same
 * turn that carries the card, and it is the sentence S9b replaced the false "The
 * agent is running" with.
 */
export const HELD_TURN_PAUSED_TEXT =
  "The run paused for a decision on the recommended skills.";

/** The sentence a QUEUED dispatch gets. A held turn must NEVER carry it. */
export const HELD_TURN_RUNNING_TEXT = "The agent is running";

// ---------------------------------------------------------------------------
// THE RATIFIED §V DRAWING'S ANCHORS (#2841 redraw, #2879 slot identity).
//
// THE ROW IS THE CARD: one declaring root, three per-chip controls, no heading
// plate and NO row-level confirm/skip. The pre-redraw
// `[data-action="confirm-run-recommendation"]` control does not exist any more,
// and the flow asserts its ABSENCE so a silent revival cannot pass unnoticed.
// ---------------------------------------------------------------------------

/** The card's own root, carrying kind + host + state on ONE element. */
export const CARD_ROOT = '[data-lifecycle-card="recommendation_hold"]';
/** The host declaration that separates a chat transcript from the run page. */
export const CARD_HOST_CHAT = '[data-lifecycle-card-host="chat_thread"]';
/** The transcript's own mount marker, rendered only under a `chat_thread` host. */
export const CHAT_HOLD_MARKER = "[data-chat-thread-recommendation-hold]";
/** A live parked hold. */
export const CARD_HELD = '[data-lifecycle-card-state="held"]';
/** A released hold, settled in place. */
export const CARD_DECIDED = '[data-lifecycle-card-state="decided"]';
/** The chip row's conformance id — the card's own outermost element under §V. */
export const CHIP_ROW = '[data-conformance-id="run-chip-row"]';
/** One chip per skill. */
export const CHIP = "[data-recommendation-chip]";
/** The three per-chip controls §V rules. */
export const CHIP_CONFIRM = '[data-skill-action="confirm"]';
export const CHIP_ADJUST = '[data-skill-action="adjust"]';
export const CHIP_SKIP = '[data-skill-action="skip"]';
/**
 * The settled row's recorded outcome, as an ATTRIBUTE NAME rather than a selector.
 *
 * §V puts it on the card's own outermost element, beside the kind/host/state
 * declaration — so it is read with `getAttribute` on the root. Looking for it with
 * `querySelector` inside the root finds nothing and reports "never settled", which
 * is indistinguishable from the runtime failing to settle the card. Naming it as an
 * attribute is what stops the selector form from being written again.
 */
export const DECISION_ATTR = "data-run-recommendation-decision";
/** The transcript list, and the producing slot S9i marks. */
export const CONVERSATION_LIST = "[data-conversation-list]";
export const TRANSCRIPT_SLOT = "[data-transcript-slot]";
/** The composer. */
export const CHAT_PROMPT = '[data-testid="chat-prompt-input"]';

/**
 * THE RETIRED ROW-LEVEL CONTROLS. §V's redraw deleted them; the flow asserts they
 * are absent so "the row is the whole card" is checked rather than assumed.
 */
export const RETIRED_ROW_CONFIRM = '[data-action="confirm-run-recommendation"]';
export const RETIRED_ROW_SKIP = '[data-action="skip-run-recommendation"]';
