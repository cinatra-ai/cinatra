// Deployment registry config loader.
// Mirrors src/lib/verdaccio-config.ts gated-loader shape.
//
// Callers must run an auth gate before calling loadDeploymentRegistryConfig().
//
// Config source resolution (cohesive, all-or-none):
//
//   1. A live, environment-sourced FULL config (the `CINATRA_DEPLOYMENT_REGISTRY_*`
//      keys) is the production source. It is read all-or-none: the public triple
//      (URL + read token + routingMode) is mandatory and the private destination
//      is all-or-none. A PARTIAL or malformed env config THROWS
//      (`DeploymentRegistryConfigIncoherentError`) rather than silently pairing an
//      env URL with the in-repo fixture's tokens/routing — a config source is
//      never mixed.
//
//   2. Otherwise the in-repo fixture is used, but ONLY in development mode or when
//      an operator sets the explicit, loud transition opt-in
//      `CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE=true`. This mirrors the sibling
//      transition-flag pattern in `extension-trust-config.ts`
//      (`CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP`).
//
//   3. Production with neither a live env config nor the explicit opt-in FAILS
//      CLOSED (`DeploymentRegistryConfigNotConfiguredError`). The fixture can
//      therefore never silently back a production deployment's registry routing or
//      the extension-trust host allowlist derived from it
//      (`extension-trust-config.ts` → `trustedActivationHosts`, which catches the
//      throw and yields `[]` — fail-closed, boot-safe).
//
// Rollout note: a production deployment must supply the `CINATRA_DEPLOYMENT_REGISTRY_*`
// config (or, as a documented interim bridge, set the explicit
// `CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE=true`) BEFORE it runs, otherwise
// registry-dependent paths fail closed.

import "server-only";

// Relative import (not the "@/lib/*" alias) so the loader resolves in every
// consumer context — including the isolated packages/extensions test suites,
// whose config maps individual "@/lib/*" modules but not this one.
import { isAppDevelopmentMode } from "./runtime-mode";
import {
  DEPLOYMENT_REGISTRY_CONFIG_FIXTURE,
} from "./__fixtures__/deployment-registry-config.fixture";

// ---------------------------------------------------------------------------
// Locked shape. Do NOT alter field names or types without updating the fixture
// file and all test imports.
// ---------------------------------------------------------------------------
export type DeploymentRegistryConfig = {
  publicRegistryUrl: string;
  publicReadToken: string;
  publicPublishToken: string | null;
  privateRegistryUrl: string | null;
  privateReadToken: string | null;
  privatePublishToken: string | null;
  privateDestinationConfigured: boolean;
  privateDestinationId: string | null;
  /** Routing topology — controls which CLI flags resolveInstallEnvironment emits. */
  routingMode: "scope-based" | "shared-acl";
};

// ---------------------------------------------------------------------------
// Environment keys for the live, env-sourced config (all-or-none).
// ---------------------------------------------------------------------------
export const DEPLOYMENT_REGISTRY_ENV = {
  publicUrl: "CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL",
  publicReadToken: "CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_READ_TOKEN",
  publicPublishToken: "CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_PUBLISH_TOKEN",
  privateUrl: "CINATRA_DEPLOYMENT_REGISTRY_PRIVATE_URL",
  privateReadToken: "CINATRA_DEPLOYMENT_REGISTRY_PRIVATE_READ_TOKEN",
  privatePublishToken: "CINATRA_DEPLOYMENT_REGISTRY_PRIVATE_PUBLISH_TOKEN",
  privateDestinationId: "CINATRA_DEPLOYMENT_REGISTRY_PRIVATE_DESTINATION_ID",
  routingMode: "CINATRA_DEPLOYMENT_REGISTRY_ROUTING_MODE",
} as const;

/** The explicit, loud opt-in that permits the in-repo fixture OUTSIDE development
 *  mode (dev/transition only). ONLY the exact string "true" enables it. */
export const ALLOW_FIXTURE_ENV = "CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE";

