import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPooledDb } from "@/lib/db/pooled";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { loadRunDerivationContext } from "./run-artifact-materializer";
import {
  pickUpDefaultRoadItems,
  type DefaultRoadItem,
  type DefaultRoadItemOutcome,
  type DefaultRoadPickupDeps,
} from "./default-road-pickup";

// ---------------------------------------------------------------------------
// The post-terminal pickup of the DEFAULT ROAD (cinatra#3029, epic #3023 W5;
// Agents Lifecycle (C) item 0.17).
//
// WHAT THIS MODULE USED TO BE, AND WHY IT IS NOT THAT ANY MORE.
// It was the produces-scoped derivation of the run's final RESPONSE TEXT: the
// terminal transition captured the last agent message, this job typed it
// against the agent's validated `produces`, and when nothing matched it raised
// a notification saying the output had not been kept, and dropped the work.
// Item 0.17 retires all three of those: response text is not an output, a
// produces declaration is a RUNG of a per-output ladder rather than the whole
// decision, and nothing an agent makes is dropped with a notice.
//
// WHAT IT IS NOW. The drain of the item FAMILY the terminal transition captures:
// every end-node output at or above the one-kilobyte document floor that no
// binding named. Per item it runs the detection ladder (item 0.18), resolves the
// per-output ladder's remaining rungs (the agent's declared kind, the form's
// base, the binary base), and writes through the ONE artifact write path with
// one ledger row per item — carrying the rung that decided and the verdict it
// decided on.
//
// WHAT IS UNCHANGED. The durable outbox and its RECOVERABLE ROW LEASE, verbatim:
// a driver atomically claims the row (`pending`/expired-`deriving` → `deriving`
// + token + attempts++), every terminal write is guarded by that token, a losing
// driver's claim matches zero rows and it exits, the sweep reclaims expired
// leases, and an exhausted row stays VISIBLE at its last non-terminal status
// rather than being forced to a wrong terminal outcome.
//
// THE WRITE FENCE, RE-ARGUED. The retired core carried the outbox `done`-settle
// INTO the artifact write's Tx2 so a stale driver's artifact rolled back with
// its settle. With a FAMILY that fence cannot ride one transaction, and it does
// not need to: the materialization ledger's own 4-part identity
// (run, output_id, extension, content_hash) plus its single-winner finalize
// guard already make TWO drivers converge on ONE artifact per item — the loser's
// Tx2 aborts and it recovers the winner's refs. The outbox settle stays
// token-guarded, so exactly one driver records the outcome. No twin artifact is
// reachable; only the settle's atomicity with the write is given up, and a
// settle that does not land leaves the row re-drivable, which is the safe side.
//
// SCOPE. The END-NODE OUTPUT half only. "once per emitted file" is #3030's (W6).
// ---------------------------------------------------------------------------

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const SWEEP_BATCH = 50;

/** A terminal derivation outcome, plus the two non-terminal dispositions the
 *  driver returns when it did NOT settle the row (another holder / nothing to
 *  do). `no_produces` is RETIRED as a reachable outcome by item 0.17 — an agent
 *  that declares nothing now takes the form's base instead of being advised —
 *  and stays in the union only because rows settled by the old core still
 *  carry it. */
export type UnboundDerivationOutcome =
  | "done"
  | "no_match"
  | "no_produces"
  | "skipped";

export type UnboundDerivationDeps = DefaultRoadPickupDeps & {
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
  /** The run agent's declared `produces` — a REGISTRY MANIFEST read, not the
   *  pickup's seam. Injectable so a suite can state an agent's declaration
   *  without a live registry; production reads it from the installed package. */
  loadContext?: typeof loadRunDerivationContext;
};

/** Transient failure escaping the derivation so BullMQ (or the next sweep)
 *  re-drives — the lease is released before it is thrown. */
export class UnboundDerivationRetryableError extends Error {
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "UnboundDerivationRetryableError";
  }
}

