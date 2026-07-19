import "server-only";

// ---------------------------------------------------------------------------
// Production artifact-bridge package-store rescan (cinatra#661).
//
// The bundled artifact-bridge scan (`registerArtifactExtensions`, driven from
// `register-all-object-types.ts`) only ever scanned the IMAGE-bundled tree
// (`process.cwd()/extensions/cinatra-ai`). A RUNTIME-installed artifact package
// is metadata-only (no serverEntry), so the runtime activator returns
// `no-server-entry` and never registers its object type in-process — the
// artifact type therefore never appeared after a marketplace install, even
// after a restart, because nothing scanned the runtime store.
//
// This adapter closes that gap: it scans the on-disk package store and
// registers each materialized `kind:"artifact"` package's generic object type
// (WITH package provenance, so teardown can later reach it), giving metadata-
// only artifacts a registration path PARALLEL to the server-entry activator.
//
// SECURITY (unsigned-code-execution invariant preserved): this NEVER imports or
// executes any package code. It reads `package.json` only (via the bridge's own
// `registerArtifactExtensionDir`, which parses + validates the semantic
// manifest) and registers a pure-DATA object-type descriptor. There is no
// server entry to import for an artifact, and we do not resolve one.
//
// FAIL-CLOSED against the canonical store: a store dir is registered ONLY when
// the package's canonical `installed_extension` row is `active|locked` (or it is
// an ungoverned bundled/disk artifact with no row — CG-1). A deliberately
// archived install in the store is NOT re-registered, so the rescan can never
// resurrect a torn-down artifact type. The status check is
// `isArtifactExtensionWriteAllowed` — the SAME DB-status gate the write paths
// use, so discovery and write authz can never diverge.
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from "node:fs/promises";
import {
  type PackageStoreFs,
} from "@cinatra-ai/sdk-extensions";
import { registerArtifactExtensionDir } from "@cinatra-ai/objects/register-artifact-extensions";
import {
  hasLiveInstallRow,
  isArtifactExtensionWriteAllowed,
} from "@/lib/artifacts/artifact-extension-access";

/** Real node:fs surface for the pure store-discovery walk (read-only). */
const realFs: PackageStoreFs = {
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: async (p) => {
    try {
      return await readdir(p);
    } catch {
      return [];
    }
  },
  readFile: (p) => readFile(p, "utf8"),
};

/** True iff a materialized store record's `package.json` declares an artifact
 *  kind. Read-only `package.json` probe; never imports package code. Any read
 *  error → false (skip, never fatal). */
async function recordIsArtifactKind(storeDir: string): Promise<boolean> {
  try {
    const raw = await realFs.readFile(`${storeDir}/package.json`);
    const pkg = JSON.parse(raw) as { cinatra?: { kind?: unknown } };
    return pkg?.cinatra?.kind === "artifact";
  } catch {
    return false;
  }
}

export type RescanArtifactBridgeOptions = {
  /** Override the package store root (defaults to the `/data` volume path).
   *  Tests pass a temp dir. */
  storeRoot?: string;
  /** Limit the rescan to a single package (the activate-hook path passes the
   *  just-installed package so an install registers only its own type). */
  onlyPackage?: string;
  /**
   * cinatra#1837 R3: a package being RESTORED whose canonical row is still
   * archived at the moment of this call. The write-allowed gate correctly
   * refuses archived rows for the ordinary rescan (so it can never resurrect a
   * torn-down type), but restore must register the restored type's surface
   * BEFORE it flips the row active in the SAME held-lock operation — else the
   * activation gate cannot resolve the type's validator on the archived row
   * (F3). For THIS package only, the write-allowed gate is bypassed; every other
   * fail-closed narrowing (digest/anchor/kind) still applies. Must be paired
   * with `onlyPackage` so nothing else is affected.
   */
  restorePackage?: string;
};

export type RescanArtifactBridgeResult = {
  /** The package names whose artifact object type was (re)registered. */
  registered: string[];
  /** The registered packages WITH their anchor-vetted store dir — the input the
   *  boot claim-activation backstop needs (cinatra#1493): same order as
   *  `registered`, one record per registered package. */
  registeredRecords: Array<{ packageName: string; storeDir: string }>;
  /** The package names found in the store as `kind:"artifact"` but SKIPPED
   *  because their install row is archived/absent-and-governed (fail-closed). */
  skippedNotActive: string[];
};

