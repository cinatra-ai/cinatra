import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";

const SKILL_AUTOSAVE_CONFIG_KEY = "skill_autosave";

export type SkillAutosaveConfig = {
  /** Master switch — when false, autosave never fires. */
  enabled: boolean;
  /** Whether non-admin users can see and toggle autosave per prompt field. */
  userCanConfigure: boolean;
  /** Whether non-admin users can see the autosave indicator at all. */
  userCanSeeIndicator: boolean;
};

const DEFAULT_CONFIG: SkillAutosaveConfig = {
  enabled: false,
  userCanConfigure: false,
  userCanSeeIndicator: true,
};

export function readSkillAutosaveConfig(): SkillAutosaveConfig {
  const stored = readConnectorConfigFromDatabase<Partial<SkillAutosaveConfig>>(
    SKILL_AUTOSAVE_CONFIG_KEY,
    {},
  );
  return {
    enabled: stored.enabled ?? DEFAULT_CONFIG.enabled,
    userCanConfigure: stored.userCanConfigure ?? DEFAULT_CONFIG.userCanConfigure,
    userCanSeeIndicator: stored.userCanSeeIndicator ?? DEFAULT_CONFIG.userCanSeeIndicator,
  };
}

export function writeSkillAutosaveConfig(value: Partial<SkillAutosaveConfig>): SkillAutosaveConfig {
  const current = readSkillAutosaveConfig();
  const merged: SkillAutosaveConfig = {
    ...current,
    ...value,
  };
  writeConnectorConfigToDatabase(SKILL_AUTOSAVE_CONFIG_KEY, merged);
  // Return the persisted config so callers (the save action → form) can re-sync
  // their rendered state to the authoritative saved values (cinatra#808).
  return merged;
}

/**
 * Determines whether autosave UI should be visible for a given user role.
 * Admins always see it. Non-admins see it only if `userCanSeeIndicator` is true.
 */
export function isAutosaveVisibleForRole(role: string | undefined, config: SkillAutosaveConfig) {
  const isAdmin = String(role ?? "")
    .split(",")
    .map((r) => r.trim())
    .includes("admin");
  return isAdmin || config.userCanSeeIndicator;
}

/**
 * Determines whether the user can toggle autosave on a given prompt field.
 * Admins can always toggle. Non-admins can toggle only if `userCanConfigure` is true.
 */
export function canUserToggleAutosave(role: string | undefined, config: SkillAutosaveConfig) {
  const isAdmin = String(role ?? "")
    .split(",")
    .map((r) => r.trim())
    .includes("admin");
  return isAdmin || config.userCanConfigure;
}
