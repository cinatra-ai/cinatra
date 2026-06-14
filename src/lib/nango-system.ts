import "server-only";

// Host-side resolution of the NANGO SYSTEM capability (the nango serverEntry
// cutover, cinatra#151 Stage 1 — mirrors `llm-provider-surfaces.ts`): the
// nango gateway registers its full host-facing surface from its own
// `register(ctx)`; every former `@cinatra-ai/nango-connector` / `@/lib/nango`
// consumer resolves it HERE at call time. The host names no extension
// package — IoC restored on the LAST open import-floor cluster.
//
// Resolution semantics (nango is a `systemExtension` — its generated REQUIRED
// loader activates unguarded on every boot path; prod arms
// `required-extension-activation`):
//   - `getNangoSystem()` → null when unwired — build-time/test contexts and
//     the ONE sanctioned pre-activation boot read (`getGoogleOAuthSettings`'s
//     module-eval-time chain in auth.ts, pinned by the boot-order test).
//   - `requireNangoSystem()` → fail-loud default with a descriptive
//     pre-activation error (every other host path is call-time, post-boot).
//
// The delegating wrappers below keep the EXACT import-era signatures (sync
// stays sync — `resolveCapabilityProviders` is synchronous by ABI), so the
// facade-era consumers re-point mechanically. The const key maps + connector
// definitions are live Proxies over the resolved surface: every host use is
// inside function bodies (verified — the design's call-time audit), so
// property access resolves the surface at call time, never at module eval.

import type {
  NangoConnectorKey,
  NangoConnectionIdKey,
  NangoConnectorDefinition,
  NangoSystemSurface,
} from "@cinatra-ai/sdk-extensions";
import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability impl is `unknown` by contract — trust it only
// if the always-present sync core members are functions.
function isNangoSystemSurface(impl: unknown): impl is NangoSystemSurface {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as Partial<NangoSystemSurface>;
  return (
    typeof candidate.isNangoConfigured === "function" &&
    typeof candidate.getNangoStatus === "function" &&
    typeof candidate.getNangoSettings === "function" &&
    typeof candidate.providerConfigKeys === "object"
  );
}

/** The live nango-system surface, or null when unwired (degraded contexts). */
export function getNangoSystem(): NangoSystemSurface | null {
  const provider = resolveCapabilityProviders(NANGO_SYSTEM_CAPABILITY)[0];
  if (!provider || !isNangoSystemSurface(provider.impl)) return null;
  return provider.impl;
}

/** Fail-loud default for a systemExtension: every host path except the pinned
 * pre-activation boot read requires the surface. */
export function requireNangoSystem(): NangoSystemSurface {
  const surface = getNangoSystem();
  if (!surface) {
    throw new Error(
      "The nango-system capability surface is not registered. nango is a " +
        "systemExtension whose generated REQUIRED loader activates `register(ctx)` " +
        "at boot — a miss here means this code ran BEFORE static-bundle activation " +
        "(module-eval-time nango access is banned; resolve at call time) or the " +
        "activation itself failed (see required-extension-activation).",
    );
  }
  return surface;
}

// ---------------------------------------------------------------------------
// Delegating wrappers — identical names + signatures to the retired facade.
// ---------------------------------------------------------------------------

export const isNangoConfigured: NangoSystemSurface["isNangoConfigured"] = () =>
  requireNangoSystem().isNangoConfigured();
export const getNangoStatus: NangoSystemSurface["getNangoStatus"] = () =>
  requireNangoSystem().getNangoStatus();
export const getNangoFrontendConfig: NangoSystemSurface["getNangoFrontendConfig"] = () =>
  requireNangoSystem().getNangoFrontendConfig();
export const getNangoSettings: NangoSystemSurface["getNangoSettings"] = () =>
  requireNangoSystem().getNangoSettings();
export const getNangoOAuthCallbackUrl: NangoSystemSurface["getNangoOAuthCallbackUrl"] = () =>
  requireNangoSystem().getNangoOAuthCallbackUrl();

export const listSavedNangoConnections: NangoSystemSurface["listSavedNangoConnections"] = (
  connectorKey,
  options,
) => requireNangoSystem().listSavedNangoConnections(connectorKey, options);
export const getPrimarySavedNangoConnection: NangoSystemSurface["getPrimarySavedNangoConnection"] =
  (connectorKey, options) =>
    requireNangoSystem().getPrimarySavedNangoConnection(connectorKey, options);
export const getPrimarySavedNangoConnections: NangoSystemSurface["getPrimarySavedNangoConnections"] =
  (options) => requireNangoSystem().getPrimarySavedNangoConnections(options);
