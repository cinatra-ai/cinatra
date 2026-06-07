/**
 * Vendor-application state reconcile worker.
 *
 * Sibling to `@cinatra-ai/marketplace-sync`'s `runMarketplaceSync`. Drives the
 * `vendor_application_complete_recovery` ability on the cm side for every
 * namespace-reservation row this cinatra instance considers "stuck": the
 * broker (Verdaccio user) + WP cap-grant (CAP_VENDOR_PUBLISH) have already
 * completed marketplace-side, but the final DB flip from `applied` →
 * `approved` did not land (network blip, half-failed approve, etc.).
 *
 * Composition:
 *   - `getStuckApplications()` — fn returning the bounded candidate set this
 *     run should attempt to recover. Wiring lives in the cinatra-side deps
 *     factory (`buildVendorApplicationReconcileDeps`); for the v0 single-
 *     instance shape this resolves to a 0-or-1 element list derived from the
 *     local `instance_identity.vendorApplicationId` slot when
 *     `vendorState === "applied"`. Multi-instance / admin-queue iteration is
 *     a follow-up.
 *   - `client.vendorApplicationCompleteRecovery({ application_id })` — the
 *     PRINCIPAL_SYNC_WORKER-only ability that re-runs the broker + cap-grant
 *     + DB flip as one idempotent unit. Returns a state union the worker
 *     interprets as recovery-success vs needs-retry.
 *
 * Telemetry:
 *   - Per-run `{ recovered, failed, attempted }` is returned for the BullMQ
 *     dispatcher to log. Per-application failures are warned + counted but
 *     do not throw (one bad row must not stop the rest, and the loop must
 *     always re-delay).
 */

/**
 * Narrow structural interface for the one client method we call. Declared
 * here (rather than imported from `@cinatra-ai/marketplace-mcp-client`) so
 * this worker stays compilable while the sibling C1 chunk ships the typed
 * wrapper on `MarketplaceMcpClient`. Once C1 lands, the deps factory can
 * pass a `MarketplaceMcpClient` directly and TypeScript will satisfy the
 * structural match on the single method.
 */
export interface VendorApplicationCompleteRecoveryCaller {
  vendorApplicationCompleteRecovery(input: {
    application_id: string;
  }): Promise<VendorApplicationCompleteRecoveryResult>;
}

/**
 * Shape of `vendor_application_complete_recovery`'s output. Faithful to the
 * cm-side ability contract — a discriminated union over the recovery outcome:
 *
 *   - `state: "approved"` — DB flip landed (or the row was already approved on
 *     an idempotent re-run, signalled by `already_approved`). Recovery
 *     successful → recovered.
 *   - `state: "stuck"` — the recovery-attempt cap is exhausted; the saga is
 *     terminally stuck and will NOT auto-retry. `repair_stuck_at` records when
 *     it was marked. The worker records the durable local flag (via `onStuck`)
 *     and stops attempting this application → stuck.
 *   - `state: "applied"` + `retriable: true` — the saga started/restarted but
 *     the row has not flipped yet and the cap is not reached. The next cycle
 *     retries → failed (counted for retry, non-fatal).
 *   - `state: "applied"` + `recovery_not_applicable: true` — no saga is
 *     in-flight (commercial pending / pre-broker). A benign skip → skipped,
 *     NOT a failure.
 *
 * The trailing structural fallbacks keep the worker compilable against
 * contract drift; an unrecognised shape is treated as non-terminal (failed).
 */
export type VendorApplicationCompleteRecoveryResult =
  | { state: "approved"; application_id: string; completed_at?: string; already_approved?: boolean }
  | { already_approved: true; application_id: string; state?: string }
  | { state: "stuck"; application_id: string; recovery_attempts: number; repair_stuck_at: string }
  | { state: "applied"; application_id: string; recovery_attempts: number; retriable: true }
  | {
      state: "applied";
      application_id: string;
      recovery_attempts: number;
      recovery_not_applicable: true;
    }
  | { state: "applied" | "rejected" | "cancelled" | "reset" | "none"; application_id: string }
  | Record<string, unknown>;

export interface ReconcileCandidate {
  application_id: string;
}

