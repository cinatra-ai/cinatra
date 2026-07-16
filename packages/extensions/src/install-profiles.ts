// Install-profile capability declaration (target side).
//
// Root `package.json` declares the install MODES this Cinatra checkout ships
// support for under `cinatra.installProfiles`. The CLI (`cinatra install <mode>`,
// cinatra-ai/cinatra-cli#122) reads THIS array cross-repo to decide whether an
// install mode is honored: its `assertTargetSupportsDemo` refuses `--mode demo`
// LOUDLY unless the array includes `"demo"` (rather than silently producing a
// hollow dev install with no demo overlay). `dev`/`prod` are unconditional
// install modes, but the canonical declaration lists all three for
// documentation + forward-compat.
//
// This is a HOST-owned root-manifest declaration — the same trust home and
// fail-closed read pattern as `cinatra.systemExtensions` (system-extension
// inventory) and `cinatra.extensions` (required-in-prod). It is deliberately
// NOT a per-extension `CinatraManifest` field (packages/sdk-extensions): an
// extension must not be able to self-declare which install profiles the TARGET
// supports (a host trust decision, and a privilege-escalation channel if
// self-declared — mirrors the system-extension-inventory rationale).
//
// Distinct AXIS from the RUNTIME active profile in `src/lib/install-profile.ts`
// (env-driven, `dev | demo`, decides fixture/seed activation for THIS running
// instance). This declaration is the SET of install MODES the checkout supports
// (`dev | prod | demo`), mirroring the CLI's `VALID_MODES`.
//
// The reader FAILS CLOSED: a missing/malformed declaration yields an empty set
// (the CLI then correctly refuses `--mode demo`), never a spurious "supported".
import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The canonical install-profile vocabulary — the install MODES a Cinatra
 * checkout can declare support for. Mirrors the CLI's `VALID_MODES`
 * (`["dev","prod","demo"]`; cinatra-cli#122 `src/install.mjs`). `demo` is the
 * only mode that REQUIRES the declaration to be honored; `dev`/`prod` are
 * unconditional install modes.
 */
export const INSTALL_PROFILE_NAMES = ["dev", "prod", "demo"] as const;
export type InstallProfileName = (typeof INSTALL_PROFILE_NAMES)[number];

/** Narrowing guard: is `value` a recognized install-profile vocabulary member? */
export function isInstallProfileName(value: unknown): value is InstallProfileName {
  return typeof value === "string" && (INSTALL_PROFILE_NAMES as readonly string[]).includes(value);
}

const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");

type CinatraBlock = {
  installProfiles?: unknown;
};

let cachedProfiles: InstallProfileName[] | null = null;

/**
 * Validate a raw `cinatra.installProfiles` value into the recognized
 * vocabulary set (fail-closed): a non-array yields `[]`; only recognized
 * vocabulary strings survive (unknown strings are dropped, never trusted);
 * duplicates are de-duped and the result is normalized to canonical
 * vocabulary order so the set is stable regardless of declaration order.
 */
export function parseInstallProfiles(raw: unknown): InstallProfileName[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<InstallProfileName>();
  for (const v of raw) {
    if (isInstallProfileName(v)) seen.add(v);
  }
  return INSTALL_PROFILE_NAMES.filter((p) => seen.has(p));
}

function readRawInstallProfiles(packageJsonPath: string): unknown {
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { cinatra?: CinatraBlock };
    return pkg.cinatra?.installProfiles;
  } catch {
    return undefined;
  }
}

/**
 * Read + validate the declared `cinatra.installProfiles` from the root
 * package.json. Fail-closed via `parseInstallProfiles`.
 *
 * ONLY the default (production) root path is cached — the declaration does not
 * change at runtime. An EXPLICIT `packageJsonPath` always re-reads, so a caller
 * (or test) can read several manifests back-to-back without a stale cross-path
 * result leaking from the cache.
 */
export function readDeclaredInstallProfiles(
  packageJsonPath: string = PACKAGE_JSON_PATH,
): InstallProfileName[] {
  if (packageJsonPath !== PACKAGE_JSON_PATH) {
    return parseInstallProfiles(readRawInstallProfiles(packageJsonPath));
  }
  if (cachedProfiles) return cachedProfiles;
  cachedProfiles = parseInstallProfiles(readRawInstallProfiles(packageJsonPath));
  return cachedProfiles;
}

export function _resetCachedInstallProfilesForTesting() {
  cachedProfiles = null;
}

/** True when the checkout declares support for install mode `profile`. */
export function targetSupportsInstallProfile(
  profile: InstallProfileName,
  packageJsonPath: string = PACKAGE_JSON_PATH,
): boolean {
  return readDeclaredInstallProfiles(packageJsonPath).includes(profile);
}

/**
 * Convenience: does this checkout ship the demo-overlay capability signal
 * (`cinatra.installProfiles` includes `"demo"`)? This is the exact predicate
 * the CLI's `assertTargetSupportsDemo` enforces against the target checkout.
 */
export function targetSupportsDemoProfile(packageJsonPath: string = PACKAGE_JSON_PATH): boolean {
  return targetSupportsInstallProfile("demo", packageJsonPath);
}
