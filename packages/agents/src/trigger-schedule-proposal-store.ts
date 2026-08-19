import "server-only";

// ---------------------------------------------------------------------------
// The trigger schedule PROPOSAL store (cinatra#2569, epic #2564 S5).
//
// Three durable facts and nothing else:
//
//   1. THE CONSUME EDGE — this proposal has been spent, and here is the run it
//      produced. A PRIMARY KEY on `consume_key`, so "spent twice" is a database
//      error rather than a race the application has to notice.
//   2. THE INSTALL INTENT — this run's schedule still has to be armed and
//      installed. An outbox row drained in a PINNED ORDER.
//   3. THE LINEAGE-LATEST RATCHET — this proposal lineage is already holding a
//      live replacement open, and here it is. A PRIMARY KEY on `consume_key`
//      again, so re-proposing an expired card is IDEMPOTENT WHILE LIVE instead
//      of minting without bound. Unlike the other two it hangs off no run (it
//      exists before one does) — see `claimLineageReproposal`.
//
// WHY BOTH ARE WRITTEN WITH THE RUN, IN ONE TRANSACTION. Confirm has to produce
// three things together: the proposal is spent, the run exists, the schedule is
// going to be installed. Any sequencing of those three has a crash window that
// breaks a promise the card made — a run with no schedule coming, a schedule
// with no run, or a second run from a re-pressed Confirm. They share the run's
// own org-write-guarded transaction (`createAgentRunPendingInput`'s
// `withinCreateTx`), so there is no window at all: either all three committed
// or none did.
//
// RETENTION IS THE RUN'S. Both tables hang off `agent_runs(id)` with ON DELETE
// CASCADE and are keyed one-row-per-run, so neither grows independently of the
// runs a person actually created: deleting a run takes its consume row and its
// install intent with it, and no separate reaper or TTL is needed to keep them
// bounded. (Proven in the integration suite's CASCADE case.) A consume row is
// deliberately kept for the LIFE of its run rather than expired with the
// proposal token: it is the answer to "which run did this proposal create?",
// which the settled card asks on every reload, long after the token's own TTL.
//
// WHY THE INSTALL IS AN INTENT AND NOT AN INSTALL. The BullMQ scheduler is not
// in the database, so it cannot join that transaction. Installing it inline
// would mean either installing before the run is armed — where a release firing
// on a not-armed run hits the `armed → queued` CAS, logs, and skips, losing a
// one-shot fire permanently (the hazard #2523 named and this slice must not
// re-open) — or arming a run whose schedule silently failed to install. The
// intent turns that into a retry: the drain ARMS first, EXPOSES second, and a
// crash anywhere between simply leaves the intent claimable again.
// ---------------------------------------------------------------------------

import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "./db";
import {
  triggerScheduleInstallOutbox,
  triggerScheduleProposalConsumes,
  triggerScheduleProposalLineage,
  type TriggerScheduleInstallOutboxRow,
  type TriggerScheduleProposalLineageRow,
} from "./schema";
import type { GuardedRunTx } from "./org-write-run-seam";

/** The drizzle surface shared by `db` and a guarded transaction. */
type Executor = typeof db | GuardedRunTx;

/** Postgres unique-violation. The consume edge's ONLY expected failure. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === PG_UNIQUE_VIOLATION) return true;
  // Drizzle wraps the driver error on some paths; check one level down.
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return cause?.code === PG_UNIQUE_VIOLATION;
}

/**
 * Thrown by `spendProposalWithinTx` when the consume key is already spent.
 *
 * A typed error rather than a returned verdict, deliberately: it has to unwind
 * the transaction it is raised in — that transaction is creating a RUN, and the
 * whole point is that the loser of a double-Confirm creates nothing. A returned
 * verdict would leave the caller holding a committed run it must then delete.
 */
export class ProposalAlreadyConsumedError extends Error {
  constructor(public readonly consumeKey: string) {
    super("trigger schedule proposal: already consumed");
    this.name = "ProposalAlreadyConsumedError";
  }
}

export type ProposalConsumeRecord = {
  consumeKey: string;
  runId: string;
  orgId: string;
  templateId: string;
  consumedBy: string;
  consumedAt: Date;
};

export type ScheduleInstallIntent = {
  runId: string;
  orgId: string;
  requestedBy: string;
  triggerType: "immediate" | "scheduled" | "recurring";
  scheduledAt: Date | null;
  cronExpression: string | null;
  timezone: string;
};

