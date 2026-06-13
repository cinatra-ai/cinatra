import "server-only";

// The runtime extension package-store materializer (the runtime installer).
//
// Turns a registry tarball into a verified, on-disk package the
// `RuntimePackageLoader` can discover + dynamically import WITHOUT an image
// rebuild. The flow:
//   1. fetch the EXACT tarball bytes (default: pacote via @cinatra-ai/registries);
//   2. verify SRI over those bytes BEFORE anything is written;
//   3. extract into a TEMP dir (no lifecycle scripts ever — the security-hardening rule);
//   4. validate it is a Cinatra extension + the bundled-deps gate;
//   5. compute a content hash + write the `.cinatra-store.json` sidecar;
//   6. atomically rename TEMP -> `<storeRoot>/<pkg@ver>/<digest>/` and persist
//      the verified tarball alongside as `<digest>.tgz` for boot re-verify.
//
// `verifyMaterializedPackageIntegrity` is the loader's `verifyIntegrity` hook:
// it re-verifies on every boot — the declared digest binds the
// store path to the verified tarball, the content hash detects on-disk
// tampering, and the persisted tarball is re-checked against its recorded SRI.

import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_PACKAGE_STORE_PATH,
  classifyServerEntryArtifact,
  resolveDeclaredServerEntry,
  resolveExportsSubpath,
  type PackageStoreRecord,
} from "@cinatra-ai/sdk-extensions";
import {
  HOST_PROVIDED_PACKAGES,
  STORE_SIDECAR_FILENAME,
  basePackageOfSpecifier,
  contentHashOfEntries,
  parseModuleImports,
  scanHostPeerValueImports,
  sriMatches,
  storePackageDir,
  tarballDigestSegment,
  validateBundledDependencies,
  type ContentHashEntry,
  type StoreSidecar,
} from "@/lib/extension-package-store-core";
import {
  planRootDependencyNames,
  type MaterializationPlan,
} from "@/lib/extension-materialization-plan-core";
import {
  executeMaterializationPlan,
  extractTarballHardened,
} from "@/lib/extension-materialization-plan-executor";
import { isBuiltin } from "node:module";

export type FetchTarballResult = { bytes: Buffer; integrity: string };
export type FetchTarball = (input: {
  packageName: string;
  packageVersion?: string;
  expectedIntegrity?: string;
}) => Promise<FetchTarballResult>;

export type MaterializeInput = {
  packageName: string;
  version: string;
  /** Recorded SRI (`sha512-...`) to verify the tarball against. Required for untrusted installs. */
  expectedIntegrity: string;
  /** Registry the tarball was resolved from — persisted for boot-time trust. */
  registryUrl?: string;
  /** Override the store root (default `/data/extensions/packages`). */
  storeRoot?: string;
  /**
   * The PARSED + VALIDATED signed materialization plan (cinatra#181), when
   * the package declares a library-dependency closure. The pipeline parses
   * the packument transport, verifies the v2 signature against its own
   * recomputed closureHash, and threads BOTH here; the executor re-derives
   * the hash and refuses a mismatch. null/omitted = closure-less (today's
   * behavior byte-for-byte).
   */
  plan?: MaterializationPlan | null;
  /** The pipeline-verified closureHash (REQUIRED when `plan` is set). */
  expectedClosureHash?: string | null;
};

export type MaterializeDeps = {
  /** Injected tarball fetch (default: pacote via @cinatra-ai/registries). */
  fetchTarball?: FetchTarball;
  /** Injected clock (ISO). */
  now?: () => string;
};

export type MaterializedPackage = {
  packageName: string;
  version: string;
  storeDir: string;
  digest: string;
  integrity: string;
  /**
   * Content hash of the materialized dir, computed at install time when the
   * tarball was trusted. The installer (the installer flow) persists this in the DB
   * install record so boot can re-verify the extracted files against a trusted
   * anchor OUTSIDE the writable store (the sidecar alone is self-attested).
   */
  contentHash: string;
  /** True when an already-materialized, integrity-valid dir was reused. */
  reused: boolean;
};

/**
 * The trusted install anchor (the installer flow supplies it from the DB install record;
 * the runtime loader ships the seam). Lives OUTSIDE the writable package store, so it —
 * not the in-store sidecar — is the root of trust for boot-time verification.
 */
export type InstallTrustAnchor = {
  /** Authoritative tarball SRI (recorded at install). */
  integrity: string;
  /** Authoritative content hash of the materialized dir (recorded at install). */
  contentHash: string;
  /** Registry the package was resolved from (drives the trust classifier). */
  registryUrl: string | null;
  /** A persisted host trust decision; undefined = not yet decided. */
  trustDecision?: boolean;
  /**
   * The admin-APPROVED host-port subset (from the grant store). The loader grants
   * the extension ONLY these ports, NOT the raw manifest's requestedHostPorts.
   */
  approvedPorts?: readonly string[];
  /** The package version (recorded at install) — part of the signature payload. */
  version?: string | null;
  /** The base64 Ed25519 signature over the tarball (recorded at install), if signed. */
  signature?: string | null;
  /**
   * The 128-hex closureHash recorded at install when the package carried a
   * signed materialization plan (cinatra#181). Threaded into the v2 signature
   * verdict at boot/activation — a closure package can never re-verify as
   * trusted on a v1/absent signature. null/undefined = closure-less.
   */
  closureHash?: string | null;
  /**
   * The tarball DIGEST the FINALIZED install-op journal recorded for this anchor
   * (cinatra#158). The on-disk store dir is `<pkg>@<ver>/<digest>`, so the loader
   * binds the journal anchor to the actual bytes by asserting
   * `record.declaredDigest === anchor.digest` — fail-closed on a mismatch. This
   * closes the append-only residue where an OLD `finalized` journal op could
   * coexist with a NEW canonical source (a crash mid-restore): NEW bytes verify
   * against NEW source, but the OLD anchor's digest will not match, so NEW is
   * refused. null when the finalized op recorded no digest (legacy rows) — the
   * loader treats a null anchor digest as "unbound" and does not assert (the
   * integrity/contentHash re-verify remains the backstop).
   */
  digest?: string | null;
};

