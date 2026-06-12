// ---------------------------------------------------------------------------
// The NANGO SYSTEM capability contract (the nango serverEntry cutover,
// cinatra#151 Stage 1 — the LAST open import-floor cluster of the IoC
// cutover).
//
// The nango gateway registers its FULL host-facing surface under this id from
// its own `register(ctx)` (a `systemExtension`: the generated REQUIRED loader
// activates it unguarded on every boot path). The host resolves the surface
// in `src/lib/nango-system.ts` — it never imports the package. Function
// members keep their exact import-era signatures (sync stays sync —
// `resolveCapabilityProviders` is synchronous by ABI); the const key maps +
// connector definitions reach the host as members at call time (single
// author: the connector).
//
// Least privilege: the raw Nango SDK client (`getNangoClient`) is NOT a
// member. Credential readers ARE members — the same in-process trust boundary
// as the importable-module era (call sites own gating).
//
// TYPES here are the relocated single-author copies of the connector's
// public shapes (the host names no extension package, even type-only — the
// instance-coupling gate counts every package-name occurrence).
// ---------------------------------------------------------------------------

export const NANGO_SYSTEM_CAPABILITY = "nango-system";

export type NangoConnectorKey =
  | "a2aServer"
  | "apify"
  | "apollo"
  | "claude"
  | "drupal"
  | "github"
  | "gmail"
  | "gemini"
  | "googleCalendar"
  | "googleOAuth"
  | "linkedin"
  | "openai"
  | "tailscale"
  | "wordpress"
  | "youtube";

export type NangoSettings = {
  secretKey?: string;
  serverUrl?: string;
};

export type NangoFrontendConfig = {
  apiURL?: string;
  baseURL?: string;
};

export type SavedNangoConnection = {
  connectorKey: NangoConnectorKey;
  connectionId: string;
  providerConfigKey: string;
  connectedAt: string;
  scope?: "app" | "user";
  userId?: string;
  displayName?: string;
  email?: string;
  authMode?: string;
  metadata?: Record<string, unknown>;
};

export type NangoConnectorDefinition = {
  key: NangoConnectorKey;
  title: string;
  description: string;
  providerConfigKey: string;
  connectDisplayName?: string;
  multiple?: boolean;
  manageHref?: string;
  usesConnectUI: boolean;
};

/** The injected persistence contract the connector's `register(ctx)` binds
 * from the host's delete-capable `@cinatra-ai/host:connector-config` service. */
export type NangoConfigStore = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
  delete(connectorId: string): void;
};

/** The connector keys that carry a well-known app-level connection id (the
 * connector's CINATRA_NANGO_CONNECTION_IDS map omits the per-instance /
 * Connect-UI-only keys). */
export type NangoConnectionIdKey = Exclude<NangoConnectorKey, "a2aServer" | "drupal" | "linkedin">;

export type NangoConnectionScopeOptions = {
  scope?: "app" | "user";
  userId?: string;
};

export type NangoOAuth2IntegrationCredentials = {
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
};

/** Structural subset of the Nango connection-details response the host
 * consumers read (display/email enrichment, credential type, metadata). */
export type NangoConnectionDetails = {
  credentials?: { type?: string; [k: string]: unknown };
  end_user?: { display_name?: string | null; email?: string | null; [k: string]: unknown } | null;
  metadata?: Record<string, unknown> | null;
  [k: string]: unknown;
};

/** The route-handler result contract (`/api/nango/*` delegates). */
export type NangoRouteResult = {
  status?: number;
  body: Record<string, unknown>;
};

export type NangoSystemSurface = {
  // settings/status (sync)
  isNangoConfigured(): boolean;
  getNangoStatus(): { status: "connected" | "not_connected"; detail: string };
  getNangoFrontendConfig(): NangoFrontendConfig;
  getNangoSettings(): NangoSettings;
  getNangoOAuthCallbackUrl(): string;
  // saved-connection records (sync reads, async writes)
  listSavedNangoConnections(
    connectorKey: NangoConnectorKey,
    options?: NangoConnectionScopeOptions,
  ): SavedNangoConnection[];
  getPrimarySavedNangoConnection(
    connectorKey: NangoConnectorKey,
    options?: NangoConnectionScopeOptions,
  ): SavedNangoConnection | null;
  getPrimarySavedNangoConnections(
    options?: NangoConnectionScopeOptions,
  ): Record<NangoConnectorKey, SavedNangoConnection | null>;
  saveNangoConnectionRecord(
    connectorKey: NangoConnectorKey,
    record: Omit<SavedNangoConnection, "connectorKey" | "connectedAt"> & { connectedAt?: string },
    options?: NangoConnectionScopeOptions & { multiple?: boolean },
  ): Promise<void>;
  removeNangoConnectionRecord(
    connectorKey: NangoConnectorKey,
    connectionId: string,
    options?: NangoConnectionScopeOptions,
  ): Promise<void>;
  clearNangoConnectionRecords(
    connectorKey: NangoConnectorKey,
    options?: NangoConnectionScopeOptions,
  ): Promise<void>;
  // integrations + connections (async)
  ensureNangoIntegration(input: {
    provider: string;
    providerConfigKey: string;
    displayName: string;
    credentials?: {
      type: "OAUTH2";
      client_id: string;
      client_secret: string;
      scopes?: string;
    };
  }): Promise<unknown>;
  ensureNangoConnectorIntegration(connectorKey: NangoConnectorKey): Promise<unknown>;
  importNangoConnection(input: {
    connectorKey?: NangoConnectorKey;
    providerConfigKey: string;
    connectionId: string;
    credentials: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    connectionConfig?: Record<string, unknown>;
    endUser?: { id: string; email?: string; display_name?: string };
    tags?: Record<string, string>;
  }): Promise<unknown>;
  getNangoConnection(
    providerConfigKey: string,
    connectionId: string,
    options?: { forceRefresh?: boolean; refreshToken?: boolean },
  ): Promise<NangoConnectionDetails | null>;
  getNangoCredentials(
    providerConfigKey: string,
    connectionId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<unknown>;
  deleteNangoConnection(providerConfigKey: string, connectionId: string): Promise<void>;
  getNangoOAuth2IntegrationCredentials(
    providerConfigKey: string,
  ): Promise<NangoOAuth2IntegrationCredentials | null>;
  createNangoConnectSession(input: {
    connectorKey: NangoConnectorKey;
    reconnectConnectionId?: string;
    scope?: "app" | "user";
    userId?: string;
    userEmail?: string;
    userDisplayName?: string;
  }): Promise<string>;
  buildBearerAuthHeaderFromNango(input: {
    providerConfigKey: string;
    connectionId: string;
    label: string;
  }): Promise<{ Authorization: string } | null>;
  // route-handler members (the host's /api/nango/* routes delegate here)
  handleNangoConnectSessionRequest(
    request: Request,
    options?: { userId?: string; userEmail?: string; userDisplayName?: string },
  ): Promise<NangoRouteResult>;
  handleNangoConnectionSaveRequest(
    request: Request,
    options?: { userId?: string },
  ): Promise<NangoRouteResult>;
  handleNangoWebhookRequest(request: Request): Promise<NangoRouteResult>;
  // the manage-gated save action (host onboarding forwarder delegates)
  saveNangoConnectionAction(formData: FormData): Promise<void>;
  // const key maps + connector definitions (single author: the connector)
  providerConfigKeys: Readonly<Record<NangoConnectorKey, string>>;
  connectionIds: Readonly<Record<NangoConnectionIdKey, string>>;
  connectorDefinitions: Readonly<Record<NangoConnectorKey, NangoConnectorDefinition>>;
};
