import "server-only";

// -----------------------------------------------------------------------------
// Public-registry polling driver (BullMQ worker handler).
//
// This handler implements the registry polling response branches plus the
// security-critical approved-response ordering: write npm token to Nango BEFORE
// deleting the request-secret; on Nango-write failure flip status to `error`
// and never let the token leak.
//
// Concurrency model — distinct-attempt jobId pattern + same-source timestamp +
// post-expiry short-circuit. The action-side initial enqueue uses bare jobId
// `registry-poll:{requestId}` for single-in-flight behavior. The handler-side
// reschedules use timestamped jobIds `registry-poll:{requestId}:{nextPollAtMs}`
// so BullMQ never silently drops them, with an app-level stale-attempt guard for
// "most-recent-attempt-only" semantics.
// -----------------------------------------------------------------------------

import { BACKGROUND_JOB_NAMES, enqueueBackgroundJob } from "@/lib/background-jobs";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import {
  readInstanceIdentity,
  updateInstanceIdentityRegistries,
  type RemoteRegistryConnection,
} from "@/lib/instance-identity-store";
import type { InstanceIdentityCasOutcome } from "@/lib/instance-identity-cas";
import {
  readRegistryCredential,
  writeRegistryCredential,
  deleteRegistryCredential,
  getRegistryCredentialRef,
} from "@/lib/registry-credentials";
import { redactSensitive } from "@/lib/redact-sensitive";
import { REMOTE_REGISTRY_URL } from "@/app/configuration/network/constants";

// -----------------------------------------------------------------------------
// Module-private constants
// -----------------------------------------------------------------------------

const BACKOFF_START_MS = 30_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const SECRET_MISSING_REASON =
  "Registry credential is missing locally; submit a fresh request.";
const TOKEN_STORAGE_FAILED_REASON =
  "Token storage failed. The registration is consumed; please submit a fresh request.";
