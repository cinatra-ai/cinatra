// System-extension inventory.
//
// These packages are flagged `locked` on install via the canonical lifecycle
// primitive. Locked status enforces destructive-op rejection (archive,
// uninstall, force-delete, purge, registry-removal) for any row in this set.
// Update is still allowed, preserving the lock.
//
// The inventory is DATA, not code (cinatra#35 / IOC-43): the set is the
// HOST-owned `cinatra.systemExtensions` declaration in the root package.json —
// the same host-trust home (and read pattern) as `cinatra.extensions`
// (./required-in-prod). It is deliberately NOT an extension-side declaration:
// system/locked status is a host trust decision, and letting an extension's
// own manifest self-declare it would be a privilege-escalation channel.
// Alignment invariants:
//   - systemExtensions ⊆ extensions (drift test) — a system package
//     missing from extensions would leave the prod-boot verifier
//     unable to ensure it is installed;
//   - every entry must exist in the generated extension manifest — enforced
//     fail-closed by scripts/extensions/generate-extension-manifest.mjs.
// The reader FAILS CLOSED: a missing/malformed declaration throws (loudly
// breaking boot-lock + destructive-op checks) instead of silently locking
// nothing.
import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  readInstalledExtensionsByPackageName,
} from "./canonical-store";
import { transitionExtensionLifecycle } from "./lifecycle-primitive";
import { readRequiredInProdPackages } from "./required-in-prod";

/**
 * Locate the HOST root package.json (the one carrying the `cinatra` block).
 * `process.cwd()` is the deployed/dev convention (same as ./required-in-prod),
 * but test runners execute from workspace-package dirs, so ascend from cwd to
 * the first package.json that declares `cinatra.systemExtensions`. Returns the
 * cwd-local path when nothing declares the block — the fail-closed reader then
 * reports THAT file's missing declaration.
 */
function resolveRootPackageJsonPath(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8"));
        if (Array.isArray(parsed?.cinatra?.systemExtensions)) return candidate;
      } catch {
        /* unreadable candidate — keep ascending */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd(), "package.json");
    dir = parent;
  }
}

/**
 * Read the host-declared system-extension set from the root package.json
 * (`cinatra.systemExtensions`). Fail-closed: throws on a missing, empty, or
 * malformed declaration (entries must be scoped package NAMES, no ranges).
 */
export function readSystemExtensions(
  packageJsonPath: string = resolveRootPackageJsonPath(),
): readonly string[] {
  let parsed: { cinatra?: { systemExtensions?: unknown } };
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `system-extension inventory: cannot read root package.json at ${packageJsonPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const declared = parsed.cinatra?.systemExtensions;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      "system-extension inventory: root package.json must declare a non-empty cinatra.systemExtensions array (host-owned system/locked set)",
    );
  }
  for (const entry of declared) {
    // Scoped bare NAME only — `@scope/name` (no version range; lock semantics
    // key on names, and ranges live in extensions).
    if (
      typeof entry !== "string" ||
      !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(entry)
    ) {
      throw new Error(
        `system-extension inventory: invalid cinatra.systemExtensions entry ${JSON.stringify(entry)} — expected a scoped package name`,
      );
    }
  }
  return Object.freeze([...new Set(declared as string[])]);
}

/**
 * System packages that ship locked — read once at module load from the root
 * package.json declaration (fail-loud, see readSystemExtensions).
 */
export const SYSTEM_EXTENSIONS: readonly string[] = readSystemExtensions();

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
