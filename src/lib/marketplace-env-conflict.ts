/**
 * Shared guard: marketplace-bootstrap and pre-provisioned-registry env paths
 * are mutually exclusive. If both `MARKETPLACE_INSTANCE_TOKEN` and any
 * `CINATRA_AGENT_REGISTRY_*` env var are set, the setup wizard would persist a
 * marketplace-issued token while runtime publish/install
 * (`loadVerdaccioConfigAsync` env-fast-path) silently prefers the pre-
 * provisioned env values — split-brain. Setup catches this at first-run; the
 * env can be ADDED after setup though, so every marketplace admin action
 * (register, status read, visibility-set, token-rotate) re-checks at call
 * time.
 */

export interface MarketplaceEnvConflict {
  conflict: true;
  reason: string;
}

export function detectMarketplaceEnvConflict(): MarketplaceEnvConflict | null {
  const hasMarketplaceToken = !!process.env.MARKETPLACE_INSTANCE_TOKEN?.trim();
  if (!hasMarketplaceToken) {
    return null;
  }
  const conflictingEnv: string[] = [];
  if (process.env.CINATRA_AGENT_REGISTRY_TOKEN?.trim()) conflictingEnv.push("CINATRA_AGENT_REGISTRY_TOKEN");
  if (process.env.CINATRA_AGENT_REGISTRY_URL?.trim())   conflictingEnv.push("CINATRA_AGENT_REGISTRY_URL");
  if (process.env.CINATRA_AGENT_REGISTRY_SCOPE?.trim()) conflictingEnv.push("CINATRA_AGENT_REGISTRY_SCOPE");
  if (conflictingEnv.length === 0) {
    return null;
  }
  return {
    conflict: true,
    reason:
      `Conflicting registry configuration: MARKETPLACE_INSTANCE_TOKEN is set AND ` +
      `${conflictingEnv.join(", ")} ${conflictingEnv.length === 1 ? "is" : "are"} ` +
      `set. Setup persisted a marketplace-issued token but runtime would honour ` +
      `the env override (split-brain). Unset one path before continuing.`,
  };
}