// ---------------------------------------------------------------------------
// The one-transaction Confirm commit
// ---------------------------------------------------------------------------

/**
 * Spend a proposal and record its schedule-install intent — INSIDE the caller's
 * transaction, which is the run's own creation transaction.
 *
 * Order inside the transaction is load-bearing: the CONSUME insert runs FIRST,
 * so a concurrent second Confirm fails here and unwinds before anything else in
 * the transaction has meaning. The install intent goes second, because it
 * references the run the consume row now owns.
 *
 * THROWS `ProposalAlreadyConsumedError` on a double spend — the caller catches
 * it, re-reads the consume row, and answers with the ORIGINAL run.
 */
export async function spendProposalWithinTx(
  tx: GuardedRunTx,
  input: {
    consumeKey: string;
    runId: string;
    orgId: string;
    templateId: string;
    consumedBy: string;
    install: Omit<ScheduleInstallIntent, "runId" | "orgId" | "requestedBy">;
  },
): Promise<void> {
  const dtx = tx as unknown as typeof db;
  try {
    await dtx.insert(triggerScheduleProposalConsumes).values({
      consumeKey: input.consumeKey,
      runId: input.runId,
      orgId: input.orgId,
      templateId: input.templateId,
      consumedBy: input.consumedBy,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ProposalAlreadyConsumedError(input.consumeKey);
    }
    throw err;
  }

  await dtx.insert(triggerScheduleInstallOutbox).values({
    runId: input.runId,
    orgId: input.orgId,
    requestedBy: input.consumedBy,
    triggerType: input.install.triggerType,
    scheduledAt: input.install.scheduledAt,
    cronExpression: input.install.cronExpression,
    timezone: input.install.timezone,
    status: "pending",
  });
}

/**
 * Read the run a proposal already produced. The idempotent answer to a
 * re-pressed Confirm, a retried request, or the loser of a concurrent race.
 */
export async function readProposalConsume(
  consumeKey: string,
  executor: Executor = db,
): Promise<ProposalConsumeRecord | null> {
  const rows = await (executor as typeof db)
    .select()
    .from(triggerScheduleProposalConsumes)
    .where(eq(triggerScheduleProposalConsumes.consumeKey, consumeKey))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    consumeKey: row.consumeKey,
    runId: row.runId,
    orgId: row.orgId,
    templateId: row.templateId,
    consumedBy: row.consumedBy,
    consumedAt: row.consumedAt,
  };
}

// ---------------------------------------------------------------------------
// The lineage-latest ratchet
// ---------------------------------------------------------------------------

/** The replacement a lineage is currently holding open. */
export type LineageReproposalRecord = {
  consumeKey: string;
  token: string;
  expiresAt: Date;
};

/**
 * WHAT THE CONDITIONAL CLAIM ACTUALLY DID — three outcomes, named, because the
 * caller must treat them differently and a bare record cannot tell them apart.
 *
 *   `claimed`  — the slot is now OURS; `record.token` is the token we passed in
 *                and the lineage row names it.
 *   `yielded`  — a live replacement was already there and still is; `record` is
 *                THEIRS. Our mint is discarded, and their token has not been
 *                read against the reader asking — the caller must do that.
 *   `vanished` — the claim refused (a live row was there) and yet no live row
 *                could be read back: it expired or was deleted between the two
 *                statements. NOTHING is holding the slot and nothing of ours is
 *                installed in it, so there is no token here to hand anybody.
 *
 * The third one used to be collapsed into "answer with the caller's own mint",
 * which is why it now has a name: that mint was never written to the lineage
 * row, so returning it put a live token in a reader's hands that the ratchet
 * was not holding. See `claimLineageReproposal`.
 */
export type LineageClaimResult =
  | { outcome: "claimed"; record: LineageReproposalRecord }
  | { outcome: "yielded"; record: LineageReproposalRecord }
  | { outcome: "vanished" };

function projectLineage(
  row: TriggerScheduleProposalLineageRow,
): LineageReproposalRecord {
  return {
    consumeKey: row.consumeKey,
    token: row.latestToken,
    expiresAt: row.expiresAt,
  };
}

/**
 * Read the replacement this lineage is currently holding open, if any.
 *
 * Answers the row whatever its expiry: whether it is still LIVE is decided by
 * the caller, by re-reading the token against the reader asking — the same
 * authenticated read the ref itself went through, so the ratchet can never hand
 * back a token this reader is not entitled to and can never disagree with the
 * token's own clock.
 */
