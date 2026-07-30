// ---------------------------------------------------------------------------
// Canonical agent-run status-transition primitive (extracted from store.ts,
// cinatra#1939 wave 2 file-size ratchet).
// ---------------------------------------------------------------------------
//
// `transitionRunStatus` — the single entry point for every agent_runs.status
// change — together with its two CAS/meta primitives
// (updateAgentRunStatusConditional, updateAgentRunStatus) and the per-dispatch
// bookkeeping type. Moved verbatim from packages/agents/src/store.ts (the
// wave-2 org-write-seam restructure) so the transition primitive has a home
// independent of the persistence hub; store.ts re-exports every symbol below so
// its public `./store` surface is unchanged for existing importers and for
// `vi.mock("../store")` in tests.
//
// The ONLY store.ts dependency is the `AgentRunRecord` TYPE (an `import type`,
// erased at build) — there is no runtime import of ./store, so no module-init
// cycle. Every other dependency is imported from its SOURCE module.
// ---------------------------------------------------------------------------
import { and, eq, sql } from "drizzle-orm";
import { expireRunStream } from "@cinatra-ai/a2a";
import type { OrgWriteAuthority, OrgWriteCapability, OrgWriteDb, OrgWriteTx } from "@cinatra-ai/org-write-kernel";
// cinatra#1940 P1 (Decision 4): the per-run, epoch-agnostic lease-settle shape,
// folded into the terminal transaction so status + lease settlement commit as
// one guarded tx. `orgWriteLeaseSchemaName` is the same lease-schema resolver
// the run-write seam already consults (already in this module's transitive
// graph via ./org-write-run-seam — a direct import here adds no new graph edge).
import { settleLeaseForRunStatement } from "@cinatra-ai/org-write-kernel";
// cinatra#1940 P4: the lease-expiry finalizer's phase-2 fenced settle. It
// consumes wave-3's `guardOrgLifecycleMutation` (never forks it) and the
// kernel's own in-fence re-verify shape + `rowsOf` result helper.
import { guardOrgLifecycleMutation, expiredLeaseForUpdateStatement, rowsOf } from "@cinatra-ai/org-write-kernel";
import { orgWriteLeaseSchemaName } from "@/lib/org-write/schema-name";
// The finalizer's sole minting module (kept OUT of agent-run-authority-mint.ts
// so its audit domain stays disjoint from normal run dispatch — see that
// module's own comment). Same host-import posture as `orgWriteLeaseSchemaName`
// above — packages/agents already reaches into src/lib/org-write/* directly.
import { mintLeaseExpiryFinalizerAuthority } from "@/lib/org-write/lease-expiry-authority-mint";
import { db } from "./db";
import { agentRuns } from "./schema";
import { dispatchRunWaitTransition } from "./run-wait-notifier"; // #1559/E9: zero-dep leaf seam
import { LEGAL_TRANSITIONS, TERMINAL_RUN_STATUSES, RunTransitionError } from "./run-status";
import type { AgentRunStatus } from "./run-status";
// cinatra#1939 wave 2 — the agent-run org-write seam. transitionRunStatus runs
// its CAS + delegated meta write inside guardOrgMutation's org-locked
// transaction; the required `authority` param is the compile-time ratchet that
// forces every caller to thread a host-minted authority in the SAME commit.
import { guardedRunWrite, AgentRunOrgWriteAuthorityError, type GuardedRunTx } from "./org-write-run-seam";
// cinatra#1893 (epic #1883 A5): terminal-success-with-derivation-outbox seam
// (file-size ratchet #1893); transitionRunStatus delegates its `derivationOutbox`
// branch here (option type re-used in the unchanged public signature).
import { transitionRunToCompletedWithDerivationOutbox, type DerivationOutboxCapture } from "./run-terminal-derivation-outbox";
// The AgentRunRecord shape stays in ./store (the persistence hub); imported as a
// TYPE only (erased) for updateAgentRunStatus's `patch` — no runtime ./store dep.
import type { AgentRunRecord } from "./store";

