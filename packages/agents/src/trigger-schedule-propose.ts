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
  verifyTriggerScheduleProposalTokenDetailed,
  type ProposalSchedule,
} from "@/lib/trigger-schedule-proposal-token";
import { readAgentTemplateById, readAgentTemplateByPackageName } from "./store";
// THE SAME NARROW ALIAS `agent_run` applies to a package name, imported rather
// than re-implemented so a proposal and a run resolve one name the same way.
import { aliasPackageNameToCanonicalScope } from "./package-name-alias";

// ---------------------------------------------------------------------------
// PROPOSE
// ---------------------------------------------------------------------------

export type ProposeScheduleInput = {
  /**
   * THE AGENT, NAMED THE WAY THE CALLER CAN NAME IT (cinatra#3052).
   *
   * EXACTLY ONE of these is required, and the XOR is the point rather than a
   * convenience: accepting both silently risks proposing a schedule for the
   * wrong agent when the two disagree — the same rule, for the same reason,
   * `agent_run` applies to its own pair.
   *
   * `packageName` exists because a template ID is not a handle every caller
   * HAS. Inside a third-party application the assistant's closed toolbox holds
   * no primitive that yields one — the one start it holds takes a package name
   * and deliberately refuses ids — so a proposal that could only be addressed
   * by ID was a proposal that surface could never make, and the person stating
   * a schedule there read the producer's one fixed refusal instead of seeing
   * their card. Resolution happens HERE, server-side, against the same store
   * the run start resolves against.
   */
  templateId?: string;
  packageName?: string;
  userId: string;
  orgId: string;
  schedule: ProposalSchedule;
};

/**
 * WHY a proposal was not made — for the SERVER's record only.
 *
 * The producer answers ONE fixed sentence to the model whatever happened (see
 * its module header: a refusal that named what was refused would be a durable
 * enumeration oracle in the transcript). That rule is unchanged. What was
 * missing is that the SERVER could not tell those cases apart either, which is
 * why the defect this reason exists for could not be read off a log at all: the
 * caller logs the stage, the reader still reads the one sentence.
 */
export type ProposeRefusalReason =
  | "no_identity"
  /** ADJUST / RE-PROPOSE only: the prior ref did not verify for this reader. */
  | "ref_refused"
  | "no_agent_named"
  | "two_agents_named"
  | "unknown_agent"
  | "cross_org"
  | "past_time"
  | "mint_failed";

export type ProposeScheduleResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: ProposeRefusalReason };

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
 * The shared body of PROPOSE and ADJUST. `lineageNonce` is the only thing that
 * differs between them, and it differs in exactly one direction: supplied, the
 * minted proposal INHERITS an existing consume identity instead of opening a
 * new one. See `adjustTriggerSchedule`.
 */
async function mintProposal(
  input: ProposeScheduleInput,
  lineageNonce?: string,
): Promise<ProposeScheduleResult> {
  if (!input.userId || !input.orgId) return { ok: false, reason: "no_identity" };

  const namedId = typeof input.templateId === "string" && input.templateId.length > 0;
  const namedPackage = typeof input.packageName === "string" && input.packageName.length > 0;
  if (namedId && namedPackage) return { ok: false, reason: "two_agents_named" };
  if (!namedId && !namedPackage) return { ok: false, reason: "no_agent_named" };

  const template = namedId
    ? await readAgentTemplateById(input.templateId as string)
    : await resolveTemplateByPackageName(input.packageName as string);
  if (!template) return { ok: false, reason: "unknown_agent" };
  // The org boundary, before anything confirms the template exists to a caller
  // outside it.
  if (template.orgId && template.orgId !== input.orgId) {
    return { ok: false, reason: "cross_org" };
  }

  // A schedule with a past `runAt` would be refused at Confirm by the trigger
  // service's own future check; refusing it HERE instead means the assistant
  // re-reads the user's intent rather than drawing a card that cannot be
  // pressed.
  if (input.schedule.kind === "scheduled") {
    const ms = naiveDatetimeToUtcMs(input.schedule.runAt, input.schedule.timezone);
    if (Number.isNaN(ms) || ms <= Date.now()) return { ok: false, reason: "past_time" };
  }

  const minted = mintTriggerScheduleProposalToken(
    {
      // THE RESOLVED ID, never the caller's string. Everything downstream — the
      // card, the Confirm transaction, the run — addresses the template by id,
      // so the name is spent here and travels no further.
      templateId: template.id,
      userId: input.userId,
      orgId: input.orgId,
      schedule: input.schedule,
    },
    lineageNonce === undefined ? undefined : { nonce: lineageNonce },
  );
  if (!minted) return { ok: false, reason: "mint_failed" };
  return { ok: true, token: minted.token, expiresAt: minted.expiresAt };
}