const CONSUMED_REASON = "Token was consumed elsewhere; submit a fresh request.";
const NOT_FOUND_REASON = "Request not recognized by registry.";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Persist `next` into `instance_identity.registries.remote`, cross-process-safe
 * via a row-level CAS with bounded retry (cinatra#850).
 *
 * This worker is a BullMQ replica racing the foreground network-config actions
 * on the single `instance_identity` row. Two guarantees:
 *   1. Whole-row safety: the CAS re-reads the fresh row each attempt, so the
 *      sibling `registries.local` slot and every non-registries field are
 *      carried forward — a concurrent write to a DIFFERENT field/slot is never
 *      clobbered (the earlier lock-free whole-row overwrite, serialised only by
 *      an in-process mutex, lost those across processes).
 *   2. Same-slot state-awareness: the mutation only applies this poll's
 *      transition if the freshly re-read `remote` slot is STILL the same
 *      in-flight request validated at handler entry (matching `requestId`) AND
 *      still `pending`. If the operator cancelled/disconnected it, a newer
 *      request superseded it (different `requestId`), or a concurrent poll (or
 *      the "Refresh status" action) already terminalised it, the poll becomes a
 *      no-op — it never resurrects a cancelled request or reverts a newer
 *      authoritative state (the classic same-slot lost update).
 *
 * `next` is always `{ ...remote, ... }` for the `remote` this handler validated,
 * so `next.requestId` identifies the request under poll. A missing identity row
 * is a no-op. "exhausted" under sustained contention is logged and NOT
 * force-written; the next tick re-derives and re-persists.
 *
 * The approved branch does NOT use this helper — it needs to distinguish a real
 * commit from the benign slot-moved-on no-op (both return "swapped") to drive the
 * orphaned-token cleanup, so it uses `persistConnectedRemote` below.
 */
function persistRemote(next: RemoteRegistryConnection): InstanceIdentityCasOutcome {
  const outcome = updateInstanceIdentityRegistries((registries) => {
    const fresh = registries.remote;
    const sameInflight =
      !!fresh && fresh.requestId === next.requestId && fresh.status === "pending";
    if (!sameInflight) return registries; // slot moved on — do not resurrect/clobber
    return { ...registries, remote: next };
  });
  if (outcome === "exhausted" || outcome === "unparseable") {
    console.warn(
      `[registry-poll] persistRemote could not commit registries.remote (${outcome}); ` +
        `a reconciliation poll will re-derive and re-persist.`,
    );
  }
  return outcome;
}

/**
 * Approved-branch persist that ALSO reports whether the connected transition
 * actually applied and where the slot finally resolved (cinatra#899).
 *
 * `persistRemote` returns "swapped" for BOTH a real commit AND the benign
 * slot-moved-on no-op — the CAS commits a byte-identical row when the mutator
 * returns the slot unchanged — so the outcome alone cannot tell them apart. The
 * approved branch MUST tell them apart: it has just written the npm `token` to
 * Nango, and if the slot moved on (the operator cancelled or superseded the
 * request in the approval window) that token is orphaned and must be cleaned up.
 *
 * Two side-channel signals, both captured inside the mutator so they reflect the
 * FINAL CAS attempt (the one whose row was actually swapped):
 *   - `applied`: this attempt wrote the `connected` state (the slot was still the
 *     same in-flight pending request). `applied && outcome === "swapped"` means
 *     THIS poll landed the connection.
 *   - `finalSlotIsThisRequest`: the freshly re-read slot still carries THIS
 *     request's `requestId` (any status). This guards the benign race where a
 *     SIBLING poll (a BullMQ tick vs. the manual "Refresh status" action) already
 *     connected the SAME request: `applied` is false but the token is LIVE, so it
 *     must NOT be treated as an orphan. When the mutator never runs (a missing or
 *     unusable identity row → "no-identity"/"aborted"), it stays false, so the
 *     just-written token is correctly reclaimed.
 */
function persistConnectedRemote(next: RemoteRegistryConnection): {
  outcome: InstanceIdentityCasOutcome;
  applied: boolean;
  finalSlotIsThisRequest: boolean;
} {
  let applied = false;
  let finalSlotRequestId: string | null | undefined;
  const outcome = updateInstanceIdentityRegistries((registries) => {
    const fresh = registries.remote;
    finalSlotRequestId = fresh?.requestId ?? null;
    const sameInflight =
      !!fresh && fresh.requestId === next.requestId && fresh.status === "pending";
    applied = sameInflight;
    if (!sameInflight) return registries; // slot moved on — do not resurrect/clobber
    return { ...registries, remote: next };
  });
  if (outcome === "exhausted" || outcome === "unparseable") {
    console.warn(
      `[registry-poll] persistConnectedRemote could not commit registries.remote (${outcome}); ` +
        `a reconciliation poll will re-derive and re-persist.`,
    );
  }
  return {
    outcome,
    applied,
    finalSlotIsThisRequest: finalSlotRequestId === next.requestId,
  };
}

/**
 * Reconcile a TERMINAL-branch persist whose row-level CAS did not commit
 * (cinatra#850). The terminal response branches (approved / denied / 404 / 410)
 * have already performed an IRREVERSIBLE Nango credential delete and — unlike
 * the pending / backoff branches — do NOT self-reschedule, so a lost CAS
 * (sustained contention → "exhausted", or a corrupt row → "unparseable") would
 * leave the slot silently stuck at `pending`. The caller must NOT treat that as
 * success: enqueue ONE bounded reconciliation poll so a later tick (once
 * contention has passed) re-derives the real terminal state instead of the loop
 * going quiet. `swapped` (committed, incl. the benign slot-moved-on no-op) and
 * `no-identity` (the row is gone — nothing to reconcile) need no action. A
 * reconciliation that races a genuinely fresh attempt is dropped by the
 * stale-attempt guard, so an extra poll is at worst one wasted HTTP round-trip.
 */
async function reconcileUncommittedTerminalPersist(
  requestId: string,
  outcome: InstanceIdentityCasOutcome,
  expiresAt: string | null | undefined,
): Promise<void> {
  if (outcome === "swapped" || outcome === "no-identity") return;
  console.warn(
    "[registry-poll] terminal persist did not commit; scheduling reconciliation",
    redactSensitive({ requestId, outcome }),
  );
  await reschedule(requestId, BACKOFF_START_MS, expiresAt).catch((err) => {
    console.warn(
      "[registry-poll] reconciliation reschedule failed",
      redactSensitive({ requestId, error: err }),
    );
    return null;
  });
}

/**
 * Self-reschedule with cap-to-`expiresAt` and same-source timestamp.
 *
 * Returns `{ scheduledFor }` so the caller persists `nextPollAt` from the
 * SAME ms-epoch baseline that ends up in the BullMQ payload — the
 * stale-attempt guard then compares them with exact equality and never marks a
 * legitimate attempt as stale.
 *
 * Returns `null` when `remainingMs <= 0` so the caller can flip status to
 * `expired` directly without enqueuing a dead job.
 *
 * The jobId pattern `registry-poll:{requestId}:{nextPollAtMs}` uses
 * distinct-attempt jobIds to avoid BullMQ's same-jobId-while-active dedup.
 * App-level "most-recent-attempt-only" semantics live in the stale-attempt
 * guard.
 */
async function reschedule(
  requestId: string,
  delayMs: number,
  expiresAt: string | null | undefined,
): Promise<{ scheduledFor: number } | null> {
  const remainingMs = expiresAt
    ? new Date(expiresAt).getTime() - Date.now()
    : Number.POSITIVE_INFINITY;

  // Post-expiry short-circuit.
  if (remainingMs <= 0) {
    return null;
  }

  // Cap delay to ≥ 1s and ≤ remaining time-to-expiresAt; the SAME `capped`
  // value drives both the BullMQ delay and the payload.scheduledFor field.
  const capped = Math.max(1_000, Math.min(delayMs, remainingMs));
  // Single Date.now() read for both the trailing jobId suffix AND
  // payload.scheduledFor — keeps stale-attempt guard exact-equality safe.
  const cappedNextPollAtMs = Date.now() + capped;
  const attemptJobId = `registry-poll:${requestId}:${cappedNextPollAtMs}`;
  await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.REGISTRY_POLL,
    { requestId, scheduledFor: cappedNextPollAtMs },
    {
      jobId: attemptJobId,
      delay: capped,
      // SYSTEM_JOB worker-internal enqueue; avoid inheriting HumanUser
      // attribution. See https://docs.cinatra.ai/references/platform/notifications/.
      inheritActorContext: false,
    },
  );
  return { scheduledFor: cappedNextPollAtMs };
}