/** Default fetch — lazily imports the registries package (pacote lives there). */
const defaultFetchTarball: FetchTarball = async (input) => {
  const { fetchExtensionTarballBytes } = await import("@cinatra-ai/registries");
  const { loadVerdaccioConfigForServer } = await import("@/lib/verdaccio-config");
  const config = await loadVerdaccioConfigForServer();
  return fetchExtensionTarballBytes(
    {
      packageName: input.packageName,
      packageVersion: input.packageVersion,
      expectedIntegrity: input.expectedIntegrity,
    },
    config,
  );
};

/**
 * Materialize a verified package into the on-disk store. Idempotent: a second
 * call with the same bytes resolves to the same `<digest>` dir and reuses it if
 * it is already present + integrity-valid.
 */
export async function materializePackageToStore(
  input: MaterializeInput,
  deps: MaterializeDeps = {},
): Promise<MaterializedPackage> {
  const fetchTarball = deps.fetchTarball ?? defaultFetchTarball;
  const now = deps.now ?? (() => new Date().toISOString());
  const storeRoot = input.storeRoot ?? DEFAULT_PACKAGE_STORE_PATH;

  // cinatra#181 — library-dependency-closure threading preconditions. The plan
  // (when present) must arrive WITH the pipeline-verified closureHash, and its
  // self-declared identity must equal the package being materialized — a plan
  // signed for another (name, version) must never execute here.
  const plan = input.plan ?? null;
  const expectedClosureHash = input.expectedClosureHash ?? null;
  if (plan && !expectedClosureHash) {
    throw new Error(
      `[package-store] ${input.packageName}: a materialization plan was threaded without its verified ` +
        `closureHash — refusing (the executor requires the pipeline-verified hash)`,
    );
  }
  if (!plan && expectedClosureHash) {
    throw new Error(
      `[package-store] ${input.packageName}: a closureHash was threaded without its plan — refusing ` +
        `(inconsistent caller threading)`,
    );
  }
  if (plan && (plan.package.name !== input.packageName || plan.package.version !== input.version)) {
    throw new Error(
      `[package-store] ${input.packageName}@${input.version}: the materialization plan identifies as ` +
        `${plan.package.name}@${plan.package.version} — a plan must bind the exact package it executes for`,
    );
  }

  // 1. fetch bytes + 2. verify SRI BEFORE writing anything.
  const { bytes, integrity } = await fetchTarball({
    packageName: input.packageName,
    packageVersion: input.version,
    expectedIntegrity: input.expectedIntegrity,
  });
  if (!sriMatches(bytes, input.expectedIntegrity)) {
    throw new Error(
      `[package-store] integrity mismatch for ${input.packageName}@${input.version} ` +
        `— refusing to materialize (expected ${input.expectedIntegrity})`,
    );
  }

  const digest = tarballDigestSegment(bytes);
  const targetDir = storePackageDir(storeRoot, input.packageName, input.version, digest);
  const targetTarball = `${targetDir}.tgz`;

  // Idempotency: if already materialized + integrity-valid, reuse it. The
  // expected anchor here is the freshly-fetched, SRI-verified tarball we just
  // downloaded (authoritative), not the in-store sidecar.
  if (await pathExists(path.join(targetDir, "package.json"))) {
    const ok = await verifyMaterializedPackageIntegrity(
      {
        packageName: input.packageName,
        serverEntry: null,
        requestedHostPorts: [],
        storeDir: targetDir,
        declaredDigest: digest,
      },
      { trustedIntegrity: input.expectedIntegrity },
    );
    const existingSidecar = ok ? await readStoreSidecar(targetDir) : null;
    if (ok && existingSidecar) {
      // The built-artifacts-only gate (step 4.6 below) applies to the REUSE
      // path too (codex AB-r1 finding 2): an integrity-valid same-digest dir
      // written by a PRE-CONTRACT installer must not be accepted as a
      // successful materialization — re-installing a source-mirror package
      // must refuse loudly, not silently reuse the old dir. An unreadable
      // manifest falls through to remove + re-materialize (where the fresh
      // extract re-runs full validation over the same bytes).
      const existingPkgRaw = await readFile(path.join(targetDir, "package.json"), "utf8").catch(() => null);
      let existingPkg: Record<string, unknown> | null = null;
      if (existingPkgRaw) {
        try {
          existingPkg = JSON.parse(existingPkgRaw) as Record<string, unknown>;
        } catch {
          existingPkg = null;
        }
      }
      if (existingPkg) {
        await assertServerEntryIsBuiltArtifact(targetDir, existingPkg, input.packageName);
        // cinatra#181 REUSE closure check — FAIL-LOUD, NON-DESTRUCTIVE (codex
        // round-0 finding 3): a signed plan is IMMUTABLE per (name, version,
        // integrity), so a same-digest dir whose recorded closureHash differs
        // from the expected plan's (or is absent when a plan is expected, or
        // present when none is) is refused with operator remediation — NEVER
        // silently reused and NEVER automatically removed (the dir may be a
        // live finalized install; store identity is <pkg>@<ver>/<digest>).
        const recordedClosureHash = existingSidecar.closureHash ?? null;
        if (recordedClosureHash !== expectedClosureHash) {
          throw new Error(
            `[package-store] ${input.packageName}@${input.version}: an integrity-valid store dir for this ` +
              `exact tarball digest exists, but its recorded closureHash ` +
              `(${recordedClosureHash ?? "absent"}) does not match the expected plan's ` +
              `(${expectedClosureHash ?? "absent"}). A signed plan is immutable per (name, version, ` +
              `integrity) — this dir was materialized under a different/absent plan (possibly by a ` +
              `pre-closure installer, possibly tampering). Refusing to reuse AND refusing to delete a ` +
              `possibly-live install: an operator must uninstall the package (or remove ${targetDir} ` +
              `after confirming it is not live) before re-installing.`,
          );
        }
        return {
          packageName: input.packageName,
          version: input.version,
          storeDir: targetDir,
          digest,
          integrity,
          contentHash: existingSidecar.contentHash,
          reused: true,
        };
      }
    }
    // Present but invalid → remove + re-materialize.
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(targetTarball, { force: true }).catch(() => undefined);
  }

  // 3. extract into a temp dir (strip the npm `package/` prefix). No scripts.
  // cinatra#158 EXDEV FIX: stage on the SAME FILESYSTEM as `targetDir`, NOT under
  // `os.tmpdir()`. On the typical container topology `storeRoot` (e.g. the `/data`
  // volume) and `os.tmpdir()` are on DIFFERENT filesystems, so the publish-time
  // `rename(extractDir, targetDir)` would throw EXDEV (a hazard CI never exercises
  // because CI runs both on one fs). We stage in a dedicated `.staging` SIBLING of
  // `storeRoot` (same parent dir → same fs as the target, but OUTSIDE the scanned
  // store tree, so `discoverPackageStoreRecords` never mistakes a half-extracted
  // staging dir for a materialized package). The publish rename is then
  // intra-filesystem (atomic); `atomicReplaceDir` additionally carries an EXDEV
  // copy-fallback as defense-in-depth.
  const stagingRoot = path.join(path.dirname(storeRoot), ".cinatra-ext-staging");
  await mkdir(stagingRoot, { recursive: true });
  const tmpRoot = await mkdtemp(path.join(stagingRoot, "materialize-"));
  const extractDir = path.join(tmpRoot, "pkg");
  await mkdir(extractDir, { recursive: true });
  try {
    // HARDENED extraction (cinatra#181, codex round-0 finding 4): the tar
    // entry-type filter accepts ONLY File + Directory headers — a HARDLINK
    // (Link) entry materializes as a regular file and passes every
    // `lstat`-based walk, so the header is the only reliable refusal point.
    // Bundled node_modules stays LEGAL for the extension tarball itself
    // (inline-mode packages bundle their deps).
    await extractTarballHardened({
      bytes,
      destDir: extractDir,
      label: `${input.packageName}@${input.version}`,
      forbidNodeModules: false,
    });

    // 3b. Walk-time re-check (defense in depth behind the tar-header filter):
    // reject symlinks / special files anywhere under the extracted tree — a
    // bundled symlink would let `file://` import + the content hash escape the
    // integrity-verified package dir.
    await assertNoUnsafeEntries(extractDir);

    // 4. validate it is a Cinatra extension + the bundled-deps gate.
    const pkgJsonRaw = await readFile(path.join(extractDir, "package.json"), "utf8").catch(() => null);
    if (!pkgJsonRaw) {
      throw new Error(`[package-store] tarball for ${input.packageName} has no package.json`);
    }
    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = JSON.parse(pkgJsonRaw) as Record<string, unknown>;
    } catch {
      throw new Error(`[package-store] ${input.packageName}: package.json is not valid JSON`);
    }
    if (!pkgJson.cinatra || typeof pkgJson.cinatra !== "object") {
      throw new Error(`[package-store] ${input.packageName}: not a Cinatra extension (no cinatra manifest block)`);
    }
    const present = await readPresentNodeModules(path.join(extractDir, "node_modules"));
    const planRootDeps = plan ? planRootDependencyNames(plan) : null;
    const depVerdict = validateBundledDependencies(pkgJson, present, planRootDeps);
    if (!depVerdict.ok) {
      if (depVerdict.hostProvidedInDeps.length > 0) {
        throw new Error(
          `[package-store] ${input.packageName}: host-provided SDK package(s) in "dependencies" ` +
            `(${depVerdict.hostProvidedInDeps.join(", ")}). These are host-internal peers — declare them in ` +
            `"peerDependencies" and never bundle a copy (a duplicate SDK instance breaks ABI identity).`,
        );
      }
      if (depVerdict.bundledAndPlanned && depVerdict.bundledAndPlanned.length > 0) {
        throw new Error(
          `[package-store] ${input.packageName}: dependency(ies) ${depVerdict.bundledAndPlanned.join(", ")} ` +
            `are BOTH bundled in the tarball AND covered by the signed materialization plan — one source ` +
            `of truth per dependency (bundled XOR planned); refusing.`,
        );
      }
      if (depVerdict.planOnlyUndeclared && depVerdict.planOnlyUndeclared.length > 0) {
        throw new Error(
          `[package-store] ${input.packageName}: the signed materialization plan covers ` +
            `${depVerdict.planOnlyUndeclared.join(", ")} which the manifest does not declare in ` +
            `"dependencies" — plan and manifest must reconcile in both directions; refusing.`,
        );
      }
      throw new Error(
        `[package-store] ${input.packageName}: runtime dependencies are neither bundled in the tarball ` +
          `nor covered by a signed materialization plan (${depVerdict.missing.join(", ")}). Extensions ` +
          `MUST ship every runtime dep (bundled, or via a signed plan) — the installer never runs ` +
          `npm/pnpm install (the security-hardening rule).`,
      );
    }

    // 4.5. Host-peer value-import gate (model-B runtime-resolution rule). The
    // extension's serverEntry import graph must keep host-internal SDK peers
    // (@cinatra-ai/sdk-extensions / sdk-ui / mcp-client) type-only (erased at
    // compile) or take the value via the injected `ctx`. A runtime VALUE import
    // of a host peer is the hazard the prod `file://` loader CANNOT resolve — the
    // bare specifier has no entry in the store dir's node_modules and the
    // bundled-deps gate (above) forbids bundling one, so it would either
    // ERR_MODULE_NOT_FOUND or load a SECOND SDK instance and break ABI identity.
    // Fail-closed at materialize time so a hazardous package is never published.
    await assertNoHostPeerValueImports(extractDir, pkgJson, input.packageName);

    // 4.6. Built-artifacts-only serverEntry gate (cinatra#161 — the PRIMARY
    // refusal). A declared `cinatra.serverEntry` must resolve — through the
    // shared exports-aware resolver, same semantics as the loader — to an
    // EXISTING regular file with a Node-importable extension. A source-mirror
    // shape is REFUSED loudly HERE, at install time, never deferred to an
    // opaque activation failure. `serverEntry` absent stays a valid
    // no-server-entry package (agents/skills/artifacts unaffected).
    await assertServerEntryIsBuiltArtifact(extractDir, pkgJson, input.packageName);

    // 4.7 (cinatra#181) — execute the SIGNED materialization plan VERBATIM,
    // BEFORE the step-5 content hash so the hash + the install trust anchor
    // cover the POST-closure tree (boot re-verify then covers the libraries
    // with zero loader changes). Per-node fetches ride the SAME injected
    // fetchTarball seam as the root tarball (broker identity preserved); the
    // executor re-derives the closureHash and refuses caller-threading drift.
    if (plan && expectedClosureHash) {
      await executeMaterializationPlan(
        { plan, expectedClosureHash, packageDir: extractDir, packageName: input.packageName },
        { fetchTarball },
      );

      // 4.8 — residual-coverage check (the install-time mirror of the
      // closure-mode builder's relaxed residual-import check): every bare
      // VALUE-import specifier reachable from the built serverEntry must map
      // to a node builtin, a bundled top-level node_modules package, or a
      // plan ROOT dependency. Anything else would defer to an opaque
      // activation-time ERR_MODULE_NOT_FOUND — refuse at materialize instead.
      // Closure packages only: the closure-less path stays byte-for-byte
      // today's behavior. `present` is the PRE-plan bundled set: a hoisted
      // TRANSITIVE plan node legally lands at
      // top-level node_modules, but direct extension imports of it are
      // covered ONLY by plan ROOTS — Node would resolve such an import today
      // and silently break when the transitive dep dedupes elsewhere.
      await assertServerEntryBareSpecifierCoverage(extractDir, pkgJson, input.packageName, {
        present,
        planRoots: planRootDeps ?? new Set<string>(),
      });
    }

    // 5. content hash (excludes the sidecar we are about to write) + sidecar.
    const entries = await collectFileEntries(extractDir, [STORE_SIDECAR_FILENAME]);
    const contentHash = contentHashOfEntries(entries);
    const sidecar: StoreSidecar = {
      integrity: input.expectedIntegrity,
      tarballDigest: digest,
      contentHash,
      packageName: input.packageName,
      version: input.version,
      registryUrl: input.registryUrl,
      ...(expectedClosureHash ? { closureHash: expectedClosureHash } : {}),
      materializedAt: now(),
    };
    await writeFile(path.join(extractDir, STORE_SIDECAR_FILENAME), JSON.stringify(sidecar, null, 2));

    // 6. publish. Write the verified tarball FIRST, then publish the dir LAST,
    // so boot never discovers a package dir without its trusted tarball
    // (verifyMaterializedPackageIntegrity fails closed on a missing tarball).
    await mkdir(path.dirname(targetDir), { recursive: true });
    await writeFile(targetTarball, bytes);
    try {
      await atomicReplaceDir(extractDir, targetDir);
    } catch (error) {
      await rm(targetTarball, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      packageName: input.packageName,
      version: input.version,
      storeDir: targetDir,
      digest,
      integrity,
      contentHash,
      reused: false,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export type VerifyIntegrityOptions = {
  /**
   * Authoritative tarball SRI from a TRUSTED source OUTSIDE the writable store
   * (the installer flow's DB install record). When provided it is the root of trust;
   * the in-store sidecar is treated as informational only.
   */
  trustedIntegrity?: string;
  /** Authoritative content hash from the trusted install record (the installer flow). */
  trustedContentHash?: string;
};

/**
 * The loader's `verifyIntegrity` hook — re-verified on EVERY boot/activation,
 * FAIL-CLOSED:
 *   (a) the persisted `<digest>.tgz` MUST exist (a partial install — a dir
 *       without its tarball, e.g. a crash mid-publish — fails closed);
 *   (b) the tarball's sha512 digest must equal the store-path digest segment
 *       (a tamperer cannot rename the dir without moving it) AND the sidecar;
 *   (c) the tarball must match the TRUSTED SRI when one is supplied (else the
 *       sidecar's — install-time only, documented weaker);
 *   (d) the materialized dir's content hash must match the TRUSTED content hash
 *       when supplied (else the sidecar's); symlinks/special files are rejected.
 * Any missing/failed factor → false (the loader refuses to import). The
 * sidecar alone is self-attested and NOT a root of trust — callers should pass
 * `trustedIntegrity`/`trustedContentHash` from the DB install record.
 */
export async function verifyMaterializedPackageIntegrity(
  record: PackageStoreRecord,
  opts: VerifyIntegrityOptions = {},
): Promise<boolean> {
  try {
    const sidecar = await readStoreSidecar(record.storeDir);
    if (!sidecar) return false;

    const tarballPath = `${record.storeDir}.tgz`;
    if (!(await pathExists(tarballPath))) return false; // (a) fail closed
    const tarballBytes = await readFile(tarballPath);

    // (b) bind the tarball to the store-path digest + the sidecar.
    const tarballDigest = tarballDigestSegment(tarballBytes);
    if (record.declaredDigest && record.declaredDigest !== tarballDigest) return false;
    if (sidecar.tarballDigest !== tarballDigest) return false;

    // (c) tarball SRI against the trusted anchor when provided.
    const expectedIntegrity = opts.trustedIntegrity ?? sidecar.integrity;
    if (!sriMatches(tarballBytes, expectedIntegrity)) return false;

    // (d) extracted-files content hash against the trusted anchor when provided.
    const entries = await collectFileEntries(record.storeDir, [STORE_SIDECAR_FILENAME]);
    const expectedContentHash = opts.trustedContentHash ?? sidecar.contentHash;
    if (contentHashOfEntries(entries) !== expectedContentHash) return false;

    return true;
  } catch {
    return false;
  }
}

/** Read + parse a materialized package's sidecar, or null if absent/invalid. */
export async function readStoreSidecar(storeDir: string): Promise<StoreSidecar | null> {
  try {
    const raw = await readFile(path.join(storeDir, STORE_SIDECAR_FILENAME), "utf8");
    return JSON.parse(raw) as StoreSidecar;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Top-level bundled module names under a `node_modules/` dir (scope-aware). */
async function readPresentNodeModules(nmDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(nmDir);
  } catch {
    return out; // no node_modules → no bundled deps
  }
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = await readdir(path.join(nmDir, entry));
      } catch {
        continue;
      }
      for (const name of scoped) out.add(`${entry}/${name}`);
    } else if (!entry.startsWith(".")) {
      out.add(entry);
    }
  }
  return out;
}

/**
 * Reject symlinks / hardlinked-out / special files anywhere under `dir`. tar
 * already strips `..` + absolute paths, but a bundled SYMLINK would let a
 * `file://` import (which follows links) and the content hash escape the
 * integrity-verified package dir, so we refuse any non-regular-file/non-dir.
 */
async function assertNoUnsafeEntries(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isSymbolicLink()) {
      throw new Error(`[package-store] refusing extracted symlink "${e.name}" (escape vector)`);
    }
    if (e.isDirectory()) {
      await assertNoUnsafeEntries(path.join(dir, e.name));
    } else if (!e.isFile()) {
      throw new Error(`[package-store] refusing non-regular file "${e.name}" in extracted package`);
    }
  }
}

