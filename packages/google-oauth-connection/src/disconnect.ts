import {
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  clearNangoConnectionRecords,
  deleteNangoConnection,
  getNangoOAuthCallbackUrl,
  getPrimarySavedNangoConnection,
} from "@/lib/nango-system";
import { writeStoredGoogleOAuthSettings } from "./index";

// ---------------------------------------------------------------------------
// Google OAuth DISCONNECT surface (org-level + per-user), split out of the
// package barrel ON PURPOSE (cinatra#952 W2).
//
// WHY a separate module: the disconnect path owns the cinatra#952 revocation
// ordering — soft-delete the `nango_connection` identity row FIRST so the
// per-connection use-gate fails closed on the very next resolution, THEN the
// upstream token, THEN the pointer records. That ordering imports the
// connection-identity-store; the barrel (./index) is on the static graph of
// every server consumer of the facade — including /sign-in via auth.ts +
// layout.tsx — and /sign-in's route-graph-ratchet ceiling (132 first-party
// modules) is a locked dev-perf budget. Keeping the identity-store edge here,
// UNREACHABLE from the barrel (deliberately not re-exported), keeps /sign-in
// at its ceiling while preserving the ordering invariant verbatim.
//
// Import via the `@cinatra-ai/google-oauth-connection/disconnect` alias.
// ---------------------------------------------------------------------------

/** Soft-delete the `nango_connection` identity row for a connection so the
 * cinatra#952 use-gate fails closed on the next resolution (revocation
 * ordering: identity FIRST, then upstream token, then pointer records).
 * Best-effort in degraded/unit contexts where the identity store is not
 * provisioned. */
async function softDeleteConnectionIdentity(
  connectorKey: string,
  connectionId: string | undefined,
): Promise<void> {
  if (!connectionId) return;
  try {
    const { readNangoConnectionByNaturalKey, softDeleteNangoConnection } = await import(
      "@cinatra-ai/extensions/connection-identity-store"
    );
    const identity = await readNangoConnectionByNaturalKey(connectorKey, connectionId);
    if (identity) await softDeleteNangoConnection(identity.id);
  } catch {
    // Identity store unavailable (unit env) — the delete below still removes
    // the credential itself.
  }
}

export async function clearGoogleOAuthConnection() {
  writeStoredGoogleOAuthSettings({
    redirectUri: getNangoOAuthCallbackUrl(),
  });
  const savedConnection = getPrimarySavedNangoConnection("googleOAuth");
  // Revocation ordering (cinatra#952 W2): soft-delete the identity row FIRST
  // so the per-connection use-gate fails closed on the very next resolution,
  // then the upstream token, then the pointer records below.
  await softDeleteConnectionIdentity("googleOAuth", savedConnection?.connectionId);
  await deleteNangoConnection(
    savedConnection?.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.googleOAuth,
    savedConnection?.connectionId ?? "cinatra-google-oauth",
  );
  await clearNangoConnectionRecords("googleOAuth");
}

export async function clearUserGoogleOAuthConnection(userId: string) {
  const savedConnection = getPrimarySavedNangoConnection("googleOAuth", {
    scope: "user",
    userId,
  });

  if (savedConnection) {
    // Same revocation ordering as the org-level clear: identity row first.
    await softDeleteConnectionIdentity("googleOAuth", savedConnection.connectionId);
    await deleteNangoConnection(
      savedConnection.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.googleOAuth,
      savedConnection.connectionId,
    );
  }

  await clearNangoConnectionRecords("googleOAuth", {
    scope: "user",
    userId,
  });
}