function pool(): Pool {
  return getPooledDb({
    name: "unbound-output-derivation",
    connectionString: () => getPostgresConnectionString(),
  });
}

function schema(): string {
  return postgresSchema.replaceAll('"', '""');
}

type LeasedOutboxRow = {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  createdBy: string | null;
  /** RETIRED (item 0.17): the response-text snapshot. Present ONLY on a row
   *  captured before this slice; `null` on every row captured after it. */
  content: string | null;
  /** The default road's item family (item 0.17), or null on a legacy row. */
  items: DefaultRoadItem[] | null;
  attempts: number;
};

type DerivationVerdict =
  | {
      status: "done" | "no_match";
      detail: Record<string, unknown> | null;
    }
  | { retryable: true; error: string };

// ---------------------------------------------------------------------------
// Outbox lease store (real-store seam — no stubs). UNCHANGED from the retired
// core except for the two columns the capture now writes.
// ---------------------------------------------------------------------------

/**
 * Atomically CLAIM the outbox row: `pending` (unclaimed) OR `deriving` with an
 * EXPIRED lease, and under the attempts cap, becomes `deriving` with a fresh
 * token + `attempts++`. Returns the row's pickup inputs on a win, else null
 * (missing / already-terminal / lease held by another driver / exhausted).
 */
async function claimOutboxLease(input: {
  runId: string;
  orgId: string;
  leaseToken: string;
  now: Date;
  leaseMs: number;
  maxAttempts: number;
}): Promise<LeasedOutboxRow | null> {
  ensurePostgresSchema();
  const s = schema();
  const expiry = new Date(input.now.getTime() + input.leaseMs);
  const res = await pool().query(
    `UPDATE "${s}"."agent_run_output_derivations"
        SET status = 'deriving', lease_token = $3, lease_expires_at = $4,
            attempts = attempts + 1, updated_at = $5
      WHERE run_id = $1 AND org_id = $2
        AND (status = 'pending' OR (status = 'deriving' AND lease_expires_at < $5))
        AND attempts < $6
    RETURNING run_id, org_id, template_id, package_version, created_by,
              content, items, attempts`,
    [
      input.runId,
      input.orgId,
      input.leaseToken,
      expiry,
      input.now,
      input.maxAttempts,
    ],
  );
  const row = res.rows[0] as
    | {
        run_id: string;
        org_id: string;
        template_id: string;
        package_version: string | null;
        created_by: string | null;
        content: string | null;
        items: unknown;
        attempts: number;
      }
    | undefined;
  if (!row) return null;
  return {
    runId: row.run_id,
    orgId: row.org_id,
    templateId: row.template_id,
    packageVersion: row.package_version,
    createdBy: row.created_by,
    content: row.content,
    items: Array.isArray(row.items) ? (row.items as DefaultRoadItem[]) : null,
    attempts: row.attempts,
  };
}

/** Write the terminal outcome, GUARDED by the held lease token (a driver whose
 *  lease was stolen by an expiry-reclaim writes zero rows and does not clobber
 *  the winner's decision). Clears the lease. */
async function finishOutbox(input: {
  runId: string;
  orgId: string;
  leaseToken: string;
  status: "done" | "no_match";
  detail: Record<string, unknown> | null;
  now: Date;
}): Promise<boolean> {
  const s = schema();
  const res = await pool().query(
    `UPDATE "${s}"."agent_run_output_derivations"
        SET status = $4, detail = $5, lease_token = NULL, lease_expires_at = NULL,
            updated_at = $6
      WHERE run_id = $1 AND org_id = $2 AND lease_token = $3`,
    [
      input.runId,
      input.orgId,
      input.leaseToken,
      input.status,
      input.detail === null ? null : JSON.stringify(input.detail),
      input.now,
    ],
  );
  return (res.rowCount ?? 0) === 1;
}

/** Release the lease back to `pending` (a RETRYABLE mid-drive failure) so the
 *  next sweep re-drives — guarded by the held token. */