export async function updateAgentRunStatus(
  id: string,
  status: string,
  patch: Partial<AgentRunRecord> | undefined,
  tx: GuardedRunTx,
): Promise<void> {
  // unified terminal-status detection via TERMINAL_RUN_STATUSES
  // (defined below). This was once a local `terminalStatuses` array;
  // unifying prevents drift if a new terminal state is ever added.
  const isTerminal = TERMINAL_RUN_STATUSES.has(status as AgentRunStatus);
  const updates: Partial<typeof agentRuns.$inferInsert> = { status };

  if (isTerminal) {
    updates.completedAt = new Date();
  }

  if (patch?.stepResults !== undefined) {
    updates.stepResults = JSON.stringify(patch.stepResults);
  }
  if (patch?.error !== undefined) {
    updates.error = patch.error;
  }
  if (patch?.startedAt !== undefined) {
    updates.startedAt = patch.startedAt ?? undefined;
  }

  // cinatra#1939 wave 2: DB-ONLY, and REQUIRED to run inside transitionRunStatus's
  // guarded transaction on the passed `tx` (no `?? db` fallback — the org-write
  // seam is the only supplier, so the un-guarded API is closed). The terminal
  // Redis Streams TTL sweep (`expireRunStream`) that used to fire here is
  // relocated to transitionRunStatus's POST-COMMIT side-effects: no non-
  // transactional side-effect runs inside the guard, and the "single terminal
  // hook" invariant is preserved one level up (all status changes flow through
  // transitionRunStatus). The tx is cast to the drizzle surface (kernel hands
  // back its minimal contract type; the runtime tx is the real drizzle tx).
  const dtx = tx as unknown as typeof db;
  await dtx.update(agentRuns).set(updates).where(eq(agentRuns.id, id));
}

/**
 * Atomically transition an agent run's status from a specific expected
 * state to a new state. Returns true if exactly one row was updated
 * (i.e. the previous status matched), false otherwise.
 *
 * This is the compare-and-swap primitive that triggerAgentRun uses to
 * guarantee that two concurrent "Run" clicks cannot both enqueue a job:
 * only the first request whose UPDATE matches `pending_input` succeeds.
 */
export async function updateAgentRunStatusConditional(
  id: string,
  expectedStatus: string,
  nextStatus: string,
  dispatch: AgentRunDispatchFields | undefined,
  orgId: string,
  tx: GuardedRunTx,
): Promise<boolean> {
  // cinatra#1937: a queued→running CAS IS a dispatch — it stamps per-dispatch
  // bookkeeping ATOMICALLY with the status flip at the deepest layer, so no
  // caller can bypass it and `running` rows never carry stale attempt ids.
  const isDispatchTransition = expectedStatus === "queued" && nextStatus === "running";
  if (isDispatchTransition && !dispatch) {
    throw new Error(
      `updateAgentRunStatusConditional: queued→running for run ${id} requires dispatch fields (executionAttemptId; the deadline is computed in SQL)`,
    );
  }
  // Inverse guard: dispatch bookkeeping belongs ONLY to the dispatch edge.
  if (!isDispatchTransition && dispatch) {
    throw new Error(
      `updateAgentRunStatusConditional: dispatch fields supplied for non-dispatch transition ${expectedStatus}→${nextStatus} on run ${id}`,
    );
  }
  // cinatra#1939 wave 2: runs inside transitionRunStatus's guarded transaction on
  // the passed `tx` (cast to the drizzle surface). The CAS `WHERE` is ORG-SCOPED
  // (`AND org_id = orgId`, G1 Finding F): a mismatched-org runId returns 0 rows →
  // `stale_from_status` (fail-closed) instead of mutating another org's row under
  // org A's lock + permit. Dispatch bookkeeping (set clause) unchanged.
  const dtx = tx as unknown as typeof db;
  const result = await dtx
    .update(agentRuns)
    .set({
      status: nextStatus,
      ...(dispatch
        ? {
            executionAttemptId: dispatch.attemptId,
            // DB clock: the row's own timeout (COALESCE default 24h) from now().
            executionDeadlineAt: sql`now() + make_interval(secs => COALESCE(${agentRuns.timeoutSeconds}, 86400))`,
            humanWaitAttemptId: null, // #1938: a fresh dispatch drops any wait marker
          }
        : {}),
      // cinatra#1938: durable in-attempt wait marker (rationale on the agent_runs
      // column). running→pending_approval stamps the attempt id; else clears.
      ...(nextStatus === "pending_approval"
        ? { humanWaitAttemptId: expectedStatus === "running" ? sql`${agentRuns.executionAttemptId}` : null }
        : {}),
    })
    .where(and(eq(agentRuns.id, id), eq(agentRuns.status, expectedStatus), eq(agentRuns.orgId, orgId)))
    .returning({ id: agentRuns.id });
  return result.length === 1;
}

