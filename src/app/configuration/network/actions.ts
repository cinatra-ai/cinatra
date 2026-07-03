"use server";

import { createHash } from "node:crypto";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAdminSession } from "@/lib/auth-session";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { encryptSecret } from "@/lib/instance-secrets";
import {
  readInstanceIdentity,
  updateInstanceIdentityRegistries,
  type InstanceIdentity,
  type RegistryConnection,
  type RemoteRegistryConnection,
} from "@/lib/instance-identity-store";
import {
  deleteRegistryCredential,
  writeRegistryCredential,
} from "@/lib/registry-credentials";
import { redactSensitive } from "@/lib/redact-sensitive";
import { BACKGROUND_JOB_NAMES, enqueueBackgroundJob } from "@/lib/background-jobs";
import { runRegistryPollJob } from "@/lib/registry-poll-job";

const SETTINGS_PATH = "/configuration/environment?tab=registries";
const SETTINGS_REVALIDATE_PATH = "/configuration/environment";

function settingsRedirectUrl(param: "ok" | "error", value: string): string {
  return `${SETTINGS_PATH}&${param}=${encodeURIComponent(value)}`;
}

const REMOTE_REGISTRY_URL = "https://registry.cinatra.ai";

const DEFAULT_LOCAL_REGISTRY_URL = "http://127.0.0.1:4873";
void DEFAULT_LOCAL_REGISTRY_URL;

function redirectWithError(message: string): never {
  redirect(settingsRedirectUrl("error", message));
}

function getInstanceUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    "http://localhost:3000"
  );
}

function ensureIdentityWithNamespace(): InstanceIdentity {
  const current = readInstanceIdentity();
  if (!current || !current.instanceNamespace) {
    redirectWithError("Complete instance setup before configuring registries.");
  }
  return current;
}

// Registry-slot writers. Cross-process-safe (cinatra#850): these persist a
// single `registries` slot via a row-level CAS with bounded retry
// (`updateInstanceIdentityRegistries`) instead of the former lock-free whole-row
// overwrite that spread a STALE `identity` (read before an HTTP/Nango await)
// across the write — which could clobber a concurrent registry-poll worker write
// to `registries.remote` and stale-spread other identity fields. The CAS
// re-reads the fresh row each attempt, so the untouched slot and every other
// field are preserved; only the targeted slot is set/deleted.
function persistLocalRegistrySlot(next: RegistryConnection | null) {
  return updateInstanceIdentityRegistries((registries) => {
    const updated = { ...registries };
    if (next === null) {
      delete updated.local;
    } else {
      updated.local = next;
    }
    return updated;
  });
}

// Unconditional remote-slot writer for the request-ESTABLISH path
// (`requestRemoteAccessAction`), which intentionally installs a brand-new
// pending request. The operator-teardown actions (cancel/disconnect/reset) do
// NOT use this — they call `updateInstanceIdentityRegistries` directly with a
// STATE-AWARE mutation so a stale teardown never clobbers a newer request the
// worker or another tab produced in the meantime. Returns the CAS outcome so
// callers can react to a persist that did not land.
function persistRemoteRegistrySlot(next: RemoteRegistryConnection | null) {
  return updateInstanceIdentityRegistries((registries) => {
    const updated = { ...registries };
    if (next === null) {
      delete updated.remote;
    } else {
      updated.remote = next;
    }
    return updated;
  });
}

/**
 * Deterministic Idempotency-Key for POST /api/register so that
 * a network-blip retry on the same UTC day with identical inputs collapses
 * to the registry's idempotency cache (REGISTRY-CONTRACT.md §6) instead of
 * creating a duplicate row.
 *
 * The day-bucket (`Math.floor(Date.now() / 86_400_000)`) ensures that retries
 * spanning a UTC midnight produce DIFFERENT keys — that's the deliberate
 * boundary. The hash is one-way; the registry cannot recover the inputs from
 * the key (so the key is safe to log if needed for debugging).
 */