async function releaseOutboxLease(input: {
  runId: string;
  orgId: string;
  leaseToken: string;
  now: Date;
}): Promise<void> {
  const s = schema();
  await pool().query(
    `UPDATE "${s}"."agent_run_output_derivations"
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            updated_at = $4
      WHERE run_id = $1 AND org_id = $2 AND lease_token = $3`,
    [input.runId, input.orgId, input.leaseToken, input.now],
  );
}

async function readTemplateName(templateId: string): Promise<string | null> {
  ensurePostgresSchema();
  const s = schema();
  const res = await pool().query(
    `SELECT name FROM "${s}"."agent_templates" WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  const row = res.rows[0] as { name?: string | null } | undefined;
  return typeof row?.name === "string" ? row.name : null;
}

// ---------------------------------------------------------------------------
// The drive over ONE claimed row.
// ---------------------------------------------------------------------------

/** A per-item outcome, reduced to what the outbox row records. */
function summarizeOutcome(outcome: DefaultRoadItemOutcome): Record<string, unknown> {
  return {
    outputId: outcome.outputId,
    outputName: outcome.outputName,
    status: outcome.status,
    rung: outcome.verdict.rung,
    form: outcome.verdict.form,
    reason: outcome.verdict.reason,
    targetRung: outcome.targetRung,
    ...(outcome.verdict.modelAnswer !== undefined
      ? { modelAnswer: outcome.verdict.modelAnswer, confidence: outcome.verdict.confidence }
      : {}),
    ...(outcome.verdict.modelSkipped !== undefined
      ? { modelSkipped: outcome.verdict.modelSkipped }
      : {}),
    ...(outcome.extension ? { extension: outcome.extension } : {}),
    ...(outcome.objectTypeId ? { objectTypeId: outcome.objectTypeId } : {}),
    ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
    ...(outcome.representationRevisionId
      ? { representationRevisionId: outcome.representationRevisionId }
      : {}),
    ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
  };
}

async function driveClaimedRow(
  row: LeasedOutboxRow,
  deps: UnboundDerivationDeps | undefined,
): Promise<DerivationVerdict> {
  // A row captured BEFORE this slice carries the response-text snapshot and no
  // item family. Response text takes no road (§2, §3): settle it without
  // writing anything and without a notice — the advisory retires with it.
  if (row.items === null) {
    return {
      status: "done",
      detail: {
        reason: "response_text_retired",
        note:
          "captured before the default road; response text is not an output and takes no road",
        hadContent: row.content !== null && row.content.length > 0,
      },
    };
  }
  if (row.items.length === 0) {
    return {
      status: "done",
      detail: { reason: "nothing_above_the_floor", items: 0 },
    };
  }

  const ctx = await (deps?.loadContext ?? loadRunDerivationContext)({
    templateId: row.templateId,
    packageVersion: row.packageVersion,
  });
  const templateName = await readTemplateName(row.templateId);

  const outcomes = await pickUpDefaultRoadItems(
    {
      runId: row.runId,
      orgId: row.orgId,
      templateId: row.templateId,
      packageVersion: row.packageVersion,
      createdBy: row.createdBy,
      templateName,
      items: row.items,
      producesRefs: ctx.producesRefs,
      // The FILE half of item 0.22 needs the grammar itself: a binding may name
      // a file of the run folder as its content source, and the folder is only
      // readable here.
      bindings: ctx.bindings,
    },
    deps,
  );

  const written = outcomes.filter((o) => o.status !== "no_target");
  const detail = {
    items: outcomes.length,
    written: written.length,
    outcomes: outcomes.map(summarizeOutcome),
  };
  // "no_match" now means EXACTLY: every item was typed, and no rung of the
  // per-output ladder could claim any of them. It is a recorded verdict, not a
  // dropped output — the reason is on the row, per item.
  return { status: written.length > 0 ? "done" : "no_match", detail };
}

// ---------------------------------------------------------------------------
// Public: drive ONE run's captured item family.
// ---------------------------------------------------------------------------
export async function deriveUnboundRunOutput(
  input: { runId: string; orgId: string },
  deps?: UnboundDerivationDeps,
): Promise<{ outcome: UnboundDerivationOutcome }> {
  const now = deps?.now ?? (() => new Date());
  const leaseMs = deps?.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = deps?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const leaseToken = randomUUID();

  const row = await claimOutboxLease({
    runId: input.runId,
    orgId: input.orgId,
    leaseToken,
    now: now(),
    leaseMs,
    maxAttempts,
  });
  // No claim: the row is missing, already terminal, held by another driver, or
  // exhausted. Nothing to do (idempotent).
  if (!row) return { outcome: "skipped" };

  let verdict: DerivationVerdict;
  try {
    verdict = await driveClaimedRow(row, deps);
  } catch (err) {
    // Unexpected infra failure mid-drive: release the lease so a re-drive
    // retries, then surface as retryable.
    await releaseOutboxLease({
      runId: row.runId,
      orgId: row.orgId,
      leaseToken,
      now: now(),
    }).catch(() => undefined);
    throw new UnboundDerivationRetryableError(
      `default-road pickup failed for run ${row.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if ("retryable" in verdict) {
    await releaseOutboxLease({
      runId: row.runId,
      orgId: row.orgId,
      leaseToken,
      now: now(),
    }).catch(() => undefined);
    throw new UnboundDerivationRetryableError(verdict.error);
  }

  const settled = await finishOutbox({
    runId: row.runId,
    orgId: row.orgId,
    leaseToken,
    status: verdict.status,
    detail: verdict.detail,
    now: now(),
  });
  // ONLY the driver that still holds the lease owns the outcome. A driver whose
  // lease was reclaimed by an expiry-sweep wrote zero rows here; the reclaiming
  // driver settles the row, so a stale driver must report `skipped`, not a
  // terminal outcome it did not persist.
  if (!settled) return { outcome: "skipped" };
  return { outcome: verdict.status };
}

// ---------------------------------------------------------------------------
// Public: reconciliation sweep — the backstop for outbox rows whose one-shot
// enqueue was lost / crashed, and for leases stranded by a crashed driver.
// Converges: a settled row (done/no_match/no_produces) is never re-selected.
// ---------------------------------------------------------------------------
export type UnboundDerivationSweepSummary = {
  attempted: number;
  done: number;
  no_match: number;
  no_produces: number;
  skipped: number;
  failed: number;
};

export async function sweepPendingUnboundDerivations(
  deps?: UnboundDerivationDeps & { batch?: number },
): Promise<UnboundDerivationSweepSummary> {
  ensurePostgresSchema();
  const s = schema();
  const now = deps?.now ?? (() => new Date());
  const maxAttempts = deps?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const batch = deps?.batch ?? SWEEP_BATCH;
  const candidates = await pool().query(
    `SELECT run_id, org_id
       FROM "${s}"."agent_run_output_derivations"
      WHERE (status = 'pending' OR (status = 'deriving' AND lease_expires_at < $1))
        AND attempts < $2
      ORDER BY created_at ASC
      LIMIT $3`,
    [now(), maxAttempts, batch],
  );
  const summary: UnboundDerivationSweepSummary = {
    attempted: 0,
    done: 0,
    no_match: 0,
    no_produces: 0,
    skipped: 0,
    failed: 0,
  };
  for (const c of candidates.rows as Array<{ run_id: string; org_id: string }>) {
    summary.attempted += 1;
    try {
      const { outcome } = await deriveUnboundRunOutput(
        { runId: c.run_id, orgId: c.org_id },
        deps,
      );
      summary[outcome] += 1;
    } catch (err) {
      // A retryable failure (or any throw): count it and continue — one poison
      // row must never abort the sweep. The lease was released; a later sweep
      // retries until the attempts cap.
      summary.failed += 1;
      console.warn(
        `[default-road-sweep] run=${c.run_id} failed (will retry until cap):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return summary;
}
