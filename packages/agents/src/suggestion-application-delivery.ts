import "server-only";

// ---------------------------------------------------------------------------
// suggestion-application-delivery (cinatra#2571, epic #2564 S6b).
//
// The DRAIN half of the application-intent outbox: claim a leased batch, resolve
// each intent's accepted suggestions against the gate's hash-verified snapshot,
// hand the still-unapplied ones to the registered APPLIER, and stamp what landed.
// The mirror image of `artifact-review-resume-delivery`, and deliberately so —
// same lease discipline, same at-least-once posture, same "one broken row never
// poisons the queue" tally.
//
// THE APPLIER IS A SEAM, AND TODAY NOTHING BINDS IT. Applying a patch to a pinned
// artifact revision means minting a new representation revision through the
// objects kernel — an authorization surface, a provenance surface and a claims
// surface that belong to the slice that owns them, not to the decision slice.
// S6b's job is that the reviewer's accepted set is DURABLE, ATOMIC WITH THE
// DECISION, and applied EXACTLY ONCE when it is applied. So this module ships the
// registry and the whole drain, and no production registration.
//
// THAT GAP IS LOUD, NOT SILENT — which is the difference between a seam and the
// defect it would otherwise be. With no applier bound the sweep claims NOTHING
// (an unclaimed row burns no attempts and can never churn its way to
// dead-letter), and every waiting intent is listed on the lifecycle-operations
// ops console next to the dead-lettered ones. An operator can see, at any moment,
// exactly which accepted suggestions are waiting and how long they have waited.
// The alternative — draining into a no-op and marking rows done — would report
// applied work that never happened.
//
// THE APPLIER CONTRACT.
//   • It is called with the intent's still-unapplied accepted suggestions,
//     resolved from the IMMUTABLE snapshot (never from the outbox row's bytes),
//     in snapshot order.
//   • It MUST be idempotent per (snapshot, suggestion): the stamp is taken after
//     the effect, so a worker that applies and then crashes — or that loses its
//     lease mid-call — will re-apply on the next lease. This is the same
//     at-least-once contract the resume consumer carries; what the fenced stamp
//     guarantees is that the RECORD is written once, by the owner.
//   • It returns which ids actually landed. Only those are stamped. Reporting an
//     id it did not apply would put a false `applied_at` in the decision record.
// ---------------------------------------------------------------------------

import type { ProducedSuggestion } from "@/lib/lifecycle/lifecycle-suggestion-producer";

import {
  claimPendingApplicationIntents,
  deadLetterApplicationIntent,
  deadLetterExhaustedApplicationIntents,
  markApplicationIntentDone,
  markSuggestionApplied,
  readUnappliedAcceptedSuggestions,
  resolveAcceptedSuggestions,
  type ApplicationIntentRow,
} from "./suggestion-decision-store";

/** What the drain hands an applier. */
export interface SuggestionApplicationRequest {
  gateId: string;
  runId: string;
  reviewTaskId: string;
  snapshotId: string;
  /** The still-unapplied accepted suggestions, read from the verified snapshot. */
  suggestions: ProducedSuggestion[];
}

export type SuggestionApplicationOutcome =
  /** The effect landed for `appliedIds` (a subset is allowed; the rest stay
   *  unapplied and are retried on a later lease). */
  | { status: "applied"; appliedIds: string[] }
  /** Nothing landed and the cause is transient — the intent keeps its budget and
   *  is re-claimed when the lease lapses. */
  | { status: "retryable"; reason: string }
  /** Nothing landed and nothing will: the intent is closed and the reason kept.
   *  For a decision that can no longer be applied at all (e.g. the pinned
   *  revision is gone), NOT for a transient fault. */
  | { status: "refused"; reason: string };

export type SuggestionApplier = (
  request: SuggestionApplicationRequest,
) => Promise<SuggestionApplicationOutcome>;

let registeredApplier: SuggestionApplier | null = null;

