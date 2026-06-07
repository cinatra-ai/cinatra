// Required-in-prod declaration.
//
// Root `package.json` declares the list under `cinatra.requiredExtensions`.
// At install time:
//   - production: the canonical lifecycle primitive auto-locks the row
//     because required-in-prod implies locked-in-prod.
//   - dev: the implication is advisory (logged warning if violated).
//
// At boot:
//   - production: missing required packages fail closed.
//   - dev: missing required packages log a warning.
import "server-only";

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { listInstalledExtensions } from "./canonical-store";

const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");

type CinatraBlock = {
  requiredExtensions?: string[];
};

export type RequiredVerificationResult =
  | { ok: true; required: string[]; installed: string[] }
  | {
      ok: false;
      required: string[];
      installed: string[];
      missing: string[];
      reason: string;
    };

let cachedRequired: string[] | null = null;

/**
 * Read the declared required-in-prod packages from the root package.json.
 * Cached after the first read (the list does not change at runtime).
 */
export function readRequiredInProdPackages(packageJsonPath: string = PACKAGE_JSON_PATH): string[] {
  if (cachedRequired) return cachedRequired;
  if (!existsSync(packageJsonPath)) {
    cachedRequired = [];
    return cachedRequired;
  }
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { cinatra?: CinatraBlock };
    cachedRequired = (pkg.cinatra?.requiredExtensions ?? []).filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    return cachedRequired;
  } catch {
    cachedRequired = [];
    return cachedRequired;
  }
}

export function _resetCachedRequiredForTesting() {
  cachedRequired = null;
}

export function isPackageRequiredInProd(packageName: string): boolean {
  return readRequiredInProdPackages().includes(packageName);
}

/**
 * Boot-time verification. In production, returns ok=false with details
 * (caller decides whether to throw); in dev, callers usually log the
 * warning and continue.
 */
export async function verifyRequiredInProdInstalled(): Promise<RequiredVerificationResult> {
  const required = readRequiredInProdPackages();
  if (required.length === 0) {
    return { ok: true, required: [], installed: [] };
  }

  // Pull every installed_extension row and check by package_name. We
  // intentionally do not narrow by org — required-in-prod is a
  // platform-wide contract, satisfied by any installed row (`active`
  // or `locked`).
  const all = await listInstalledExtensions({});
  const installedSet = new Set(
    all
      .filter((e) => e.status === "active" || e.status === "locked")
      .map((e) => e.packageName),
  );
  const installed = required.filter((p) => installedSet.has(p));
  const missing = required.filter((p) => !installedSet.has(p));

  if (missing.length === 0) return { ok: true, required, installed };
  return {
    ok: false,
    required,
    installed,
    missing,
    reason: `Required-in-prod packages missing from installed_extension manifest: ${missing.join(", ")}`,
  };
}