function buildIdempotencyKey({
  namespace,
  instanceUrl,
  contactEmail,
}: {
  namespace: string;
  instanceUrl: string;
  contactEmail: string;
}): string {
  const dayBucket = Math.floor(Date.now() / 86_400_000);
  return createHash("sha256")
    .update(`${namespace}|${instanceUrl}|${contactEmail}|${dayBucket}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// LOCAL REGISTRY — paste-and-save (URL + token), no out-of-band request flow.
// ---------------------------------------------------------------------------

export async function setLocalRegistryAction(formData: FormData): Promise<void> {
  await requireAdminSession();

  const rawUrl = formData.get("url");
  const rawToken = formData.get("token");
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
  const token = typeof rawToken === "string" ? rawToken.trim() : "";

  if (!url) redirectWithError("Registry URL is required.");
  try {
    new URL(url);
  } catch {
    redirectWithError("Registry URL is not a valid URL.");
  }
  const identity = ensureIdentityWithNamespace();
  const existingLocal = identity.registries?.local ?? null;

  if (!existingLocal && token.length < 16) {
    redirectWithError("Token must be at least 16 characters.");
  }
  if (token && token.length < 16) {
    redirectWithError("Token must be at least 16 characters.");
  }

  const enc = token ? encryptSecret(token, "vendor.token") : null;

  // The keep-existing-token branch reads from the pre-await `existingLocal`
  // snapshot; the CAS write below still preserves the fresh sibling `remote`
  // slot and every other field. Two concurrent edits to the SAME local slot
  // remain last-writer-wins by design (an operator save intentionally sets it).
  persistLocalRegistrySlot({
    url,
    tokenCiphertext: enc?.ciphertext ?? existingLocal!.tokenCiphertext,
    tokenIv: enc?.iv ?? existingLocal!.tokenIv,
    tokenAlgo: "aes-256-gcm",
    tokenUpdatedAt: enc ? new Date().toISOString() : existingLocal!.tokenUpdatedAt,
  });

  revalidatePath(SETTINGS_REVALIDATE_PATH);
  redirect(settingsRedirectUrl("ok", "local-saved"));
}

export async function disconnectLocalRegistryAction(): Promise<void> {
  await requireAdminSession();
  const identity = readInstanceIdentity();
  if (!identity) redirect(settingsRedirectUrl("ok", "local-disconnected"));
  persistLocalRegistrySlot(null);
  revalidatePath(SETTINGS_REVALIDATE_PATH);
  redirect(settingsRedirectUrl("ok", "local-disconnected"));
}

// ---------------------------------------------------------------------------
// REMOTE REGISTRY (public registry, e.g. registry.cinatra.ai) — polling flow:
//   not_connected → request → POST /api/register (201) → write Nango secret →
//   write local pending row → enqueue REGISTRY_POLL → poll → connected/denied/
//   expired/error
// Cancel from pending is local-only. Disconnect from connected clears
// the Nango token credential and resets the slot. Reset clears terminal-state
// rows back to not_connected.
// ---------------------------------------------------------------------------

export async function requestRemoteAccessAction(formData: FormData): Promise<void> {
  await requireAdminSession();

  const rawEmail = formData.get("contactEmail");
  const contactEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";
  if (!contactEmail || !/.+@.+\..+/.test(contactEmail)) {
    redirectWithError("Enter a valid contact email.");
  }

  const identity = ensureIdentityWithNamespace();
  const namespace = identity.instanceNamespace;
  if (!namespace) {
    // ensureIdentityWithNamespace guarantees this, but TS can't narrow it
    // through the helper boundary.
    redirectWithError("Complete instance setup before configuring registries.");
  }
  const instanceUrl = getInstanceUrl();
  const idempotencyKey = buildIdempotencyKey({ namespace, instanceUrl, contactEmail });

  // POST first — we intentionally do NOT persist any local row before the
  // registry returns 201 (orphan-pending-row recovery requires the registry
  // has accepted the request before the local slot believes it's pending).
  let res: Response;
  try {
    // Bounded so a hung registry can't pin this server action indefinitely
    // (mirrors the registry-poll job). A timeout throw hits the same catch and
    // redirects with registry_unreachable — no behavior change beyond the wait.
    res = await fetchWithTimeout(`${REMOTE_REGISTRY_URL}/api/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ namespace, instanceUrl, contactEmail }),
    });
  } catch (err) {
    console.warn("Registry register POST failed:", redactSensitive(err));
    redirect(settingsRedirectUrl("error", "registry_unreachable"));
  }

  if (res.status === 201) {
    // REGISTRY-CONTRACT.md §5: 201 returns exactly { requestId, requestSecret,
    // expiresAt, pollIntervalSeconds }. Do NOT destructure a `status` field
    // (it is not in the response shape).
    let body: {
      requestId?: string;
      requestSecret?: string;
      expiresAt?: string;
      pollIntervalSeconds?: number;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      console.warn("Registry 201 body was not valid JSON:", redactSensitive(err));
      redirect(settingsRedirectUrl("error", "registry_unreachable"));
    }
    const requestId = body.requestId;
    const requestSecret = body.requestSecret;
    const expiresAt = body.expiresAt;
    const pollIntervalSeconds = body.pollIntervalSeconds;
    if (
      !requestId ||
      !requestSecret ||
      !expiresAt ||
      typeof pollIntervalSeconds !== "number"
    ) {
      console.warn(
        "Registry 201 body missing required fields:",
        redactSensitive(body),
      );
      redirect(settingsRedirectUrl("error", "registry_unreachable"));
    }

    // Order is mandatory: Nango first, THEN local row, THEN enqueue. If Nango
    // fails, no local pending row is persisted — this enables orphan-pending-row
    // recovery (the registry has the request and will replay the same 201
    // within 24h via the Idempotency-Key cache once Nango is fixed).
    try {
      await writeRegistryCredential(namespace, "request-secret", requestSecret);
    } catch (err) {
      console.warn(
        "Failed to persist request-secret to Nango:",
        redactSensitive(err),
      );
      redirect(settingsRedirectUrl("error", "nango_unavailable"));
    }

    const persistOutcome = persistRemoteRegistrySlot({
      url: REMOTE_REGISTRY_URL,
      namespace,
      requestId,
      expiresAt,
      status: "pending",
      contactEmail,
      requestedAt: new Date().toISOString(),
      lastPolledAt: null,
      nextPollAt: new Date(Date.now() + pollIntervalSeconds * 1000).toISOString(),
    });
    if (persistOutcome !== "swapped") {
      // The pending row did not land (realistically only "exhausted" under
      // sustained CAS contention on the identity row). Roll back the
      // request-secret we just wrote so no Nango credential is stranded for a
      // request with no local row, then surface an error instead of claiming
      // ok=requested. The operator retries and the registry replays the same
      // 201 within 24h via the Idempotency-Key cache — the same orphan-recovery
      // contract as the Nango-first ordering above.
      try {
        await deleteRegistryCredential(namespace, "request-secret");
      } catch (err) {
        console.warn(
          "Failed to roll back request-secret after pending-row persist failure:",
          redactSensitive(err),
        );
      }
      console.warn(
        "[registry] pending-row persist did not land",
        redactSensitive({ outcome: persistOutcome }),
      );
      redirect(settingsRedirectUrl("error", "registry_unreachable"));
    }

    try {
      await enqueueBackgroundJob(
        BACKGROUND_JOB_NAMES.REGISTRY_POLL,
        { requestId },
        {
          jobId: `registry-poll:${requestId}`,
          delay: pollIntervalSeconds * 1000,
        },
      );
    } catch (err) {
      console.warn(
        "Failed to enqueue REGISTRY_POLL job:",
        redactSensitive(err),
      );
      // The local pending row already exists; the next page load (or a
      // crash-restart re-enqueue) will drive it forward. Surface the
      // request as accepted so the operator sees pending state.
    }

    revalidatePath(SETTINGS_REVALIDATE_PATH);
    redirect(settingsRedirectUrl("ok", "requested"));
  }

  if (res.status === 409) {
    let body: { error?: { code?: string } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Fall through to registry_unreachable.
    }
    const code = body.error?.code;
    if (
      code === "namespace_taken" ||
      code === "request_in_flight" ||
      code === "idempotency_conflict"
    ) {
      redirect(settingsRedirectUrl("error", code));
    }
    // Unknown 409 code — treat as unreachable / contract drift.
    redirect(settingsRedirectUrl("error", "registry_unreachable"));
  }

  // Anything else (4xx other than 409, 5xx, etc.) — registry-unreachable.
  // Do NOT persist a pending row (no requestId to track).
  console.warn(
    "Registry register POST returned non-success status:",
    redactSensitive({ status: res.status }),
  );
  redirect(settingsRedirectUrl("error", "registry_unreachable"));
}

