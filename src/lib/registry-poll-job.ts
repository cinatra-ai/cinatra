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
import {
  readInstanceIdentity,
  writeInstanceIdentity,
  type RemoteRegistryConnection,
} from "@/lib/instance-identity-store";
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
 * Persist `next` into `instance_identity.registries.remote`. Skips writing if
 * there is no identity row at all (defensive — should never happen because the
 * handler's first guard re-reads identity).
 *
 * Duplication of the action-side helper is intentional: the action file is
 * `"use server"` and importing from a worker context would inflate the bundle.
 * The function is 6 lines — duplication is cheap.
 */
function persistRemote(next: RemoteRegistryConnection): void {
  const identity = readInstanceIdentity();
  if (!identity) return;
  const registries = { ...(identity.registries ?? {}) };
  registries.remote = next;
  writeInstanceIdentity({ ...identity, registries });
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

  // Read requestSecret from Nango (never cached).
  const requestSecret = await readRegistryCredential(remote.namespace, "request-secret");
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
    res = await fetch(`${REMOTE_REGISTRY_URL}/api/register/${payload.requestId}`, {
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
        await writeRegistryCredential(remote.namespace, "token", token);
      } catch (err) {
        // Drop token from process memory. No caching. No log emission of the token.
        try {
          await deleteRegistryCredential(remote.namespace, "request-secret");
        } catch (cleanupErr) {
          console.warn(
            "[registry-poll] nango-failure-cleanup",
            redactSensitive(cleanupErr),
          );
        }
        persistRemote({
          ...remote,
          status: "error",
          terminalReason: TOKEN_STORAGE_FAILED_REASON,
        });
        console.warn(
          "[registry-poll] nango-failure",
          redactSensitive({ requestId: payload.requestId, error: err }),
        );
        return;
      }

      // Nango write succeeded. NOW delete the request-secret.
      await deleteRegistryCredential(remote.namespace, "request-secret");
      const nowIso = new Date().toISOString();
      persistRemote({
        ...remote,
        status: "connected",
        approvedAt: nowIso,
        tokenUpdatedAt: nowIso,
        nangoCredentialRef: getRegistryCredentialRef(remote.namespace, "token"),
        denyReason: null,
        terminalReason: null,
      });
      // Audit emission — event tag + requestId only. Never the token.
      console.log("[registry-poll] approved", { requestId: payload.requestId });
      return;
    }

    if (body.status === "denied") {
      const nowIso = new Date().toISOString();
      await deleteRegistryCredential(remote.namespace, "request-secret");
      persistRemote({
        ...remote,
        status: "denied",
        deniedAt: nowIso,
        denyReason: body.reason ?? null,
      });
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
    await deleteRegistryCredential(remote.namespace, "request-secret");
    persistRemote({
      ...remote,
      status: "error",
      terminalReason: NOT_FOUND_REASON,
    });
    return;
  }

  if (status === 410) {
    let body: { status?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = {};
    }
    await deleteRegistryCredential(remote.namespace, "request-secret");
    if (body.status === "expired") {
      persistRemote({ ...remote, status: "expired" });
    } else {
      // "consumed" or unknown — terminal error.
      persistRemote({
        ...remote,
        status: "error",
        terminalReason: CONSUMED_REASON,
      });
    }
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