/**
 * Recursively collect `{relPath, bytes}` for every file under `dir`, excluding
 * top-level names in `excludeTopLevel`. THROWS on a symlink/special entry (so a
 * post-install symlink swap can't evade the hash) — callers treat a throw as a
 * failed verification.
 */
async function collectFileEntries(dir: string, excludeTopLevel: readonly string[]): Promise<ContentHashEntry[]> {
  const exclude = new Set(excludeTopLevel);
  const out: ContentHashEntry[] = [];
  async function walk(current: string, relBase: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (!relBase && exclude.has(e.name)) continue;
      const abs = path.join(current, e.name);
      if (e.isSymbolicLink()) {
        throw new Error(`[package-store] refusing symlink "${rel}" (escape vector)`);
      }
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile()) {
        out.push({ relPath: rel, bytes: await readFile(abs) });
      } else {
        throw new Error(`[package-store] refusing non-regular file "${rel}"`);
      }
    }
  }
  await walk(dir, "");
  return out;
}

// ---------------------------------------------------------------------------
// Host-peer value-import gate (model-B runtime-resolution rule) — step 4.5
// ---------------------------------------------------------------------------

/** Source extensions the static import graph follows (the extension's OWN files). */
const TRACEABLE_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

/**
 * Resolve `cinatra.serverEntry` to an absolute source file INSIDE `extractDir`.
 * Supports the two real declaration forms:
 *   - a direct relative file path: `serverEntry: "./register.mjs"`;
 *   - an `exports` map KEY: `serverEntry: "./register"` →
 *     `exports["./register"]` → e.g. `./register.mjs`.
 * The exports-key resolution is the SDK's `resolveExportsSubpath` — the SAME
 * shared resolver the runtime loader applies (cinatra#161: one resolver
 * everywhere, drift impossible). Mirrors the safe-path discipline of the
 * loader's `resolveServerEntryPath`: an absolute path or any `..` segment is
 * rejected (returns null) so the trace can never escape the integrity-verified
 * package dir. Returns null when there is no serverEntry (nothing to scan).
 */
