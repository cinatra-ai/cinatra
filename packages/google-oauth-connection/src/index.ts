import {
  deleteConnectorConfig,
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";
import {
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  ensureNangoIntegration,
  getNangoConnection,
  getNangoOAuthCallbackUrl,
  getNangoSystem,
  getPrimarySavedNangoConnection,
} from "@/lib/nango-system";
// This package barrel is intentionally SERVER-ONLY and exposes the Google OAuth
// RUNTIME facade (settings/status/token refresh) consumed by auth.ts + layout.tsx
// + the host google-oauth-connector provider binder. The operator-facing setup UI
// lives IN the google-oauth-connector extension (its own setup-page →
// settings-form → settings-panel, behind the manage-gated save action). Keeping
// the barrel free of any "use client" form also keeps the @/app/campaigns/actions
// graph (-> agents/objects/mcp) out of every server consumer of this barrel.
//
// The DISCONNECT surface (clearGoogleOAuthConnection / clearUserGoogleOAuthConnection)
// lives in ./disconnect (alias @cinatra-ai/google-oauth-connection/disconnect) and is
// deliberately NOT re-exported here: its cinatra#952 revocation ordering imports the
// connection-identity-store, and re-exporting it would put that edge on the static
// graph of EVERY barrel consumer — including /sign-in, whose route-graph-ratchet
// ceiling (132) is a fought-for dev-perf budget.

type GoogleScopedConnectorKey = "googleOAuth" | "gmail" | "googleCalendar" | "youtube";

/** INTERNAL (shared with ./disconnect): shape of the stored `google_oauth` settings row. */
export type GoogleOAuthStoredSettings = {
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
};

/**
 * cinatra#2545 — the outcome of the LAST connection-service (Nango) mirror
 * attempt, kept in its OWN connector-config row (`google_oauth_nango_sync`).
 *
 * WHY A SEPARATE ROW (Codex round 2): recording the failure on the credential
 * row itself meant read-modify-writing that row from the failure path, which
 * can lose a concurrent save's newer credentials — the exact data-loss class
 * this change exists to remove. Writing the marker to its own key means the
 * failure path NEVER touches credentials at all, so the race cannot exist
 * rather than being narrowed.
 *
 * The marker is a HINT, never the arbiter: `getGoogleOAuthStatus` believes it
 * only while Nango genuinely does not hold the stored client, so a marker left
 * behind by a lost race (or resolved out of band) is harmless and self-heals.
 *
 * LEAK RAIL: a CLASSIFIED code and a timestamp — never provider-echoed text —
 * so a durable row can never become a leak vector for a credential a Nango
 * error body happened to echo back.
 */
type GoogleOAuthNangoSyncMarker = {
  status: "failed";
  code: NangoSyncFailureCode;
  at: string;
};

const NANGO_SYNC_MARKER_KEY = "google_oauth_nango_sync";

type GoogleOAuthSettings = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
};

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(",");

// ---------------------------------------------------------------------------
// Connection-service (Nango) sync-failure classification — cinatra#2545.
//
// WHY IT LIVES IN THIS FILE and not a sibling module: this barrel is on the
// static graph of every locked route in
// `scripts/audit/route-graph-ratchet.baseline.json` (it is reached from
// auth.ts + layout.tsx, including /sign-in). A new first-party module here
// costs +1 on EVERY locked ceiling and would force a ratchet raise for ~50
// lines of pure logic. Inlined, it costs zero modules.
//
// WHY CLASSIFY AT ALL: `ensureNangoIntegration` reaches Nango through the SDK's
// axios client, so a rejected secret key arrives as the bare string
// "Request failed with status code 401" — true, and useless to an operator.
// Classifying the failure lets the connector setup panel state the actual cause
// and the actual recourse (see `describeNangoSyncFailure`).
// ---------------------------------------------------------------------------

/** The classified cause of a failed Nango mirror. Stable — it is persisted. */
export type NangoSyncFailureCode =
  | "secret-key-rejected"
  | "unreachable"
  | "service-unavailable"
  | "request-rejected"
  | "service-not-configured"
  | "mirror-not-confirmed"
  | "unknown";

