#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DECISION-POINTER CONTRACT — the text half of the chat-HITL anti-fraud gates
// (cinatra#2821, epic #2784 S9h).
//
// WHAT IT REFUSES. A held chat dispatch must answer with the CARD, in the turn
// that parked. The anti-pattern this contract detects is the TEXT POINTER: the
// deterministic dispatch answers in prose that presents ANOTHER surface as the
// place where the human decides. #2794's first round shipped exactly that
// sentence -- "confirm or skip the recommended skills on the run card above" --
// and no gate saw it, because it reads like ordinary helpful copy.
//
// WHAT IT DOES NOT REFUSE, deliberately: a bare link OFFER. `InlineAgentRunCard`
// ships the label "Open the run page", and that is legitimate -- the card is
// still the decision path, the link is a convenience beside it. The separator
// is a DECISION verb (or a decision written as a noun) tied to a place. No
// decision word, no finding.
//
// THE HONEST LIMIT. This is a lexical contract over prose. It cannot see
// whether a card mounted; that is the structural half (`evaluateHeldTurnRecord`
// below, and the transcript-tier DOM proof that feeds it). The two are meant to
// be read together: the structure is the gate, the vocabulary is defence in
// depth beside it.
//
// Zero runtime dependencies (node builtins only) so the gate stays pre-install
// safe and can run in a lean CI job.
// ---------------------------------------------------------------------------

/** Verbs that name the act of deciding. */
export const DECISION_VERBS = [
  "confirm",
  "approve",
  "reject",
  "skip",
  "decide",
  "accept",
  "deny",
  "dismiss",
  "acknowledge",
  "authorize",
  "authorise",
  "sign off",
];

/** The decision written as a noun ("the approval is available in ..."). */
export const DECISION_NOUNS = [
  "approval",
  "confirmation",
  "decision",
  "sign-off",
  "signoff",
];

/**
 * Surface parts. #2794's sentence escaped an earlier vocabulary because it
 * named a CARD with a positional locator rather than a place ("the run page"),
 * so the closed set covers the parts a UI is made of, not just whole screens.
 */
export const SURFACE_NOUNS = [
  "page",
  "card",
  "screen",
  "view",
  "detail",
  "details",
  "panel",
  "region",
  "tab",
  "section",
  "dialog",
  "modal",
  "sidebar",
  "window",
  // Whole-surface names. "Approve it in the dashboard." named a place the
  // closed set did not cover, so every arm read it as legal copy -- the exact
  // escape #2794's sentence made, one vocabulary generation later.
  "dashboard",
  "console",
  "portal",
];

/** A place named only by position -- "decide it there / above / below". */
export const BARE_LOCATORS = [
  "there",
  "above",
  "below",
  "beside it",
  "next to it",
  "elsewhere",
  "over there",
];

/** Imperatives that send the reader somewhere before deciding. */
export const NAVIGATION_VERBS = [
  "go to",
  "head to",
  "head over to",
  "navigate to",
  "visit",
  "open",
  "click through to",
  "jump to",
];

const alt = (words) =>
  words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"))
    .join("|");

const PREPOSITION = "(?:on|in|at|from|via|over|under|through|inside)";
// `the run card`, `run details`, `that agents page` -- an optional article, up
// to three intervening words, then the surface noun.
const SURFACE_PHRASE = `${PREPOSITION}\\s+(?:the|that|this|its|a|an)?\\s*(?:[a-z][a-z-]*\\s+){0,3}(?:${alt(
  SURFACE_NOUNS,
)})\\b`;

/**
 * The arms, each with the shape it names. Order is the reporting order; a text
 * can trip more than one and every hit is reported (a finding that names only
 * the first arm teaches the author the wrong lesson).
 */
export const POINTER_ARMS = [
  {
    id: "decide-elsewhere",
    why: "a decision verb tied to another surface or to a bare position",
    re: new RegExp(
      `\\b(?:${alt(DECISION_VERBS)})\\b[^.!?]{0,60}?(?:${SURFACE_PHRASE}|\\b(?:${alt(
        BARE_LOCATORS,
      )})\\b)`,
      "i",
    ),
  },
  {
    id: "decision-as-noun-elsewhere",
    why: "the decision written as a noun that LIVES on another surface",
    re: new RegExp(
      `\\b(?:${alt(
        DECISION_NOUNS,
      )})\\b[^.!?]{0,40}?\\b(?:is|are|can\\s+be|will\\s+be)\\b[^.!?]{0,25}?\\b(?:available|found|waiting|offered|made)\\b[^.!?]{0,25}?(?:${SURFACE_PHRASE}|\\b(?:${alt(
        BARE_LOCATORS,
      )})\\b)`,
      "i",
    ),
  },
  {
    id: "surface-for-decision",
    why: "a surface named as the thing you go to in order to decide",
    re: new RegExp(
      `\\b(?:${alt(SURFACE_NOUNS)})\\b\\s+(?:for|to)\\s+(?:the\\s+)?(?:${alt(
        DECISION_NOUNS,
      )})\\b`,
      "i",
    ),
  },
];

