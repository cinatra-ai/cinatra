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
 * pointer. The POSITIVE arm — the anchors must be there at all — runs with
 * `requireMount`, and the kinds whose production chat_thread mount is not on
 * main yet are listed in `HELD_TURN_MOUNT_OBLIGATIONS`. That list is a ratchet,
 * not a waiver: the transcript test measures the PRODUCTION view and asserts the
 * OBSERVED unmounted set equals it, so the day the mount lands the row must be
 * struck or CI goes red.
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

export type DecisionPathPointerHit = {
  patternId: string;
  why: string;
  /** The matched fragment, trimmed, so the failure message is actionable. */
  match: string;
};

/**
 * Every decision-path pointer in a piece of deterministic dispatch text. Empty
 * means the text is clean.
 */
export function findDecisionPathPointers(text: string): DecisionPathPointerHit[] {
  const hits: DecisionPathPointerHit[] = [];
  for (const p of DECISION_PATH_POINTER_PATTERNS) {
    const m = p.pattern.exec(text);
    if (m) hits.push({ patternId: p.id, why: p.why, match: m[0].trim() });
  }
  return hits;
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
    // whose two decision controls carry these action names.
    ownerAnchors: Object.freeze([
      '[data-conformance-id="run-chip-row"]',
      '[data-action="confirm-run-recommendation"]',
      '[data-action="skip-run-recommendation"]',
    ]),
    ruledRootAnchors: rootAnchorsFor("recommendation_hold"),
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
  "recommendation_hold",
]);

/**
 * Kinds whose shipped owner component does not yet emit the RULED root
 * declaration (`data-lifecycle-card` + `data-lifecycle-card-host`).
 *
 * `ReviewGateCard` emits both today, so it is absent from this list and would
 * fail the check if it stopped. The transcript suite renders each listed owner
 * and asserts the declaration is STILL missing, so the day the owning slice adds
 * it the row must be struck. Same ratchet discipline as the mount obligations:
 * an obligation is a red done-check, never a waiver.
 */
export const ROOT_DECLARATION_OBLIGATIONS: readonly LifecycleCardKind[] = Object.freeze([
  "recommendation_hold",
]);

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
    | "card_not_mounted";
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
 * With it off, the check is the always-on negative arm: no text pointer, and any
 * anchors that DO appear must appear at the triggering slot and outside every
 * foreign-host subtree.
 */
export function evaluateHeldTurnProjection(
  projection: TurnProjection,
  row: ChatThreadCarriageRow = HELD_TURN_ROW,
  options: { requireMount?: boolean } = {},
): HeldTurnViolation[] {
  const violations: HeldTurnViolation[] = [];

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
  if (options.requireMount) {
    const covered = new Set<string>();
    for (const node of cleanNodes) for (const a of node.anchors) covered.add(a);
    const missing = row.ownerAnchors.filter((a) => !covered.has(a));
    if (missing.length > 0) {
      violations.push({
        code: "card_not_mounted",
        detail:
          `the held turn does not project ${row.owner}: [${missing.join(", ")}] ` +
          "render nowhere at the triggering position outside every foreign host",
      });
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