function resolveServerEntryFile(
  extractDir: string,
  pkgJson: Record<string, unknown>,
): string | null {
  const cinatra = (pkgJson.cinatra ?? null) as Record<string, unknown> | null;
  const serverEntry = cinatra && typeof cinatra.serverEntry === "string" ? cinatra.serverEntry : null;
  if (!serverEntry) return null;
  // Shared three-way resolution: a DECLARED exports key with an out-of-contract
  // target is NOT silently treated as a literal path (it yields null here —
  // nothing to scan — and the built-artifact gate refuses it loudly).
  const resolution = resolveDeclaredServerEntry(pkgJson.exports, serverEntry);
  if (resolution.kind !== "resolved") return null;
  return safeJoinInside(extractDir, resolution.rel);
}

/**
 * Step 4.6 — the built-artifacts-only serverEntry gate (cinatra#161, the
 * PRIMARY refusal; the loader's classification is defense in depth for legacy
 * store dirs). A declared `cinatra.serverEntry` must resolve — exports-map key
 * first (shared SDK resolver), else the literal `./`-relative path — to a path
 * that (a) stays inside the package dir, (b) names an existing regular file,
 * and (c) carries a Node-importable extension (`.mjs`/`.cjs`/`.js`).
 * `.ts`/`.tsx`/`.mts`/`.cts`, extensionless resolutions, and missing files are
 * refused with an actionable error BEFORE anything is published to the store.
 * `serverEntry` absent stays a valid no-server-entry package (silent return).
 */
