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

// ---------------------------------------------------------------------------
// Per-user chat-capture preference (cinatra#1367). Sits BENEATH the admin
// master switch: `null` (unset) follows the admin-configured default (master
// on ⇒ capture on), an explicit boolean overrides it for that user only.
// Toggle-off stops FUTURE captures; already-captured skills are never
// deleted. Stored as one connector_config row per user (no read-modify-write
// races across users).
// ---------------------------------------------------------------------------

const SKILL_AUTOSAVE_USER_PREF_KEY_PREFIX = "skill_autosave_user:";

export type SkillAutosaveUserPref = {
  /** null = follow the admin default. */
  chatCaptureEnabled: boolean | null;
};

function userPrefKey(userId: string): string {
  return `${SKILL_AUTOSAVE_USER_PREF_KEY_PREFIX}${userId}`;
}

export function readSkillAutosaveUserPref(userId: string): SkillAutosaveUserPref {
  const stored = readConnectorConfigFromDatabase<Partial<SkillAutosaveUserPref>>(
    userPrefKey(userId),
    {},
  );
  return {
    chatCaptureEnabled:
      typeof stored.chatCaptureEnabled === "boolean" ? stored.chatCaptureEnabled : null,
  };
}

export function writeSkillAutosaveUserPref(
  userId: string,
  value: SkillAutosaveUserPref,
): SkillAutosaveUserPref {
  const normalized: SkillAutosaveUserPref = {
    chatCaptureEnabled:
      typeof value.chatCaptureEnabled === "boolean" ? value.chatCaptureEnabled : null,
  };
  writeConnectorConfigToDatabase(userPrefKey(userId), normalized);
  return normalized;
}

/**
 * Effective chat-capture enablement for a user: the admin master switch is a
 * hard gate; beneath it the per-user preference applies, defaulting to the
 * admin-configured default (enabled) when unset.
 */
export function isChatCaptureEnabledForUser(
  userId: string,
  config: SkillAutosaveConfig = readSkillAutosaveConfig(),
): boolean {
  if (!config.enabled) return false;
  const pref = readSkillAutosaveUserPref(userId);
  return pref.chatCaptureEnabled ?? true;
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