/**
 * Backoff derivation for the 5xx / network-throw branch.
 *
 * Stateless — derived from the persisted `lastPolledAt → nextPollAt` delta.
 *
 * Sequence: 30_000 → 60_000 → 120_000 → 240_000 → 300_000 (capped) → 300_000…
 *
 * - First 5xx attempt (no prior `lastPolledAt` or `nextPollAt`) → BACKOFF_START_MS.
 * - Defensive: previous delta <= 0 (clock skew or corrupt state) → restart from base.
 * - Previous delta >= cap → stay at cap.
 * - Otherwise → double, capped at BACKOFF_CAP_MS.
 *
 * Tests assert this exact formula.
 */
function deriveNext5xxBackoffMs(remote: RemoteRegistryConnection): number {
  if (!remote.lastPolledAt || !remote.nextPollAt) {
    return BACKOFF_START_MS;
  }
  const previousDeltaMs =
    new Date(remote.nextPollAt).getTime() - new Date(remote.lastPolledAt).getTime();
  if (previousDeltaMs <= 0) {
    return BACKOFF_START_MS;
  }
  if (previousDeltaMs >= BACKOFF_CAP_MS) {
    return BACKOFF_CAP_MS;
  }
  return Math.min(previousDeltaMs * 2, BACKOFF_CAP_MS);
}

// -----------------------------------------------------------------------------
// Public handler
// -----------------------------------------------------------------------------

/**
 * Run a single registry-poll attempt.
 *
 * `payload.scheduledFor` is set by self-reschedules from inside this handler
 * for the app-level stale-attempt guard. The action-side initial enqueue
 * does NOT set it — the handler treats unset as "no stale-attempt comparison
 * possible" and proceeds.
 */