// The config-source keys that, if ANY is present (set, even if empty), commit the
// loader to the env source. The ALLOW_FIXTURE flag is deliberately NOT one of them
// — it gates the fixture, it is not a config value.
const CONFIG_SOURCE_KEYS: readonly string[] = [
  DEPLOYMENT_REGISTRY_ENV.publicUrl,
  DEPLOYMENT_REGISTRY_ENV.publicReadToken,
  DEPLOYMENT_REGISTRY_ENV.publicPublishToken,
  DEPLOYMENT_REGISTRY_ENV.privateUrl,
  DEPLOYMENT_REGISTRY_ENV.privateReadToken,
  DEPLOYMENT_REGISTRY_ENV.privatePublishToken,
  DEPLOYMENT_REGISTRY_ENV.privateDestinationId,
  DEPLOYMENT_REGISTRY_ENV.routingMode,
];

type EnvLike = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/** Thrown when the registry config row is malformed (missing routingMode). */
export class DeploymentRegistryConfigNotAvailableError extends Error {
  readonly code = "DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE";
  constructor() {
    super("deployment config malformed — routingMode missing");
    this.name = "DeploymentRegistryConfigNotAvailableError";
  }
}

/** Thrown in production when there is neither a live env config nor the explicit
 *  fixture opt-in — the loader fails closed rather than serving the fixture. */
export class DeploymentRegistryConfigNotConfiguredError extends Error {
  readonly code = "DEPLOYMENT_REGISTRY_CONFIG_NOT_CONFIGURED";
  constructor() {
    super(
      "no deployment registry config: production requires a live env config " +
        `(${DEPLOYMENT_REGISTRY_ENV.publicUrl} + ` +
        `${DEPLOYMENT_REGISTRY_ENV.publicReadToken} + ` +
        `${DEPLOYMENT_REGISTRY_ENV.routingMode}) or the explicit ` +
        `${ALLOW_FIXTURE_ENV}=true transition opt-in`,
    );
    this.name = "DeploymentRegistryConfigNotConfiguredError";
  }
}

/** Thrown when an env config source is present but incomplete/invalid. The
 *  message names offending KEYS only — never any token/secret value. */