/**
 * Synchronous registry poll triggered by the "Refresh status" button.
 *
 * The BullMQ poll loop is the steady-state driver, but a button labelled
 * "Refresh status" must actually re-check the registry — `router.refresh()`
 * alone only re-reads the same local DB row and never surfaces a transition.
 * We run a single poll attempt inline and revalidate the page; if the
 * registry has approved/denied/expired since the last loop iteration, the
 * card flips immediately on the redirect that follows.
 *
 * The handler is idempotent and short-circuits cleanly on non-pending state,
 * so racing the button with a BullMQ worker tick is safe.
 */
export async function pollRemoteRequestNowAction(): Promise<void> {
  await requireAdminSession();
  const identity = ensureIdentityWithNamespace();
  const remote = identity.registries?.remote;
  if (!remote || remote.status !== "pending" || !remote.requestId) {
    revalidatePath(SETTINGS_REVALIDATE_PATH);
    redirect(SETTINGS_PATH);
  }
  try {
    await runRegistryPollJob({ requestId: remote.requestId });
  } catch (err) {
    console.warn("Manual registry poll failed:", redactSensitive(err));
  }
  revalidatePath(SETTINGS_REVALIDATE_PATH);
  redirect(SETTINGS_PATH);
}

export async function cancelRemoteRequestAction(): Promise<void> {
  await requireAdminSession();
  const identity = ensureIdentityWithNamespace();
  const namespace = identity.instanceNamespace;
  if (!namespace) {
    redirectWithError("Complete instance setup before configuring registries.");
  }
  const remote = identity.registries?.remote;

  if (!remote || remote.status !== "pending") {
    // Idempotent: nothing to cancel.
    revalidatePath(SETTINGS_REVALIDATE_PATH);
    redirect(settingsRedirectUrl("ok", "cancelled"));
  }
  // The specific pending request this action intends to cancel.
  const cancelledRequestId = remote.requestId ?? null;

  try {
    await deleteRegistryCredential(namespace, "request-secret");
  } catch (err) {
    console.warn(
      "Failed to delete request-secret from Nango (cancel):",
      redactSensitive(err),
    );
    redirect(settingsRedirectUrl("error", "nango_unavailable"));
  }

  // State-aware CAS (cinatra#850): only revert to not_connected if the freshly
  // re-read slot is STILL the SAME pending request read above. A concurrent
  // registry-poll worker can advance it (e.g. to `connected`), and a
  // cancel-then-re-request can replace it with a DIFFERENT pending request; in
  // either case cancelling must NOT clobber that newer authoritative state.
  // When the fresh slot has moved on, leave it untouched (the redirect
  // re-renders the real state). The sibling `local` slot and every other field
  // are preserved by the CAS re-read regardless.
  const cancelOutcome = updateInstanceIdentityRegistries((registries) => {
    const fresh = registries.remote;
    if (fresh?.status !== "pending" || (fresh.requestId ?? null) !== cancelledRequestId) {
      return registries;
    }
    return {
      ...registries,
      remote: { url: fresh.url, namespace, status: "not_connected" },
    };
  });
  if (cancelOutcome !== "swapped") {
    // The not_connected reset did not land (realistically only "exhausted"
    // under sustained CAS contention on the identity row). The request-secret
    // is already deleted, so do NOT claim ok=cancelled — surface an error. The
    // operator retries; the idempotent secret-delete + CAS re-run then resolves
    // it (cinatra#850). A slot that legitimately moved on returns "swapped" (the
    // no-op re-read) and correctly falls through to the ok redirect below.
    console.warn(
      "[registry] cancel slot reset did not commit",
      redactSensitive({ outcome: cancelOutcome }),
    );
    redirect(settingsRedirectUrl("error", "registry_unreachable"));
  }

  // Best-effort BullMQ cancel is NOT attempted from the action. The repo does
  // not expose a generic queue-handle helper; rather than invent one, rely on
  // the REGISTRY_POLL handler reading the local `registries.remote.status`
  // first thing and exiting cleanly when it is no longer "pending"
  // (status-guard). Worst case: one extra HTTP poll observes the flipped state
  // and exits — an accepted trade-off.

  revalidatePath(SETTINGS_REVALIDATE_PATH);
  redirect(settingsRedirectUrl("ok", "cancelled"));
}