export interface ReconcileDeps {
  client: VendorApplicationCompleteRecoveryCaller;
  /** Returns the bounded candidate set this run should attempt. */
  getStuckApplications: () => Promise<ReconcileCandidate[]>;
  /**
   * Optional notification fired when the marketplace reports a recovery as
   * terminally stuck. The deps layer records the durable local stuck flag so
   * the candidate resolver stops returning this application on later cycles.
   * Non-fatal: a throw here is logged but does not fail the run.
   */
  onStuck?: (applicationId: string, repairStuckAt: string) => Promise<void> | void;
}

export interface ReconcileRunSummary {
  startedAt: string;
  finishedAt: string;
  attempted: number;
  recovered: number;
  failed: number;
  /** Applications the marketplace reported as terminally stuck this run. */
  stuck: number;
  /** Applications with no in-flight saga (benign skip, not a failure). */
  skipped: number;
}

export async function runVendorApplicationStateReconcile(
  deps: ReconcileDeps,
): Promise<ReconcileRunSummary> {
  const startedAt = new Date().toISOString();
  let attempted = 0;
  let recovered = 0;
  let failed = 0;
  let stuck = 0;
  let skipped = 0;

  let candidates: ReconcileCandidate[];
  try {
    candidates = await deps.getStuckApplications();
  } catch (err) {
    console.warn(
      "[vendor-application-state-reconcile] getStuckApplications threw — treating as empty candidate set:",
      err instanceof Error ? err.message : err,
    );
    candidates = [];
  }

  for (const { application_id } of candidates) {
    attempted++;
    try {
      const result = await deps.client.vendorApplicationCompleteRecovery({ application_id });
      const classification = classifyRecovery(result);
      switch (classification) {
        case "recovered":
          recovered++;
          break;
        case "stuck": {
          stuck++;
          // Record the durable local stuck flag so the candidate resolver
          // stops returning this dead saga on later cycles. Non-fatal.
          const repairStuckAt = extractRepairStuckAt(result);
          if (deps.onStuck) {
            try {
              await deps.onStuck(application_id, repairStuckAt);
            } catch (notifyErr) {
              console.warn(
                `[vendor-application-state-reconcile] onStuck threw application_id=${application_id}:`,
                notifyErr instanceof Error ? notifyErr.message : notifyErr,
              );
            }
          }
          console.warn(
            `[vendor-application-state-reconcile] recovery terminally stuck application_id=${application_id} repair_stuck_at=${repairStuckAt}`,
          );
          break;
        }
        case "skipped":
          // No saga in-flight (commercial pending / pre-broker). Benign.
          skipped++;
          console.debug(
            `[vendor-application-state-reconcile] recovery not applicable application_id=${application_id} (no saga in-flight)`,
          );
          break;
        case "retry":
        default:
          // The call succeeded but the row did not flip to approved this
          // cycle and is still retriable. Non-fatal; the next tick retries.
          failed++;
          console.warn(
            `[vendor-application-state-reconcile] non-terminal recovery state application_id=${application_id} result=${safeStringify(result)}`,
          );
          break;
      }
    } catch (err) {
      failed++;
      console.warn(
        `[vendor-application-state-reconcile] failed application_id=${application_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    attempted,
    recovered,
    failed,
    stuck,
    skipped,
  };
}

type RecoveryClassification = "recovered" | "stuck" | "skipped" | "retry";

function classifyRecovery(
  result: VendorApplicationCompleteRecoveryResult,
): RecoveryClassification {
  if (result === null || typeof result !== "object") return "retry";
  const r = result as Record<string, unknown>;
  if (r.already_approved === true) return "recovered";
  if (r.state === "approved") return "recovered";
  if (r.state === "stuck") return "stuck";
  if (r.state === "applied" && r.recovery_not_applicable === true) return "skipped";
  // `state: "applied"` + retriable, or any other non-terminal shape.
  return "retry";
}

function extractRepairStuckAt(result: VendorApplicationCompleteRecoveryResult): string {
  if (result && typeof result === "object") {
    const value = (result as Record<string, unknown>).repair_stuck_at;
    if (typeof value === "string" && value.length > 0) return value;
  }
  // Defensive default — the cm contract always supplies it on `stuck`, but a
  // drifted payload must not write an empty marker.
  return new Date().toISOString();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