export async function readLineageReproposal(
  consumeKey: string,
  executor: Executor = db,
): Promise<LineageReproposalRecord | null> {
  const rows = await (executor as typeof db)
    .select()
    .from(triggerScheduleProposalLineage)
    .where(eq(triggerScheduleProposalLineage.consumeKey, consumeKey))
    .limit(1);
  return rows[0] ? projectLineage(rows[0]) : null;
}

/**
 * CLAIM the lineage's live slot for a freshly minted replacement — or YIELD to
 * the one already in it.
 *
 * ONE STATEMENT, because the check and the write have to be the same act. Two
 * Adjusts racing on the same expired ref both read "no live replacement" and
 * both mint; if each then wrote its own token, the lineage would be holding two
 * live tokens at once and the bound this table exists for would be exactly as
 * absent as before. So the upsert carries the condition: it overwrites the row
 * ONLY when the replacement already there has expired (`setWhere`), and returns
 * nothing when it has not. The loser then reads the winner's row and answers
 * with THAT token — its own mint is discarded unreturned, which costs nothing,
 * because minting writes no run and arms nothing.
 *
 * Returns WHICH OF THE THREE OUTCOMES happened rather than a bare record, and
 * that distinction is the fix for codex round-5 finding 2. A record alone
 * cannot say whether the token in it is installed in the lineage row: `claimed`
 * and `yielded` both name a token the row is holding, and the third case names
 * none at all. Collapsing the third into "here is your own mint" handed out a
 * live token the ratchet had never heard of. The caller decides what to do with
 * `vanished` (`reproposeExpiredScheduleProposal` re-claims once, then refuses);
 * this function's job is only to report it truthfully.
 */