/** Socket/DNS/undici codes that mean the Nango SERVER was never reached. */
const NANGO_UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** The upstream HTTP status an axios/fetch-shaped error carries, or null. */
function readHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    response?: { status?: unknown };
    status?: unknown;
    statusCode?: unknown;
  };
  for (const value of [candidate.response?.status, candidate.status, candidate.statusCode]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** True when the error means the Nango server was never reached (transport). */
function isNangoTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  // axios puts the socket code on `.code`; Node fetch puts it on `.cause.code`.
  const direct = (error as Error & { code?: unknown }).code;
  const causal = (error as Error & { cause?: { code?: unknown } }).cause?.code;
  if (typeof direct === "string" && NANGO_UNREACHABLE_CODES.has(direct)) return true;
  if (typeof causal === "string" && NANGO_UNREACHABLE_CODES.has(causal)) return true;
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

/**
 * Classify a thrown Nango mirror failure. PURE (exported for the unit test).
 *
 * A 401/403 is the cinatra#2545 case: the bearer this instance sends is not
 * accepted by nango-server — either it does not match the environment secret,
 * or (bundled local Nango, `FLAG_AUTH_ENABLED=false`) it is not UUID-v4 shaped,
 * which nango-server still rejects as `invalid_secret_key_format`.
 */
export function classifyNangoSyncFailure(error: unknown): NangoSyncFailureCode {
  const status = readHttpStatus(error);
  if (status === 401 || status === 403) return "secret-key-rejected";
  if (status !== null && status >= 500) return "service-unavailable";
  if (status !== null && status >= 400) return "request-rejected";
  if (isNangoTransportFailure(error)) return "unreachable";
  return "unknown";
}

/** What every degraded-save message ends with: the reassurance + the impact. */
const SAVED_LOCALLY_SUFFIX =
  "Your Google OAuth client ID and secret are saved on this instance — nothing was lost. " +
  "Google sign-in and Gmail/Calendar access stay unavailable until the connection service has " +
  "the client, so save again once the cause above is fixed.";

/** The same, for an instance that ALREADY has a connected Google account: the
 *  old connection keeps working, so the honest impact is that the client the
 *  operator just saved is simply not in effect. */
const SAVED_LOCALLY_SUFFIX_WITH_CONNECTION =
  "Your Google OAuth client ID and secret are saved on this instance — nothing was lost. The " +
  "already-connected Google account keeps working with the client it was connected with, so the " +
  "client you just saved is not in effect yet; save again once the cause above is fixed.";

/**
 * Operator-facing copy for a classified sync failure. STATIC per code — no
 * provider-echoed text is ever interpolated (same fail-closed doctrine as
 * `setup-provider-connection-writer`'s `interpretActionResult`).
 */
export function describeNangoSyncFailure(
  code: NangoSyncFailureCode,
  options?: { hasConnectedAccount?: boolean },
): string {
  const cause = {
    "secret-key-rejected":
      "The connection service (Nango) rejected this instance's API secret key, so the Google OAuth " +
      "client could not be stored there. Set NANGO_SECRET_KEY to the secret key of your Nango " +
      "environment — the bundled local Nango additionally requires it to be a UUID v4, and rejects " +
      "anything else as an invalid secret-key format.",
    unreachable:
      "The connection service (Nango) could not be reached, so the Google OAuth client could not be " +
      "stored there. Check that the Nango server is running and that NANGO_SERVER_URL points at it.",
    "service-unavailable":
      "The connection service (Nango) returned a server error, so the Google OAuth client could not " +
      "be stored there. Check the Nango server logs.",
    "request-rejected":
      "The connection service (Nango) rejected the integration request, so the Google OAuth client " +
      "could not be stored there. Check the Nango server logs for the rejected request.",
    "service-not-configured":
      "This instance has no connection service (Nango) configured, so there was nowhere to store the " +
      "Google OAuth client. Set NANGO_SECRET_KEY to the secret key of your Nango environment (and " +
      "NANGO_SERVER_URL if you run your own Nango server).",
    "mirror-not-confirmed":
      "The connection service (Nango) accepted the request but does not report the saved Google OAuth " +
      "client, so the client cannot be confirmed as stored. Check the Nango server logs and the " +
      "integration registered for this instance.",
    unknown:
      "The Google OAuth client could not be stored in the connection service (Nango). Check the " +
      "Nango server logs.",
  }[code];
  return `${cause} ${
    options?.hasConnectedAccount ? SAVED_LOCALLY_SUFFIX_WITH_CONNECTION : SAVED_LOCALLY_SUFFIX
  }`;
}

/**
 * Does Nango actually hold the client that is STORED locally?
 *
 * PIN (cinatra#2545, Codex round 1): compare against the STORED row, never
 * against the resolved `settings` — `settings.clientId` is Nango-FIRST, so
 * comparing it to `nangoCredentials.clientId` compares Nango to itself and
 * always agrees. That made a failed client ROTATION (Nango still holding the
 * previous client) read as healthy.
 *
 * The secret is compared only when Nango returns one. This repo already depends
 * on Nango returning `client_secret` (it is the source of truth in
 * `getGoogleOAuthSettings`), and the live check on this change confirmed it
 * does. The tolerance exists so a deployment that DID redact it would not
 * report every save as unsynced forever.
 *
 * ACCEPTED RESIDUAL (Codex round 2): on such a hypothetical redacting
 * deployment, a failed rotation of the SECRET ALONE — same client id — cannot
 * be distinguished from a healthy one, so it would read as confirmed. Closing
 * that needs a stronger success signal from the nango gateway than this repo
 * can assert today (its `ensureNangoIntegration` swallows some rejections); the
 * cost of the alternative is a permanent false "not confirmed" on every save.
 */
function nangoHoldsStoredClient(
  stored: GoogleOAuthStoredSettings,
  nangoCredentials: { clientId?: string; clientSecret?: string } | null | undefined,
): boolean {
  if (!stored.clientId || !nangoCredentials?.clientId) return false;
  if (nangoCredentials.clientId !== stored.clientId) return false;
  return nangoCredentials.clientSecret === undefined
    ? true
    : nangoCredentials.clientSecret === stored.clientSecret;
}

function readStoredSettings(): GoogleOAuthStoredSettings {
  return readConnectorConfigFromDatabase<GoogleOAuthStoredSettings>("google_oauth", {});
}

function readNangoSyncMarker(): GoogleOAuthNangoSyncMarker | null {
  const marker = readConnectorConfigFromDatabase<GoogleOAuthNangoSyncMarker | null>(
    NANGO_SYNC_MARKER_KEY,
    null,
  );
  return marker?.status === "failed" ? marker : null;
}

/** INTERNAL (shared with ./disconnect): forget any recorded sync failure. */
export function clearGoogleOAuthNangoSyncMarker(): void {
  deleteConnectorConfig(NANGO_SYNC_MARKER_KEY);
}

/** INTERNAL (shared with ./disconnect): single-sourced writer for the stored
 * `google_oauth` settings row — not part of the public facade. */
export function writeStoredGoogleOAuthSettings(value: GoogleOAuthStoredSettings) {
  writeConnectorConfigToDatabase("google_oauth", value);
}

/**
 * The ONE settings resolution, returning the resolved view PLUS the two inputs
 * that produced it. `getGoogleOAuthStatus` needs the raw stored row (for the
 * cinatra#2545 sync marker) and the live Nango credentials (to tell a real
 * degradation from a stale marker) — resolving once here keeps that to a
 * SINGLE Nango round-trip instead of a second one per status read.
 */
async function resolveGoogleOAuthSettings() {
  // BOOT-ORDER PIN (cinatra#151 item 9a — the ONE module-eval-time nango
  // path): auth.ts awaits this at module TOP LEVEL, BEFORE static-bundle
  // activation registers the nango-system surface. An unresolved surface
  // degrades to the stored DB row (nangoCredentials = null in the existing
  // fallback chain) — NEVER a throw; runtime reads after activation see live
  // Nango values. Pinned by the boot-order test.
  const nangoSystem = getNangoSystem();
  const nangoCredentials = nangoSystem
    ? await nangoSystem.getNangoOAuth2IntegrationCredentials(nangoSystem.providerConfigKeys.googleOAuth)
    : null;
  const stored = readStoredSettings();
  const marker = readNangoSyncMarker();

  // cinatra#2545 — is Nango's copy KNOWN to be stale? A recorded sync failure
  // that the live state does not contradict means the last save never reached
  // Nango, so whatever Nango still holds is the PREVIOUS client.
  const nangoIsStale = Boolean(marker) && !nangoHoldsStoredClient(stored, nangoCredentials);

  const settings: GoogleOAuthSettings = {
    // Prefer Nango as source of truth; fall back to the DB copy for resilience
    // across Nango restarts.
    //
    // EXCEPT while Nango is known stale (Codex round 2): keeping Nango first
    // there is a data-loss trap. The setup form renders these values, so a
    // failed ROTATION would re-display the PREVIOUS client id, and the "leave
    // blank to keep the saved value" merge in `saveGoogleOAuthSettings` would
    // re-merge the PREVIOUS secret — so the operator following our own "save
    // again" advice would silently overwrite the rotation they just made. While
    // we know our copy never reached Nango, the local row is the operator's
    // intent and wins.
    clientId: nangoIsStale ? stored.clientId : (nangoCredentials?.clientId ?? stored.clientId),
    clientSecret: nangoIsStale
      ? stored.clientSecret
      : (nangoCredentials?.clientSecret ?? stored.clientSecret),
    redirectUri: stored.redirectUri ?? (nangoSystem ? nangoSystem.getNangoOAuthCallbackUrl() : undefined),
  };
  return { settings, stored, nangoCredentials, marker, nangoIsStale };
}

export async function getGoogleOAuthSettings(): Promise<GoogleOAuthSettings> {
  return (await resolveGoogleOAuthSettings()).settings;
}

export async function getGoogleOAuthStatus() {
  const { settings, marker, nangoIsStale } = await resolveGoogleOAuthSettings();
  const savedConnection = getPrimarySavedNangoConnection("googleOAuth");

  // cinatra#2545 — reconcile the sync marker BEFORE any "connected" return,
  // including the saved-connection one (Codex round 1): an install that already
  // has a connected Google account and then rotates its client unsuccessfully
  // is exactly the case most likely to hit this path, and returning "connected"
  // there would hide the failed rotation completely.
  //
  // A save that persisted locally but could NOT be mirrored into the connection
  // service is not "connected": the Nango-backed OAuth flow has no integration
  // matching the saved client, so claiming a working connection misleads both
  // the setup panel and `connector-readiness`.
  //
  // THIS IS THE OPERATOR-FACING SURFACE for the failure. The connector's save
  // toast deliberately CANNOT carry it: `settings-form.tsx` discards the caught
  // message and shows static copy, because Next.js replaces a thrown Server
  // Action message with a generic blurb in a production build. `status.detail`
  // is server-rendered into the panel, so it survives that.
  //
  // The marker is only believed while Nango still does not hold the STORED
  // client — a marker left by a transient failure that a later Nango-side
  // change resolved self-heals here. This read stays PURE: a stale marker is
  // ignored, never rewritten; the next successful save clears it.
  if (marker && nangoIsStale) {
    return {
      status: "incomplete" as const,
      accountEmail: savedConnection?.email,
      detail: describeNangoSyncFailure(marker.code, {
        hasConnectedAccount: Boolean(savedConnection),
      }),
    };
  }

  if (savedConnection) {
    return {
      status: "connected" as const,
      accountEmail: savedConnection.email,
      detail: `Connected${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}.`,
    };
  }

  if (settings.clientId && settings.clientSecret) {
    return {
      status: "connected" as const,
      accountEmail: undefined,
      detail: "Google OAuth is configured for Cinatra.",
    };
  }

  if (settings.clientId || settings.clientSecret || settings.redirectUri) {
    return {
      status: "incomplete" as const,
      accountEmail: undefined,
      detail: "Save the Google OAuth client values and connect a Google account to enable Gmail and Calendar access.",
    };
  }

  return {
    status: "not_connected" as const,
    accountEmail: undefined,
    detail: undefined,
  };
}

export async function getUserGoogleOAuthStatus(userId: string) {
  const savedConnection = getPrimarySavedNangoConnection("googleOAuth", {
    scope: "user",
    userId,
  });

  if (savedConnection) {
    return {
      status: "connected" as const,
      accountEmail: savedConnection.email,
      detail: `Connected${savedConnection.displayName ? ` as ${savedConnection.displayName}` : ""}.`,
    };
  }

  return {
    status: "not_connected" as const,
    accountEmail: undefined,
    detail: "Connect your Google account to enable Gmail and Google Calendar access.",
  };
}

export async function saveGoogleOAuthSettings(input: {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}) {
  // The merge base for "leave blank to keep the saved value" is the resolved
  // view, which is stored-first while Nango is known stale (see
  // `resolveGoogleOAuthSettings`) — so a retry after a failed mirror keeps the
  // rotation the operator just made instead of re-merging Nango's previous copy.
  const current = await getGoogleOAuthSettings();
  const normalizedRedirectUri = input.redirectUri?.trim() || current.redirectUri || getNangoOAuthCallbackUrl();
  const nextSettings: GoogleOAuthSettings = {
    clientId: input.clientId?.trim() || current.clientId,
    clientSecret: input.clientSecret?.trim() || current.clientSecret,
    redirectUri: normalizedRedirectUri,
  };
  // ORDERING PIN (cinatra#2545 defect 1). The client id/secret the operator
  // just typed is LOCAL configuration; it must never be hostage to a live
  // outbound call. Before this, the Nango mirror ran FIRST and a
  // Nango 401 threw before the DB write, so a misconfigured or momentarily
  // unreachable connection service silently DISCARDED the operator's input and
  // they had to retype the secret on every attempt.
  //
  // Persist first; the Nango mirror is a best-effort follow-up below.
  const attempt: GoogleOAuthStoredSettings = {
    redirectUri: nextSettings.redirectUri,
    clientId: nextSettings.clientId,
    clientSecret: nextSettings.clientSecret,
  };
  writeStoredGoogleOAuthSettings(attempt);

  // DEGRADED SUCCESS, not a failure (the repo's `saved-degraded` /
  // `savedWithoutConnectionService` doctrine — see
  // `src/lib/setup-provider-connection-writer.ts`): the values ARE saved, so
  // throwing here would make the connector report "save failed" for a save that
  // succeeded, and would skip the connector's post-save revalidate — the very
  // thing that renders the explanation (google-oauth-connector#57). Record the
  // classified cause instead; `getGoogleOAuthStatus` turns it into operator
  // copy with recourse.
  //
  // Both arms write only the MARKER row, never the credential row, so a
  // concurrent save's credentials can never be clobbered from here.
  finalizeNangoSyncMarker(attempt, await mirrorGoogleOAuthClient(nextSettings));
  return nextSettings;
}

/**
 * Record this save's mirror outcome — but ONLY while this save is still the one
 * the credential row describes.
 *
 * CAUSAL BINDING (cinatra#2545, Codex round 3): the mirror is asynchronous, so
 * two overlapping saves can finish out of order. Without this guard an OLDER
 * save whose mirror happened to succeed late would clear the NEWER save's
 * failure marker, leaving the worst state of all: stored credentials Nango does
 * not have, and nothing recording that. `resolveGoogleOAuthSettings` would then
 * treat Nango as authoritative again and a later blank-secret save would
 * overwrite the newer client with the older one — the original defect, back
 * under concurrency.
 *
 * The credential row IS the version: a save that no longer owns it is stale and
 * says nothing. This also stops an in-flight save from resurrecting a marker
 * that `clearGoogleOAuthConnection` just cleared, because disconnect rewrites
 * the row too.
 *
 * Residual: this is a read-then-write, so a cross-process interleave can still
 * leave a marker stale or absent. Neither loses credentials, and a stale marker
 * is inert — `getGoogleOAuthStatus` believes it only while Nango genuinely does
 * not hold the stored client.
 */
function finalizeNangoSyncMarker(
  attempt: GoogleOAuthStoredSettings,
  failureCode: NangoSyncFailureCode | null,
): void {
  const currentRow = readStoredSettings();
  if (
    currentRow.clientId !== attempt.clientId ||
    currentRow.clientSecret !== attempt.clientSecret ||
    currentRow.redirectUri !== attempt.redirectUri
  ) {
    return;
  }
  if (failureCode) {
    writeConnectorConfigToDatabase(NANGO_SYNC_MARKER_KEY, {
      status: "failed",
      code: failureCode,
      at: new Date().toISOString(),
    } satisfies GoogleOAuthNangoSyncMarker);
  } else {
    clearGoogleOAuthNangoSyncMarker();
  }
}

/**
 * Mirror the Google OAuth client into the connection service. Returns the
 * classified failure code, or `null` when the client is confirmed stored.
 *
 * POSTCONDITION CHECK (cinatra#2545, Codex round 1): a resolved
 * `ensureNangoIntegration` is NOT proof the mirror landed. The nango gateway
 * swallows "unique key already exists" and "invalid input" as success, its
 * delete+recreate fallback is skipped entirely when saved connections exist,
 * and it returns `null` without any call when Nango is not configured at all.
 * So we verify what Nango actually holds instead of trusting the absence of a
 * throw. One extra read on a save path is cheap; a status read stays free
 * because it already resolves the same credentials.
 */
async function mirrorGoogleOAuthClient(
  settings: GoogleOAuthSettings,
): Promise<NangoSyncFailureCode | null> {
  if (!settings.clientId || !settings.clientSecret) return null;

  let outcome: unknown;
  try {
    outcome = await ensureNangoIntegration({
      provider: "google",
      providerConfigKey: CINATRA_NANGO_PROVIDER_CONFIG_KEYS.googleOAuth,
      displayName: "Cinatra Google OAuth",
      credentials: {
        type: "OAUTH2",
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        scopes: GOOGLE_SCOPES,
      },
    });
  } catch (error) {
    const code = classifyNangoSyncFailure(error);
    logNangoSyncFailure(error, code);
    return code;
  }

  // The gateway returns `null` — with no outbound call at all — when this
  // instance has no connection service configured.
  if (outcome === null) return "service-not-configured";

  const nangoSystem = getNangoSystem();
  if (!nangoSystem) return "service-not-configured";
  let mirrored: { clientId?: string; clientSecret?: string } | null = null;
  try {
    mirrored = await nangoSystem.getNangoOAuth2IntegrationCredentials(
      nangoSystem.providerConfigKeys.googleOAuth,
    );
  } catch (error) {
    // Classify the read-back failure too, rather than collapsing every cause
    // into "not confirmed" — a 401 here is the same secret-key problem.
    const code = classifyNangoSyncFailure(error);
    logNangoSyncFailure(error, code);
    return code;
  }
  return nangoHoldsStoredClient(
    { clientId: settings.clientId, clientSecret: settings.clientSecret },
    mirrored,
  )
    ? null
    : "mirror-not-confirmed";
}

/**
 * LEAK RAIL: log the CLASSIFIED code, the HTTP status and the error CLASS only.
 *
 * The raw message is never logged (Codex round 1). The nango gateway rewraps
 * upstream rejections as `new Error(getNangoErrorMessage(...))` — text lifted
 * from the provider's HTTP response body, with the status dropped — so a
 * message here is untrusted provider-echoed content, not a safe diagnostic.
 */
function logNangoSyncFailure(error: unknown, code: NangoSyncFailureCode): void {
  const status = readHttpStatus(error);
  console.warn(
    "[google-oauth-connection] the Google OAuth client was saved locally, but the " +
      `connection-service (Nango) sync did not complete (cinatra#2545): code=${code}` +
      (status === null ? "" : ` httpStatus=${status}`) +
      ` errorClass=${error instanceof Error ? error.name : typeof error}`,
  );
}

export async function refreshGoogleOAuthAccessTokenIfNeeded(input?: { userId?: string; connectorKey?: GoogleScopedConnectorKey }) {
  const connectorKey: GoogleScopedConnectorKey = input?.connectorKey ?? "googleOAuth";
  const savedConnection = input?.userId
    ? getPrimarySavedNangoConnection(connectorKey, {
        scope: "user",
        userId: input.userId,
      }) ?? getPrimarySavedNangoConnection("googleOAuth", {
        scope: "user",
        userId: input.userId,
      })
    : getPrimarySavedNangoConnection(connectorKey) ?? getPrimarySavedNangoConnection("googleOAuth");
  if (!savedConnection) {
    throw new Error("Google OAuth is not connected.");
  }
  const nangoConnection = await getNangoConnection(
    savedConnection.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.googleOAuth,
    savedConnection.connectionId,
    { forceRefresh: true, refreshToken: true },
  );
  const nangoCredentials = (nangoConnection as {
    credentials?: {
      type?: string;
      access_token?: string;
      refresh_token?: string;
      expires_at?: string | Date;
    };
    end_user?: {
      email?: string;
    };
  } | null);

  if (nangoCredentials?.credentials?.type !== "OAUTH2" || !nangoCredentials.credentials.access_token) {
    throw new Error("Unable to load the Google OAuth access token from Nango.");
  }

  return {
    accessToken: nangoCredentials.credentials.access_token,
    refreshToken: nangoCredentials.credentials.refresh_token,
    tokenExpiresAt:
      typeof nangoCredentials.credentials.expires_at === "string"
        ? nangoCredentials.credentials.expires_at
        : nangoCredentials.credentials.expires_at instanceof Date
          ? nangoCredentials.credentials.expires_at.toISOString()
          : undefined,
    accountEmail: nangoCredentials.end_user?.email ?? savedConnection.email,
  };
}

export async function googleApiFetch<T>(input: {
  url: string;
  method?: string;
  body?: unknown;
}, options?: { userId?: string; connectorKey?: GoogleScopedConnectorKey }) {
  const settings = await refreshGoogleOAuthAccessTokenIfNeeded(options);
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${settings.accessToken}`,
      ...(input.body ? { "Content-Type": "application/json" } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Google API request failed.");
  }
  return payload;
}

