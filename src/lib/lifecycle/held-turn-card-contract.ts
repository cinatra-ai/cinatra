/**
 * THE HELD-TURN CARD CONTRACT — a held chat dispatch must answer with the CARD,
 * never with TEXT that points at another surface.
 *
 * WHY THIS EXISTS. A chat dispatch that PARKS (the run reaches `pending_input`
 * and waits for a human) has exactly one correct answer in the transcript: the
 * lifecycle card, mounted in the conversation, with its own decision controls.
 * The failure mode this module makes mechanical is the one a review round caught
 * by hand: the held turn answered with a sentence that named the run page as the
 * place to decide, and the "chat" evidence showed no card at all. A sentence is
 * not a screen. A pointer to another surface is the absence of the screen.
 *
 * WHAT IT IS. Two pure pieces, no DOM and no React, so the SAME authority runs
 * in three places: the server dispatch test (root Vitest), the fixture suite
 * (root Vitest), and the transcript DOM test (the chat package suite).
 *
 *   1. `evaluateHeldTurnProjection` — THE GATE, and it is structural. It reads a
 *      normalized `TurnProjection` (ordered parts + the nodes the transcript
 *      rendered, each with the anchors it carries, its ordered container, and the
 *      foreign-host subtrees it sits inside) and reports violations. The
 *      transcript suite builds that projection from the PRODUCTION chat view and
 *      the REAL card, so the check measures what a reader gets. One evaluator,
 *      three callers, no second opinion.
 *
 *   2. `findDecisionPathPointers` — the text ban, DEFENCE IN DEPTH. It targets
 *      prose that presents ANOTHER SURFACE as the decision path. It is
 *      deliberately NOT a ban on the words "run page": the inline run card's
 *      legitimate "Open the run page" link is a link inside a ruled card, not
 *      deterministic dispatch prose. What is banned is prose that tells the human
 *      to go elsewhere TO DECIDE. A card that is genuinely mounted makes the
 *      prose harmless; the ban exists so a regression is named in words too.
 *
 *   3. `findUnmountedSurfacePointers` — the SAME ban with the verb requirement
 *      dropped, and it applies only when the turn mounts no card. Which rule a
 *      turn gets is decided structurally, by whether the card is there, so a
 *      pointer written without a decision verb cannot ride the cardless state.
 *
 * THE PER-KIND CONTRACT TABLE. `CHAT_THREAD_CARRIAGE_CONTRACT` has one row per
 * ruled chat_thread carriage, keyed off the protocol package's own closed set of
 * kinds and its carriage map, so a fifth kind cannot appear without a row. Each
 * row names the ENFORCER that actually executes it — this module for the held
 * turn, the one-card gate for the DATA_PART kinds — because a table row with no
 * live enforcer is a claim, and a duplicate proof beside a sibling's proof is
 * worse than no proof: when the two drift, neither is authoritative.
 *
 * ANCHORS ARE READ OFF THE SHIPPED COMPONENTS. `ownerAnchors` names what the
 * real card really emits, so a corrected real-renderer test ACCEPTS the ruled
 * mount. The ruled root declaration a kind does not emit yet is carried
 * separately in `ruledRootAnchors` and tracked as an obligation, because an
 * obligation is a red done-check and never a reason to fail the mount that
 * exists.
 *
 * THE HONEST LIMIT. The always-on arm is NEGATIVE: if the owner anchors appear
 * at all, they must appear in the triggering part's OWN container and OUTSIDE
 * every foreign-host subtree, and the turn's text must carry no decision-path
 * pointer. The POSITIVE arm — the anchors must be there at all — is ON BY
 * DEFAULT, and the kinds whose production chat_thread mount is not on main yet
 * are listed in `HELD_TURN_MOUNT_OBLIGATIONS`. That list is a ratchet, not a
 * waiver: the transcript test measures the PRODUCTION view and asserts the
 * OBSERVED unmounted set equals it, so the day the mount lands the row must be
 * struck or CI goes red.
 *
 * WHY THE DEFAULT MOVED. The arm used to be off unless a caller asked for it,
 * which made "must a held turn show its card?" a property of the CALL rather
 * than of the contract — every kind read as exempt, including the ones whose
 * mount had landed, and the only thing standing between a cardless held turn and
 * a green suite was a finite list of decision-verb regexes. Now the obligation
 * list is the single ruled reason the card may be missing, and a turn that takes
 * that exemption pays for it under (3) above: no card, no pointers, no verb
 * required. Card-absence is still legitimate — for exactly one kind, for exactly
 * as long as its row stands.
 *
 * AND NO ROW STANDS TODAY. S9b (cinatra#2786) landed the held card's production
 * chat_thread mount and its ruled root declaration, so both obligation lists
 * below are struck to empty and the positive arm is on for every ruled kind. A
 * held turn that draws no card is now a failure, with no exemption to take.
 */

