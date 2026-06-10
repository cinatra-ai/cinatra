// Required-in-prod declaration.
//
// Root `package.json` declares the list under `cinatra.requiredExtensions`.
// Each entry is `"<packageName>@<versionRange>"` (e.g.
// `"@cinatra-ai/nango-connector@^0.1.0"`) — the host's pinned compatibility
// intent for that extension (the host → extension half of the compatibility
// contract; the extension → host half is the manifest's `cinatra.sdkAbiRange`).
// A bare name (no range) is tolerated as UNPINNED for forward/back-compat, but
// the canonical root manifest pins every entry. The format is deliberately
// `name@range` ONLY — no dist-tags, aliases, or URLs.
//
// At install/update time:
//   - the host installer refuses an install/update of a PINNED package at a
//     version outside the pinned range (see `checkRequiredExtensionVersionPin`).
//   - production: the canonical lifecycle primitive auto-locks the row
//     because required-in-prod implies locked-in-prod.
//   - dev: the implication is advisory (logged warning if violated).
//
// At boot:
//   - production: missing required packages fail closed.
//   - dev: missing OR version-mismatched required packages log a warning.
import "server-only";

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { listInstalledExtensions } from "./canonical-store";

const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");

type CinatraBlock = {
  requiredExtensions?: string[];
};

/** One parsed `cinatra.requiredExtensions` entry. */
export type RequiredExtensionEntry = {
  packageName: string;
  /** The pinned version range, or null for a bare (unpinned) entry. */
  versionRange: string | null;
};

/** A pinned required package whose installed version does not satisfy the pin. */
export type RequiredVersionMismatch = {
  packageName: string;
  requiredRange: string;
  /** The installed row's version; null when unverifiable (non-registry source). */
  installedVersion: string | null;
};

export type RequiredVerificationResult =
  | { ok: true; required: string[]; installed: string[] }
  | {
      ok: false;
      required: string[];
      installed: string[];
      missing: string[];
      mismatched: RequiredVersionMismatch[];
      reason: string;
    };

let cachedEntries: RequiredExtensionEntry[] | null = null;

/**
 * Parse one `requiredExtensions` entry. Split on the LAST `@` with index > 0 so
 * a scoped bare name (`@scope/name`, lastIndexOf === 0) stays a name; an
 * empty range (trailing `@`) parses as unpinned.
 */
export function parseRequiredExtensionEntry(raw: string): RequiredExtensionEntry | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return { packageName: trimmed, versionRange: null };
  const packageName = trimmed.slice(0, at);
  const versionRange = trimmed.slice(at + 1).trim();
  return { packageName, versionRange: versionRange.length > 0 ? versionRange : null };
}

/**
 * Read + parse the declared required-in-prod entries (name + pinned range)
 * from the root package.json. Cached after the first read (the list does not
 * change at runtime).
 */
export function readRequiredInProdEntries(
  packageJsonPath: string = PACKAGE_JSON_PATH,
): RequiredExtensionEntry[] {
  if (cachedEntries) return cachedEntries;
  if (!existsSync(packageJsonPath)) {
    cachedEntries = [];
    return cachedEntries;
  }
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { cinatra?: CinatraBlock };
    cachedEntries = (pkg.cinatra?.requiredExtensions ?? [])
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map(parseRequiredExtensionEntry)
      .filter((e): e is RequiredExtensionEntry => e !== null);
    return cachedEntries;
  } catch {
    cachedEntries = [];
    return cachedEntries;
  }
}

/**
 * The declared required-in-prod package NAMES (ranges stripped) — the shape
 * every presence-only consumer (system-extension inventory, lock-on-install,
 * boot presence check) keys on.
 */
export function readRequiredInProdPackages(packageJsonPath: string = PACKAGE_JSON_PATH): string[] {
  return readRequiredInProdEntries(packageJsonPath).map((e) => e.packageName);
}

export function _resetCachedRequiredForTesting() {
  cachedEntries = null;
}

export function isPackageRequiredInProd(packageName: string): boolean {
  return readRequiredInProdPackages().includes(packageName);
}