/**
 * Register the process-wide applier. Deliberately last-write-wins and
 * un-namespaced: there is exactly ONE way to apply an accepted suggestion, the
 * same way there is exactly one way to decide a review. A second applier would be
 * a second application path, with the same class of problem #2047 row 8 names for
 * decisions.
 */
export function registerSuggestionApplier(applier: SuggestionApplier): void {
  registeredApplier = applier;
}

/** Test/teardown seam — drops the registration. */
export function clearSuggestionApplier(): void {
  registeredApplier = null;
}

export function isSuggestionApplierRegistered(): boolean {
  return registeredApplier !== null;
}

export interface SuggestionApplicationSummary {
  /** False ⇒ nothing was claimed at all (see the module header). */
  applierBound: boolean;
  attempted: number;
  /** Intents closed with every accepted suggestion applied. */
  completed: number;
  /** Intents that had nothing left to apply — a replay, and a no-op. */
  alreadyApplied: number;
  /** Suggestion rows stamped `applied_at` by THIS pass. */
  applied: number;
  /** Intents left for a later lease (transient, or a partial application). */
  retryable: number;
  /** Intents DEAD-LETTERED without applying, because the applier refused
   *  terminally. They stay in the ops queue — a refusal is a stuck decision. */
  refused: number;
  /** Intents whose pass threw — left for re-claim (and dead-lettered here if the
   *  throw consumed their last attempt; they are then counted in BOTH `failed`
   *  and `deadLettered`, which is the honest reading: the pass failed AND the
   *  intent is finished). */
  failed: number;
  /** Intents dead-lettered this pass for EXHAUSTED ATTEMPTS. A terminal refusal
   *  is also dead-lettered, but is counted under `refused`. */
  deadLettered: number;
}

/**
 * Apply ONE leased intent. Returns what happened; THROWS only on an unexpected
 * fault (the caller tallies it and leaves the intent for lease re-claim).
 */
export type ApplyIntentOutcome =
  | "completed"
  | "already-applied"
  | "retryable"
  /** The applier refused terminally — dead-lettered with its reason. */
  | "refused"
  /** The pass consumed the LAST attempt without finishing — dead-lettered here,
   *  under this pass's own live lease. Counted as a dead-letter, not a refusal. */
  | "exhausted"
  | "lease-lost";