export class DeploymentRegistryConfigIncoherentError extends Error {
  readonly code = "DEPLOYMENT_REGISTRY_CONFIG_INCOHERENT";
  constructor(detail: string) {
    super(`deployment registry env config incomplete/invalid — ${detail}`);
    this.name = "DeploymentRegistryConfigIncoherentError";
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure over the injected env).
// ---------------------------------------------------------------------------

function readTrimmed(env: EnvLike, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when ANY config-source key is present (set, even if empty). A set-but-empty
 *  value counts as present so it fails loud in `readEnvConfig` rather than silently
 *  falling back to the fixture. */
function anyEnvConfigPresent(env: EnvLike): boolean {
  return CONFIG_SOURCE_KEYS.some((key) => env[key] !== undefined);
}

function isFixtureExplicitlyAllowed(env: EnvLike): boolean {
  return env[ALLOW_FIXTURE_ENV] === "true";
}

/** Validate a registry URL is an absolute http(s) URL with a host. */
function isValidRegistryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * Build the full config from env, all-or-none. Throws
 * `DeploymentRegistryConfigIncoherentError` (naming keys only) on any missing or
 * invalid field so an env URL is never paired with fixture tokens/routing.
 */
function readEnvConfig(env: EnvLike): DeploymentRegistryConfig {
  const publicRegistryUrl = readTrimmed(env, DEPLOYMENT_REGISTRY_ENV.publicUrl);
  const publicReadToken = readTrimmed(env, DEPLOYMENT_REGISTRY_ENV.publicReadToken);
  const routingMode = readTrimmed(env, DEPLOYMENT_REGISTRY_ENV.routingMode);

  if (!publicRegistryUrl || !publicReadToken || !routingMode) {
    const missing: string[] = [];
    if (!publicRegistryUrl) missing.push(DEPLOYMENT_REGISTRY_ENV.publicUrl);
    if (!publicReadToken) missing.push(DEPLOYMENT_REGISTRY_ENV.publicReadToken);
    if (!routingMode) missing.push(DEPLOYMENT_REGISTRY_ENV.routingMode);
    throw new DeploymentRegistryConfigIncoherentError(
      `missing required key(s): ${missing.join(", ")}`,
    );
  }
  if (!isValidRegistryUrl(publicRegistryUrl)) {
    throw new DeploymentRegistryConfigIncoherentError(
      `${DEPLOYMENT_REGISTRY_ENV.publicUrl} must be an absolute http(s) URL`,
    );
  }
  if (routingMode !== "scope-based" && routingMode !== "shared-acl") {
    throw new DeploymentRegistryConfigIncoherentError(
      `${DEPLOYMENT_REGISTRY_ENV.routingMode} must be "scope-based" or "shared-acl"`,
    );
  }

  // Private destination is all-or-none: URL + read token + destination id together
  // or none at all (the publish token is independently optional).
  const privateRegistryUrl = readTrimmed(env, DEPLOYMENT_REGISTRY_ENV.privateUrl);
  const privateReadToken = readTrimmed(env, DEPLOYMENT_REGISTRY_ENV.privateReadToken);
  const privatePublishToken = readTrimmed(env, DEPLOYMENT_REGISTRY_ENV.privatePublishToken);
  const privateDestinationId = readTrimmed(env, DEPLOYMENT_REGISTRY_ENV.privateDestinationId);

  const anyPrivate =
    privateRegistryUrl !== null ||
    privateReadToken !== null ||
    privatePublishToken !== null ||
    privateDestinationId !== null;
  const allPrivateRequired =
    privateRegistryUrl !== null && privateReadToken !== null && privateDestinationId !== null;

  if (anyPrivate && !allPrivateRequired) {
    throw new DeploymentRegistryConfigIncoherentError(
      `private destination is all-or-none — set ${DEPLOYMENT_REGISTRY_ENV.privateUrl}, ` +
        `${DEPLOYMENT_REGISTRY_ENV.privateReadToken}, and ` +
        `${DEPLOYMENT_REGISTRY_ENV.privateDestinationId} together or none`,
    );
  }
  if (privateRegistryUrl !== null && !isValidRegistryUrl(privateRegistryUrl)) {
    throw new DeploymentRegistryConfigIncoherentError(
      `${DEPLOYMENT_REGISTRY_ENV.privateUrl} must be an absolute http(s) URL`,
    );
  }

  return {
    publicRegistryUrl,
    publicReadToken,
    publicPublishToken: readTrimmed(env, DEPLOYMENT_REGISTRY_ENV.publicPublishToken),
    privateRegistryUrl,
    privateReadToken,
    privatePublishToken,
    privateDestinationConfigured: allPrivateRequired,
    privateDestinationId,
    routingMode,
  };
}

/**
 * Resolve the config source. Env config (all-or-none) wins; otherwise the fixture
 * is served ONLY in development mode or under the explicit opt-in; otherwise the
 * loader fails closed.
 */
function resolveDeploymentRegistryConfig(env: EnvLike): DeploymentRegistryConfig {
  if (anyEnvConfigPresent(env)) {
    return readEnvConfig(env);
  }
  if (isAppDevelopmentMode() || isFixtureExplicitlyAllowed(env)) {
    return DEPLOYMENT_REGISTRY_CONFIG_FIXTURE;
  }
  throw new DeploymentRegistryConfigNotConfiguredError();
}

/**
 * Loads the deployment registry config.
 *
 * Resolution order: a live env config (all-or-none) → the in-repo fixture
 * (development mode or the explicit `CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE=true`
 * opt-in only) → fail closed in production. See the file header for the full
 * contract.
 *
 * The caller must be auth-gated before this function is invoked. The loader
 * itself does not call requireAuthSession — that is the caller's responsibility.
 *
 * import "server-only" ensures this never ships to the client.
 */
export function loadDeploymentRegistryConfig(): DeploymentRegistryConfig {
  const config = resolveDeploymentRegistryConfig(process.env);
  if (!config.routingMode) {
    throw new DeploymentRegistryConfigNotAvailableError();
  }
  return config;
}

/**
 * The FINAL registry identity URL — the deployment's PUBLIC registry base
 * (`registry.cinatra.ai`). This is the URL the install pipeline records as
 * the package origin (provenance) and classifies trust from, on BOTH the
 * legacy and the gatekept paths. It is PUBLIC and credential-free: the read
 * credential lives in the separate `publicReadToken` field, never in
 * `publicRegistryUrl`. Resolving the identity this way (instead of via
 * `loadVerdaccioConfigForServer()`, which requires decryptable server creds)
 * keeps a gatekept consumer-only install free of any server-credential
 * dependency.
 */
export function getPublicRegistryIdentityUrl(): string {
  return loadDeploymentRegistryConfig().publicRegistryUrl;
}
