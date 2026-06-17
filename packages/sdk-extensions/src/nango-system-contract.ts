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

// ---------------------------------------------------------------------------
// Vendor identity is OPEN (#12 connector vendor-identity end-state, eng#159 /
// owner ruling eng#183 decision 2). The SDK no longer enumerates an
// authoritative vendor ROSTER — Cinatra is an open connector marketplace, so a
// connector declares its OWN vendor key in its manifest (`cinatra.vendor`,
// see `./manifest`) and that identity is verified at the marketplace publish
// gate, NOT frozen into an SDK union.
//
// `NangoConnectorKey` is therefore the OPEN vendor-key shape: a plain `string`.
// It keeps its name only as a read-compat alias so the many wrapper signatures,
// persisted `SavedNangoConnection.connectorKey` values, and the const key maps
// (`Record<NangoConnectorKey, …>`) re-point mechanically. Every existing call
// site that passed a bare literal (`"github"`, `"a2aServer"`, …) still
// type-checks (a literal IS a `string`), and a persisted connector key on disk
// still reads back unchanged — read-compat is total.
// ---------------------------------------------------------------------------

/**
 * Open connector vendor-key shape — a plain `string`. The SDK owns NO
 * authoritative vendor roster: a connector declares its own vendor key in its
 * manifest (`cinatra.vendor.key`) and the marketplace publish gate verifies it.
 * Retained as a named alias for read-compat across the nango-system wrappers,
 * persisted connection records, and the const key maps.
 */
export type NangoConnectorKey = string;

// ---------------------------------------------------------------------------
// ConnectorVendorKey — a TYPE-ONLY branded vendor-key SHAPE (#12).
//
// The brand is the SHAPE a vendor key carries ONCE the boundary that owns the
// authoritative vendor identity (the host manifest / marketplace publish gate)
// has accepted it. The SDK provides only the type and a PURE (non-validating)
// cast: it carries NO roster and performs NO runtime membership/enumeration
// check. Vendor-identity validation belongs at the host manifest/gate boundary,
// never in the SDK.
//
// The brand is a phantom property keyed by a `unique symbol` — it is erased at
// build, has zero runtime footprint, and a branded value is the identical string
// at runtime (round-trips through JSON/persistence unchanged).
// ---------------------------------------------------------------------------

declare const ConnectorVendorKeyBrand: unique symbol;

/**
 * A connector vendor key that a trust boundary has accepted as a vendor identity.
 * Structurally a `string` (the open `NangoConnectorKey` shape) carrying a
 * compile-time-only phantom brand; read-compat — assignable TO `NangoConnectorKey`
 * and to `string` without a cast. The brand only narrows the OTHER direction: a
 * bare string is NOT a `ConnectorVendorKey` until cast. The SDK holds no
 * authoritative vendor list — membership validation lives at the host
 * manifest/gate boundary.
 */
export type ConnectorVendorKey = string & {
  readonly [ConnectorVendorKeyBrand]: true;
};

/**
 * PURE cast: brand a vendor-key `string` as a `ConnectorVendorKey`. Performs NO
 * membership check and consults NO roster (the SDK owns no authoritative vendor
 * list). The caller asserts the value was already accepted by the boundary that
 * owns vendor identity (the host manifest / marketplace publish gate). Identity
 * at runtime — returns the same value.
 */
export const asConnectorVendorKey = (key: NangoConnectorKey): ConnectorVendorKey =>
  key as ConnectorVendorKey;

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

/** The connector keys that carry a well-known app-level connection id. Open
 * (a plain `string`, the `NangoConnectorKey` shape): which keys carry a
 * well-known connection id is the connector's own decision (its
 * `connectionIds` map declares the subset), not an SDK-frozen exclusion list. */
export type NangoConnectionIdKey = NangoConnectorKey;

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