export async function claimLineageReproposal(input: {
  consumeKey: string;
  token: string;
  expiresAt: Date;
  orgId: string;
  templateId: string;
  reproposedBy: string;
}): Promise<LineageClaimResult> {
  const claimed = await db
    .insert(triggerScheduleProposalLineage)
    .values({
      consumeKey: input.consumeKey,
      latestToken: input.token,
      expiresAt: input.expiresAt,
      orgId: input.orgId,
      templateId: input.templateId,
      reproposedBy: input.reproposedBy,
    })
    .onConflictDoUpdate({
      target: triggerScheduleProposalLineage.consumeKey,
      set: {
        latestToken: input.token,
        expiresAt: input.expiresAt,
        orgId: input.orgId,
        templateId: input.templateId,
        reproposedBy: input.reproposedBy,
        updatedAt: sql`now()`,
      },
      // THE RATCHET, in SQL. A live replacement is never overwritten, so the
      // window can only roll forward once the last one has genuinely closed.
      setWhere: lte(triggerScheduleProposalLineage.expiresAt, sql`now()`),
    })
    .returning();
  if (claimed[0]) {
    return { outcome: "claimed", record: projectLineage(claimed[0]) };
  }

  // The row was there and still LIVE: somebody else holds the slot. Answer with
  // theirs. The `gt` is belt-and-braces — the same condition the upsert just
  // refused on — so a row that expired in the microseconds between the two
  // statements is not returned as live.
  const held = await db
    .select()
    .from(triggerScheduleProposalLineage)
    .where(
      and(
        eq(triggerScheduleProposalLineage.consumeKey, input.consumeKey),
        gt(triggerScheduleProposalLineage.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (held[0]) return { outcome: "yielded", record: projectLineage(held[0]) };
  // Neither claimed nor held — the row expired into overwritability, or was
  // deleted outright (a retention pass), between the two statements. Nothing is
  // holding the slot AND nothing of ours was written into it, so there is no
  // token here that this function may honestly call the lineage's. Say so; the
  // caller re-claims into the slot it now knows is free.
  return { outcome: "vanished" };
}

// ---------------------------------------------------------------------------
// The install outbox
// ---------------------------------------------------------------------------

export type InstallIntentRow = {
  runId: string;
  orgId: string;
  requestedBy: string;
  triggerType: "immediate" | "scheduled" | "recurring";
  scheduledAt: Date | null;
  cronExpression: string | null;
  timezone: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  armedAt: Date | null;
};

function projectIntent(row: TriggerScheduleInstallOutboxRow): InstallIntentRow {
  return {
    runId: row.runId,
    orgId: row.orgId,
    requestedBy: row.requestedBy,
    triggerType: row.triggerType as InstallIntentRow["triggerType"],
    scheduledAt: row.scheduledAt,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseToken: row.leaseToken,
    armedAt: row.armedAt,
  };
}

/** Read one run's install intent (the card asks "is it still arming?"). */
export async function readInstallIntent(
  runId: string,
  executor: Executor = db,
): Promise<InstallIntentRow | null> {
  const rows = await (executor as typeof db)
    .select()
    .from(triggerScheduleInstallOutbox)
    .where(eq(triggerScheduleInstallOutbox.runId, runId))
    .limit(1);
  return rows[0] ? projectIntent(rows[0]) : null;
}

/**
 * Claim pending (or lease-expired) install intents for a drain pass.
 *
 * `FOR UPDATE SKIP LOCKED` + a lease token, exactly as the review-resume outbox
 * does: two workers never drain the same intent, and a worker that dies mid-
 * install releases its claim when the lease expires. Delivery is AT-LEAST-ONCE,
 * so `installScheduleForIntent` is written to be re-runnable — arming an armed
 * run is a no-op transition and installing an installed schedule is an upsert
 * on the same job id.
 */
export async function claimPendingInstallIntents(opts?: {
  limit?: number;
  leaseMs?: number;
  runId?: string;
}): Promise<InstallIntentRow[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 200));
  const leaseMs = Math.max(1000, opts?.leaseMs ?? 60_000);
  const leaseToken = randomUUID();

  const claimed = await db.transaction(async (tx) => {
    const claimable = or(
      eq(triggerScheduleInstallOutbox.status, "pending"),
      and(
        eq(triggerScheduleInstallOutbox.status, "installing"),
        lte(triggerScheduleInstallOutbox.leaseExpiresAt, sql`now()`),
      ),
    );
    const candidates = await tx
      .select({
        runId: triggerScheduleInstallOutbox.runId,
        attempts: triggerScheduleInstallOutbox.attempts,
        maxAttempts: triggerScheduleInstallOutbox.maxAttempts,
      })
      .from(triggerScheduleInstallOutbox)
      .where(
        opts?.runId
          ? and(eq(triggerScheduleInstallOutbox.runId, opts.runId), claimable)
          : claimable,
      )
      .orderBy(asc(triggerScheduleInstallOutbox.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];

    // THE RETRY BUDGET IS ENFORCED HERE, not only in `releaseInstallIntent`.
    //
    // A worker that DIES mid-install never calls the release path, so its lease
    // simply expires and the intent becomes claimable again. Without this
    // partition a crash-looping worker would re-claim the same intent forever,
    // incrementing `attempts` past its cap and never parking it — an unbounded
    // retry that reads as healthy because the row keeps moving. Exhausted
    // intents are parked `failed` INSIDE the same transaction that would
    // otherwise have claimed them, so they leave the claimable set once and
    // stay visible to ops.
    const exhausted = candidates.filter((c) => c.attempts >= c.maxAttempts);
    if (exhausted.length > 0) {
      await tx
        .update(triggerScheduleInstallOutbox)
        .set({
          status: "failed",
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: sql`coalesce(${triggerScheduleInstallOutbox.lastError}, 'install attempts exhausted without a completed pass')`,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            triggerScheduleInstallOutbox.runId,
            exhausted.map((c) => c.runId),
          ),
        );
    }

    const ids = candidates
      .filter((c) => c.attempts < c.maxAttempts)
      .map((c) => c.runId);
    const rows: TriggerScheduleInstallOutboxRow[] = [];
    for (const id of ids) {
      const updated = await tx
        .update(triggerScheduleInstallOutbox)
        .set({
          status: "installing",
          leaseToken,
          leaseExpiresAt: sql`now() + (${leaseMs} || ' milliseconds')::interval`,
          attempts: sql`${triggerScheduleInstallOutbox.attempts} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(triggerScheduleInstallOutbox.runId, id))
        .returning();
      if (updated[0]) rows.push(updated[0]);
    }
    return rows;
  });

  return claimed.map(projectIntent);
}

/**
 * Stamp the moment the run became ARMED — the instant a scheduled fire can no
 * longer be lost. Written BEFORE the schedule is exposed, so the row itself
 * records that the pinned order held; a `done` intent with a null `armed_at`
 * would be evidence of the exact inversion this design exists to prevent, and
 * the ordering test asserts it never occurs.
 */
export async function markInstallIntentArmed(
  runId: string,
  leaseToken: string,
): Promise<boolean> {
  const rows = await db
    .update(triggerScheduleInstallOutbox)
    .set({ armedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(triggerScheduleInstallOutbox.runId, runId),
        eq(triggerScheduleInstallOutbox.leaseToken, leaseToken),
        isNull(triggerScheduleInstallOutbox.armedAt),
      ),
    )
    .returning({ runId: triggerScheduleInstallOutbox.runId });
  return rows.length === 1;
}

/**
 * Mark an intent installed.
 *
 * THREE guards, and each one closes a different way the ordering could be lost:
 *
 *   - the LEASE — a stale worker whose lease was re-claimed can never mark
 *     another worker's in-flight install done;
 *   - `status = 'installing'` — an intent that is not currently claimed cannot
 *     be closed at all, so a done-marking that arrives out of order finds
 *     nothing to close;
 *   - `armed_at IS NOT NULL` — the ARM-BEFORE-EXPOSE rule, enforced by the
 *     DATABASE rather than by the drain's call order.
 *
 * The third is the load-bearing one. Without it the ordering was a property of
 * one function's statement order: a future caller (or a reordered drain) could
 * close an intent that had never armed its run, and the intent would then stop
 * being claimable — leaving a run that no schedule will ever fire, reported as
 * successfully installed. Now that outcome is not expressible: the update
 * matches no row, `markInstallIntentDone` answers `false`, and the intent stays
 * claimable for a pass that does arm it.
 */
export async function markInstallIntentDone(
  runId: string,
  leaseToken: string,
): Promise<boolean> {
  const rows = await db
    .update(triggerScheduleInstallOutbox)
    .set({
      status: "done",
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(triggerScheduleInstallOutbox.runId, runId),
        eq(triggerScheduleInstallOutbox.leaseToken, leaseToken),
        eq(triggerScheduleInstallOutbox.status, "installing"),
        isNotNull(triggerScheduleInstallOutbox.armedAt),
      ),
    )
    .returning({ runId: triggerScheduleInstallOutbox.runId });
  return rows.length === 1;
}

/**
 * Park an intent `failed` outright — for a TERMINAL refusal, not a fault.
 *
 * The retry budget exists for TRANSIENT trouble (Redis down, a lost lease). An
 * honest refusal from the trigger ladder — "this run has already finished" — is
 * not going to become true on the twentieth attempt, and burning the budget on
 * it only buries the reason under nineteen identical failures. Lease-guarded
 * like every other transition, so a stale worker cannot park a live install.
 */
export async function parkInstallIntent(
  runId: string,
  leaseToken: string,
  reason: string,
): Promise<boolean> {
  const rows = await db
    .update(triggerScheduleInstallOutbox)
    .set({
      status: "failed",
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: reason.slice(0, 500),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(triggerScheduleInstallOutbox.runId, runId),
        eq(triggerScheduleInstallOutbox.leaseToken, leaseToken),
      ),
    )
    .returning({ runId: triggerScheduleInstallOutbox.runId });
  return rows.length === 1;
}

/**
 * Release a failed install back to `pending` (retryable) or park it `failed`
 * once its attempts are exhausted.
 *
 * A parked intent is NOT a lost run: the run is either still `pending_input`
 * (never armed — nothing fires, nothing is lost) or `armed` with no schedule
 * installed, which the run's own Trigger tab can re-arm. Ops sees the row and
 * `last_error`. What it is never allowed to be is silently green.
 */
export async function releaseInstallIntent(
  runId: string,
  leaseToken: string,
  error: string,
): Promise<"retry" | "failed" | "not-owned"> {
  const rows = await db
    .update(triggerScheduleInstallOutbox)
    .set({
      status: sql`CASE WHEN ${triggerScheduleInstallOutbox.attempts} >= ${triggerScheduleInstallOutbox.maxAttempts} THEN 'failed' ELSE 'pending' END`,
      leaseToken: null,
      leaseExpiresAt: null,
      // Bounded: an error string is operator-facing, never unbounded storage.
      lastError: error.slice(0, 500),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(triggerScheduleInstallOutbox.runId, runId),
        eq(triggerScheduleInstallOutbox.leaseToken, leaseToken),
      ),
    )
    .returning({ status: triggerScheduleInstallOutbox.status });
  if (rows.length !== 1) return "not-owned";
  return rows[0].status === "failed" ? "failed" : "retry";
}
