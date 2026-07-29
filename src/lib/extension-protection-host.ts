import "server-only";

// ---------------------------------------------------------------------------
// Host reader for the generic extension PROTECTION declaration (cinatra#1927).
//
// Resolves whether an INSTALLED package declares itself protected
// (`cinatra/config.json` → `{ "protected": true }`) by reading the SAME
// materialized declaration bytes the install pipeline validated
// (`readAssistantInstallSignalsFromStore` reads the same file from the same
// store dir), through the SINGLE shared domain parser
// `@cinatra-ai/sdk-extensions/extension-protection`. Kind-agnostic: an agent,
// connector, artifact, skill or workflow package declares protection the same
// way, so this reader never looks at `cinatra.kind`.
//
// This is the production default behind
// `@cinatra-ai/extensions/protected-extension`'s injectable
// `readDeclaredProtection` seam — the removal gates themselves stay pure and
// unit-testable; only this module touches the store.
//
// ABSENCE vs CORRUPTION (the fail-closed split, mirroring the install reader):
//   - no materialized record for the package, no `cinatra/` dir, no
//     `config.json`, or a config with no `protected` key → `false`. Absence is a
//     PROVABLE non-protection: this is the state of every extension in the
//     fleet today, so an ordinary uninstall is completely unaffected.
//   - a config that EXISTS but cannot be read (permissions/IO), is not valid
//     JSON, or carries a non-boolean `protected` → THROW. We cannot prove the
//     extension is unprotected, so the removal is refused rather than allowed.
//
// MULTIPLE RECORDS — ANCHOR-BOUND, with a fail-safe fallback (codex round-1).
// A package can have several materialized digest dirs: a side-by-side version
// row, or a STALE pre-GC digest of a previous version. Naively OR-ing them all
// would let a long-gone version that once declared `protected: true` make the
// CURRENT, unprotected install permanently unremovable — a silent operability
// regression. So the reader binds to the digest the canonical install ANCHOR
// records (the same trust root the loader and the widget-auth provenance arm
// use) and consults ONLY that materialization. The verdict falls back to the OR
// across every record ONLY when no anchor digest is resolvable (an unbound /
// legacy row, an ambiguous multi-org install, or an unreachable manifest) or
// when the anchored digest has no materialized record — in those cases we
// cannot bind, and over-refusing a destructive op is the safe direction.
// ---------------------------------------------------------------------------

import { parseDeclaredProtection } from "@cinatra-ai/sdk-extensions/extension-protection";

/** A materialized package the reader can inspect (the subset of
 *  `PackageStoreRecordV2` this reader needs). `declaredDigest` is the store
 *  path's digest segment — the key the canonical install anchor binds. */
export type ProtectionStoreRecord = {
  packageName: string;
  storeDir: string;
  declaredDigest?: string | null;
};

/** Injectable seams — production passes nothing; tests drive the reader with no
 *  filesystem and no data root. */
export type ExtensionProtectionHostDeps = {
  /** Enumerate every materialized package record (default: the V2 store
   *  discovery over the resolved extension data root). */
  listStoreRecords?: () => Promise<ProtectionStoreRecord[]>;
  /** Read one materialized package's declared protection (default:
   *  {@link readDeclaredProtectionFromStore}). */
  readFromStoreDir?: (storeDir: string, packageName: string) => Promise<boolean>;
  /**
   * The digest of the package's ACTIVE install, from the canonical anchor
   * (default: the platform-global install-anchor resolver — the same one the
   * loader/provenance arms use). `null` = unbound/legacy/ambiguous → the reader
   * falls back to the fail-safe OR across every materialized record.
   */
  resolveActiveDigest?: (packageName: string) => Promise<string | null>;
};

/** Raised when a PRESENT declaration cannot be read or is malformed. Distinct
 *  from the SDK's `ExtensionProtectionDeclarationError` (a schema violation) —
 *  this is the IO/JSON layer. Both are fail-closed for the caller. */
export class ExtensionProtectionReadError extends Error {
  readonly code = "PROTECTION_DECLARATION_UNREADABLE";
  constructor(message: string) {
    super(`[extension-protection-host] ${message}`);
    this.name = "ExtensionProtectionReadError";
  }
}

/**
 * Read the declared protection of ONE materialized package dir. See the
 * absence-vs-corruption contract above.
 */
export async function readDeclaredProtectionFromStore(
  storeDir: string,
  packageName: string,
): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  const configPath = path.join(storeDir, "cinatra", "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Genuinely absent → the package declares no protection.
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new ExtensionProtectionReadError(
      `cinatra/config.json for ${packageName} exists but is unreadable: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ExtensionProtectionReadError(
      `cinatra/config.json for ${packageName} is not valid JSON: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // The SHARED domain parser — a non-boolean `protected` throws
  // (`ExtensionProtectionDeclarationError`), never coerces.
  return parseDeclaredProtection(parsed, { packageName });
}

async function defaultListStoreRecords(): Promise<ProtectionStoreRecord[]> {
  const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
  const { discoverStoreRecordsV2, realStoreFs } = await import("@/lib/extension-store-io");
  const records = await discoverStoreRecordsV2(resolveExtensionDataRoot(), realStoreFs);
  return records.map((r) => ({
    packageName: r.packageName,
    storeDir: r.storeDir,
    declaredDigest: r.declaredDigest ?? null,
  }));
}

/**
 * Default `resolveActiveDigest` — the canonical install anchor's digest at
 * platform-global scope (0 or an ambiguous multi-org install resolves `null`,
 * exactly as every other anchor consumer treats it). BEST-EFFORT: an
 * unreachable manifest resolves `null` (fall back to the fail-safe OR) rather
 * than throwing, so the removal gate keeps working when the canonical store is
 * down — the pre-existing behavior of the choke-point it runs inside.
 */
async function defaultResolveActiveDigest(packageName: string): Promise<string | null> {
  try {
    const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
    const resolver = await makeDefaultInstallAnchorResolver(null, "platform-global");
    const anchor = await resolver(packageName);
    return anchor?.digest ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve whether `packageName`'s installed declaration marks it protected.
 * The production default behind the removal gate's `readDeclaredProtection`
 * seam. Returns `false` when the package has no materialized record at all.
 */
export async function resolveDeclaredProtectionForPackage(
  packageName: string,
  deps: ExtensionProtectionHostDeps = {},
): Promise<boolean> {
  const list = deps.listStoreRecords ?? defaultListStoreRecords;
  const read = deps.readFromStoreDir ?? readDeclaredProtectionFromStore;
  const resolveActiveDigest = deps.resolveActiveDigest ?? defaultResolveActiveDigest;

  const records = (await list()).filter((r) => r.packageName === packageName);
  if (records.length === 0) return false;

  // ANCHOR-BOUND: consult ONLY the materialization the canonical anchor names,
  // so a stale pre-GC digest of a formerly-protected version cannot make the
  // current install unremovable.
  const activeDigest = await resolveActiveDigest(packageName);
  const anchored = activeDigest
    ? records.filter((r) => (r.declaredDigest ?? null) === activeDigest)
    : [];
  // No anchor, or an anchor naming a digest we have not materialized → we cannot
  // bind; fall back to the fail-safe OR across every record.
  const considered = anchored.length > 0 ? anchored : records;

  for (const record of considered) {
    if (await read(record.storeDir, packageName)) return true;
  }
  return false;
}
