// Vendor-agnostic trust configuration for in-process extension activation.
// This is the server-only seam that
// derives the two NON-scope trust inputs `classifyExtensionTrust` consumes:
//
//   1. `trustedActivationHosts()` — the host allowlist an extension's resolved
//      registry must belong to before its code may be imported in-process. It is
//      sourced ONLY from `deploymentRegistryConfig.publicRegistryUrl` — never the
//      instance's OWN publish target (`privateRegistryUrl` / `identity.registryUrl`
//      / `CINATRA_AGENT_REGISTRY_URL`) and never a free-form host-override env
//      (that would re-open a trust hole — the instance publishes its own packages to
//      that registry, so trusting it would in-process-trust unsigned local code).
//      Fail-closed: a malformed/empty config yields `[]` (everything untrusted).
//
//   2. `allowMarketplaceBootstrapTrust()` — the single transition lever. During the
//      pre-signature window an integrity-verified, persisted-decision package from a
//      trusted activation host with NO signature may still import in-process
//      (`trusted-bootstrap`). Flipping `CINATRA_EXTENSION_REQUIRE_SIGNATURES=true`
//      turns this off, making a verified signature the sole vendor-agnostic in-process
//      trust root (Window-3).
//
// BOOT-SAFE CONTRACT: both helpers are safe to call from the boot
// path (`instrumentation.node.ts` → `runtime-package-loader.ts`). They perform NO
// auth gate, NO database I/O, and have no `next build` page-data hazard.
// `trustedActivationHosts` reads ONLY `publicRegistryUrl` — a public, non-secret
// policy field — so it does NOT require the caller auth gate the broader
// `loadDeploymentRegistryConfig` consumers run (see the note in
// `deployment-registry-config.ts`). Any failure to read the config fails closed.

import "server-only";

import { loadDeploymentRegistryConfig } from "@/lib/deployment-registry-config";
import { signaturesRequired } from "@/lib/extension-signature";

/**
 * The set of registry HOSTS (lowercased) whose packages may be imported
 * in-process, derived ONLY from the deployment's `publicRegistryUrl` (the
 * marketplace registry). Never includes the private/identity/env registries — the
 * instance's own publish target must never become an in-process trust root.
 *
 * Fail-closed: a missing/malformed `publicRegistryUrl` (or any throw resolving the
 * config) yields `[]` — which makes every package untrusted (no host matches).
 *
 * Boot-safe: no auth gate, no DB I/O. Pure over the deployment registry config.
 */
export function trustedActivationHosts(): string[] {
  let publicRegistryUrl: string | null | undefined;
  try {
    publicRegistryUrl = loadDeploymentRegistryConfig().publicRegistryUrl;
  } catch {
    return [];
  }
  const host = registryHostOf(publicRegistryUrl);
  return host ? [host] : [];
}

/**
 * Whether a configured-marketplace-host package with NO signature may bootstrap
 * into `trusted-bootstrap` during the transition. The single transition lever:
 * `true` while `CINATRA_EXTENSION_REQUIRE_SIGNATURES` is unset (Windows 1–2),
 * `false` once it is set (Window-3 — a verified signature becomes mandatory).
 */
export function allowMarketplaceBootstrapTrust(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !signaturesRequired(env);
}

function registryHostOf(registryUrl: string | null | undefined): string | null {
  if (!registryUrl) return null;
  try {
    return new URL(registryUrl).host.toLowerCase();
  } catch {
    return null;
  }
}