/** The declared entry for a package, or null when not required. */
export function findRequiredInProdEntry(
  packageName: string,
  packageJsonPath: string = PACKAGE_JSON_PATH,
): RequiredExtensionEntry | null {
  return readRequiredInProdEntries(packageJsonPath).find((e) => e.packageName === packageName) ?? null;
}

// ---------------------------------------------------------------------------
// Version-range satisfaction (host-side).
//
// Deliberately NOT the SDK's `isSdkAbiRangeSatisfied`: that checker is part of
// the FROZEN extension ABI and rejects major-0 by design (ABI caret semantics),
// while required extensions live on 0.x lines — so the host needs proper
// npm-style 0.x caret semantics (`^0.1.0` → >=0.1.0 <0.2.0). Supported forms:
// exact `X.Y.Z`, caret `^X.Y.Z`, tilde `~X.Y.Z`, bare/x-range `X` / `X.Y` /
// `X.x` / `X.Y.x`, `>=X.Y.Z`, and `*`. Anything else (dist-tags, `||`,
// hyphen ranges, pre-release) FAILS CLOSED.
// ---------------------------------------------------------------------------

type Triple = [number, number, number];

function parseTriple(v: string): Triple | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** [lower, upperExclusive) bounds for a supported range form, or null → fail closed. */
function requiredRangeBounds(range: string): { lower: Triple; upper: Triple | null } | null {
  const m = range.trim().match(/^(\^|~|>=|=)?\s*(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/);
  if (!m) return null;
  const op = m[1] ?? "=";
  const isWild = (t: string | undefined) => t === undefined || /^[xX*]$/.test(t);
  const maj = Number(m[2]);
  const min = isWild(m[3]) ? null : Number(m[3]);
  const pat = isWild(m[4]) ? null : Number(m[4]);
  const lower: Triple = [maj, min ?? 0, pat ?? 0];
  if (op === ">=") return { lower, upper: null };
  if (op === "^") {
    // npm caret: widen at the leftmost NON-ZERO component.
    if (maj > 0) return { lower, upper: [maj + 1, 0, 0] };
    if ((min ?? 0) > 0) return { lower, upper: [0, (min ?? 0) + 1, 0] };
    // major 0, minor 0: ^0.0.z admits only the exact patch; ^0 / ^0.0 keep
    // their declared wildcard span (npm: ^0.x := 0.x).
    if (pat !== null) return { lower, upper: [0, 0, pat + 1] };
    return { lower, upper: min === null ? [1, 0, 0] : [0, 1, 0] };
  }
  if (op === "~") return { lower, upper: min === null ? [maj + 1, 0, 0] : [maj, min + 1, 0] };
  // "=" / bare / x-range: the upper bound narrows with each specified component.
  if (min === null) return { lower, upper: [maj + 1, 0, 0] }; // "1" / "1.x"
  if (pat === null) return { lower, upper: [maj, min + 1, 0] }; // "1.2" / "1.2.x"
  return { lower, upper: [maj, min, pat + 1] }; // exact "1.2.3"
}

/**
 * Does a CONCRETE version satisfy a declared required-extension range?
 * Fail closed: a non-concrete version (dist-tag, pre-release, garbage) or an
 * unsupported/malformed range is NOT satisfied. `*` admits any concrete version.
 */
export function satisfiesRequiredVersionRange(version: string, range: string): boolean {
  const r = range.trim();
  const v = parseTriple(version);
  if (!v) return false;
  if (r === "*") return true;
  const bounds = requiredRangeBounds(r);
  if (!bounds) return false;
  if (cmp(v, bounds.lower) < 0) return false;
  if (bounds.upper && cmp(v, bounds.upper) >= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Install/update pin gate (the host → extension half of the contract).
// ---------------------------------------------------------------------------

export type RequiredVersionPinVerdict =
  | { ok: true }
  | { ok: false; requiredRange: string; reason: string };

/**
 * The host-installer gate: an install/update of a package PINNED in
 * `cinatra.requiredExtensions` must target a CONCRETE version that satisfies
 * the pinned range. Non-required and unpinned packages always pass. A pinned
 * package with an absent / non-concrete (dist-tag) / out-of-range version is
 * refused with an actionable reason. Pure read of the host's own manifest —
 * safe to run BEFORE any install mutation.
 */
export function checkRequiredExtensionVersionPin(
  input: { packageName: string; version: string | null | undefined; op: "install" | "update" },
  packageJsonPath: string = PACKAGE_JSON_PATH,
): RequiredVersionPinVerdict {
  const entry = findRequiredInProdEntry(input.packageName, packageJsonPath);
  if (!entry || entry.versionRange === null) return { ok: true };
  const requiredRange = entry.versionRange;
  const got = input.version?.trim();
  if (!got || !satisfiesRequiredVersionRange(got, requiredRange)) {
    return {
      ok: false,
      requiredRange,
      reason:
        `${input.op} of ${input.packageName}${got ? `@${got}` : ""} refused: this host pins the ` +
        `required extension to "${requiredRange}" (cinatra.requiredExtensions in the host's ` +
        `package.json), and ${got ? `version "${got}"` : "an install without an explicit version"} ` +
        `does not satisfy that pin (a non-concrete version such as a dist-tag fails closed). ` +
        `Choose a concrete ${input.packageName} version inside "${requiredRange}", or change the ` +
        `host's pinned range first. Nothing was ${input.op === "update" ? "updated" : "installed"}.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Boot-time verification.
// ---------------------------------------------------------------------------

/**
 * Boot-time verification. In production, returns ok=false with details
 * (caller decides whether to throw); in dev, callers usually log the
 * warning and continue.
 *
 * Presence: required-in-prod is a platform-wide contract, satisfied by any
 * installed row (`active` or `locked`) — we intentionally do not narrow by org.
 * Version: for a PINNED entry, EVERY active/locked row of that package must
 * carry a registry version satisfying the pin — a single drifted org-scoped
 * row is a real incompatibility, and a non-registry source (whose version is
 * unverifiable) counts as a mismatch, never a silent pass.
 */
export async function verifyRequiredInProdInstalled(): Promise<RequiredVerificationResult> {
  const entries = readRequiredInProdEntries();
  const required = entries.map((e) => e.packageName);
  if (entries.length === 0) {
    return { ok: true, required: [], installed: [] };
  }

  const all = await listInstalledExtensions({});
  const liveRows = all.filter((e) => e.status === "active" || e.status === "locked");
  const liveByName = new Map<string, typeof liveRows>();
  for (const row of liveRows) {
    const bucket = liveByName.get(row.packageName);
    if (bucket) bucket.push(row);
    else liveByName.set(row.packageName, [row]);
  }

  const installed: string[] = [];
  const missing: string[] = [];
  const mismatched: RequiredVersionMismatch[] = [];
  for (const entry of entries) {
    const rows = liveByName.get(entry.packageName) ?? [];
    if (rows.length === 0) {
      missing.push(entry.packageName);
      continue;
    }
    installed.push(entry.packageName);
    if (entry.versionRange === null) continue;
    for (const row of rows) {
      const version = row.source.type === "verdaccio" ? row.source.version : null;
      if (version === null || !satisfiesRequiredVersionRange(version, entry.versionRange)) {
        mismatched.push({
          packageName: entry.packageName,
          requiredRange: entry.versionRange,
          installedVersion: version,
        });
      }
    }
  }

  if (missing.length === 0 && mismatched.length === 0) {
    return { ok: true, required, installed };
  }
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing from installed_extension manifest: ${missing.join(", ")}`);
  }
  if (mismatched.length > 0) {
    parts.push(
      `version-mismatched (installed vs pinned range): ${mismatched
        .map((m) => `${m.packageName} (installed ${m.installedVersion ?? "unverifiable non-registry source"}, requires ${m.requiredRange})`)
        .join(", ")}`,
    );
  }
  return {
    ok: false,
    required,
    installed,
    missing,
    mismatched,
    reason: `Required-in-prod packages ${parts.join("; ")}`,
  };
}
