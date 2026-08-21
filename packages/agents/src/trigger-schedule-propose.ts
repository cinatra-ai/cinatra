import "server-only";

// ---------------------------------------------------------------------------
// PROPOSE — the leaf the MCP producer reaches (cinatra#2569, epic #2564 S5).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §VI.
//
// Split out of `trigger-schedule-proposal-service.ts` for a MEASURED reason,
// not a stylistic one. The producer tool is registered on the cinatra self-MCP
// server, which is mounted by the app's auth plugins — so every module it can
// reach lands on the reachable first-party graph of FIVE locked dev-perf routes
// (`/api/mcp`, `/api/a2a`, `/api/llm-bridge`, `/chat`, `/sign-in`). Importing
// the whole service put the CONFIRM transaction, the install outbox store and
// the recurrence-to-cron translation on all five, and the route-graph ratchet
// measured it: +7 modules per route.
//
// None of that is reachable from a proposal. Proposing needs three things — a
// template read, a wall-clock check, and a token mint — so those three live
// here and the confirm/drain half stays where only a server action reaches it.
// This is the same discipline S1 applied when it mirrored the lifecycle view
// constants rather than importing the zod registry into the producer graph.
// ---------------------------------------------------------------------------

import {
  mintTriggerScheduleProposalToken,
  verifyTriggerScheduleProposalToken,
  type ProposalSchedule,
} from "@/lib/trigger-schedule-proposal-token";
import { readAgentTemplateById } from "./store";

// ---------------------------------------------------------------------------
// PROPOSE
// ---------------------------------------------------------------------------

export type ProposeScheduleInput = {
  templateId: string;
  userId: string;
  orgId: string;
  schedule: ProposalSchedule;
};

export type ProposeScheduleResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false };

/**
 * Mint a proposal. WRITES NOTHING.
 *
 * The only checks here are the ones that would make the card a lie: the
 * template has to exist and be in the caller's reach, and the schedule has to
 * be one the scheduling step could have produced. Whether the reader may
 * DISPATCH is re-resolved at render and again at Confirm — a proposal is a
 * question, and a question the reader turns out not to be allowed to answer is
 * a drawn card with a disabled floor (§IV `restricted`), not a refusal to draw.
 *
 * Returns `{ok:false}` with no reason: the caller is a model-facing tool whose
 * every denial is one fixed sentence.
 */
export async function proposeTriggerSchedule(
  input: ProposeScheduleInput,
): Promise<ProposeScheduleResult> {
  return mintProposal(input);
}

/**
 * The shared body of PROPOSE, ADJUST and RE-PROPOSE. `lineageNonce` is the only
 * thing that differs between them, and it differs in exactly one direction:
 * supplied, the minted proposal INHERITS an existing consume identity instead of
 * opening a new one. See `adjustTriggerSchedule` and
 * `reproposeTriggerScheduleInLineage`.
 */
async function mintProposal(
  input: ProposeScheduleInput,
  lineageNonce?: string,
): Promise<ProposeScheduleResult> {
  if (!input.userId || !input.orgId) return { ok: false };

  const template = await readAgentTemplateById(input.templateId);
  if (!template) return { ok: false };
  // The org boundary, before anything confirms the template exists to a caller
  // outside it.
  if (template.orgId && template.orgId !== input.orgId) return { ok: false };

  // A schedule with a past `runAt` would be refused at Confirm by the trigger
  // service's own future check; refusing it HERE instead means the assistant
  // re-reads the user's intent rather than drawing a card that cannot be
  // pressed.
  if (input.schedule.kind === "scheduled") {
    const ms = naiveDatetimeToUtcMs(input.schedule.runAt, input.schedule.timezone);
    if (Number.isNaN(ms) || ms <= Date.now()) return { ok: false };
  }

  const minted = mintTriggerScheduleProposalToken(
    {
      templateId: input.templateId,
      userId: input.userId,
      orgId: input.orgId,
      schedule: input.schedule,
    },
    lineageNonce === undefined ? undefined : { nonce: lineageNonce },
  );
  if (!minted) return { ok: false };
  return { ok: true, token: minted.token, expiresAt: minted.expiresAt };
}

/** What ADJUST needs: the ref the card was drawn with, and the new rows. */
export type AdjustScheduleInput = {
  /** The proposal being adjusted — the card's OWN ref, not a template id. */
  priorToken: string;
  userId: string;
  orgId: string;
  schedule: ProposalSchedule;
};

/**
 * RE-PROPOSE an expired proposal IN ITS OWN LINEAGE — same checks as PROPOSE,
 * but the replacement inherits `lineageNonce` as its consume identity rather
 * than opening a second one.
 *
 * Distinct from `adjustTriggerSchedule` in the question it asks, not in the
 * identity it mints. The drawn form's Adjust is a reader CHOOSING NEW ROWS: a
 * genuinely different schedule, and therefore a different question.
 * Re-proposing an expired card re-asks the SAME question off the same ref, so
 * it must not become a second answerable copy of it. Since cinatra#2859 BOTH
 * paths inherit the original's consume identity, so a family that grew either
 * way holds ONE identity: one run per lineage, whatever the timing.
 */