async function assertServerEntryIsBuiltArtifact(
  extractDir: string,
  pkgJson: Record<string, unknown>,
  packageName: string,
): Promise<void> {
  const cinatra = (pkgJson.cinatra ?? null) as Record<string, unknown> | null;
  const serverEntry = cinatra && typeof cinatra.serverEntry === "string" ? cinatra.serverEntry : null;
  if (!serverEntry) return; // no serverEntry → valid (agents/skills/artifacts)

  const builtShapeHint =
    `The runtime store accepts BUILT artifacts only: ship a built ESM entry ` +
    `(top-level "register.mjs" with cinatra.serverEntry "./register.mjs" is the convention; an exports ` +
    `key targeting a built file under dist/ also works). Refusing to materialize.`;

  // Shared three-way resolution (codex AB-r0 finding 1): a DECLARED exports
  // key whose target is outside the pinned resolver language is refused — it
  // must never silently fall back to the literal path.
  const resolution = resolveDeclaredServerEntry(pkgJson.exports, serverEntry);
  if (resolution.kind !== "resolved") {
    throw new Error(
      `[package-store] ${packageName}: cinatra.serverEntry "${serverEntry}" is a declared exports key ` +
        `whose target is outside the supported exports forms (an exact key mapping to a "./"-relative ` +
        `string, or a one-level conditional whose import/default/require value is such a string). ` +
        `${builtShapeHint}`,
    );
  }
  const rel = resolution.rel;
  // SAME segment-level rule the loader's resolveServerEntryPath applies (codex
  // AB-r0 finding 2): any `..` segment or absolute path is refused EVEN IF it
  // would normalize back inside the package — otherwise an entry like
  // "./dist/../register.mjs" materializes here and then fails activation as
  // unsafe (install-time and activation-time must agree).
  const cleanedRel = rel.replace(/^\.\//, "");
  const escapesPackageDir =
    cleanedRel.startsWith("/") || cleanedRel.split("/").some((seg) => seg === "..");
  const abs = escapesPackageDir ? null : safeJoinInside(extractDir, rel);
  if (!abs) {
    throw new Error(
      `[package-store] ${packageName}: cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — ` +
        `escapes the package dir. ${builtShapeHint}`,
    );
  }
  const cls = classifyServerEntryArtifact(rel);
  if (cls === "source") {
    throw new Error(
      `[package-store] ${packageName}: cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — a ` +
        `TypeScript source entry. ${builtShapeHint}`,
    );
  }
  if (cls !== "importable") {
    throw new Error(
      `[package-store] ${packageName}: cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — ` +
        `has no importable extension (.mjs/.cjs/.js). ${builtShapeHint}`,
    );
  }
  let entryStat: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    entryStat = await stat(abs);
  } catch {
    entryStat = null;
  }
  if (!entryStat || !entryStat.isFile()) {
    throw new Error(
      `[package-store] ${packageName}: cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — ` +
        `does not exist in the tarball${entryStat ? " as a regular file" : ""}. ${builtShapeHint}`,
    );
  }
}

