// Locked DeploymentRegistryConfig fixture shape.
// All references to deployment registry resolution MUST go through these typed fixtures
// until the live deployment-registry resolver lands.
//
// Three exports:
//   DEPLOYMENT_REGISTRY_CONFIG_FIXTURE              — privateDestinationConfigured: false (topology B baseline)
//   DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE — privateDestinationConfigured: true, shared-acl (topology B)
//   DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A   — privateDestinationConfigured: true, scope-based (topology A)
import type { DeploymentRegistryConfig } from "../deployment-registry-config";

// ---------------------------------------------------------------------------
// Topology B — shared-acl, private NOT configured (the default/baseline).
// ---------------------------------------------------------------------------
export const DEPLOYMENT_REGISTRY_CONFIG_FIXTURE: DeploymentRegistryConfig = {
  publicRegistryUrl: "https://registry.cinatra.ai",
  publicReadToken: "fixture-public-read",
  publicPublishToken: null,
  privateRegistryUrl: null,
  privateReadToken: null,
  privatePublishToken: null,
  privateDestinationConfigured: false,
  privateDestinationId: null,
  routingMode: "shared-acl",
};

// ---------------------------------------------------------------------------
// Topology B — shared-acl, private IS configured.
// Tests toggle to this variant to exercise the "private configured" branch.
// ---------------------------------------------------------------------------
export const DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE: DeploymentRegistryConfig = {
  ...DEPLOYMENT_REGISTRY_CONFIG_FIXTURE,
  privateRegistryUrl: "https://private.registry.example.com",
  privateReadToken: "fixture-private-read",
  privatePublishToken: "fixture-private-publish",
  privateDestinationConfigured: true,
  privateDestinationId: "fixture-dest-01",
  routingMode: "shared-acl",
};

// ---------------------------------------------------------------------------
// Topology A — scope-based routing, private IS configured.
// Tests use this variant to assert --@<scope>:registry=<url> args.
// ---------------------------------------------------------------------------
export const DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A: DeploymentRegistryConfig = {
  ...DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE,
  routingMode: "scope-based",
};
