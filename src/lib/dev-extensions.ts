import "server-only";

import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";

// Instance-side vendor delegation.
// Backs the "Extensions" tab at /configuration/development. Stores a single
// scalar publishScopeOverride. When set in dev mode, publishToRegistry routes
// the publish under @<override>/<package> instead of @<instanceNamespace>/<package>.
// Hard-ignored in prod (CINATRA_RUNTIME_MODE !== "development"). Never mutates
// canonical identity — the override is a publish-path-only parameter.

export type DevExtensionsSettings = {
  publishScopeOverride: string | null;
};

const DEV_EXTENSIONS_SETTINGS_KEY = "dev-extensions";
const SCOPE_REGEX = /^[a-z0-9][a-z0-9-]{1,38}$/;

export function normalizePublishScopeOverride(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().toLowerCase().replace(/^@/, "");
  if (!trimmed) return null;
  if (trimmed.includes("/")) {
    throw new Error("Publish scope override must not contain '/'");
  }
  if (!SCOPE_REGEX.test(trimmed)) {
    throw new Error("Publish scope override must match ^[a-z0-9][a-z0-9-]{1,38}$");
  }
  return trimmed;
}

export function getDevExtensionsSettings(): DevExtensionsSettings {
  const stored = readConnectorConfigFromDatabase<Partial<DevExtensionsSettings>>(
    DEV_EXTENSIONS_SETTINGS_KEY,
    {},
  );
  const raw = typeof stored.publishScopeOverride === "string" ? stored.publishScopeOverride.trim() : "";
  return { publishScopeOverride: raw ? raw : null };
}

export function saveDevExtensionsSettings(input: Partial<DevExtensionsSettings>): void {
  const normalized = normalizePublishScopeOverride(input.publishScopeOverride ?? null);
  writeConnectorConfigToDatabase(DEV_EXTENSIONS_SETTINGS_KEY, {
    publishScopeOverride: normalized,
  });
}

/**
 * Returns the publish-scope override only when CINATRA_RUNTIME_MODE === "development".
 * In production mode this always returns null regardless of stored value. Defense
 * in depth: the server action also gates writes by dev mode, and the UI disables
 * the form when not in dev mode, but this last-mile check ensures the publish
 * path never honors a stale value if the runtime mode was flipped between save
 * and publish. Also re-normalizes on read so a hand-edited DB blob can't smuggle
 * an invalid scope into the publish path.
 */
export function readEffectivePublishScopeOverride(): string | null {
  if (process.env.CINATRA_RUNTIME_MODE !== "development") return null;
  const raw = getDevExtensionsSettings().publishScopeOverride;
  if (raw == null) return null;
  try {
    return normalizePublishScopeOverride(raw);
  } catch {
    // Hand-edited blob holds invalid data; treat as "no override" rather than
    // throw from the publish path.
    return null;
  }
}