/**
 * Resolve a relative specifier `rel` against `fromAbs` (a file), restricted to
 * `rootDir`. Returns the absolute path of the FIRST candidate that exists,
 * trying the literal path then each traceable extension then an `index.*`
 * inside a directory — the standard TS/ESM resolution order for a SOURCE tree.
 * Returns null for an unsafe (escaping) path or when nothing resolves.
 */
async function resolveRelativeImport(rootDir: string, fromAbs: string, rel: string): Promise<string | null> {
  const baseRel = path.relative(rootDir, path.dirname(fromAbs));
  const joined = safeJoinInside(rootDir, path.join(baseRel || ".", rel));
  if (!joined) return null;
  const candidates: string[] = [joined];
  for (const ext of TRACEABLE_SOURCE_EXTENSIONS) candidates.push(joined + ext);
  for (const ext of TRACEABLE_SOURCE_EXTENSIONS) candidates.push(path.join(joined, `index${ext}`));
  for (const c of candidates) {
    try {
      if ((await stat(c)).isFile()) return c;
    } catch {
      // keep trying
    }
  }
  return null;
}

/**
 * Join `rel` onto `rootDir`, refusing any result that escapes `rootDir`
 * (absolute input, `..` traversal). Returns the absolute path, or null when
 * unsafe. Mirrors the loader's `resolveServerEntryPath` safety check.
 */