export async function disconnectRemoteRegistryAction(): Promise<void> {
  await requireAdminSession();
  const identity = readInstanceIdentity();
  if (!identity) redirect(settingsRedirectUrl("ok", "remote-disconnected"));
  const namespace = identity.instanceNamespace;
  if (!namespace) {
    // Without a namespace the slot can't have been written; idempotent exit.
    revalidatePath(SETTINGS_REVALIDATE_PATH);
    redirect(settingsRedirectUrl("ok", "remote-disconnected"));
  }
  const remote = identity.registries?.remote;
  if (!remote || remote.status !== "connected") {
    // Idempotent on non-connected states; nothing to clean up.
    revalidatePath(SETTINGS_REVALIDATE_PATH);
    redirect(settingsRedirectUrl("ok", "remote-disconnected"));
  }
  // The specific connected request this action intends to disconnect.
  const disconnectRequestId = remote.requestId ?? null;

  // Token revocation on the registry side is out of scope here —
  // operators must contact the registry admin out-of-band to revoke the
  // npm token. This action only removes the cinatra-side pickup of it.
  //
  // NOTE (cinatra#850 residual): the Nango `token` credential is namespace-keyed
  // (not request-scoped), so this delete targets whatever the namespace slot
  // holds. The DB-row guard below is request-identity-aware and never clobbers a
  // newer request, but namespace-keyed credential deletes across concurrent
  // requests are a separate, pre-existing concern tracked in cinatra#899
  // (request-scoped registry credentials).
  try {
    await deleteRegistryCredential(namespace, "token");
  } catch (err) {
    console.warn(
      "Failed to delete token from Nango (disconnect):",
      redactSensitive(err),
    );
    redirect(settingsRedirectUrl("error", "nango_unavailable"));
  }

  // State-aware CAS (cinatra#850): only clear the slot if it is STILL the SAME
  // connected request read above (matching `requestId`). Reconcile never changes
  // `connected` status, but a concurrent teardown + re-request could install a
  // DIFFERENT request; do not clobber that newer state. The sibling `local` slot
  // and every other field are preserved by the CAS re-read.
  const disconnectOutcome = updateInstanceIdentityRegistries((registries) => {
    const fresh = registries.remote;
    if (fresh?.status !== "connected" || (fresh.requestId ?? null) !== disconnectRequestId) {
      return registries;
    }
    return {
      ...registries,
      remote: { url: fresh.url, namespace, status: "not_connected" },
    };
  });
  if (disconnectOutcome !== "swapped") {
    // The not_connected clear did not land (realistically only "exhausted"
    // under sustained CAS contention). The token is already deleted from Nango,
    // so the slot would otherwise stay `connected` pointing at a dead
    // credential — do NOT claim ok=remote-disconnected. Surface an error; the
    // operator retries and the idempotent token-delete + CAS re-run resolves it
    // (cinatra#850). A slot that moved on returns "swapped" and falls through.
    console.warn(
      "[registry] disconnect slot clear did not commit",
      redactSensitive({ outcome: disconnectOutcome }),
    );
    redirect(settingsRedirectUrl("error", "registry_unreachable"));
  }

  revalidatePath(SETTINGS_REVALIDATE_PATH);
  redirect(settingsRedirectUrl("ok", "remote-disconnected"));
}