export async function applySuggestionIntent(
  intent: ApplicationIntentRow,
  applier: SuggestionApplier,
): Promise<{ outcome: ApplyIntentOutcome; applied: number }> {
  const { gateId, leaseToken } = intent;
  if (!leaseToken) return { outcome: "retryable", applied: 0 };

  // What is LEFT to do. A replay finds this empty and closes without calling the
  // applier at all — the property AC-3 asks for.
  const unapplied = new Set(await readUnappliedAcceptedSuggestions(intent.snapshotId));
  if (unapplied.size === 0) {
    const ok = await markApplicationIntentDone(gateId, leaseToken);
    return { outcome: ok ? "already-applied" : "lease-lost", applied: 0 };
  }

  // Resolve WHAT those ids mean from the immutable snapshot — never from the
  // outbox row. An id the snapshot does not carry, and a snapshot whose bytes no
  // longer verify, both resolve to nothing.
  const all = await resolveAcceptedSuggestions(intent);
  const suggestions = all.filter((s) => unapplied.has(s.id));
  if (suggestions.length === 0) {
    // The ledger says work is outstanding but the snapshot can no longer say what
    // it is (a tampered or re-bound row). Nothing can be applied, ever, so the
    // intent burns its attempts and dead-letters into the ops queue rather than
    // being closed as if it had succeeded — including on the LAST attempt, which
    // is why this goes through the same exhaustion check as every other
    // unsuccessful exit (Codex round 3).
    return closeIfExhausted(
      intent,
      leaseToken,
      0,
      "the gate's snapshot no longer resolves the accepted suggestions",
    );
  }

  const outcome = await applier({
    gateId,
    runId: intent.runId,
    reviewTaskId: intent.reviewTaskId,
    snapshotId: intent.snapshotId,
    suggestions,
  });

  if (outcome.status === "retryable") {
    return closeIfExhausted(intent, leaseToken, 0, outcome.reason);
  }
  if (outcome.status === "refused") {
    // DEAD-LETTERED, not `done` (Codex round 1, finding 3). A refusal means the
    // reviewer's accepted suggestions will never be applied; closing the intent
    // as done would remove it from every ops read while its ledger rows sit
    // unapplied forever, and the console would then report that everything had
    // been applied. A refusal is a stuck decision, and stuck decisions are what
    // this queue exists to show.
    const ok = await deadLetterApplicationIntent(
      gateId,
      leaseToken,
      `applier refused: ${outcome.reason}`,
    );
    console.warn(
      `[suggestion-application] gate=${gateId} refused by the applier (${outcome.reason}) — ${ok ? "DEAD-LETTERED" : "LEASE-LOST"}`,
    );
    return { outcome: ok ? "refused" : "lease-lost", applied: 0 };
  }

  // Stamp ONLY what the applier said landed, and only ids it was actually given —
  // an applier cannot stamp a suggestion this pass never handed it.
  const offered = new Set(suggestions.map((s) => s.id));
  let applied = 0;
  let leaseLost = false;
  for (const id of outcome.appliedIds) {
    if (!offered.has(id)) continue;
    const stamp = await markSuggestionApplied({
      gateId,
      snapshotId: intent.snapshotId,
      suggestionId: id,
      leaseToken,
    });
    if (stamp.status === "claimed") applied += 1;
    // The lease lapsed mid-pass and another worker owns the intent now. Stop
    // stamping: those items belong to whoever holds the lease, and this pass
    // reports the loss instead of writing a record it no longer owns.
    if (stamp.status === "lease-lost") {
      leaseLost = true;
      break;
    }
  }
  if (leaseLost) {
    console.warn(
      `[suggestion-application] gate=${gateId} lost its lease mid-pass — ${applied} stamp(s) landed before the loss; the new owner re-runs the rest`,
    );
    return { outcome: "lease-lost", applied };
  }

  const left = await readUnappliedAcceptedSuggestions(intent.snapshotId);
  if (left.length > 0) {
    // A partial application: the rest stay unapplied and ride the next lease —
    // unless this WAS the last attempt, in which case the intent is finished and
    // belongs in the ops queue now rather than after its lease lapses.
    return closeIfExhausted(
      intent,
      leaseToken,
      applied,
      `${left.length} accepted suggestion(s) still unapplied`,
    );
  }
  const ok = await markApplicationIntentDone(gateId, leaseToken);
  return { outcome: ok ? "completed" : "lease-lost", applied };
}

/**
 * A pass that did not finish the intent: if it also consumed the LAST attempt,
 * dead-letter it here, under the lease this pass still holds (Codex round 2,
 * non-blocking 1).
 *
 * Leaving it to the sweep's dead-letter pass would not work on this tick: that
 * pass deliberately skips a row whose lease is still live, and this row's lease
 * is. Without this the exhausted intent only reaches the ops queue after its lease
 * lapses and a later sweep runs — true eventually, but not what the summary said.
 */
async function closeIfExhausted(
  intent: ApplicationIntentRow,
  leaseToken: string,
  applied: number,
  reason: string,
): Promise<{ outcome: ApplyIntentOutcome; applied: number }> {
  // `intent.attempts` is the POST-increment value the claim returned, so this is
  // "did THIS pass consume the last attempt", not a stale read.
  if (intent.attempts < intent.maxAttempts) return { outcome: "retryable", applied };
  const dead = await deadLetterApplicationIntent(
    intent.gateId,
    leaseToken,
    `attempts exhausted (${intent.attempts}/${intent.maxAttempts}): ${reason}`,
  );
  if (!dead) return { outcome: "lease-lost", applied };
  console.warn(
    `[suggestion-application] gate=${intent.gateId} exhausted its attempts — DEAD-LETTERED (${reason})`,
  );
  return { outcome: "exhausted", applied };
}