/** Per-dispatch bookkeeping stamped by the queued→running CAS (cinatra#1937). */
export type AgentRunDispatchFields = {
  /** Fresh per-dispatch id — mint with crypto.randomUUID() at each dispatch. */
  attemptId: string;
};

/**
 * Settle (revoke) EVERY archive lease a run holds, on the caller's ALREADY-OPEN
 * guarded transaction — cinatra#1940 P1 (Decision 4, the terminal-tx fold).
 *
 * Runs on `tx` right after the status CAS + delegated meta write, so status +
 * meta + (derivation-outbox) + LEASE SETTLEMENT commit as ONE guarded
 * transaction: a CAS/meta failure rolls the settle back with them (the lease
 * row survives → the lease-expiry finalizer settles it later), and an in-window
 * completion under an archived org leaves zero lingering lease residue.
 * Epoch-agnostic per-run DELETE (see settleLeaseForRunStatement); on the
 * `org_archive_lease` table which is EMPTY except under archive, so this is a
 * measurable-zero indexed DELETE on the hot path for active orgs.
 *
 * Shared by BOTH transitionRunStatus branches: the plain terminal path calls it
 * directly; the derivationOutbox delegate receives it THREADED (avoiding a
 * run-transition ⇄ run-terminal-derivation-outbox import cycle) and calls it on
 * the same guarded tx. The tx exposes the kernel's minimal `.execute()` surface
 * (the same one guardOrgMutation runs the lease probe through).
 */
async function settleLeaseInTx(
  tx: GuardedRunTx,
  orgId: string,
  runId: string,
): Promise<void> {
  await tx.execute(
    settleLeaseForRunStatement({ schema: orgWriteLeaseSchemaName(), orgId, runId }),
  );
}

// ---------------------------------------------------------------------------
// canonical run-status transition primitive
// ---------------------------------------------------------------------------
//
// transitionRunStatus is the single entry point for every agent_runs.status
// change. It enforces:
//   (1) the from→to edge is one of LEGAL_TRANSITIONS (illegal → throws, pre-guard);
//   (2) a host-minted org-write authority grounds the transition under the
//       org-write kernel guard (cinatra#1939 wave 2): org locks → per-transition
//       lifecycle ruling (run.complete for terminal edges, else run.execute) →
//       permit — the CAS + delegated meta write land as ONE guarded transaction;
//   (3) the DB row is still in the expected `from` state (stale → throws, rolls
//       back the tx);
//   (4) terminal-state side-effects fire exactly once, POST-COMMIT (after the
//       guarded tx returns): expireRunStream on terminal + dispatchRunWaitTransition.
//
// The `authority` param is REQUIRED (the compile-time per-writer ratchet): every
// caller threads a host-minted authority in the SAME commit as this conversion.
// DO NOT call updateAgentRunStatusConditional directly from any other file.
// DO NOT call updateAgentRunStatus for status CHANGES from any other file —
// use transitionRunStatus. updateAgentRunStatus is still the correct call for
// the narrow meta-only case handled by updateAgentRunMeta below (now tx-scoped).

/**
 * single canonical entry point for agent_runs.status changes.
 *
 * @throws {RunTransitionError} code="illegal_transition" when (from, to) ∉ LEGAL_TRANSITIONS (pre-guard)
 * @throws {AgentRunOrgWriteAuthorityError} when `authority` is missing / for another org / bound to another run (seam)
 * @throws {OrgWriteRefusedError} when the kernel refuses the per-transition capability (e.g. archived org)
 * @throws {RunTransitionError} code="stale_from_status" when the org-scoped CAS row-count is 0 (rolls back the tx)
 */