/**
 * Terminal-state recovery counterpart to `cancelRemoteRequestAction` (which
 * only handles `pending`) and `disconnectRemoteRegistryAction` (which only
 * handles `connected`). Operators land here from the denied / expired /
 * error UI views via the "Submit a new request" CTA.
 *
 * Guards:
 *   - `connected` and `pending` → no-op (the operator must use the
 *     dedicated disconnect / cancel actions; this prevents accidentally
 *     orphaning a live npm token in Nango).
 *   - `not_connected` / absent → idempotent no-op (still redirects so the
 *     operator gets a deterministic terminal state).
 *   - `denied` / `expired` / `error` → BOTH Nango credentials are
 *     idempotently deleted (the error state can come from a partial Nango-
 *     write success) and the slot is reset.
 */
export async function resetRemoteRegistryAction(): Promise<void> {
  await requireAdminSession();
  const identity = ensureIdentityWithNamespace();
  const namespace = identity.instanceNamespace;
  if (!namespace) {
    redirectWithError("Complete instance setup before configuring registries.");
  }
  const remote = identity.registries?.remote;

  const isTerminal =
    remote?.status === "denied" ||
    remote?.status === "expired" ||
    remote?.status === "error";

  if (!isTerminal) {
    // connected / pending / not_connected / absent — all no-ops.
    revalidatePath(SETTINGS_REVALIDATE_PATH);
    redirect(settingsRedirectUrl("ok", "requested-reset"));
  }
  // The specific terminal request this action intends to reset.
  const resetRequestId = remote?.requestId ?? null;

  // Both deletes attempted because the error state can come from a partial
  // Nango-write success — the request-secret may have been deleted but the
  // token write failed, OR vice versa. Cleaning both leaves no dangling
  // credentials. Idempotent: a Nango error is logged and swallowed so the
  // local slot reset still proceeds (operator can always retry).
  try {
    await deleteRegistryCredential(namespace, "request-secret");
  } catch (err) {
    console.warn(
      "Failed to delete request-secret from Nango (reset):",
      redactSensitive(err),
    );
  }
  try {
    await deleteRegistryCredential(namespace, "token");
  } catch (err) {
    console.warn(
      "Failed to delete token from Nango (reset):",
      redactSensitive(err),
    );
  }

  // State-aware CAS (cinatra#850): only reset if the slot is STILL the SAME
  // terminal request read above (matching `requestId`). If a fresh request moved
  // it to pending/connected — or a different terminal request replaced it — in
  // the window since our terminal read, do not clobber that newer request. The
  // sibling `local` slot and every other field are preserved by the CAS re-read.
  //
  // NOTE (cinatra#850 residual): the two namespace-keyed Nango credential deletes
  // above are not request-scoped; the DB-row guard here never clobbers a newer
  // request, but concurrent-request credential deletes are tracked in cinatra#899.
  const resetOutcome = updateInstanceIdentityRegistries((registries) => {
    const fresh = registries.remote;
    const stillTerminal =
      fresh?.status === "denied" ||
      fresh?.status === "expired" ||
      fresh?.status === "error";
    if (!fresh || !stillTerminal || (fresh.requestId ?? null) !== resetRequestId) {
      return registries;
    }
    return {
      ...registries,
      remote: { url: fresh.url, namespace, status: "not_connected" },
    };
  });
  if (resetOutcome !== "swapped") {
    // The not_connected reset did not land (realistically only "exhausted"
    // under sustained CAS contention). Both Nango credentials are already
    // deleted, so do NOT claim ok=requested-reset — surface an error. The
    // operator retries; the idempotent deletes + CAS re-run resolve it
    // (cinatra#850). A slot that moved on returns "swapped" and falls through.
    console.warn(
      "[registry] reset slot did not commit",
      redactSensitive({ outcome: resetOutcome }),
    );
    redirect(settingsRedirectUrl("error", "registry_unreachable"));
  }

  revalidatePath(SETTINGS_REVALIDATE_PATH);
  redirect(settingsRedirectUrl("ok", "requested-reset"));
}