/**
 * A PACKAGE NAME to the template it names, with `agent_run`'s own NARROW alias
 * fallback: an operator-vendor-scoped name that matches this instance's
 * namespace retries under the canonical scope. Arbitrary third-party scopes are
 * NOT collapsed, exactly as there — the bridge exists for the publish-time
 * rescope, not to make any scope mean any other.
 *
 * WHAT THIS DOOR CHECKS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It checks exactly what the `templateId` door beside it checks and has always
 * checked: the template exists, and it is not another organization's. It does
 * NOT run the RUN-eligibility gate, and that is this module's design rather
 * than an omission on this path — "whether the reader may DISPATCH is
 * re-resolved at render and again at Confirm; a question the reader turns out
 * not to be allowed to answer is a drawn card with a disabled floor, not a
 * refusal to draw". Running that gate here would also pull the confirm and
 * dispatch graph into the PROPOSE leaf, which is the one thing this file was
 * split out to prevent and which the route-graph ratchet measures.
 *
 * SO THE DELTA A NAME ADDS is that the argument is guessable where a uuid is
 * not: a caller can learn whether a package it can already name is installed in
 * its OWN organization. That signal is not new to this surface — the widget's
 * one start primitive takes the same canonical package name and relays the
 * platform's own answer — and it stops at the org boundary above, which is why
 * a foreign organization's package answers the same fixed sentence an
 * uninstalled one does. Both are asserted against a real store.
 */
async function resolveTemplateByPackageName(packageName: string) {
  const direct = await readAgentTemplateByPackageName(packageName);
  if (direct) return direct;
  const alias = aliasPackageNameToCanonicalScope(packageName);
  if (!alias || alias === packageName) return null;
  return readAgentTemplateByPackageName(alias);
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
  if (!prior) return { ok: false, reason: "ref_refused" };

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
 * RE-PROPOSE FROM AN EXPIRED CARD — the Confirm press on the expired face
 * (cinatra#2836; plan (A) §7.2 step 2, "an expired card **stays visible**,
 * still editable, with **Confirm** to set the schedule again").
 *
 * The expired token is unspendable, so that press cannot be a bare Confirm.
 * It re-proposes first and confirms the replacement — the SAME composite an
 * EDITED live proposal already performs, which is why the reader sees one
 * control doing one thing and no new endpoint appears on the wire.
 *
 * WHY NOT SIMPLY WIDEN `adjustTriggerSchedule`. That function is the LIVE
 * card's path and is reached by callers for whom an expired token must stay a
 * refusal; widening it would have made "adjust" silently start accepting a
 * proposal whose window closed on every one of them. Two named paths, each
 * refusing exactly what it should, is the difference between a decision and an
 * accident.
 *
 * IT IS NOT A WEAKER DOOR. `verifyTriggerScheduleProposalTokenDetailed` reports
 * `expired` only for a token that decrypted under this server's key, carried an
 * unstretched lifetime, and was minted for EXACTLY this reader in EXACTLY this
 * org — every other input, an expired-but-foreign one included, is the same
 * flat `refused` this function turns into the same `{ ok: false }`. So the
 * authority required here is identical to Adjust's; only the freshness demanded
 * of the token differs.
 *
 * THE LINEAGE RULE IS UNTOUCHED (cinatra#2859). The replacement inherits the
 * expired proposal's nonce, exactly as Adjust's does, so the expired card and
 * its re-proposal remain ONE row in the consume table and at most one member of
 * the family can ever become a run. There is no new double-arm surface: the
 * member being replaced here could not be spent in the first place.
 *
 * A STILL-LIVE TOKEN IS ACCEPTED TOO, deliberately. The caller routes on a
 * resolve taken a moment earlier, and refusing a token that has not yet expired
 * would turn that harmless staleness into a spurious refusal. It widens
 * nothing: re-proposing from a live token is precisely what
 * `adjustTriggerSchedule` already permits the same reader to do.
 */
export async function reproposeExpiredSchedule(
  input: AdjustScheduleInput,
): Promise<ProposeScheduleResult> {
  const verified = verifyTriggerScheduleProposalTokenDetailed({
    token: input.priorToken,
    expectedUserId: input.userId,
    expectedOrgId: input.orgId,
  });
  // One answer for a forged ref and a foreign one — expired or not.
  if (verified.outcome === "refused") return { ok: false, reason: "ref_refused" };
  const prior = verified.proposal;

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