export const saveNangoConnectionRecord: NangoSystemSurface["saveNangoConnectionRecord"] = (
  connectorKey,
  record,
  options,
) => requireNangoSystem().saveNangoConnectionRecord(connectorKey, record, options);
export const removeNangoConnectionRecord: NangoSystemSurface["removeNangoConnectionRecord"] = (
  connectorKey,
  connectionId,
  options,
) => requireNangoSystem().removeNangoConnectionRecord(connectorKey, connectionId, options);
export const clearNangoConnectionRecords: NangoSystemSurface["clearNangoConnectionRecords"] = (
  connectorKey,
  options,
) => requireNangoSystem().clearNangoConnectionRecords(connectorKey, options);

export const ensureNangoIntegration: NangoSystemSurface["ensureNangoIntegration"] = (input) =>
  requireNangoSystem().ensureNangoIntegration(input);
export const ensureNangoConnectorIntegration: NangoSystemSurface["ensureNangoConnectorIntegration"] =
  (connectorKey) => requireNangoSystem().ensureNangoConnectorIntegration(connectorKey);
export const importNangoConnection: NangoSystemSurface["importNangoConnection"] = (input) =>
  requireNangoSystem().importNangoConnection(input);
export const getNangoConnection: NangoSystemSurface["getNangoConnection"] = (
  providerConfigKey,
  connectionId,
  options,
) => requireNangoSystem().getNangoConnection(providerConfigKey, connectionId, options);
export const getNangoCredentials: NangoSystemSurface["getNangoCredentials"] = (
  providerConfigKey,
  connectionId,
  options,
) => requireNangoSystem().getNangoCredentials(providerConfigKey, connectionId, options);
export const deleteNangoConnection: NangoSystemSurface["deleteNangoConnection"] = (
  providerConfigKey,
  connectionId,
) => requireNangoSystem().deleteNangoConnection(providerConfigKey, connectionId);
export const getNangoOAuth2IntegrationCredentials: NangoSystemSurface["getNangoOAuth2IntegrationCredentials"] =
  (providerConfigKey) => requireNangoSystem().getNangoOAuth2IntegrationCredentials(providerConfigKey);
export const createNangoConnectSession: NangoSystemSurface["createNangoConnectSession"] = (
  input,
) => requireNangoSystem().createNangoConnectSession(input);
export const buildBearerAuthHeaderFromNango: NangoSystemSurface["buildBearerAuthHeaderFromNango"] =
  (input) => requireNangoSystem().buildBearerAuthHeaderFromNango(input);

export const saveNangoConnectionAction: NangoSystemSurface["saveNangoConnectionAction"] = (
  formData,
) => requireNangoSystem().saveNangoConnectionAction(formData);

// ---------------------------------------------------------------------------
// Const key maps + connector definitions — live Proxies over the resolved
// surface. Property access (the only host usage shape — all inside function
// bodies) resolves at call time; iteration traps delegate for completeness.
// ---------------------------------------------------------------------------

function liveMapProxy<T extends object>(pick: (surface: NangoSystemSurface) => T): T {
  return new Proxy({} as T, {
    get: (_t, prop, receiver) => Reflect.get(pick(requireNangoSystem()), prop, receiver),
    has: (_t, prop) => Reflect.has(pick(requireNangoSystem()), prop),
    ownKeys: () => Reflect.ownKeys(pick(requireNangoSystem())),
    getOwnPropertyDescriptor: (_t, prop) =>
      Reflect.getOwnPropertyDescriptor(pick(requireNangoSystem()), prop),
  });
}

export const CINATRA_NANGO_PROVIDER_CONFIG_KEYS: Readonly<Record<NangoConnectorKey, string>> =
  liveMapProxy((surface) => surface.providerConfigKeys);
export const CINATRA_NANGO_CONNECTION_IDS: Readonly<Record<NangoConnectionIdKey, string>> =
  liveMapProxy((surface) => surface.connectionIds);
export const NANGO_CONNECTOR_DEFINITIONS: Readonly<
  Record<NangoConnectorKey, NangoConnectorDefinition>
> = liveMapProxy((surface) => surface.connectorDefinitions);

// Convenience type re-exports for the former facade's type consumers.
export type {
  NangoConnectorKey,
  NangoConnectorDefinition,
  NangoSettings,
  NangoFrontendConfig,
  SavedNangoConnection,
  NangoConnectionDetails,
} from "@cinatra-ai/sdk-extensions";
