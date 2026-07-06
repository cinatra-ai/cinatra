// Env-override precedence for the instance-global `connector-config` store
// (cinatra#982, Option A) — the PURE resolution helper.
//
// The host `register-host-connector-services` binds this onto the
// `@cinatra-ai/host:connector-config` capability so a connector that keeps its
// instance-global connector-config blob (nango) can still let an operator env
// override WIN over the DB-stored value — WITHOUT routing through the org-scoped
// `ctx.settings`/`ctx.secrets` ports (which fail closed with no actor). The
// env-var NAMES come SOLELY from the connector's own manifest
// `cinatra.envOverrides`; core never hardcodes them.
//
// This module is intentionally dependency-light (only the SDK validator) so the
// precedence logic is unit-testable without the host boot graph.

import { validateEnvOverrides, type ExtensionResolution } from "@cinatra-ai/sdk-extensions";

/**
 * Validate a connector's raw manifest `cinatra.envOverrides` and return the
 * CURRENTLY-SET operator overrides, keyed by the settings/secrets KEY the
 * connector stores the value under (the `settings:`/`secrets:` port prefix is
 * dropped — an instance-global connector-config blob has one keyspace, so both
 * ports collapse onto it). Only keys whose env var is set to a NON-BLANK
 * (trimmed) value are returned; a blank `KEY=` is treated as unset, preserving
 * the connector's pre-existing `env?.trim() || stored` precedence (the caller
 * falls through to its DB value).
 *
 * Legacy (non-namespaced, e.g. `NANGO_SECRET_KEY`) env-var names are honored
 * ONLY for a `resolution: "required"` system extension (nango) — the same
 * fail-closed eligibility the host `settings`/`secrets` ports apply; a rejected
 * entry is dropped (and logged by the caller-facing warn below) and never
 * activates a mapping.
 *
 * PURE + ACTOR-FREE: reads only `process.env` and its arguments (no org, no DB),
 * so a boot-/webhook-time read with no resolvable actor still resolves
 * env-first.
 */
export function computeConnectorConfigEnvOverrides(
  packageName: string,
  rawEnvOverrides: Record<string, string> | null | undefined,
  resolution: ExtensionResolution | undefined,
): Record<string, string> {
  if (!rawEnvOverrides) return {};
  const { overrides, rejected } = validateEnvOverrides(packageName, rawEnvOverrides, {
    allowLegacyNames: resolution === "required",
  });
  for (const rejection of rejected) {
    console.warn(
      `[connector-config-env-overrides] ${packageName} ` +
        `cinatra.envOverrides["${rejection.envKey}"] rejected: ${rejection.reason}`,
    );
  }
  const resolved: Record<string, string> = {};
  for (const [envVar, target] of Object.entries(overrides)) {
    const value = process.env[envVar]?.trim();
    if (value) resolved[target.key] = value;
  }
  return resolved;
}