export async function transitionRunStatus(
  runId: string,
  from: AgentRunStatus,
  to: AgentRunStatus,
  meta:
    | {
        error?: string;
        startedAt?: Date;
        completedAt?: Date;
        stepResults?: unknown[];
        /** Flags the ONE genuine human-wait `→pending_input` (stop-run-hitl, #1058) so it notifies; every other `pending_input` reason leaves it unset. Not a DB column — only feeds the run-wait-notifier classification below. (The archive program's durable in-attempt marker is edge-derived on `→pending_approval` inside the CAS — cinatra#1938 — and deliberately independent of this flag: the #1058 wait fires pre-dispatch from `queued`, so it is parked, not in-flight.) */
        humanWaitGate?: boolean;
        /** REQUIRED on queued→running (cinatra#1937): per-dispatch bookkeeping stamped atomically with the CAS. The primitive below throws without it. */
        dispatch?: AgentRunDispatchFields;
        /** cinatra#1893 (epic #1883 A5): when present, delegate to transitionRunToCompletedWithDerivationOutbox — terminal CAS + final-output snapshot + derivation-outbox INSERT in ONE transaction (legal ONLY for `to === "completed"`). Absent for every other caller — the historical two-write path is unchanged. */
        derivationOutbox?: DerivationOutboxCapture;
      }
    | undefined,
  // cinatra#1939 wave 2 — REQUIRED host-minted authority (the compile-time
  // per-writer ratchet: no default, no `?`, so every caller must thread one in
  // this commit). Typed `| undefined` because the ONE frame-forwarded caller
  // (mcp/handlers.ts agent_run_stop, §2e) threads its possibly-absent frame
  // authority so the seam fail-closes it uniformly; every other caller passes a
  // concrete host-side mint (§2a member session, §2b system). Cross-org
  // run management was dropped (owner ruling 2026-07-26) — non-member run-management
  // flows fail closed at their call site / the seam, never via a special mint.
  authority: OrgWriteAuthority | undefined,
): Promise<void> {
  // (1) Legal-transition pre-guard — an illegal edge is a programmer error, not
  // an authority refusal, so it throws BEFORE any org-write work.
  if (!LEGAL_TRANSITIONS.has(`${from}->${to}` as const)) {
    throw new RunTransitionError({ code: "illegal_transition", runId, from, to });
  }
  // (2) Fail-closed: every status transition requires a host-minted authority.
  // The org (lock + CAS scope) is the authority's org — a wrong-org authority
  // fails closed as `stale_from_status` via the §1d org-scoped CAS.
  if (!authority) throw new AgentRunOrgWriteAuthorityError("missing");
  const orgId = authority.orgId;
  const isTerminal = TERMINAL_RUN_STATUSES.has(to);
  // Per-transition capability (§3): terminal edges LAND a run's outputs
  // (`run.complete`); every other edge is a dispatch / lifecycle move
  // (`run.execute`). Combined with the seam's §1a run-binding, a run/OBO
  // authority (run.complete only, self-bound) can land its OWN terminal state
  // but can never dispatch, park, or drive another same-org run.
  const capability: OrgWriteCapability = isTerminal ? "run.complete" : "run.execute";

  // cinatra#1893 terminal-success-with-derivation-outbox branch (to==="completed"):
  // the CAS + final-output snapshot + derivation-outbox INSERT commit as ONE
  // guarded transaction on the guarded tx (org-scoped inside the delegate).
  if (meta?.derivationOutbox) {
    const derivationOutbox = meta.derivationOutbox;
    await guardedRunWrite(authority, { orgId, runId, capability }, async (guardedTx) => {
      await transitionRunToCompletedWithDerivationOutbox(
        runId,
        from,
        to,
        meta,
        derivationOutbox,
        orgId,
        guardedTx,
        // cinatra#1940 P1 fold: settle the lease INSIDE the delegate's terminal
        // tx (→completed is terminal), threaded to avoid an import cycle. The
        // CAS + outbox INSERT + lease DELETE commit atomically.
        settleLeaseInTx,
      );
    });
    // POST-COMMIT (codex #2/#13): the guarded tx committed ⇒ the transition
    // happened. Best-effort Redis TTL sweep on terminal. NO dispatchRunWaitTransition
    // — parity with today's derivationOutbox path (it returned before the notify).
    if (isTerminal) void expireRunStream(runId).catch(() => { /* best-effort */ });
    return;
  }

  await guardedRunWrite(authority, { orgId, runId, capability }, async (guardedTx) => {
    const won = await updateAgentRunStatusConditional(runId, from, to, meta?.dispatch, orgId, guardedTx);
    if (!won) {
      // Rolls back the guarded tx; the meta write below never runs and the
      // post-commit side-effects never fire (codex #2 — the transition did not
      // commit, so no waiter wakeup / stream expiry).
      throw new RunTransitionError({ code: "stale_from_status", runId, from, to });
    }
    // Delegate the meta patch to updateAgentRunStatus on the SAME guarded tx. The
    // CAS already wrote the status column; re-writing it is a no-op that still
    // runs the meta-patch logic. The CONTROL keys (`dispatch` — written BY the
    // CAS — and `humanWaitGate` — not a DB column) are stripped first: only
    // genuine DB meta reaches the delegated write.
    const { dispatch: _dispatch, humanWaitGate: _humanWaitGate, ...dbMeta } = meta ?? {};
    const hasDelegatedMeta =
      dbMeta.error !== undefined ||
      dbMeta.startedAt !== undefined ||
      dbMeta.completedAt !== undefined ||
      dbMeta.stepResults !== undefined;
    if (hasDelegatedMeta || isTerminal) {
      await updateAgentRunStatus(runId, to, dbMeta as Partial<AgentRunRecord>, guardedTx);
    }
    // cinatra#1940 P1 fold (Decision 4): a terminal landing settles the run's
    // lease in the SAME guarded tx as the CAS + meta — status and lease
    // settlement commit atomically (order: CAS → meta → lease DELETE).
    if (isTerminal) {
      await settleLeaseInTx(guardedTx, orgId, runId);
    }
  });

  // POST-COMMIT side-effects only (codex #2/#13): the guarded tx committed ⇒ the
  // transition happened. A meta-write failure would have rolled the tx back and
  // thrown, so reaching here means the write is durable. `expireRunStream` is the
  // single terminal Redis-TTL hook (relocated up from updateAgentRunStatus);
  // `dispatchRunWaitTransition` is the run-wait notify (#1559/E9), best-effort.
  if (isTerminal) void expireRunStream(runId).catch(() => { /* best-effort */ });
  await dispatchRunWaitTransition({ runId, from, to, humanWaitGate: meta?.humanWaitGate === true });
}