export async function runRegistryPollJob(
  payload: { requestId: string; scheduledFor?: number },
): Promise<void> {
  // Read state guards.
  const identity = readInstanceIdentity();
  const remote = identity?.registries?.remote;
  if (!identity || !remote) return;
  if (remote.requestId !== payload.requestId) return;
  if (remote.status !== "pending") return;

  // expiresAt guard — flip status to expired and exit if past expiry.
  if (remote.expiresAt && new Date(remote.expiresAt).getTime() < Date.now()) {
    persistRemote({ ...remote, status: "expired" });
    return;
  }

  // Stale-attempt guard — exit cleanly if a more recent attempt has already
  // been scheduled. This is the application-level "most-recent-attempt-only"
  // guarantee that replaces BullMQ's jobId-based dedup for the rescheduled path.
  if (
    payload.scheduledFor !== undefined &&
    remote.nextPollAt &&
    payload.scheduledFor < new Date(remote.nextPollAt).getTime()
  ) {
    return;
  }

  // Read requestSecret from Nango (never cached). Request-scoped by
  // `payload.requestId` (cinatra#899) — this handler only ever reads the secret
  // for the request it validated at entry, never a concurrent re-request's.
  const requestSecret = await readRegistryCredential(
    remote.namespace,
    "request-secret",
    payload.requestId,
  );
  if (!requestSecret) {
    console.warn(
      "[registry-poll] secret-missing",
      redactSensitive({ requestId: payload.requestId }),
    );
    persistRemote({
      ...remote,
      status: "error",
      terminalReason: SECRET_MISSING_REASON,
    });
    return;
  }

  // GET the registry. Treat thrown network errors as 5xx for backoff.
  let res: Response;
  try {
    res = await fetchWithTimeout(`${REMOTE_REGISTRY_URL}/api/register/${payload.requestId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${requestSecret}` },
    });
  } catch (err) {
    const nowIso = new Date().toISOString();
    const nextDelayMs = deriveNext5xxBackoffMs(remote);
    const rescheduleResult = await reschedule(
      payload.requestId,
      nextDelayMs,
      remote.expiresAt,
    );
    if (rescheduleResult === null) {
      // Post-expiry short-circuit.
      persistRemote({ ...remote, status: "expired", lastPolledAt: nowIso });
      return;
    }
    // Same-source timestamp.
    persistRemote({
      ...remote,
      lastPolledAt: nowIso,
      nextPollAt: new Date(rescheduleResult.scheduledFor).toISOString(),
    });
    console.warn(
      "[registry-poll] network-error",
      redactSensitive({ requestId: payload.requestId, error: err }),
    );
    return;
  }

  // Branch on response.
  const status = res.status;

  if (status === 200) {
    let body: { status?: string; pollIntervalSeconds?: number; token?: string; reason?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Malformed 200 — treat as 5xx.
      const nowIso = new Date().toISOString();
      const nextDelayMs = deriveNext5xxBackoffMs(remote);
      const rescheduleResult = await reschedule(
        payload.requestId,
        nextDelayMs,
        remote.expiresAt,
      );
      if (rescheduleResult === null) {
        persistRemote({ ...remote, status: "expired", lastPolledAt: nowIso });
        return;
      }
      persistRemote({
        ...remote,
        lastPolledAt: nowIso,
        nextPollAt: new Date(rescheduleResult.scheduledFor).toISOString(),
      });
      return;
    }

    if (body.status === "pending") {
      const pollIntervalSeconds =
        typeof body.pollIntervalSeconds === "number" && body.pollIntervalSeconds > 0
          ? body.pollIntervalSeconds
          : 30;
      const nowIso = new Date().toISOString();
      let rescheduleResult: { scheduledFor: number } | null = null;
      try {
        rescheduleResult = await reschedule(
          payload.requestId,
          pollIntervalSeconds * 1000,
          remote.expiresAt,
        );
      } catch (rescheduleErr) {
        // 200-pending reschedule failure — Redis outage. Do NOT throw — that
        // would cause BullMQ-level retry on top of the state-machine reschedule
        // and double-process this same persistRemote.
        console.warn(
          "[registry-poll] reschedule-failed",
          redactSensitive({ requestId: payload.requestId, error: rescheduleErr }),
        );
      }
      if (rescheduleResult === null) {
        // Post-expiry short-circuit.
        persistRemote({ ...remote, status: "expired", lastPolledAt: nowIso });
        return;
      }
      // Same-source timestamp.
      persistRemote({
        ...remote,
        lastPolledAt: nowIso,
        nextPollAt: new Date(rescheduleResult.scheduledFor).toISOString(),
      });
      return;
    }

    if (body.status === "approved") {
      // 200 approved branch — security-critical credential ordering.
      const token = body.token;
      if (typeof token !== "string" || token.length === 0) {
        // Malformed approved — treat as 5xx.
        const nowIso = new Date().toISOString();
        const nextDelayMs = deriveNext5xxBackoffMs(remote);
        const rescheduleResult = await reschedule(
          payload.requestId,
          nextDelayMs,
          remote.expiresAt,
        );
        if (rescheduleResult === null) {
          persistRemote({ ...remote, status: "expired", lastPolledAt: nowIso });
          return;
        }
        persistRemote({
          ...remote,
          lastPolledAt: nowIso,
          nextPollAt: new Date(rescheduleResult.scheduledFor).toISOString(),
        });
        return;
      }

      try {
        await writeRegistryCredential(
          remote.namespace,
          "token",
          payload.requestId,
          token,
        );
      } catch (err) {
        // Drop token from process memory. No caching. No log emission of the token.
        try {
          await deleteRegistryCredential(
            remote.namespace,
            "request-secret",
            payload.requestId,
          );
        } catch (cleanupErr) {
          console.warn(
            "[registry-poll] nango-failure-cleanup",
            redactSensitive(cleanupErr),
          );
        }
        const nangoFailOutcome = persistRemote({
          ...remote,
          status: "error",
          terminalReason: TOKEN_STORAGE_FAILED_REASON,
        });
        console.warn(
          "[registry-poll] nango-failure",
          redactSensitive({ requestId: payload.requestId, error: err }),
        );
        await reconcileUncommittedTerminalPersist(
          payload.requestId,
          nangoFailOutcome,
          remote.expiresAt,
        );
        return;
      }

      // Nango write succeeded. NOW delete this request's OWN request-secret —
      // request-scoped (cinatra#899), so this consumes only the secret for the
      // request just approved, never a concurrent re-request's.
      await deleteRegistryCredential(
        remote.namespace,
        "request-secret",
        payload.requestId,
      );
      const nowIso = new Date().toISOString();
      const { outcome: connectedOutcome, applied: connectedApplied, finalSlotIsThisRequest } =
        persistConnectedRemote({
          ...remote,
          status: "connected",
          approvedAt: nowIso,
          tokenUpdatedAt: nowIso,
          nangoCredentialRef: getRegistryCredentialRef(
            remote.namespace,
            "token",
            payload.requestId,
          ),
          denyReason: null,
          terminalReason: null,
        });

      if (connectedApplied && connectedOutcome === "swapped") {
        // This poll landed the connected transition. Audit emission — event tag
        // + requestId only. Never the token.
        console.log("[registry-poll] approved", { requestId: payload.requestId });
        return;
      }

      // The connected transition did NOT apply on this attempt. If the slot no
      // longer belongs to this request — cancelled (→ not_connected), superseded
      // by a fresh re-request (→ a DIFFERENT requestId), or the identity row is
      // gone/unusable — then the npm token we just wrote is orphaned (no slot
      // references it) and must be cleaned up (cinatra#899). Request-scoped keying
      // guarantees this delete only ever removes THIS request's token, never a
      // concurrent request's — and `finalSlotIsThisRequest` guards the benign
      // race where a SIBLING poller (a BullMQ tick vs. the manual "Refresh
      // status" action) already connected THIS same request: that token is LIVE,
      // so we must NOT delete it.
      if (
        !finalSlotIsThisRequest &&
        (connectedOutcome === "swapped" ||
          connectedOutcome === "no-identity" ||
          connectedOutcome === "aborted")
      ) {
        await deleteRegistryCredential(
          remote.namespace,
          "token",
          payload.requestId,
        ).catch((cleanupErr) => {
          console.warn(
            "[registry-poll] orphan-token-cleanup-failed",
            redactSensitive({ requestId: payload.requestId, error: cleanupErr }),
          );
        });
        console.log("[registry-poll] approved-superseded", {
          requestId: payload.requestId,
        });
        return;
      }

      // Otherwise the token is NOT orphaned:
      //   - a sibling poller already connected THIS request (finalSlotIsThisRequest,
      //     token is the live credential — keep it); or
      //   - the CAS could not commit under sustained contention
      //     (exhausted/unparseable) and the request may still be pending — keep the
      //     token and schedule ONE reconciliation poll so a later tick re-derives
      //     the terminal state (a re-poll re-writes the same token idempotently and
      //     reaches connected). Matches the #850 terminal-reconcile contract;
      //     `reconcileUncommittedTerminalPersist` is a no-op on a committed swap.
      await reconcileUncommittedTerminalPersist(
        payload.requestId,
        connectedOutcome,
        remote.expiresAt,
      );
      console.log("[registry-poll] approved", { requestId: payload.requestId });
      return;
    }

    if (body.status === "denied") {
      const nowIso = new Date().toISOString();
      await deleteRegistryCredential(
        remote.namespace,
        "request-secret",
        payload.requestId,
      );
      const deniedOutcome = persistRemote({
        ...remote,
        status: "denied",
        deniedAt: nowIso,
        denyReason: body.reason ?? null,
      });
      await reconcileUncommittedTerminalPersist(
        payload.requestId,
        deniedOutcome,
        remote.expiresAt,
      );
      return;
    }

    // 200 with unknown body.status — treat as 5xx-ish; re-poll.
    const nowIso = new Date().toISOString();
    const nextDelayMs = deriveNext5xxBackoffMs(remote);
    const rescheduleResult = await reschedule(
      payload.requestId,
      nextDelayMs,
      remote.expiresAt,
    );
    if (rescheduleResult === null) {
      persistRemote({ ...remote, status: "expired", lastPolledAt: nowIso });
      return;
    }
    persistRemote({
      ...remote,
      lastPolledAt: nowIso,
      nextPollAt: new Date(rescheduleResult.scheduledFor).toISOString(),
    });
    return;
  }

  if (status === 404) {
    await deleteRegistryCredential(
      remote.namespace,
      "request-secret",
      payload.requestId,
    );
    const notFoundOutcome = persistRemote({
      ...remote,
      status: "error",
      terminalReason: NOT_FOUND_REASON,
    });
    await reconcileUncommittedTerminalPersist(
      payload.requestId,
      notFoundOutcome,
      remote.expiresAt,
    );
    return;
  }

  if (status === 410) {
    let body: { status?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }
    await deleteRegistryCredential(
      remote.namespace,
      "request-secret",
      payload.requestId,
    );
    const goneOutcome =
      body.status === "expired"
        ? persistRemote({ ...remote, status: "expired" })
        : // "consumed" or unknown — terminal error.
          persistRemote({
            ...remote,
            status: "error",
            terminalReason: CONSUMED_REASON,
          });
    await reconcileUncommittedTerminalPersist(
      payload.requestId,
      goneOutcome,
      remote.expiresAt,
    );
    return;
  }

  if (status === 429) {
    const nowIso = new Date().toISOString();
    const retryAfterRaw = res.headers.get("retry-after") ?? "60";
    const parsed = parseInt(retryAfterRaw, 10);
    const retryAfterMs = (Number.isFinite(parsed) && parsed > 0 ? parsed : 60) * 1000;
    const rescheduleResult = await reschedule(
      payload.requestId,
      retryAfterMs,
      remote.expiresAt,
    );
    if (rescheduleResult === null) {
      // Post-expiry short-circuit.
      persistRemote({ ...remote, status: "expired", lastPolledAt: nowIso });
      return;
    }
    // Same-source timestamp.
    persistRemote({
      ...remote,
      lastPolledAt: nowIso,
      nextPollAt: new Date(rescheduleResult.scheduledFor).toISOString(),
    });
    return;
  }

  // 5xx (>=500) and unexpected (anything not handled above) — exponential backoff.
  if (status >= 500 || status < 200 || (status >= 300 && status < 400) || status === 401 || status === 403) {
    const nowIso = new Date().toISOString();
    const nextDelayMs = deriveNext5xxBackoffMs(remote);
    const rescheduleResult = await reschedule(
      payload.requestId,
      nextDelayMs,
      remote.expiresAt,
    );
    if (rescheduleResult === null) {
      persistRemote({ ...remote, status: "expired", lastPolledAt: nowIso });
      return;
    }
    persistRemote({
      ...remote,
      lastPolledAt: nowIso,
      nextPollAt: new Date(rescheduleResult.scheduledFor).toISOString(),
    });
    return;
  }

  // Truly unexpected status that doesn't match any branch — fall through to backoff.
  const nowIso = new Date().toISOString();
  const nextDelayMs = deriveNext5xxBackoffMs(remote);
  const rescheduleResult = await reschedule(
    payload.requestId,
    nextDelayMs,
    remote.expiresAt,
  );
  if (rescheduleResult === null) {
    persistRemote({ ...remote, status: "expired", lastPolledAt: nowIso });
    return;
  }
  persistRemote({
    ...remote,
    lastPolledAt: nowIso,
    nextPollAt: new Date(rescheduleResult.scheduledFor).toISOString(),
  });
  console.warn(
    "[registry-poll] unexpected-status",
    redactSensitive({ requestId: payload.requestId, status }),
  );
}
