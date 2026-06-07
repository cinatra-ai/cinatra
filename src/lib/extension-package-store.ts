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

import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as tar from "tar";
import {
  DEFAULT_PACKAGE_STORE_PATH,
  type PackageStoreRecord,
} from "@cinatra-ai/sdk-extensions";
import {
  HOST_PROVIDED_PACKAGES,
  STORE_SIDECAR_FILENAME,
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
    // Present but invalid → remove + re-materialize.
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(targetTarball, { force: true }).catch(() => undefined);
  }

  // 3. extract into a temp dir (strip the npm `package/` prefix). No scripts.
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "cinatra-ext-materialize-"));
  const extractDir = path.join(tmpRoot, "pkg");
  await mkdir(extractDir, { recursive: true });
  try {
    const tgzPath = path.join(tmpRoot, "package.tgz");
    await writeFile(tgzPath, bytes);
    await tar.x({ file: tgzPath, cwd: extractDir, strip: 1 });

    // 3b. Reject symlinks / hardlinks / special files. tar strips `..` and
    // absolute paths, but a bundled symlink (e.g. `register.mjs -> ../../etc`)
    // would let `file://` import + the content hash escape the package dir. We
    // refuse any non-regular-file / non-dir entry.
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
    const depVerdict = validateBundledDependencies(pkgJson, present);
    if (!depVerdict.ok) {
      if (depVerdict.hostProvidedInDeps.length > 0) {
        throw new Error(
          `[package-store] ${input.packageName}: host-provided SDK package(s) in "dependencies" ` +
            `(${depVerdict.hostProvidedInDeps.join(", ")}). These are host-internal peers — declare them in ` +
            `"peerDependencies" and never bundle a copy (a duplicate SDK instance breaks ABI identity).`,
        );
      }
      throw new Error(
        `[package-store] ${input.packageName}: runtime dependencies are not bundled in the tarball ` +
          `(${depVerdict.missing.join(", ")}). Extensions MUST bundle their runtime deps — the installer ` +
          `never runs npm/pnpm install (D4/the security-hardening rule).`,
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
 *     `exports["./register"]` → e.g. `./src/register.ts`.
 * Mirrors the safe-path discipline of the loader's `resolveServerEntryPath`:
 * an absolute path or any `..` segment is rejected (returns null) so the trace
 * can never escape the integrity-verified package dir. Returns null when there
 * is no serverEntry (nothing to scan).
 */
function resolveServerEntryFile(
  extractDir: string,
  pkgJson: Record<string, unknown>,
): string | null {
  const cinatra = (pkgJson.cinatra ?? null) as Record<string, unknown> | null;
  const serverEntry = cinatra && typeof cinatra.serverEntry === "string" ? cinatra.serverEntry : null;
  if (!serverEntry) return null;
  // Prefer the `exports` map when the serverEntry is a declared key.
  const rel = resolveExportsSubpath(pkgJson.exports, serverEntry) ?? serverEntry;
  return safeJoinInside(extractDir, rel);
}

/**
 * Resolve an `exports` map KEY (`"./register"`, `"."`) to its relative target
 * file, picking the `import`/`default`/`require` condition for a conditional
 * entry. Returns null when `exportsMap` is not a plain object or the key is
 * absent. Shared by `resolveServerEntryFile` and the self-package subpath
 * resolution in the import-graph trace.
 */
function resolveExportsSubpath(exportsMap: unknown, key: string): string | null {
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) return null;
  const target = (exportsMap as Record<string, unknown>)[key];
  if (typeof target === "string") return target;
  if (target && typeof target === "object") {
    const cond = target as Record<string, unknown>;
    const picked = cond.import ?? cond.default ?? cond.require;
    if (typeof picked === "string") return picked;
  }
  return null;
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
 * Atomically replace `targetDir` with `sourceDir` via rename. If a prior dir
 * exists, it is renamed aside first and restored on failure (mirrors the agent
 * materializer's temp-sibling-rename + rollback chain).
 */
async function atomicReplaceDir(sourceDir: string, targetDir: string): Promise<void> {
  const suffix = randomBytes(4).toString("hex");
  let priorBackup: string | null = null;
  if (await pathExists(targetDir)) {
    priorBackup = `${targetDir}.old-${suffix}`;
    await rename(targetDir, priorBackup);
  }
  try {
    await rename(sourceDir, targetDir);
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
