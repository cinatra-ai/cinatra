// System-extension inventory.
//
// These packages are flagged `locked` on install via the canonical lifecycle
// primitive. Locked status enforces destructive-op rejection (archive,
// uninstall, force-delete, purge, registry-removal) for any row in this set.
// Update is still allowed, preserving the lock.
//
// Inventory lives in CODE. Adding a package here without also declaring it in
// `cinatra.requiredExtensions` (root package.json) would leave a gap; the drift
// test enforces alignment.
import "server-only";

import {
  readInstalledExtensionsByPackageName,
} from "./canonical-store";
import { transitionExtensionLifecycle } from "./lifecycle-primitive";
import { readRequiredInProdPackages } from "./required-in-prod";

/**
 * System packages that ship locked.
 * Keeping them as constants (not pulling from package.json) ensures the
 * inventory is visible in source review, not deferred to runtime data.
 */
export const SYSTEM_EXTENSIONS: readonly string[] = [
  "@cinatra-ai/nango-connector",
  "@cinatra-ai/code-reviewer-agent",
  "@cinatra-ai/planner-agent",
  "@cinatra-ai/author-agent",
  "@cinatra-ai/lint-policy-agent",
  "@cinatra-ai/security-reviewer-agent",
  "@cinatra-ai/assistant-skills",
  "@cinatra-ai/default-artifact",
] as const;

export function isSystemExtension(packageName: string): boolean {
  return SYSTEM_EXTENSIONS.includes(packageName);
}

/**
 * Lock every installed_extension row for a given package across all
 * (org, owner) tuples. The lifecycle primitive enforces transition rules
 * — a row already at `locked` is a no-op; an `archived` row would be
 * blocked (locked transition only from `active`).
 */
export async function lockExtensionByPackageName(
  packageName: string,
  reason: string,
): Promise<{ locked: number; skipped: number }> {
  const rows = await readInstalledExtensionsByPackageName(packageName);
  let locked = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.status === "locked") {
      skipped++;
      continue;
    }
    try {
      await transitionExtensionLifecycle(row.id, "lock", {
        actor: { source: "system-extension-inventory" },
        reason,
      });
      locked++;
    } catch {
      skipped++;
    }
  }
  return { locked, skipped };
}

/**
 * Boot-time enforcement. Lock every system extension that has an installed
 * manifest row but is not currently locked. Idempotent — re-running yields
 * the same locked set.
 *
 * In production this also locks every `requiredInProd` package because
 * required-in-prod packages must be locked in production.
 */
export async function lockSystemExtensionsAtBoot(): Promise<{ lockedCount: number }> {
  const inventory = new Set<string>(SYSTEM_EXTENSIONS);
  // Production = absence of dev mode (CINATRA_RUNTIME_MODE !== "development").
  // Required-in-prod packages auto-lock in production.
  const isDev = process.env.CINATRA_RUNTIME_MODE === "development";
  if (!isDev) {
    for (const pkg of readRequiredInProdPackages()) inventory.add(pkg);
  }
  let lockedCount = 0;
  for (const pkg of inventory) {
    const result = await lockExtensionByPackageName(pkg, "system-extension boot-lock");
    lockedCount += result.locked;
  }
  return { lockedCount };
}
