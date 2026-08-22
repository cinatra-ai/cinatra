import "server-only";

// ---------------------------------------------------------------------------
// The SETTLED OUTCOME, attached to an already-authorized card state
// (cinatra#2855; plan §4.2 "the settled card names the outcome and the decider
// itself, and the Refresh button disappears with the ambiguity that required
// it").
//
// A settled review card used to know one thing: that it was settled. So every
// settled card in every channel read the same generic sentence — "the gate was
// already decided OR the run moved on" — and carried a Refresh, which was the
// only way for a reader to find out which. This module reads the answer the
// card was refreshing for.
//
// WHY THIS IS A LEAF AND NOT A BRANCH IN `lifecycle-card-refetch`. Exactly the
// reason `lifecycle-suggestion-chips` gives, and it applies here unchanged: the
// resolver is reachable from `lifecycle-pull-mcp`, which the app's auth plugins
// mount, which puts it on the module graph of all five ROUTE-LOCKED routes
// (`scripts/audit/route-graph-ratchet`). The pull uses the resolver purely as
// the AUTHORIZATION LADDER — it reads `state === "absent"` and discards the rest
// — so projecting a decider from there would drag the auth-side user table onto
// five locked budgets for a projection that path never draws. It is also the
// stronger posture rather than merely the cheaper one: nothing about who decided
// a gate can reach a tool result, because the code that reads it is not on that
// path at all.
//
// THE STATE IS THE AUTHORIZATION, AND IT IS AN ARGUMENT. This module runs no
// access check of its own and must never be asked to. It takes the state
// `resolveLifecycleCardState` already answered for THIS reader and THIS ref, and
// only `settled` — which that ladder returns after run READ has passed and the
// gate has been found resolved — unlocks a read. Every denial has already
// collapsed into `absent`, and `absent` carries no outcome, so a reader who may
// not read the run, a gate that does not exist and a ref that does not decode
// all arrive here as a state that cannot carry one and leave unchanged.
//
// WHAT THIS DISCLOSES, STATED PLAINLY. To a reader who may READ the run: which
// of the three recorded outcomes closed its gate, and the decider's display
// name. The outcome is the plan's target for this card. The decider's NAME is a
// genuine widening — no shipped surface printed it before — and it is the point
// of the slice: a settled review that cannot say who decided it is exactly the
// card the plan is replacing. What is NOT widened is the audience: it is the
// same run READ that already shows this reader the gate, its target and its
// recorded suggestion partition.
//
// NEVER AN IDENTIFIER. The decider travels as a display name and nothing else.
// The user id that resolved the gate never leaves this module, and neither does
// the email address — an address is a way to reach a person, not a way to name
// one, and a card is not a directory. A decider with no safely displayable name
// yields NO name at all: the card then states the outcome alone, which is true,
// where "Approved by 4f3a…" would be a leak wearing a label.
//
// A FAILURE COSTS THE READING, NEVER THE CARD. Everywhere else on this path a
// failure collapses to `absent`, because everywhere else the question is
// authorization or existence. Here it is neither: a gate row that vanished
// between the two reads, a disposition outside the closed set and a store that
// threw all mean "this build cannot name the outcome". Each returns the state
// untouched, and the card draws the generic reading with its Refresh — which is
// precisely the reading that shipped, so the degrade is to today's card rather
// than to a broken one.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";

import {
  LIFECYCLE_DECIDER_NAME_MAX_LENGTH,
  type LifecycleCardState,
  type LifecycleDataPartViewType,
  type LifecycleSettledOutcome,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { readReviewGate } from "@cinatra-ai/agents/artifact-review-gate-store";

import { betterAuthDb, betterAuthUsers } from "@/lib/better-auth-db";
import { decodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";

/**
 * The persisted disposition → the wire outcome. CLOSED, and closed on the
 * STORE's side of the seam: these are the three values a gate row can be
 * RESOLVED with — `approve` / `reject` from the decision core's terminal CAS,
 * `changes_requested` from the prompt-window path that closes the base gate and
 * opens a repair. A `comment` never resolves a gate, so it is absent by
 * construction rather than by omission.
 *
 * Anything else — a row written by a build this one does not know, a corrupted
 * column, a future disposition — is NOT mapped, and an unmapped disposition
 * attaches no outcome. The card then says what it has always said instead of
 * naming an outcome nobody here understands.
 */
const OUTCOME_BY_DISPOSITION: Readonly<Record<string, LifecycleSettledOutcome>> = {
  approve: "approved",
  reject: "rejected",
  changes_requested: "changes_requested",
};

/**
 * Control characters, bidi overrides and zero-width marks — stripped before a
 * stored name is printed, so a row cannot smuggle line breaks or a reversed
 * run of text into a card.
 */
const UNPRINTABLE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Reduce one stored user row to something safe to print beside an outcome.
 *
 * THE ORDER IS THE SANITIZATION. `name` is what the person chose to be called;
 * `username` is the handle they chose to be known by. Both are display values.
 * `email` and `id` are NOT in the ladder and never will be: they address a
 * person rather than name one.
 *
 * The clamp is applied LAST, after the strip and the whitespace collapse, so
 * the value the schema receives is exactly the value the card draws.
 */
function displayableName(candidates: ReadonlyArray<string | null>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const cleaned = candidate.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length === 0) continue;
    return cleaned.slice(0, LIFECYCLE_DECIDER_NAME_MAX_LENGTH);
  }
  return undefined;
}

/** The decider's display name, or `undefined` when there is none to show. */
async function readDeciderName(userId: string | null): Promise<string | undefined> {
  if (!userId) return undefined;
  const rows = await betterAuthDb
    // ONLY the two display columns are selected. The id is already in hand and
    // the address is deliberately not asked for: a column that is never read
    // cannot be printed by a later edit reaching for "whatever we have".
    .select({ name: betterAuthUsers.name, username: betterAuthUsers.username })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return displayableName([row.name, row.username]);
}

/**
 * Attach the recorded outcome (and its decider, where one can be named) to a
 * review card state the ladder has already authorized.
 *
 * Returns the state UNCHANGED for every kind and every state that cannot carry
 * one — which is all of them but `settled` on `artifact_review_gate`.
 */
export async function attachLifecycleSettledOutcome(
  state: LifecycleCardState,
  viewType: LifecycleDataPartViewType,
  ref: string,
): Promise<LifecycleCardState> {
  if (viewType !== "artifact_review_gate") return state;
  if (state.state !== "settled") return state;
  try {
    const payload = decodeLifecycleGateRef(ref);
    if (!payload) return state;
    const gate = await readReviewGate(payload.runId, payload.reviewTaskId);
    // The gate is re-read rather than carried down from the ladder, and the
    // re-read is re-checked: a row that vanished or reverted between the two
    // reads is a row this attachment has nothing to say about.
    if (!gate || gate.status !== "resolved") return state;
    const outcome = gate.disposition
      ? OUTCOME_BY_DISPOSITION[gate.disposition]
      : undefined;
    if (!outcome) return state;
    const decidedByName = await readDeciderName(gate.resolvedBy);
    return decidedByName ? { ...state, outcome, decidedByName } : { ...state, outcome };
  } catch {
    return state;
  }
}