/**
 * Drain a batch of application intents. Per-intent failures are TALLIED (never
 * rethrown) so one broken row can never poison the queue — the row stays claimed
 * until its lease lapses, then is re-claimed.
 *
 * With NO applier registered this claims nothing and returns immediately: an
 * unclaimed row burns no attempt, so a waiting intent cannot churn its way to
 * dead-letter while the seam is unbound.
 */
export async function sweepSuggestionApplicationIntents(opts?: {
  limit?: number;
  leaseMs?: number;
  applier?: SuggestionApplier;
}): Promise<SuggestionApplicationSummary> {
  const summary: SuggestionApplicationSummary = {
    applierBound: false,
    attempted: 0,
    completed: 0,
    alreadyApplied: 0,
    applied: 0,
    retryable: 0,
    refused: 0,
    failed: 0,
    deadLettered: 0,
  };
  const applier = opts?.applier ?? registeredApplier;
  if (!applier) return summary;
  summary.applierBound = true;

  // The lease must comfortably exceed the time to process the whole claimed batch
  // so it cannot expire mid-pass and let a second worker apply concurrently —
  // the same sizing argument the resume sweep makes, and the same small batch.
  const DEFAULT_LEASE_MS = 5 * 60_000;
  const DEFAULT_LIMIT = 5;
  // Dead-letter BEFORE claiming (Codex round 1, finding 2): an intent that has
  // used its last attempt must leave the queue on the tick it becomes eligible,
  // not linger behind a fresh lease. The claim predicate also refuses exhausted
  // rows, so the two together make "attempts exhausted" terminal rather than a
  // number that keeps climbing.
  summary.deadLettered = await deadLetterExhaustedApplicationIntents({
    lastError: "suggestion application attempts exhausted",
  });
  const claimed = await claimPendingApplicationIntents({
    limit: opts?.limit ?? DEFAULT_LIMIT,
    leaseMs: opts?.leaseMs ?? DEFAULT_LEASE_MS,
  });
  for (const intent of claimed) {
    summary.attempted += 1;
    try {
      const result = await applySuggestionIntent(intent, applier);
      summary.applied += result.applied;
      if (result.outcome === "completed") summary.completed += 1;
      else if (result.outcome === "already-applied") summary.alreadyApplied += 1;
      else if (result.outcome === "refused") summary.refused += 1;
      // An exhausted pass IS a dead-letter, and is counted as one (Codex round 3):
      // `refused` means the applier said no, `deadLettered` means the budget ran
      // out, and the summary must not blur the two.
      else if (result.outcome === "exhausted") summary.deadLettered += 1;
      else summary.retryable += 1; // "retryable" | "lease-lost"
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[suggestion-application] pass failed for gate=${intent.gateId} — left for re-claim:`,
        err,
      );
      // A THROWN pass is still a consumed attempt (Codex round 3). If it was the
      // last one, dead-letter it here under the lease this pass still holds —
      // otherwise the post-pass backstop skips it (live lease) and the intent
      // only surfaces after its lease lapses.
      if (intent.leaseToken && intent.attempts >= intent.maxAttempts) {
        const closed = await deadLetterApplicationIntent(
          intent.gateId,
          intent.leaseToken,
          `attempts exhausted (${intent.attempts}/${intent.maxAttempts}): the application pass threw`,
        ).catch(() => false);
        if (closed) summary.deadLettered += 1;
      }
    }
  }

  // ...and again after the pass. This second call is a BACKSTOP for rows nobody
  // leased (a pending row that reached the ceiling some other way); an intent that
  // exhausted its budget inside this pass was already dead-lettered under its own
  // live lease by `closeIfExhausted`, because this sweep deliberately skips a row
  // whose lease is still live.
  summary.deadLettered += await deadLetterExhaustedApplicationIntents({
    lastError: "suggestion application attempts exhausted",
  });
  return summary;
}