export async function reproposeTriggerScheduleInLineage(
  input: ProposeScheduleInput & { lineageNonce: string },
): Promise<ProposeScheduleResult> {
  if (!input.lineageNonce) return { ok: false };
  return mintProposal(input, input.lineageNonce);
}

/**
 * ADJUST. A distinct name for the same act, because §VI draws it as a distinct
 * affordance and the distinction is the safety property: "Adjust opens the same
 * option rows in place; Confirm settles them." Adjusting a proposal RE-PROPOSES
 * rather than editing the old one, so no partially changed schedule can ever
 * exist.
 *
 * THE REPLACEMENT INHERITS THE ORIGINAL'S CONSUME IDENTITY (cinatra#2859).
 *
 * It did not, and that was the defect. A fresh identity left the adjusted-away
 * token SPENDABLE for the rest of its TTL: the two tokens addressed different
 * rows in `trigger_schedule_proposal_consumes`, whose uniqueness is per
 * `consume_key` only, so a stale tab or a replayed turn could Confirm the old
 * card and the reader could Confirm the new one and BOTH would land — two runs,
 * one of them on the schedule the reader had just corrected.
 *
 * The old rationale — "each answer is its own, because the reader is asking a
 * different question" — is true about the QUESTION and false about the ANSWER.
 * Adjust exists to REPLACE a proposal, so at most one member of the family may
 * ever become a run, and which schedule the reader ends up with must not depend
 * on which tab was still open.
 *
 * So the replacement is minted with the ORIGINAL's nonce. `proposalConsumeKey`
 * derives the single-use edge from the nonce, so old and new are ONE row under
 * that table's PRIMARY KEY: the second spender's INSERT raises a unique
 * violation inside its own run-creation transaction, unwinds it, and the caller
 * is answered with the FIRST run. "Both confirmed" is not a race the
 * application has to win; it is a state the database cannot hold. No lock, no
 * claim row, no new table, no migration — and PROPOSE-PURITY IS UNTOUCHED,
 * because inheriting an identity writes nothing.
 *
 * This is the SAME mechanism #2837 gives the expired card's re-propose, and the
 * two compose: whether a family grew by re-proposing an expired card, by
 * adjusting a live one, or by both, every member shares one consume key and
 * exactly one Confirm in it can ever produce a run.
 *
 * THE PRIOR REF IS THE INPUT, not a template id. The nonce can only come from a
 * token this server minted and authenticated, so a consume identity cannot be
 * chosen without forging the token that carries it — and reading the template
 * out of the verified ref means Adjust can never be re-pointed at an agent the
 * reader was never proposed. A ref that does not verify against this reader is
 * refused before anything is minted.
 */
export async function adjustTriggerSchedule(
  input: AdjustScheduleInput,
): Promise<ProposeScheduleResult> {
  const prior = verifyTriggerScheduleProposalToken({
    token: input.priorToken,
    expectedUserId: input.userId,
    expectedOrgId: input.orgId,
  });
  // One answer for a forged ref, a foreign one, and one whose window has
  // closed. An expired proposal is re-proposed through the EXPIRED path, which
  // is the reading Confirm may not act on; this one adjusts a LIVE card.
  if (!prior) return { ok: false };

  return mintProposal(
    {
      templateId: prior.templateId,
      userId: input.userId,
      orgId: input.orgId,
      schedule: input.schedule,
    },
    prior.nonce,
  );
}

/**
 * Interpret a timezone-naive "YYYY-MM-DDTHH:MM" wall clock in an IANA zone.
 *
 * The same derivation `trigger-service.ts` uses, and it has to be: a proposal
 * validated here and armed there must agree on what "09:00 in Europe/Berlin"
 * is. `new Date(naive)` would read the string in the SERVER's zone (UTC), which
 * is the bug this exists to avoid.
 *
 * KNOWN LIMIT, INHERITED DELIBERATELY (codex round-2 finding). The offset is
 * inferred at a single reference instant and not round-tripped, so the two DST
 * edge cases are imprecise: a wall clock inside a spring-forward GAP (a time
 * that does not exist) maps to a nearby real instant rather than being refused,
 * and a fall-back AMBIGUOUS time resolves to one of its two instants without an
 * explicit policy. This is the SHIPPED behaviour of the scheduling form, and
 * making the conversational path stricter would be worse, not better: the
 * proposal and the form would then disagree about what a confirmed schedule
 * means, which is the one thing §VI's "confirm what you see" cannot survive.
 * Closing it is a change to BOTH, on its own issue.
 */
export function naiveDatetimeToUtcMs(naive: string, timezone: string): number {
  const padded = naive.length === 16 ? `${naive}:00` : naive;
  const asUtcMs = new Date(`${padded}Z`).getTime();
  if (Number.isNaN(asUtcMs)) return NaN;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(asUtcMs));
  } catch {
    // An unknown IANA zone. NaN, so both the propose check and the install
    // translation refuse rather than silently scheduling in UTC.
    return NaN;
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const rawHour = get("hour");
  const tzHour = rawHour === "24" ? "00" : rawHour;
  const inTzMs = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${tzHour}:${get("minute")}:${get("second")}Z`,
  ).getTime();
  if (Number.isNaN(inTzMs)) return NaN;
  return asUtcMs + (asUtcMs - inTzMs);
}