function safeJoinInside(rootDir: string, rel: string): string | null {
  const cleaned = rel.replace(/^\.\//, "");
  if (cleaned.startsWith("/") || path.isAbsolute(cleaned)) return null;
  const abs = path.resolve(rootDir, cleaned);
  const rootResolved = path.resolve(rootDir);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return abs;
}

/**
 * Trace the static import graph from the package's `serverEntry` over the
 * extension's OWN source files inside `extractDir`, and fail-closed if ANY
 * reachable file carries a host-peer VALUE import.
 *
 * The trace follows only RUNTIME VALUE edges — `import type`/`export type` and
 * all-inline-`type` brace clauses are erased at compile and have NO runtime
 * graph presence, so following them would falsely pull in files reachable only
 * type-only. It resolves two kinds of value edge inside the
 * package: a RELATIVE specifier (`./x`, `../y`), and a SELF-package subpath
 * (`@scope/ext/internal` where the base equals `pkgJson.name`) resolved through
 * the `exports` map — a Node self-reference, not a third-party dep. It never
 * enters `node_modules/` and never follows a TRUE third-party
 * bare specifier — bundled runtime deps are legitimate and out of scope; the
 * rule is solely about HOST-internal peers, which are never bundled.
 *
 * Exported for direct testing of the fail-loud read-error path.
 */
export async function assertNoHostPeerValueImports(
  extractDir: string,
  pkgJson: Record<string, unknown>,
  packageName: string,
): Promise<void> {
  const entryAbs = resolveServerEntryFile(extractDir, pkgJson);
  if (!entryAbs) return; // no serverEntry (or unsafe) → nothing to scan here
  try {
    if (!(await stat(entryAbs)).isFile()) return;
  } catch {
    return; // serverEntry points at a missing file — the loader handles that
  }

  const selfName = typeof pkgJson.name === "string" ? pkgJson.name : null;
  const exportsMap = pkgJson.exports;

  const visited = new Set<string>();
  const queue: string[] = [entryAbs];
  while (queue.length > 0) {
    const fileAbs = queue.shift() as string;
    if (visited.has(fileAbs)) continue;
    visited.add(fileAbs);

    // A file that resolved INTO the graph but cannot be read is a HARD failure:
    // silently skipping it would defer a possibly-hazardous
    // import to a later, opaquer loader failure. (The serverEntry-missing and
    // no-serverEntry cases are handled above and stay silent skips.)
    let source: string;
    try {
      source = await readFile(fileAbs, "utf8");
    } catch (error) {
      const relFile = path.relative(extractDir, fileAbs);
      throw new Error(
        `[package-store] ${packageName}: a file that resolved INTO the serverEntry import graph ` +
          `cannot be read (${relFile}): ${error instanceof Error ? error.message : String(error)}. ` +
          `Failing closed — the host-peer value-import gate cannot certify an unreadable graph file.`,
      );
    }

    // Pass the real on-disk path so the parser derives the correct ScriptKind
    // (a `.tsx`/`.jsx` graph file's JSX-embedded value import is otherwise
    // missed — a fail-open gap).
    const hits = scanHostPeerValueImports(source, HOST_PROVIDED_PACKAGES, fileAbs);
    if (hits.length > 0) {
      const relFile = path.relative(extractDir, fileAbs);
      const hit = hits[0];
      const bindings = hit.bindings.length > 0 ? ` (${hit.bindings.join(", ")})` : "";
      throw new Error(
        `[package-store] ${packageName}: serverEntry graph imports host-internal SDK peer ` +
          `${hit.peer} at VALUE position${bindings} in ${relFile} (line ${hit.line}). ` +
          `Host-internal SDK peers are NEVER bundled — the prod file:// loader cannot resolve a bare ` +
          `host-peer specifier. Use \`import type\` (erased at compile) or take the value via the ` +
          `injected \`ctx\`.`,
      );
    }

    // Enqueue every VALUE edge into the extension's own files: relative
    // specifiers + self-package subpaths (`@scope/ext/internal`). Type-only
    // edges are NOT followed (no runtime graph presence). Third-party bare
    // specifiers + node_modules are out of scope (never followed). Thread the
    // real path so the parser uses the correct ScriptKind for `.tsx`/`.jsx`.
    for (const imp of parseModuleImports(source, fileAbs)) {
      if (!imp.isValueEdge) continue;
      const spec = imp.specifier;
      let next: string | null = null;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        next = await resolveRelativeImport(extractDir, fileAbs, spec);
      } else if (selfName) {
        next = await resolveSelfPackageImport(extractDir, exportsMap, selfName, spec);
      }
      if (next && !visited.has(next)) queue.push(next);
    }
  }
}

/**
 * Step 4.8 (cinatra#181) — residual-coverage check for CLOSURE packages: walk
 * the SAME value-edge graph as the host-peer gate (relative + self-package
 * specifiers; type-only edges erased; node_modules never entered) and collect
 * every BARE specifier. Each bare specifier's base package must be a node
 * BUILTIN, a BUNDLED top-level node_modules package, or a plan ROOT
 * dependency — else the import would only fail at activation
 * (ERR_MODULE_NOT_FOUND under the prod file:// loader), so refuse loudly at
 * materialize time. Host peers are NOT exempted here: a host-peer VALUE
 * import was already refused by step 4.5, and a host-peer TYPE import never
 * reaches this walk (type edges are erased).
 *
 * Mirrors the closure-mode builder's relaxed residual-import check (builtins
 * ∪ declared deps) — the install-time set is builtins ∪ bundled ∪ plan roots,
 * the exact set Node can actually resolve in the materialized store dir.
 */
async function assertServerEntryBareSpecifierCoverage(
  extractDir: string,
  pkgJson: Record<string, unknown>,
  packageName: string,
  allowed: { present: ReadonlySet<string>; planRoots: ReadonlySet<string> },
): Promise<void> {
  const entryAbs = resolveServerEntryFile(extractDir, pkgJson);
  if (!entryAbs) return; // no serverEntry → nothing to cover (plan-only package)
  try {
    if (!(await stat(entryAbs)).isFile()) return;
  } catch {
    return; // missing serverEntry file is the built-artifact gate's refusal (4.6, already ran)
  }

  const selfName = typeof pkgJson.name === "string" ? pkgJson.name : null;
  const exportsMap = pkgJson.exports;

  const visited = new Set<string>();
  const queue: string[] = [entryAbs];
  while (queue.length > 0) {
    const fileAbs = queue.shift() as string;
    if (visited.has(fileAbs)) continue;
    visited.add(fileAbs);

    let source: string;
    try {
      source = await readFile(fileAbs, "utf8");
    } catch (error) {
      const relFile = path.relative(extractDir, fileAbs);
      throw new Error(
        `[package-store] ${packageName}: a file in the serverEntry import graph cannot be read ` +
          `(${relFile}): ${error instanceof Error ? error.message : String(error)}. Failing closed — ` +
          `the residual-coverage check cannot certify an unreadable graph file.`,
      );
    }

    for (const imp of parseModuleImports(source, fileAbs)) {
      if (!imp.isValueEdge) continue;
      const spec = imp.specifier;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const next = await resolveRelativeImport(extractDir, fileAbs, spec);
        if (next && !visited.has(next)) queue.push(next);
        continue;
      }
      if (selfName) {
        const next = await resolveSelfPackageImport(extractDir, exportsMap, selfName, spec);
        if (next) {
          if (!visited.has(next)) queue.push(next);
          continue;
        }
      }
      const base = basePackageOfSpecifier(spec);
      if (base === null) continue; // absolute/odd specifier — not a bare package import
      if (base === selfName) {
        // FAIL CLOSED: a SELF-package bare import
        // that `resolveSelfPackageImport` could not map to a real in-package
        // file would only surface at activation (ERR_PACKAGE_PATH_NOT_EXPORTED
        // / ERR_MODULE_NOT_FOUND under the prod file:// loader) — refuse at
        // materialize like every other uncovered bare specifier.
        const relFile = path.relative(extractDir, fileAbs);
        throw new Error(
          `[package-store] ${packageName}: serverEntry graph imports the SELF subpath "${spec}" ` +
            `(${relFile}, line ${imp.line}) which does not resolve through the package's exports map ` +
            `to an existing in-package file — it would fail at activation; refusing at materialize.`,
        );
      }
      if (isBuiltin(spec) || isBuiltin(base)) continue;
      if (allowed.present.has(base) || allowed.planRoots.has(base)) continue;
      const relFile = path.relative(extractDir, fileAbs);
      throw new Error(
        `[package-store] ${packageName}: serverEntry graph imports "${spec}" (${relFile}, line ${imp.line}) ` +
          `— not a node builtin, not bundled in node_modules, and not a root of the signed ` +
          `materialization plan. The prod file:// loader could never resolve it (it would fail at ` +
          `activation as ERR_MODULE_NOT_FOUND); refusing at materialize. Bundle the dependency or add ` +
          `it to the package's declared dependencies so the publish-time plan covers it.`,
      );
    }
  }
}

