"use server";

import { createHash } from "node:crypto";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAdminSession } from "@/lib/auth-session";
import { encryptSecret } from "@/lib/instance-secrets";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
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

function persistLocalRegistrySlot(
  identity: InstanceIdentity,
  next: RegistryConnection | null,
): void {
  const registries = { ...(identity.registries ?? {}) };
  if (next === null) {
    delete registries.local;
  } else {
    registries.local = next;
  }
  writeInstanceIdentity({
    ...identity,
    registries,
  });
}

function persistRemoteRegistrySlot(
  identity: InstanceIdentity,
  next: RemoteRegistryConnection | null,
): void {
  const registries = { ...(identity.registries ?? {}) };
  if (next === null) {
    delete registries.remote;
  } else {
    registries.remote = next;
  }
  writeInstanceIdentity({
    ...identity,
    registries,
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

  persistLocalRegistrySlot(identity, {
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
  persistLocalRegistrySlot(identity, null);
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
    res = await fetch(`${REMOTE_REGISTRY_URL}/api/register`, {
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

    persistRemoteRegistrySlot(identity, {
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

  try {
    await deleteRegistryCredential(namespace, "request-secret");
  } catch (err) {
    console.warn(
      "Failed to delete request-secret from Nango (cancel):",
      redactSensitive(err),
    );
    redirect(settingsRedirectUrl("error", "nango_unavailable"));
  }

  persistRemoteRegistrySlot(identity, {
    url: remote.url,
    namespace,
    status: "not_connected",
  });

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

  // Token revocation on the registry side is out of scope here —
  // operators must contact the registry admin out-of-band to revoke the
  // npm token. This action only removes the cinatra-side pickup of it.
  try {
    await deleteRegistryCredential(namespace, "token");
  } catch (err) {
    console.warn(
      "Failed to delete token from Nango (disconnect):",
      redactSensitive(err),
    );
    redirect(settingsRedirectUrl("error", "nango_unavailable"));
  }

  persistRemoteRegistrySlot(identity, {
    url: remote.url,
    namespace,
    status: "not_connected",
  });

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

  persistRemoteRegistrySlot(identity, {
    url: remote!.url,
    namespace,
    status: "not_connected",
  });

  revalidatePath(SETTINGS_REVALIDATE_PATH);
  redirect(settingsRedirectUrl("ok", "requested-reset"));
}
