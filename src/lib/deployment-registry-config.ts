// Fixture-backed deployment registry config loader.
// Mirrors src/lib/verdaccio-config.ts gated-loader shape.
//
// Callers must run an auth gate before calling loadDeploymentRegistryConfig().
//
// Fixture mode: deployment registry resolution goes through the in-repo fixture.
// The TODO below marks the swap point for the live deployment-registry resolver.

import "server-only";

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
// Error — thrown when the registry config row is malformed (missing routingMode).
// ---------------------------------------------------------------------------
export class DeploymentRegistryConfigNotAvailableError extends Error {
  readonly code = "DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE";
  constructor() {
    super("deployment config malformed — routingMode missing");
    this.name = "DeploymentRegistryConfigNotAvailableError";
  }
}

/**
 * Loads the deployment registry config.
 *
 * Fixture mode returns DEPLOYMENT_REGISTRY_CONFIG_FIXTURE. Registry resolution
 * goes through the fixture file until live deployment-registry integration is
 * enabled.
 *
 * The caller must be auth-gated before this function is invoked. The loader
 * itself does not call requireAuthSession — that is the caller's responsibility.
 *
 * import "server-only" ensures this never ships to the client.
 */
export function loadDeploymentRegistryConfig(): DeploymentRegistryConfig {
  // TODO(live integration): replace fixture with live deployment-registry resolver call.
  const config = DEPLOYMENT_REGISTRY_CONFIG_FIXTURE;
  if (!config.routingMode) {
    throw new DeploymentRegistryConfigNotAvailableError();
  }
  return config;
}
