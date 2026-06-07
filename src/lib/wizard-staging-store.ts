/**
 * Generic in-memory staging store for resources being built through chat wizards.
 * No data is written to the real DB until the user confirms.
 * Data is lost on server restart (acceptable — the user restarts the wizard).
 *
 * Uses globalThis to survive Next.js dev-mode hot reloads.
 */

export type StagedResource = {
  resourceType: string;
  createArgs: Record<string, unknown>;
  overrides: Record<string, unknown>;
  createdAt: string;
};

const GLOBAL_KEY = "__cinatra_wizard_staging_store__" as const;

function getStore(): Map<string, StagedResource> {
  const g = globalThis as unknown as Record<string, Map<string, StagedResource> | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map();
  }
  return g[GLOBAL_KEY];
}

function key(resourceType: string, resourceId: string) {
  return `${resourceType}:${resourceId}`;
}

export function stageResource(resourceType: string, resourceId: string, createArgs: Record<string, unknown>) {
  getStore().set(key(resourceType, resourceId), {
    resourceType,
    createArgs,
    overrides: {},
    createdAt: new Date().toISOString(),
  });
}

export function getStagedResource(resourceType: string, resourceId: string): StagedResource | undefined {
  return getStore().get(key(resourceType, resourceId));
}

export function updateStagedResource(resourceType: string, resourceId: string, updates: Record<string, unknown>): boolean {
  const entry = getStore().get(key(resourceType, resourceId));
  if (!entry) return false;
  Object.assign(entry.overrides, updates);
  return true;
}

export function removeStagedResource(resourceType: string, resourceId: string) {
  getStore().delete(key(resourceType, resourceId));
}

export function isStagedResource(resourceType: string, resourceId: string): boolean {
  return getStore().has(key(resourceType, resourceId));
}

export function getMergedStagedConfig(resourceType: string, resourceId: string): Record<string, unknown> | null {
  const entry = getStore().get(key(resourceType, resourceId));
  if (!entry) return null;
  return { ...entry.createArgs, ...entry.overrides };
}

/** Also check by resourceId alone (when resourceType is unknown). */
export function findStagedResourceById(resourceId: string): { resourceType: string; config: Record<string, unknown> } | null {
  for (const [, entry] of getStore()) {
    const merged = { ...entry.createArgs, ...entry.overrides };
    // Check if any value in createArgs or key matches the resourceId
    if (getStore().has(key(entry.resourceType, resourceId))) {
      return { resourceType: entry.resourceType, config: merged };
    }
  }
  return null;
}

/** Returns all staged resources of a given type. */
export function getAllStagedByType(resourceType: string): Array<{ resourceId: string; config: Record<string, unknown> }> {
  const result: Array<{ resourceId: string; config: Record<string, unknown> }> = [];
  const prefix = `${resourceType}:`;
  for (const [k, entry] of getStore()) {
    if (k.startsWith(prefix)) {
      result.push({
        resourceId: k.slice(prefix.length),
        config: { ...entry.createArgs, ...entry.overrides },
      });
    }
  }
  return result;
}

/**
 * Extract a value from an object by a simple path.
 * Supports "field", "field.nested", "field[-1]" (last array element).
 */
export function extractByPath(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== "object") return undefined;

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;

    const arrayMatch = part.match(/^(.+)\[(-?\d+)\]$/);
    if (arrayMatch) {
      const [, field, indexStr] = arrayMatch;
      const arr = (current as Record<string, unknown>)[field];
      if (!Array.isArray(arr)) return undefined;
      const idx = Number(indexStr);
      current = idx < 0 ? arr[arr.length + idx] : arr[idx];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}