/**
 * Rescan the on-disk package store and register every materialized,
 * install-active `kind:"artifact"` package's object type WITH provenance.
 *
 * Idempotent: the object registry is replace-by-id, so re-running across
 * web/worker restarts (or after a same-digest re-activate) is a clean no-op for
 * an already-registered type. A missing store root yields an empty result (a
 * deployment with no `/data` volume is a clean no-op, never an error) — matching
 * `discoverPackageStoreRecords`'s own semantics. Every per-dir step is
 * best-effort: an unreadable/foreign dir is skipped, never fatal.
 */
export async function rescanArtifactBridgeFromStore(
  opts: RescanArtifactBridgeOptions = {},
): Promise<RescanArtifactBridgeResult> {
  const storeRoot =
    opts.storeRoot ?? (await import("@/lib/extension-data-root")).resolveExtensionDataRoot();
  const registered: string[] = [];
  const registeredRecords: Array<{ packageName: string; storeDir: string }> = [];
  const skippedNotActive: string[] = [];

  const { discoverStoreRecordsV2 } = await import("@/lib/extension-store-io");
  let records: Awaited<ReturnType<typeof discoverStoreRecordsV2>>;
  try {
    records = await discoverStoreRecordsV2(storeRoot, realFs);
  } catch (err) {
    // A discovery failure must NOT crash boot or an install — degrade to a
    // no-op rescan (the bundled built-ins are already registered separately).
    console.warn(
      "[artifact-bridge-rescan] store discovery failed — skipping rescan:",
      err instanceof Error ? err.message : err,
    );
    return { registered, registeredRecords, skippedNotActive };
  }

  // cinatra#792 — MULTI-DIGEST NARROWING + UNIFORM ANCHOR KIND BINDING: with
  // retention (#796) several digests of one package may legitimately be on disk.
  // A package discovered at more than one digest registers ONLY its anchor-bound
  // digest (the DB pins it); no anchor / a digest-unbound anchor with >1 digest =
  // skip the package (fail closed — never register an arbitrary digest's object
  // type). The trusted install anchor also carries the canonical row's KIND, and
  // that kind gates a SINGLE-digest record too: a package whose row governs a
  // DIFFERENT kind than the store path kind must never register an object type
  // (fail closed, uniformly with the boot loader). A package with NO row resolves
  // to a null anchor and keeps the ungoverned (no-row) bundled/disk allowance
  // (CG-1).
  const digestCountByName = new Map<string, number>();
  for (const rec of records) {
    digestCountByName.set(rec.packageName, (digestCountByName.get(rec.packageName) ?? 0) + 1);
  }
  // Resolve the anchor for EVERY package (memoized), not only the multi-digest
  // ones — the single-digest kind binding needs it. A resolver that is
  // unavailable (no DB at boot) degrades to the pre-#792 posture: multi-digest
  // packages fail closed (skipped below), single-digest packages proceed unbound.
  let boundAnchorFor:
    | ((packageName: string) => Promise<{ digest: string | null; kind: string | null } | null>)
    | null = null;
  try {
    const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
    const resolveAnchor = await makeDefaultInstallAnchorResolver();
    const memo = new Map<string, { digest: string | null; kind: string | null } | null>();
    boundAnchorFor = async (packageName: string) => {
      if (memo.has(packageName)) return memo.get(packageName) ?? null;
      const anchor = await resolveAnchor(packageName);
      const bound = anchor ? { digest: anchor.digest ?? null, kind: anchor.kind ?? null } : null;
      memo.set(packageName, bound);
      return bound;
    };
  } catch (err) {
    console.warn(
      "[artifact-bridge-rescan] anchor resolver unavailable — multi-digest packages skipped, " +
        "single-digest packages proceed unbound:",
      err instanceof Error ? err.message : err,
    );
  }

  for (const rec of records) {
    if (opts.onlyPackage && rec.packageName !== opts.onlyPackage) continue;
    const multiDigest = (digestCountByName.get(rec.packageName) ?? 0) > 1;
    const anchor = boundAnchorFor ? await boundAnchorFor(rec.packageName) : null;
    if (multiDigest) {
      // Ambiguous on disk: register ONLY the anchor-bound digest; an unbound or
      // absent anchor with >1 digest = fail closed.
      const bound = anchor?.digest ?? null;
      if (!bound || rec.declaredDigest !== bound) {
        console.warn(
          `[artifact-bridge-rescan] skipping ${rec.packageName}@${rec.declaredDigest ?? "(flat)"}: ` +
            `multiple store digests on disk and this one is not the anchor-bound digest ` +
            `(${bound ?? "unbound"}) — fail closed`,
        );
        continue;
      }
    } else if (anchor != null) {
      // Single-digest WITH a resolved anchor: if the row pins a digest, it must
      // match the one on disk. An unbound anchor (digest null) leaves the single
      // unambiguous record registrable, as before.
      if (anchor.digest != null && rec.declaredDigest !== anchor.digest) {
        console.warn(
          `[artifact-bridge-rescan] skipping ${rec.packageName}@${rec.declaredDigest ?? "(flat)"}: ` +
            `the canonical row pins digest ${anchor.digest} but only this unpinned digest is on disk — fail closed`,
        );
        continue;
      }
    } else if (await hasLiveInstallRow(rec.packageName)) {
      // Single-digest, resolver returned NO anchor. `null` from the resolver
      // conflates "no row" with "row present but REFUSED" (activeDigest/journal
      // mismatch or ambiguous scope); the live-row probe disambiguates it and
      // FAILS CLOSED on its own read error (returns true) so an unreadable store
      // can never be misread as ungoverned. A true result here = a governed
      // package whose anchor was refused OR an unprovable store → never register
      // an unpinned digest. (Only a PROVEN-absent live row falls through to the
      // CG-1 ungoverned bundled/disk allowance via the recordIsArtifactKind /
      // write-allow gates below.)
      console.warn(
        `[artifact-bridge-rescan] skipping ${rec.packageName}@${rec.declaredDigest ?? "(flat)"}: ` +
          `a live canonical row exists but its trusted anchor could not be resolved ` +
          `(refused/ambiguous) — fail closed`,
      );
      continue;
    }
    // cinatra#792 — ANCHOR KIND BINDING (uniform across single- and multi-digest,
    // same rule as the boot loader): the canonical row's kind must agree with the
    // record's PATH-derived kind — a package/digest materialized under a DIFFERENT
    // kind dir than the row governs must never register an object type (fail
    // closed). An unbound (null) anchor kind = no assertion (legacy resolvers); no
    // anchor at all = the ungoverned (no-row) bundled/disk allowance (CG-1).
    if (anchor?.kind != null && anchor.kind !== rec.kind) {
      console.warn(
        `[artifact-bridge-rescan] skipping ${rec.packageName}@${rec.declaredDigest ?? "(flat)"}: ` +
          `canonical row kind ${JSON.stringify(anchor.kind)} contradicts the store path kind ` +
          `"${rec.kind}" — fail closed`,
      );
      continue;
    }
    // Read-only probe: only `kind:"artifact"` packages have a bridge type.
    if (!(await recordIsArtifactKind(rec.storeDir))) continue;

    // FAIL-CLOSED against the canonical store: never re-register an archived
    // install. An ungoverned (no-row) bundled/disk artifact is allowed (CG-1).
    // EXCEPTION (cinatra#1837 R3): a package being RESTORED registers its
    // still-archived type surface here so its claim reactivation can resolve the
    // validator before the row flips active in the same locked operation.
    if (opts.restorePackage !== rec.packageName && !(await isArtifactExtensionWriteAllowed(rec.packageName))) {
      skippedNotActive.push(rec.packageName);
      continue;
    }

    try {
      if (registerArtifactExtensionDir(rec.storeDir)) {
        registered.push(rec.packageName);
        registeredRecords.push({ packageName: rec.packageName, storeDir: rec.storeDir });
      }
    } catch (err) {
      console.warn(
        `[artifact-bridge-rescan] failed to register ${rec.packageName} from ${rec.storeDir}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (registered.length || skippedNotActive.length) {
    console.info(
      `[artifact-bridge-rescan] store=${storeRoot} registered=[${registered.join(", ")}]` +
        (skippedNotActive.length ? ` skipped(not-active)=[${skippedNotActive.join(", ")}]` : ""),
    );
  }
  return { registered, registeredRecords, skippedNotActive };
}