import {
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_CARD_KINDS,
  type LifecycleCardKind,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

// ---------------------------------------------------------------------------
// Held statuses
// ---------------------------------------------------------------------------

/**
 * The run statuses that mean HELD — the run is parked and a human owes it an
 * answer. A dispatch that returns one of these is a HELD TURN and this whole
 * contract applies to it.
 */
export const HELD_RUN_STATUSES = Object.freeze(["pending_input"] as const);

export type HeldRunStatus = (typeof HELD_RUN_STATUSES)[number];

/** Does this dispatch result describe a parked run? */
export function isHeldDispatch(result: { status?: string | null } | null | undefined): boolean {
  const status = result?.status;
  return typeof status === "string" && (HELD_RUN_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// The text ban
// ---------------------------------------------------------------------------

export type DecisionPathPointerPattern = {
  /** Stable id, so a failure names WHICH shape of pointer was found. */
  id: string;
  /** What this pattern is about, in one sentence, for the failure message. */
  why: string;
  pattern: RegExp;
};

/**
 * DEFENCE IN DEPTH, NOT THE GATE. The primary invariant is structural: a parked
 * dispatch must project an actionable card in the same turn, and a decision
 * taken in that card keeps the URL and settles the same root. The transcript
 * suite holds that. These patterns catch the prose that TRIES to stand in for
 * the card, so a regression is named in words as well as in structure.
 *
 * Each pattern is anchored on a decision verb, not on a noun: naming the run
 * page is fine ("the run page shows every step"), telling the human to decide
 * there is not. The patterns are case-insensitive and are applied to
 * deterministic dispatch text only — never to a card's own rendered copy.
 *
 * THE SURFACE VOCABULARY IS SHARED so a new spelling is added once. The round
 * that motivated this gate said "confirm or skip the recommended skills on the
 * run card above": no leading "open", and the surface noun was CARD, not page,
 * with a positional locator instead of "there". Both gaps are closed below and
 * that exact sentence is a pinned failing fixture.
 */
const DECIDE_VERBS =
  "confirm|approve|accept|decide|choose|select|pick|respond|reply|answer|continue|proceed|resume|skip|reject|dismiss|adjust";
const SURFACE_NOUNS = "run|runs|agent|agents|review|task|panel";
const SURFACE_PARTS = "page|card|screen|view|detail|details|panel|region|tab|section|dialog|sidebar";
/** Where "somewhere else" can be spelled without naming a surface at all. */
const ELSEWHERE = "there|above|below|beside\\s+it|elsewhere|on\\s+that\\s+screen|over\\s+there";

export const DECISION_PATH_POINTER_PATTERNS: readonly DecisionPathPointerPattern[] =
  Object.freeze([
    {
      id: "go-elsewhere-to-decide",
      why: "sends the human to another screen to make the decision the chat should carry",
      // `continue` and `proceed` are deliberately NOT in this arm's trailing
      // verb set. They are weak: "open the agent page and then continue reading
      // here" is navigation, not a relocated decision, and matching it would
      // train readers to ignore this ban. They stay in the arm below, where a
      // surface is named explicitly.
      pattern: new RegExp(
        `\\b(open|go\\s+to|head\\s+to|visit|navigate\\s+to|switch\\s+to|jump\\s+to|see|check|view|use)\\b[^.?!]{0,60}\\b(${SURFACE_NOUNS})\\b[^.?!]{0,60}\\b(to|and|then)\\b[^.?!]{0,40}\\b(confirm|approve|accept|decide|choose|select|pick|respond|reply|answer|resume|skip|reject|dismiss|adjust)\\b`,
        "i",
      ),
    },
    {
      id: "decide-on-another-surface",
      why: "names another surface as the place the decision is taken",
      pattern: new RegExp(
        `\\b(${DECIDE_VERBS})\\b[^.?!]{0,80}\\b(on|in|from|at|via|through|using)\\s+(the\\s+)?(${SURFACE_NOUNS})\\s+(${SURFACE_PARTS})\\b`,
        "i",
      ),
    },
    {
      id: "decide-elsewhere",
      why: "tells the human the decision happens somewhere other than this conversation",
      pattern: new RegExp(`\\b(${DECIDE_VERBS})\\b[^.?!]{0,80}\\b(${ELSEWHERE})\\b`, "i"),
    },
    {
      // The same relocation written as a NOUN: "the review screen for approval",
      // "the approval controls are in run details". No verb, same instruction.
      id: "decision-lives-on-another-surface",
      why: "puts the decision itself on another surface, as a noun",
      pattern: new RegExp(
        `\\b(approval|approvals|confirmation|decision|decisions|sign-?off|selection)\\b[^.?!]{0,80}\\b(on|in|from|at|via|through|using|available\\s+in|available\\s+on)\\s+(the\\s+)?(${SURFACE_NOUNS})\\s+(${SURFACE_PARTS})\\b`,
        "i",
      ),
    },
    {
      id: "another-surface-holds-the-decision",
      why: "names another surface as the place the decision lives, before naming the decision",
      pattern: new RegExp(
        `\\b(${SURFACE_NOUNS})\\s+(${SURFACE_PARTS})\\b[^.?!]{0,40}\\b(for|to)\\b[^.?!]{0,40}\\b(approval|confirmation|decision|sign-?off|${DECIDE_VERBS})\\b`,
        "i",
      ),
    },
    {
      id: "run-url-in-prose",
      why: "hands the human a URL to another surface instead of mounting the card",
      pattern: /(^|[\s(\[`"'])\/agents\/[A-Za-z0-9@._~%-]+\/[^\s)\]`"']+/,
    },
    {
      id: "waiting-for-you-elsewhere",
      why: "describes the hold but locates it on another surface",
      pattern: new RegExp(
        `\\b(waiting|paused|held|blocked|needs?\\s+(your\\s+)?(input|approval|decision|confirmation))\\b[^.?!]{0,60}\\b(on|at|in)\\s+(the\\s+)?(${SURFACE_NOUNS})\\s+(${SURFACE_PARTS})\\b`,
        "i",
      ),
    },
  ]);

/**
 * THE RULE FOR A TURN THAT MOUNTS NO CARD — and why it is a different, blunter
 * rule rather than more entries in the list above.
 *
 * The patterns above are anchored on a decision VERB because they run while a
 * card is on screen, where "the run page shows every step" is honest prose
 * beside a working card and only the relocated DECISION is the defect. That
 * anchoring is also their ceiling: a pointer written without a decision verb —
 * "The controls you need are in run details" — walks past every one of them,
 * and no amount of extending the verb list closes a class defined by not being
 * on it.
 *
 * So the vocabulary is not what decides. THE STRUCTURE IS. When the turn mounts
 * no card at all, the sentence is not beside the answer — the sentence IS the
 * answer, and any sentence that points at another surface is the anti-pattern
 * whether or not it conjugates a verb this module knows. That needs no verb,
 * and these patterns require none: naming another surface, or handing over a
 * run URL, is enough on its own.
 *
 * The cost is stated too: this arm would reject "the run page shows every step"
 * in a cardless turn, which is honest prose. That is deliberate. A cardless held
 * turn has nothing to be secondary to, so prose about another surface has
 * nowhere legitimate to stand, and the ratchet that permits the cardless turn
 * (`HELD_TURN_MOUNT_OBLIGATIONS`) is what this arm is paying for.
 */
export const UNMOUNTED_SURFACE_POINTER_PATTERNS: readonly DecisionPathPointerPattern[] =
  Object.freeze([
    {
      id: "surface-named-with-no-card",
      why: "names another surface in a turn that mounts no card, so the sentence stands in for one",
      pattern: new RegExp(`\\b(${SURFACE_NOUNS})\\s+(${SURFACE_PARTS})\\b`, "i"),
    },
    {
      id: "run-url-with-no-card",
      why: "hands the human a URL in a turn that mounts no card",
      pattern: /(^|[\s(\[`"'])\/agents\/[A-Za-z0-9@._~%-]+\/[^\s)\]`"']+/,
    },
  ]);

export type DecisionPathPointerHit = {
  patternId: string;
  why: string;
  /** The matched fragment, trimmed, so the failure message is actionable. */
  match: string;
};

function matchAll(
  patterns: readonly DecisionPathPointerPattern[],
  text: string,
): DecisionPathPointerHit[] {
  const hits: DecisionPathPointerHit[] = [];
  for (const p of patterns) {
    const m = p.pattern.exec(text);
    if (m) hits.push({ patternId: p.id, why: p.why, match: m[0].trim() });
  }
  return hits;
}

/**
 * Every decision-path pointer in a piece of deterministic dispatch text. Empty
 * means the text is clean.
 */
export function findDecisionPathPointers(text: string): DecisionPathPointerHit[] {
  return matchAll(DECISION_PATH_POINTER_PATTERNS, text);
}

/**
 * Every pointer at another surface, for text in a turn that mounts NO card.
 * Verb-free by design — see `UNMOUNTED_SURFACE_POINTER_PATTERNS`.
 */
export function findUnmountedSurfacePointers(text: string): DecisionPathPointerHit[] {
  return matchAll(UNMOUNTED_SURFACE_POINTER_PATTERNS, text);
}

// ---------------------------------------------------------------------------
// The per-kind chat_thread carriage contract
// ---------------------------------------------------------------------------

/**
 * Who executes a row. A row with no live enforcer is a claim, so every row
 * names one and a pinned test checks the name is one of these.
 */
export const CARRIAGE_ENFORCERS = Object.freeze([
  /** This module, executed by the held-dispatch + transcript suites. */
  "held-turn-card-contract",
  /** scripts/audit/chat-hitl-one-card-gate.mjs — per-kind named owners + anchors. */
  "chat-hitl-one-card-gate",
] as const);

export type CarriageEnforcer = (typeof CARRIAGE_ENFORCERS)[number];

export type ChatThreadCarriageRow = {
  kind: LifecycleCardKind;
  /** How the kind reaches the transcript, mirrored from the protocol package. */
  carriage: "data_part" | "interrupt";
  /** The canonical part that triggers this kind's chat_thread render. */
  triggeringPart: string;
  /**
   * For an `interrupt` row: the tool name of the triggering tool result. The
   * transcript slot of THAT part is the position the card must render at.
   */
  triggerToolName: string | null;
  /** The one component that draws this kind. */
  owner: string;
  /**
   * The anchors the SHIPPED owner component emits today, which the card must
   * project at the triggering part's container: its own root plus the decision
   * controls whose absence is the anti-pattern. These are read off the real
   * component, so a corrected real-renderer test ACCEPTS the ruled mount rather
   * than failing it on a name the component never used.
   */
  ownerAnchors: readonly string[];
  /**
   * The RULED root declaration every lifecycle card owes: the kind and its host,
   * on the card's own root. `ReviewGateCard` already emits both; the kinds that
   * do not are listed in `ROOT_DECLARATION_OBLIGATIONS` and their owning slice
   * adds them. Kept OUT of `ownerAnchors` on purpose — an obligation is a red
   * done-check, never a reason to reject the mount that exists.
   */
  ruledRootAnchors: readonly string[];
  /**
   * Subtrees that belong to ANOTHER host. Anchors satisfied from inside one of
   * these are mislabeled evidence, not a chat mount.
   */
  foreignHostSubtrees: readonly string[];
  /**
   * The REAL decision controls the drawn card offers the reader, read off the
   * shipped component (cinatra#2827, epic #2784 S9i). This is what a SHELL
   * cannot satisfy: the placeholder draws a title and a state line and offers
   * nothing to press, so a matrix row that requires these refuses to certify it
   * as the kind's owner.
   *
   * EMPTY IS A RULING, NOT A GAP, and only §VII may take it: the verification
   * card "carries no floor at all — it asks nothing, so it draws nothing to
   * press". A kind with an empty list is held to the root declaration instead,
   * which the shell also cannot emit — see `chatCarriageRootAnchorsFor`.
   */
  decisionControls: readonly string[];
  enforcer: CarriageEnforcer;
};

/**
 * The subtrees that belong to the inline run card, on both the shipped view and
 * the decoupled renderer. Shared, so a kind cannot quietly drop one.
 */
const RUN_CARD_SUBTREES = Object.freeze([
  "[data-run-card]",
  '[data-lifecycle-card-host="run_card"]',
  "[data-inline-agent-run-card]",
]);

function rootAnchorsFor(kind: LifecycleCardKind): readonly string[] {
  return Object.freeze([
    `[data-lifecycle-card="${kind}"]`,
    '[data-lifecycle-card-host="chat_thread"]',
  ]);
}

/**
 * The chat_thread carriage of every ruled lifecycle kind.
 *
 * Only `recommendation_hold` is tied to the `agent_run` tool result and the held
 * dispatch turn — it is the one kind whose carriage is an INTERRUPT, because the
 * run is genuinely blocked on the answer. The DATA_PART kinds bind to their OWN
 * triggering parts and their per-kind owners/anchors are enforced by the
 * one-card gate; they are listed here so the table is the complete picture and a
 * fifth kind cannot appear without a row.
 */
export const CHAT_THREAD_CARRIAGE_CONTRACT: readonly ChatThreadCarriageRow[] = Object.freeze([
  {
    kind: "recommendation_hold",
    carriage: LIFECYCLE_CARD_CARRIAGE.recommendation_hold,
    triggeringPart: "the durable agent_run tool result of the held dispatch turn",
    triggerToolName: "agent_run",
    owner: "RecommendationHoldCard",
    // Read off the SHIPPED component: `RecommendationHoldCard` composes
    // `RunRecommendationChipRow`, whose root carries the conformance id and
    // whose decision controls carry these action names.
    //
    // RE-READ AFTER THE §V REDRAW (cinatra#2841). The row used to carry ONE
    // Confirm/Skip pair for the whole card; the ratified drawing decides PER
    // CHIP, so the shipped controls are now Confirm / Adjust / Skip on each
    // skill and the two row-level names this list used to hold are emitted
    // nowhere. Naming them anyway would have failed the real mount on names the
    // component never used — the exact defect this field exists to prevent — so
    // they are replaced by what the component really draws, not dropped.
    // Same three the capture contract names (`decisionControls` in
    // `scripts/ci/lib/capture-record-contract.mjs`); the capture suite asserts
    // the two lists stay in step, so neither can drift alone.
    ownerAnchors: Object.freeze([
      '[data-conformance-id="run-chip-row"]',
      '[data-skill-action="confirm"]',
      '[data-skill-action="adjust"]',
      '[data-skill-action="skip"]',
    ]),
    ruledRootAnchors: rootAnchorsFor("recommendation_hold"),
    // §V's decision acts, on the shipped `RunRecommendationChipRow` — the SAME
    // three the owner anchors above and the capture contract
    // (`decisionControls` in `scripts/ci/lib/capture-record-contract.mjs`)
    // already name. The capture suite asserts the two lists stay in step, so
    // neither can drift alone.
    //
    // RE-READ AFTER THE §V REDRAW (cinatra#2841), for the same reason and off
    // the same component as `ownerAnchors` above. This field held the ROW-LEVEL
    // `confirm-run-recommendation` / `skip-run-recommendation` pair, which the
    // ratified drawing deleted — the row is decided PER CHIP now, and that pair
    // is emitted nowhere.
    //
    // IT WENT STALE IN TWO PLACES AND WAS FOUND TWICE. cinatra#2866 renamed the
    // owner anchors and left this field behind, which asserted a selector the
    // shipped row never draws and turned main red (cinatra#2887, fixed by
    // cinatra#2888). Independently, nothing on this branch had ever exercised
    // it: `recommendation_hold` had no chat_thread mount, so the matrix took its
    // ratchet arm and never observed the real card. S9b (cinatra#2786) lands
    // that mount and strikes the ratchet, which is what reads this list against
    // the shipped DOM for the first time — and the evaluator requires EVERY
    // selector here inside one declaring root, so leaving the row-level pair
    // would have failed the real card on controls it no longer draws. Both
    // routes arrived at the same three names, which is the reassuring part.
    decisionControls: Object.freeze([
      '[data-skill-action="confirm"]',
      '[data-skill-action="adjust"]',
      '[data-skill-action="skip"]',
    ]),
    foreignHostSubtrees: RUN_CARD_SUBTREES,
    enforcer: "held-turn-card-contract",
  },
  {
    kind: "artifact_review_gate",
    carriage: LIFECYCLE_CARD_CARRIAGE.artifact_review_gate,
    triggeringPart: "the artifact_review_gate DATA_PART renderable view",
    triggerToolName: null,
    owner: "ReviewGateCard",
    ownerAnchors: Object.freeze(['[data-conformance-id="review-gate-card"]']),
    ruledRootAnchors: rootAnchorsFor("artifact_review_gate"),
    // §II's floor, on the shipped `ReviewDecisionBar` the card composes. The
    // three the bar really emits — a reader who may only comment keeps Comment,
    // so the set is what the card CAN offer, checked against the state it drew.
    decisionControls: Object.freeze([
      '[data-action="approve-review -> resolved"]',
      '[data-action="reject-review -> resolved"]',
      '[data-action="comment-review -> annotated"]',
    ]),
    foreignHostSubtrees: RUN_CARD_SUBTREES,
    enforcer: "chat-hitl-one-card-gate",
  },
  {
    kind: "trigger_schedule_proposal",
    carriage: LIFECYCLE_CARD_CARRIAGE.trigger_schedule_proposal,
    triggeringPart: "the trigger_schedule_proposal DATA_PART renderable view",
    triggerToolName: null,
    owner: "ScheduleProposalCard",
    ownerAnchors: Object.freeze([`[data-lifecycle-card="trigger_schedule_proposal"]`]),
    ruledRootAnchors: rootAnchorsFor("trigger_schedule_proposal"),
    // §VI's two acts. Named before they existed, on purpose — an obligation
    // with no named target is a row that can be struck against nothing — and
    // now SHIPPED: S9d (cinatra#2788) draws `ScheduleProposalCard` emitting
    // exactly these two, which the contract suite reads straight off that
    // component rather than taking this list's word for it.
    decisionControls: Object.freeze([
      '[data-action="adjust-schedule-proposal"]',
      '[data-action="confirm-schedule-proposal"]',
    ]),
    foreignHostSubtrees: RUN_CARD_SUBTREES,
    enforcer: "chat-hitl-one-card-gate",
  },
  {
    kind: "verification_summary",
    carriage: LIFECYCLE_CARD_CARRIAGE.verification_summary,
    triggeringPart: "the verification_summary DATA_PART renderable view",
    triggerToolName: null,
    owner: "VerificationSummaryCard",
    ownerAnchors: Object.freeze([`[data-lifecycle-card="verification_summary"]`]),
    ruledRootAnchors: rootAnchorsFor("verification_summary"),
    // §VII asks nothing, so it draws nothing to press. The empty list is the
    // ruling; the root declaration below is what this row is held to.
    decisionControls: Object.freeze([]),
    foreignHostSubtrees: RUN_CARD_SUBTREES,
    enforcer: "chat-hitl-one-card-gate",
  },
]);

/** The one row this module executes end-to-end: the held dispatch turn. */
export const HELD_TURN_ROW: ChatThreadCarriageRow = CHAT_THREAD_CARRIAGE_CONTRACT.find(
  (r) => r.kind === "recommendation_hold",
)!;

/** Every ruled kind has a row — the table cannot silently lose one. */
export function carriageRowFor(kind: LifecycleCardKind): ChatThreadCarriageRow {
  const row = CHAT_THREAD_CARRIAGE_CONTRACT.find((r) => r.kind === kind);
  if (!row) throw new Error(`no chat_thread carriage row for lifecycle kind "${kind}"`);
  return row;
}

/** The kinds the table must cover, from the protocol package's closed set. */
export const RULED_KINDS: readonly LifecycleCardKind[] = LIFECYCLE_CARD_KINDS;

/**
 * Kinds whose PRODUCTION chat_thread mount is not on main yet.
 *
 * This is a red done-check made mechanical, not a waiver. The transcript test
 * asserts the OBSERVED unmounted set is exactly this list, so the mount landing
 * turns CI red until the row is struck — and a row struck without the mount
 * turns CI red immediately.
 */
export const HELD_TURN_MOUNT_OBLIGATIONS: readonly LifecycleCardKind[] = Object.freeze([
  // EMPTY, and that is the ratchet being paid rather than relaxed.
  // `recommendation_hold` was the one row here. S9b (cinatra#2786) landed its
  // production chat_thread mount — `chat-messages-view.tsx` draws
  // `RecommendationHoldCard` in the `agent_run` part's own slot container,
  // outside the run card's subtree — so the row is STRUCK. The positive arm
  // turns itself on by that fact alone: every ruled kind is now asserted to
  // mount, and the transcript suite's `!HOLD_MOUNT_OWED` arms flip from
  // "nothing may import the card" to "the view must mount it and resolve its
  // authority". Re-adding a kind here would be a waiver, not a done-check.
]);

/**
 * Is this kind's chat_thread mount still OWED?
 *
 * This is what makes the positive arm structural instead of optional. The
 * evaluator used to leave "must the card be there?" to whichever caller
 * remembered to pass `requireMount`, so the default answer for every kind — the
 * mounted ones included — was NO. The obligation list is the only ruled reason a
 * held turn may show no card, so it is the only thing that turns the arm off:
 * a kind not on it is asserted, and the day a row is struck the assertion turns
 * on by itself rather than waiting for someone to also flip a flag.
 */
export function heldTurnMountIsOwed(kind: LifecycleCardKind): boolean {
  return HELD_TURN_MOUNT_OBLIGATIONS.includes(kind);
}

/**
 * Kinds whose shipped owner component does not yet emit the RULED root
 * declaration (`data-lifecycle-card` + `data-lifecycle-card-host`).
 *
 * `ReviewGateCard` emits both today, so it is absent from this list and would
 * fail the check if it stopped. The transcript suite renders each listed owner
 * and asserts the declaration is STILL missing, so the day the owning slice adds
 * it the row must be struck. Same ratchet discipline as the mount obligations:
 * an obligation is a red done-check, never a waiver.
 *
 * EMPTY, AND THAT IS THE RATCHET WORKING. `recommendation_hold` was the one row
 * here, and the §V redraw (cinatra#2841) put the declaration on the chip row's
 * own outermost element — the row IS the card — in BOTH of its states, held and
 * decided. The obligation was therefore struck the moment the declaration
 * landed, which is the only moment it may be struck.
 *
 * STRIKING IT DID NOT RETIRE THE MEASUREMENT. The transcript suite still reads
 * the real card's root and compares what it found against this list, so the
 * declaration disappearing puts `recommendation_hold` back into the OBSERVED
 * set and turns that arm red against this empty list; and the arm that runs
 * only once a row is struck reads the shipped component and requires both
 * attributes to really be there. Both directions stay live with the list empty.
 *
 * S9b (cinatra#2786) CONSUMES that root rather than adding a second one. The
 * chat_thread mount renders `RecommendationHoldCard`, which composes the very
 * chip row whose outermost element carries the declaration above, and the host
 * value is read from the provider the mount declared — so the chat mount is
 * labelled `chat_thread` by construction, a mount cannot claim a host it is
 * not, and the "ONE root" this list measures stays one.
 */
export const ROOT_DECLARATION_OBLIGATIONS: readonly LifecycleCardKind[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// The four-kind chat_thread CARRIAGE MATRIX (cinatra#2827, epic #2784 S9i)
// ---------------------------------------------------------------------------
//
// The table above says which component owns a kind and where it must render.
// This section says WHAT COUNTS as that component having rendered — because
// until now nothing did, and a gate with no answer to that question certifies
// the S1 placeholder shell as §VI and §VII. The shell emits
// `data-lifecycle-card="<kind>"` and `data-lifecycle-card-state`, so a check
// built on those two alone passes on a card that draws a title and a sentence
// and asks the reader for nothing.
//
// THE TWO THINGS A SHELL CANNOT DO, and they are the matrix:
//
//   1. DECLARE ITS HOST ON ITS OWN ROOT. `data-lifecycle-card-host` says which
//      of the four hosts drew this card. The shell renders identically on every
//      host and names none; `ReviewGateCard` writes the host it read from the
//      surface declaration. The declaration is required ON ONE ELEMENT with the
//      kind and the state — split across two, it is two elements agreeing by
//      coincidence rather than one card identifying itself.
//   2. OFFER THE KIND'S REAL DECISION CONTROLS. Named per row, read off the
//      shipped component. §VII is the one ruled empty list (it asks nothing), so
//      it is held to (1) alone — which the shell still cannot satisfy.
//
// AND THE POSITION IS PART OF THE ANSWER (the other half of this slice): the
// root must sit at the ordered slot of the part that PRODUCED the view, outside
// every foreign-host subtree. A card anywhere else in the turn is a card the
// reader has to go looking for.

/** The state attribute every drawn lifecycle card carries on its own root. */
export const LIFECYCLE_CARD_STATE_ANCHOR = "[data-lifecycle-card-state]";

/**
 * The anchors ONE element — the card's own root — must carry for the row's
 * owner to be considered drawn: its kind, the chat host, and a resolved state.
 */
export function chatCarriageRootAnchorsFor(
  row: ChatThreadCarriageRow,
): readonly string[] {
  return Object.freeze([...row.ruledRootAnchors, LIFECYCLE_CARD_STATE_ANCHOR]);
}

/**
 * Kinds whose chat_thread OWNER is not drawn on main yet — and the list is now
 * EMPTY, which is a state this ratchet was built to reach rather than a gap in
 * it. Both entries were struck by the slices that drew their cards:
 *
 *   · `verification_summary` — STRUCK by S9e (cinatra#2789); the registry
 *     dispatches it to `VerificationSummaryCard`.
 *   · `trigger_schedule_proposal` — STRUCK by S9d (cinatra#2788); the registry
 *     dispatches it to `ScheduleProposalCard`.
 *
 * The list stays, empty, because it is a red done-check in BOTH directions:
 * leaving a row standing after its owner lands turns the matrix red (which is
 * how this seam was found), and adding a row back without a shell-owned kind to
 * justify it is equally visible. An empty list is the honest reading of a tree
 * where no chat root is owned by the S1 shell any more — not a reason to delete
 * the ratchet.
 *
 * `recommendation_hold` is deliberately NOT repeated here. Its chat mount is
 * owed for its own reason (S9b, #2786) and already ratcheted by
 * `HELD_TURN_MOUNT_OBLIGATIONS`; the matrix READS that list, so the slice that
 * lands the mount strikes ONE row and both ratchets move together. Two lists
 * naming the same kind is exactly how a struck ratchet goes stale somewhere else.
 */
export const SHELL_OWNED_CHAT_KINDS: readonly LifecycleCardKind[] = Object.freeze([]);

/**
 * The whole owed set of the matrix — a RED DONE-CHECK, never a waiver. The
 * matrix asserts the OBSERVED unmounted set is EXACTLY this list, so an owner
 * landing without its row struck is red, and a row struck without its owner is
 * red the same day.
 */
export const CHAT_OWNER_MOUNT_OBLIGATIONS: readonly LifecycleCardKind[] =
  Object.freeze([...HELD_TURN_MOUNT_OBLIGATIONS, ...SHELL_OWNED_CHAT_KINDS]);

/** Is this kind's chat_thread OWNER render still owed? */
export function chatOwnerMountIsOwed(kind: LifecycleCardKind): boolean {
  return CHAT_OWNER_MOUNT_OBLIGATIONS.includes(kind);
}

/**
 * ONE kind's observation, read off the rendered transcript by the caller that
 * holds the DOM. Kept as data so the JUDGEMENT lives here, beside the table it
 * is judging against, and the DOM walk lives with the surface that produced it.
 */
export type ChatCarriageObservation = {
  /**
   * Anchor sets, one per element that carried ANY of the row's root anchors and
   * sits outside every foreign-host subtree. One element carrying all three is
   * a declaration; three elements carrying one each is not.
   */
  rootCandidates: ReadonlyArray<{
    anchors: readonly string[];
    /** The ordered transcript slot this element renders at, or null. */
    slot: number | null;
    /** The row's decision controls found INSIDE this element. */
    controls: readonly string[];
  }>;
  /** The slot of the part that produced this kind's view, or null when absent. */
  producingSlot: number | null;
};

export type ChatCarriageViolation = {
  code:
    | "owner_root_absent"
    | "root_declaration_incomplete"
    | "controls_absent"
    | "root_off_producing_slot"
    | "no_producing_slot";
  detail: string;
};

/**
 * Judge one kind's observed carriage against its row.
 *
 * An empty result means the kind's REAL owner rendered, declared itself, offered
 * what it offers, and did so at the step that produced it. Anything else names
 * what was missing — and the wording matters, because these strings are what a
 * later slice reads when its ratchet turns red.
 */
export function evaluateChatCarriage(
  observation: ChatCarriageObservation,
  row: ChatThreadCarriageRow,
): ChatCarriageViolation[] {
  const violations: ChatCarriageViolation[] = [];
  const required = chatCarriageRootAnchorsFor(row);
  const complete = observation.rootCandidates.filter((c) =>
    required.every((a) => c.anchors.includes(a)),
  );

  if (complete.length === 0) {
    if (observation.rootCandidates.length === 0) {
      violations.push({
        code: "owner_root_absent",
        detail:
          `${row.owner} did not render for ${row.kind}: no element carries ` +
          `[${required.join(", ")}] in the chat transcript outside every foreign host`,
      });
    } else {
      // TWO SHAPES, ONE CODE, and they are the same defect: something drew for
      // this kind but nothing IDENTIFIED itself as the kind's card on a host.
      // The S1 shell lands here (it names the kind and its state and declares no
      // host), and so does a declaration spread over a wrapper and its child —
      // two elements agreeing by coincidence rather than one card saying what it
      // is. Named apart from "absent" so a placeholder is never read as nothing.
      violations.push({
        code: "root_declaration_incomplete",
        detail:
          `${row.kind} rendered, but no SINGLE element declares its kind, its ` +
          `chat host and its state together — observed ` +
          observation.rootCandidates.map((c) => `[${c.anchors.join(", ")}]`).join(" + "),
      });
    }
    return violations;
  }

  // A kind's controls must live inside the root that declared itself, not
  // somewhere else in the turn.
  const best = complete.find((c) => row.decisionControls.every((a) => c.controls.includes(a)));
  if (row.decisionControls.length > 0 && best === undefined) {
    const found = new Set(complete.flatMap((c) => c.controls));
    violations.push({
      code: "controls_absent",
      detail:
        `${row.owner} drew no operable floor for ${row.kind}: ` +
        `[${row.decisionControls.filter((a) => !found.has(a)).join(", ")}] ` +
        "render nowhere inside the card's own root",
    });
  }

  const root = best ?? complete[0];
  if (observation.producingSlot === null) {
    violations.push({
      code: "no_producing_slot",
      detail:
        `the turn carries no producing step for ${row.kind}, so the card's ` +
        "position cannot be checked — a card with no slot identity is the defect",
    });
  } else if (root.slot !== observation.producingSlot) {
    violations.push({
      code: "root_off_producing_slot",
      detail:
        `${row.owner} rendered at slot ${root.slot ?? "none"} but ${row.kind} was ` +
        `produced at slot ${observation.producingSlot} — the card must render in ` +
        "its producing step's OWN container",
    });
  }
  return violations;
}

/** Does the observed transcript carry this kind's REAL owner, at its slot? */
export function carriesChatOwner(
  observation: ChatCarriageObservation,
  row: ChatThreadCarriageRow,
): boolean {
  return evaluateChatCarriage(observation, row).length === 0;
}

/**
 * VOCABULARY-INDEPENDENT probes for "a lifecycle card of ANY spelling is mounted
 * here".
 *
 * The mount ratchet above compares the anchors this contract KNOWS. That alone
 * couples the obligation to today's selector names: a mount that landed with
 * renamed actions would satisfy a reader and still read as unmounted, leaving
 * the obligation stale and CI green. These selectors are deliberately generic —
 * they match the ATTRIBUTE, not its value — so any lifecycle card, any chip row
 * and any confirm/skip control in the triggering container is seen, whatever it
 * is called.
 */
export const ANY_LIFECYCLE_MOUNT_PROBES: readonly string[] = Object.freeze([
  "[data-lifecycle-card]",
  "[data-lifecycle-card-host]",
  "[data-lifecycle-card-state]",
  "[data-run-recommendation-chip-row]",
  "[data-run-recommendation-decision]",
  // The bare attributes, not a prefix list. A card whose controls were called
  // `data-action="decide"` would slip past every value-shaped probe, and the
  // repo's convention gives an operable affordance one of these two.
  "[data-action]",
  "[data-conformance-id]",
]);

/**
 * THE FLOOR OF THAT PROBE, stated so it is not read as more than it is: a card
 * rendered with NO data attribute at all is invisible to these selectors.
 *
 * That case is not left to a sibling gate on faith. The transcript suite checks
 * the triggering container for INTERACTIVITY itself — a button, a link, a
 * control — outside the run card's subtree, because an operable card has to
 * offer the reader something to click whatever its markup is called. Attributes
 * catch the named mount; interactivity catches the unnamed one.
 */
export const ANY_LIFECYCLE_MOUNT_PROBE_LIMIT =
  "attribute probes miss a card with no data-* markers; the transcript suite's interactive-affordance check is the floor under them";

// ---------------------------------------------------------------------------
// The projection model
// ---------------------------------------------------------------------------

/** One ordered part of the assistant turn, as the transcript renders it. */
export type ProjectedPart =
  | { kind: "text"; slot: number; text: string }
  | {
      kind: "tool_result";
      slot: number;
      name: string;
      /** The DURABLE payload — what survives a transcript reload. */
      result: string | null;
      /** The run this part pins, read out of the durable payload. */
      runId?: string | null;
    };

/** One node the transcript actually rendered. */
export type ProjectedNode = {
  /** The contract selectors this node satisfies. */
  anchors: readonly string[];
  /** The ordered transcript slot this node was rendered at, or null if none. */
  slot: number | null;
  /** Foreign-host subtree selectors this node sits INSIDE. */
  insideSubtrees: readonly string[];
};

export type TurnProjection = {
  parts: readonly ProjectedPart[];
  nodes: readonly ProjectedNode[];
};

export type HeldTurnViolation = {
  code:
    | "decision_path_pointer"
    | "no_durable_result"
    | "anchors_in_foreign_host"
    | "anchors_off_position"
    | "card_not_mounted"
    | "surface_pointer_without_card";
  detail: string;
};

/** The durable tool result of the row's triggering part, if the turn carries it. */
export function durableTriggerPart(
  projection: TurnProjection,
  row: ChatThreadCarriageRow,
): Extract<ProjectedPart, { kind: "tool_result" }> | null {
  if (row.triggerToolName === null) return null;
  for (const part of projection.parts) {
    if (part.kind !== "tool_result" || part.name !== row.triggerToolName) continue;
    if (part.runId != null) return part;
    // The runId is IN the durable payload — read it from there rather than
    // making every caller pre-parse it.
    return { ...part, runId: runIdOf(part.result) };
  }
  return null;
}

/** The runId inside a durable tool-result payload, or null. */
export function runIdOf(result: string | null): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as { runId?: unknown };
    return typeof parsed.runId === "string" ? parsed.runId : null;
  } catch {
    return null;
  }
}

/**
 * Is this node in the triggering part's own container?
 *
 * ONE way, deliberately. The transcript renders one container per ordered part;
 * the card belongs in the container of the part that triggered it, beside the
 * inline run card rather than inside it. A node anywhere else in the turn is a
 * card the reader has to go looking for, and "somewhere in the same turn" is the
 * looseness that let a text pointer read as a mount.
 */
function atTriggerPosition(
  node: ProjectedNode,
  trigger: Extract<ProjectedPart, { kind: "tool_result" }>,
): boolean {
  return node.slot === trigger.slot;
}

/**
 * Evaluate a held turn against its contract row.
 *
 * `requireMount` turns on the POSITIVE arm (the card must actually be there).
 * IT DEFAULTS TO THE CONTRACT, not to off: a kind whose chat_thread mount has
 * landed is asserted, and only a kind on `HELD_TURN_MOUNT_OBLIGATIONS` — the
 * ruled, ratcheted reason a held turn may show no card — is exempt. Passing it
 * explicitly still wins, which is what lets the fixture suite drive both arms.
 *
 * AND THE EXEMPTION IS PAID FOR. A turn that ends up mounting no card is held to
 * `UNMOUNTED_SURFACE_POINTER_PATTERNS` as well: with no card on screen the prose
 * is the whole answer, so it may not point at another surface at all, verb or no
 * verb. That is what keeps "the controls you need are in run details" — a
 * sentence no decision-verb pattern matches — from passing while the obligation
 * stands.
 */
export function evaluateHeldTurnProjection(
  projection: TurnProjection,
  row: ChatThreadCarriageRow = HELD_TURN_ROW,
  options: { requireMount?: boolean } = {},
): HeldTurnViolation[] {
  const violations: HeldTurnViolation[] = [];
  const requireMount = options.requireMount ?? !heldTurnMountIsOwed(row.kind);

  // 1. No text in the turn may present another surface as the decision path.
  for (const part of projection.parts) {
    if (part.kind !== "text") continue;
    for (const hit of findDecisionPathPointers(part.text)) {
      violations.push({
        code: "decision_path_pointer",
        detail:
          `text part at slot ${part.slot} ${hit.why} ` +
          `(${hit.patternId}): "${hit.match}"`,
      });
    }
  }

  const trigger = durableTriggerPart(projection, row);

  // 2. The triggering part must be DURABLE — a card rebuilt on reload needs a
  //    persisted payload, not live stream state.
  if (row.triggerToolName !== null) {
    if (trigger === null) {
      violations.push({
        code: "no_durable_result",
        detail: `the turn carries no ${row.triggerToolName} tool result — ${row.owner} has nothing to rebuild from on reload`,
      });
    } else if (trigger.result === null || trigger.result.trim().length === 0) {
      violations.push({
        code: "no_durable_result",
        detail: `the ${row.triggerToolName} tool result carries no durable payload`,
      });
    }
  }

  // 3. Any node carrying an owner anchor must sit OUTSIDE every foreign-host
  //    subtree, and at the triggering part's own slot.
  const anchorNodes = projection.nodes.filter((n) =>
    n.anchors.some((a) => row.ownerAnchors.includes(a)),
  );
  const cleanNodes: ProjectedNode[] = [];
  for (const node of anchorNodes) {
    const foreign = node.insideSubtrees.filter((s) => row.foreignHostSubtrees.includes(s));
    if (foreign.length > 0) {
      violations.push({
        code: "anchors_in_foreign_host",
        detail:
          `${row.owner} anchors [${node.anchors.join(", ")}] render INSIDE ${foreign.join(", ")} — ` +
          "that subtree belongs to another host, so this is not a chat mount",
      });
      continue;
    }
    if (trigger !== null && !atTriggerPosition(node, trigger)) {
      violations.push({
        code: "anchors_off_position",
        detail:
          `${row.owner} anchors render in container ${node.slot ?? "none"} but the ` +
          `${row.triggerToolName} part (run ${trigger.runId ?? "unknown"}) is container ` +
          `${trigger.slot} — the card must render in its triggering part's OWN container`,
      });
      continue;
    }
    cleanNodes.push(node);
  }

  // 4. The POSITIVE arm: every owner anchor satisfied by the CLEAN nodes.
  //    The set, not one node: a card's root carries its identity attributes and
  //    its own controls carry the action anchors, so the wrapper, the row and
  //    the two decision controls are several elements of one card.
  const covered = new Set<string>();
  for (const node of cleanNodes) for (const a of node.anchors) covered.add(a);
  const missing = row.ownerAnchors.filter((a) => !covered.has(a));
  if (requireMount && missing.length > 0) {
    violations.push({
      code: "card_not_mounted",
      detail:
        `the held turn does not project ${row.owner}: [${missing.join(", ")}] ` +
        "render nowhere at the triggering position outside every foreign host",
    });
  }

  // 5. NO CARD MEANS NO POINTERS. When the turn mounts nothing, the sentence is
  //    not beside the answer — it is the answer, and a sentence that sends the
  //    reader to another surface is the anti-pattern whatever verb it uses. This
  //    is the arm that does not depend on a decision-verb list, and it is the
  //    price of the obligation list permitting a cardless held turn at all.
  if (missing.length > 0) {
    for (const part of projection.parts) {
      if (part.kind !== "text") continue;
      for (const hit of findUnmountedSurfacePointers(part.text)) {
        violations.push({
          code: "surface_pointer_without_card",
          detail:
            `the held turn mounts no ${row.owner} and its text part at slot ${part.slot} ` +
            `${hit.why} (${hit.patternId}): "${hit.match}"`,
        });
      }
    }
  }

  return violations;
}

/** Does the projection mount the row's card cleanly? */
export function projectsOwnerCard(
  projection: TurnProjection,
  row: ChatThreadCarriageRow = HELD_TURN_ROW,
): boolean {
  return (
    evaluateHeldTurnProjection(projection, row, { requireMount: true }).filter(
      (v) => v.code === "card_not_mounted" || v.code === "anchors_in_foreign_host" || v.code === "anchors_off_position",
    ).length === 0
  );
}
