import {
  clearNangoConnectionRecords,
  deleteNangoConnection,
  getNangoConnection,
  getPrimarySavedNangoConnection,
  isNangoConfigured,
} from "@/lib/nango-system";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import type { ActorContext } from "@/lib/authz";
import { readNangoConnectionByNaturalKey } from "@cinatra-ai/extensions/connection-identity-store";
import { enforceConnectionUse, ConnectionUseDeniedError } from "@/lib/connection-use-gate";

// The runtime YouTube mint is a GLOBAL, actor-less reader: its single
// consumer is the in-process media-feeds scraper service
// (register-host-connector-services.ts → HostYouTubeConnectionService.
// getConfiguredAccessToken, no arguments). It therefore must resolve ONLY an
// app/org-scoped credential — never a per-user one. We read with
// { scope: "app" } so a user-scoped record is invisible here, and we fail
// CLOSED: when no app-scoped saved connection exists we return null instead of
// minting from the legacy default provider/connection ids (which would re-fetch
// a Nango connection outside the scope filter and reintroduce the leak).
const YOUTUBE_APP_SCOPE = { scope: "app" } as const;

export async function getConfiguredYouTubeAccessToken() {
  if (!isNangoConfigured()) {
    return null;
  }

  const savedConnection = getPrimarySavedNangoConnection("youtube", YOUTUBE_APP_SCOPE);
  if (!savedConnection) {
    return null;
  }

  // Per-connection use-gate (cinatra#952 W2): the in-process scraper mint is
  // audited as an InternalWorker BOUND to the identity row's organization (so
  // the cross-org guard and a workspace grant evaluate correctly). Legacy
  // app-scope connections stay usable via the core__0015 workspace grant
  // seed, not an exemption; a deny (or a connection with no identity row)
  // fails CLOSED to the same null contract as a missing connection.
  const identity = await readNangoConnectionByNaturalKey(
    "youtube",
    savedConnection.connectionId,
  );
  if (!identity) return null;
  const workerActor: ActorContext = {
    principalType: "InternalWorker",
    principalId: "worker:media-feeds-scraper",
    organizationId: identity.organizationId ?? undefined,
    teamIds: [],
    projectGrants: [],
    projectIds: [],
    authSource: "worker",
    policyVersion: POLICY_VERSION,
  };
  try {
    await enforceConnectionUse({
      identity,
      actor: workerActor,
      subjectUserId: undefined,
      source: "youtube-api",
    });
  } catch (err) {
    if (err instanceof ConnectionUseDeniedError) return null;
    throw err;
  }

  const connection = await getNangoConnection(
    savedConnection.providerConfigKey,
    savedConnection.connectionId,
    { forceRefresh: true, refreshToken: true },
  );
  const credentials = (connection as {
    credentials?: {
      type?: string;
      access_token?: string;
    };
  } | null)?.credentials;

  if (credentials?.type === "OAUTH2" && typeof credentials.access_token === "string" && credentials.access_token.trim()) {
    return credentials.access_token;
  }

  return null;
}

export function getYouTubeAPIStatus() {
  const savedConnection = getPrimarySavedNangoConnection("youtube", YOUTUBE_APP_SCOPE);
  if (savedConnection) {
    return {
      status: "connected" as const,
      detail: `Connected${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}.`,
    };
  }

  return {
    status: "not_connected" as const,
    detail: "Connect your YouTube account to enable YouTube episode discovery.",
  };
}

export async function clearYouTubeAPISettings() {
  const savedConnection = getPrimarySavedNangoConnection("youtube", YOUTUBE_APP_SCOPE);
  if (savedConnection) {
    await deleteNangoConnection(savedConnection.providerConfigKey, savedConnection.connectionId);
  }
  // Scope the record clear to the app: this is the GLOBAL, actor-less surface,
  // so it must only ever touch app-scoped pointers — clearing without a scope
  // would also wipe per-user YouTube connection records.
  await clearNangoConnectionRecords("youtube", YOUTUBE_APP_SCOPE);
}