// ---------------------------------------------------------------------------
// finalizeExpiredLeaseRun — cinatra#1940 P4, phase 2 (the lease-expiry
// finalizer's fenced settle).
// ---------------------------------------------------------------------------
//
// A SIBLING of transitionRunStatus (same module, same discipline), NOT a
// second parallel transition API: the ONE entry point for the lease-expiry
// finalizer's audited settle under the exclusive fence. Called from phase 1
// (packages/agents/src/lease-expiry-finalizer.ts) AFTER the durable
// attempts-increment + best-effort runtime-cancel bookkeeping — this function
// is the fenced, idempotent settle only.
//
// Every step is re-verified IN-TX (never trusts the sweep's stale read):
//   1. mint a purpose-scoped system authority (no run identity — the
//      finalizer holds no lease of its own to bind to);
//   2. acquire the EXCLUSIVE epoch+write fence (guardOrgLifecycleMutation) —
//      "drain admitted writers" IS holding the write lock exclusively;
//   3. inside the fence, re-verify the exact lease row is STILL expired FOR
//      UPDATE at the fence's OWN locked-state epoch (never the sweep's) —
//      no row ⇒ benign skip (epoch moved / already settled / not actually
//      expired); already-terminal run ⇒ lease-only delete (settle-orphan);
//      else CAS the run to `failed` (never `stopped` — an expired window is a
//      failure of the run to complete in time, not user intent) + lease
//      DELETE, atomically.
export type FinalizeExpiredLeaseOutcome =
  | { readonly outcome: "skipped"; readonly reason: "lease-gone" }
  | { readonly outcome: "settled"; readonly mode: "lease-only" }
  | {
      readonly outcome: "settled";
      readonly mode: "run-and-lease";
      readonly from: AgentRunStatus;
      /** False on the defensive lost-CAS fallback (another writer already
       *  terminalized the row under the same fence-serialized write lock —
       *  structurally near-unreachable since the fence holds the write lock
       *  for the whole tx). The lease DELETE still ran (harmless no-op if the
       *  other writer's own terminal fold already deleted it); post-commit
       *  notify/audit fire ONLY when `won` — a call that did not actually
       *  land the transition must not redundantly notify (the winner's own
       *  transitionRunStatus call already did). */
      readonly won: boolean;
    };