/**
 * Resolve a bare specifier that is a SELF-reference to the extension's own
 * package name (`@scope/ext` or `@scope/ext/subpath`) to an absolute file inside
 * `extractDir`, via the `exports` map (Node self-resolves the package's own name
 * without a node_modules entry). Returns null when the base package is NOT the
 * self name, the subpath is not declared in `exports`, the target is unsafe
 * (`..`/absolute), or it does not resolve to a regular file. A TRUE third-party
 * specifier (`other-pkg/x`) returns null here and is correctly skipped.
 */
async function resolveSelfPackageImport(
  extractDir: string,
  exportsMap: unknown,
  selfName: string,
  spec: string,
): Promise<string | null> {
  // base package of `spec` (subpath-collapsed) must equal the self name.
  const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (base !== selfName) return null;
  const subpath = spec === selfName ? "." : `.${spec.slice(selfName.length)}`;
  const rel = resolveExportsSubpath(exportsMap, subpath);
  if (!rel) return null;
  const abs = safeJoinInside(extractDir, rel);
  if (!abs) return null;
  // resolve to a concrete source file (literal, then by extension / index).
  const candidates = [abs, ...TRACEABLE_SOURCE_EXTENSIONS.map((e) => abs + e)];
  for (const c of candidates) {
    try {
      if ((await stat(c)).isFile()) return c;
    } catch {
      // keep trying
    }
  }
  return null;
}

/**
 * Recursively compare two directory trees by their relative file-path sets (a
 * stronger post-copy verify than a top-level child count). Throws on any mismatch.
 */
async function assertDirTreesMatch(a: string, b: string): Promise<void> {
  const collect = async (root: string): Promise<Set<string>> => {
    const out = new Set<string>();
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(path.join(dir, ent.name), childRel);
        } else {
          out.add(childRel);
        }
      }
    };
    await walk(root, "");
    return out;
  };
  const [aset, bset] = await Promise.all([collect(a), collect(b)]);
  if (aset.size !== bset.size) {
    throw new Error(`EXDEV copy verify failed: source has ${aset.size} files, target has ${bset.size}`);
  }
  for (const rel of aset) {
    if (!bset.has(rel)) throw new Error(`EXDEV copy verify failed: target is missing ${rel}`);
  }
}

/**
 * Atomically replace `targetDir` with `sourceDir` via rename. If a prior dir
 * exists, it is renamed aside first and restored on failure (mirrors the agent
 * materializer's temp-sibling-rename + rollback chain).
 *
 * cinatra#158 EXDEV FALLBACK (defense-in-depth — the primary fix stages the source
 * on the target's filesystem). If `rename(sourceDir, targetDir)` throws EXDEV (a
 * cross-filesystem move on a container+volume topology), fall back to: recursive
 * COPY into a SAME-PARENT staging dir (`${targetDir}.staging-<rand>`, guaranteed
 * intra-fs with `targetDir`), recursively VERIFY the copied tree, then an atomic
 * intra-fs `rename(staging, targetDir)`, then remove the original source. We NEVER
 * copy straight into `targetDir` (a crash mid-copy would expose a partial target);
 * the verified staging dir is swapped in atomically. The prior-backup rename
 * (`targetDir` → `${targetDir}.old`) is always same-parent → never EXDEV.
 * Mirrors `packages/skills/src/relocate-worker.ts:249`.
 */
async function atomicReplaceDir(sourceDir: string, targetDir: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  let priorBackup: string | null = null;
  if (await pathExists(targetDir)) {
    priorBackup = `${targetDir}.old-${suffix}`;
    await rename(targetDir, priorBackup);
  }
  try {
    try {
      await rename(sourceDir, targetDir);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code !== "EXDEV") throw renameErr;
      // Cross-filesystem: copy → verify → atomic intra-fs swap → drop source.
      const staging = `${targetDir}.staging-${suffix}`;
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      try {
        await cp(sourceDir, staging, { recursive: true, preserveTimestamps: true });
        await assertDirTreesMatch(sourceDir, staging);
        await rename(staging, targetDir); // same parent → intra-fs, atomic.
      } catch (copyErr) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw copyErr;
      }
      await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (priorBackup) {
      await rename(priorBackup, targetDir).catch((restoreErr) => {
        console.error(
          `[package-store] CRITICAL: failed to restore ${priorBackup} -> ${targetDir} after rename failure:`,
          restoreErr,
        );
      });
    }
    throw error;
  }
  if (priorBackup) {
    await rm(priorBackup, { recursive: true, force: true }).catch(() => undefined);
  }
}