const NAVIGATION_RE = new RegExp(
  `\\b(?:${alt(NAVIGATION_VERBS)})\\b[^.!?]{0,40}?(?:the|that|this|its|a|an)?\\s*(?:[a-z][a-z-]*\\s+){0,3}(?:${alt(
    SURFACE_NOUNS,
  )})\\b`,
  "i",
);
const DECISION_VERB_RE = new RegExp(`\\b(?:${alt(DECISION_VERBS)})\\b`, "i");

/**
 * Classify one piece of user-visible prose.
 *
 * @param {string} text
 * @returns {{ pointer: boolean, findings: Array<{arm: string, why: string, match: string}> }}
 */
export function classifyDecisionPointer(text) {
  const findings = [];
  if (typeof text !== "string" || text.trim() === "") {
    return { pointer: false, findings };
  }
  for (const arm of POINTER_ARMS) {
    const m = arm.re.exec(text);
    if (m) findings.push({ arm: arm.id, why: arm.why, match: m[0].trim() });
  }
  // "Navigate somewhere, then decide" -- only a finding when the SAME text also
  // carries a decision word. A bare "Open the run page" is legal copy and stays
  // legal; that is the whole point of this arm being conjunctive.
  const nav = NAVIGATION_RE.exec(text);
  if (nav && DECISION_VERB_RE.test(text)) {
    findings.push({
      arm: "navigate-then-decide",
      why: "the reader is sent to another surface and told to decide once there",
      match: nav[0].trim(),
    });
  }
  return { pointer: findings.length > 0, findings };
}

/** The statuses that mean "this turn parked and owes the human a decision". */
export const HELD_STATUSES = ["pending_input", "pending_approval"];

/**
 * The STRUCTURAL half, over a held-turn record. A record is what the transcript
 * tier observes for one dispatch turn; this function is the single evaluator
 * both tiers call, so the two can never drift into two opinions.
 *
 * A held dispatch owes, in the turn that parked:
 *   1. the durable `agent_run` tool result carrying `{ runId, status }`;
 *   2. an ACTIONABLE card, mounted on the origin host, at the triggering
 *      tool-call position -- not merely somewhere later in the same turn;
 *   3. prose that does not point the decision at another surface.
 *
 * @param {object} record
 * @returns {Array<{code: string, detail: string}>} violations, empty when clean
 */
export function evaluateHeldTurnRecord(record) {
  const violations = [];
  const push = (code, detail) => violations.push({ code, detail });
  if (!record || typeof record !== "object") {
    return [{ code: "held-turn/malformed-record", detail: "not an object" }];
  }
  const status = record.status;
  if (!HELD_STATUSES.includes(status)) {
    // Not a held turn: this contract has nothing to say about it.
    return violations;
  }
  const results = Array.isArray(record.toolResults) ? record.toolResults : [];
  const durable = results.find((r) => r && r.name === "agent_run");
  if (!durable) {
    push(
      "held-turn/missing-durable-result",
      "no `agent_run` tool result in the parked turn -- nothing durable for a reload to re-render",
    );
  } else {
    let payload = durable.result;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = null;
      }
    }
    if (!payload || typeof payload.runId !== "string" || !payload.runId) {
      push(
        "held-turn/durable-result-without-runid",
        "the `agent_run` result carries no runId, so no later render can find the run",
      );
    }
  }
  const card = record.card;
  if (!card || card.mounted !== true) {
    push(
      "held-turn/no-card-in-turn",
      "the parked turn projects no card -- the human is left with prose",
    );
  } else {
    if (card.actionable !== true) {
      push(
        "held-turn/card-not-actionable",
        "the card in the parked turn carries no decision control",
      );
    }
    if (record.originHost && card.host !== record.originHost) {
      push(
        "held-turn/card-foreign-host",
        `the card declares host "${card.host}" on a turn that originated on "${record.originHost}"`,
      );
    }
    if (durable && durable.id && card.toolCallId && card.toolCallId !== durable.id) {
      push(
        "held-turn/card-outside-triggering-position",
        `the card sits at "${card.toolCallId}", not at the triggering tool call "${durable.id}" -- the same turn is not the same place`,
      );
    }
  }
  const { pointer, findings } = classifyDecisionPointer(record.text ?? "");
  if (pointer) {
    push(
      "held-turn/decision-pointer",
      `the parked turn's prose points the decision elsewhere: ${findings
        .map((f) => `${f.arm} ("${f.match}")`)
        .join("; ")}`,
    );
  }
  return violations;
}