export async function finalizeExpiredLeaseRun(
  orgId: string,
  runId: string,
): Promise<FinalizeExpiredLeaseOutcome> {
  const authority = mintLeaseExpiryFinalizerAuthority(orgId);
  const schema = orgWriteLeaseSchemaName();
  const outcome = await guardOrgLifecycleMutation(
    db as unknown as OrgWriteDb<OrgWriteTx>,
    { orgId, capability: "run.lease-expire", authority, schema },
    async (tx, permit): Promise<FinalizeExpiredLeaseOutcome> => {
      // Re-verify at the FENCE's own locked-state epoch (permit.archiveEpoch)
      // — an unarchive between the sweep read and this fence self-resolves
      // here: the row no longer exists at the new epoch.
      const leaseResult = await tx.execute(
        expiredLeaseForUpdateStatement({ schema, orgId, archiveEpoch: permit.archiveEpoch, runId }),
      );
      const leaseRows = rowsOf(leaseResult);
      if (leaseRows.length === 0) {
        return { outcome: "skipped", reason: "lease-gone" };
      }
      const leasedAttemptId = String(leaseRows[0]?.execution_attempt_id ?? "unknown");

      const dtx = tx as unknown as typeof db;
      const runRows = await dtx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
      const row = runRows[0];

      // No row (deleted) OR already terminal ⇒ settle-orphan: the ONLY
      // lease-only-delete path — a non-terminal run never loses its lease
      // without being terminalized in the SAME tx.
      if (!row || TERMINAL_RUN_STATUSES.has(row.status as AgentRunStatus)) {
        await settleLeaseInTx(tx, orgId, runId);
        return { outcome: "settled", mode: "lease-only" };
      }

      const from = row.status as AgentRunStatus;
      // Defensive legality pre-guard: every non-terminal status now has a
      // `->failed` edge so this can never throw in production — kept as a
      // guard, not a silent cast, so a future status addition that
      // forgets its `->failed` edge fails loudly here instead of corrupting a
      // lease-holding run into an illegal state.
      if (!LEGAL_TRANSITIONS.has(`${from}->failed`)) {
        throw new RunTransitionError({ code: "illegal_transition", runId, from, to: "failed" });
      }
      // Org-scoped CAS to `failed` (never `stopped` — an expired window is a
      // failure, not user intent). A lost CAS (another writer already
      // terminalized the row under the same fence-serialized write lock) is
      // benign: fall through to the lease settle regardless — that writer's
      // OWN terminal transition already folded its own settle, so this
      // DELETE is a harmless zero-row no-op.
      const won = await updateAgentRunStatusConditional(runId, from, "failed", undefined, orgId, tx);
      if (won) {
        await updateAgentRunStatus(
          runId,
          "failed",
          { error: `organization archive lease expired (attempt ${leasedAttemptId})` },
          tx,
        );
      }
      await settleLeaseInTx(tx, orgId, runId);
      return { outcome: "settled", mode: "run-and-lease", from, won };
    },
  );

  // POST-COMMIT (parity with transitionRunStatus's own post-commit block):
  // the guarded fence tx committed ⇒ whatever it decided is durable.
  // Best-effort only — the DURABLE record is the settled row
  // itself (status + error + completedAt) plus the lease deletion; an in-tx
  // audit INSERT was the rejected runner-up (a new pattern no other
  // transition uses). `expireRunStream` / `dispatchRunWaitTransition` / the
  // audit event only fire for a `run-and-lease` settle that ACTUALLY WON its
  // CAS — a lease-only settle-orphan touched no run status, and a lost CAS
  // (the defensive fallback) means this call landed nothing: the OTHER
  // writer's own transitionRunStatus call already fired its own notify/audit,
  // so redundantly firing here would double-report the same transition.
  if (outcome.outcome === "settled" && (outcome.mode === "lease-only" || outcome.won)) {
    if (outcome.mode === "run-and-lease") {
      void expireRunStream(runId).catch(() => { /* best-effort */ });
      await dispatchRunWaitTransition({ runId, from: outcome.from, to: "failed", humanWaitGate: false });
    }
    try {
      const { logAuditEvent, POLICY_VERSION } = await import("@/lib/authz");
      void logAuditEvent({
        actorPrincipalType: "system",
        authSource: "scheduler",
        resourceType: "agent_run",
        resourceId: runId,
        operation: "lease_expire",
        decision: "allowed",
        policyVersion: POLICY_VERSION,
        runId,
        organizationId: orgId,
        metadata: { via: "lease-expiry-finalizer", mode: outcome.mode },
      });
    } catch (auditErr) {
      console.warn(
        `[lease-expiry-finalizer] post-settle audit write failed for run ${runId} (continuing):`,
        auditErr instanceof Error ? auditErr.message : auditErr,
      );
    }
  }
  return outcome;
}
