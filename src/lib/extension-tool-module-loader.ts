import "server-only";

// LOADING THE CALLING PACK'S OWN DECLARED MODULE (cinatra#3249, epic #3023).
//
// The generic dispatch tool runs a module the CALLING package declares in its
// own manifest. This module is the road to that file, and it is the SAME road a
// bundled `serverEntry` is reached by today, generalised from one well-known
// entry to a caller-declared one:
//
//   - the package root is the MATERIALIZED package at the PINNED version, and
//     it is the one the TRUSTED install anchor names: the canonical row (read
//     outside the writable store) binds the kind and the digest, exactly as the
//     boot loader binds them, and the package.json actually lying there must
//     still carry that exact name and version. A floating "whatever is on disk
//     for this package" read would let a reinstall — or a retained digest
//     activation refuses — move a running flow's code;
//   - the declared path is package-relative and carries no traversal (the
//     declaration gate in `@cinatra-ai/sdk-extensions/manifest` states the rule;
//     it is applied AGAIN here, so the two gates cannot disagree);
//   - the resolved file is REALPATH-BOUND to the package dir, the same defence
//     `runtime-package-loader`'s serverEntry import is held to: a link inside
//     the tree that resolves outside it is refused before anything is imported.
//
// A SECOND ROAD, and only where the first cannot exist (cinatra#3602): where
// the writable store holds NO record for the package at all, a development
// installation reads the package's own SOURCE DIRECTORY off the generated
// static manifest, bound on both sides to the pinned version. Wherever a store
// record exists the store stays the only road, and both path gates above apply
// to the source directory exactly as they do to a store directory.
//
// Nothing here names a package, a table, a type or a state.

import path from "node:path";
import { readFile, realpath } from "node:fs/promises";

import { declaredToolModulePathIssue } from "@cinatra-ai/sdk-extensions/manifest";

import { isContainedRealpath } from "@/lib/fs-safety";

/** A stated refusal on the load road: the calling node fails visibly on it. */
export class ExtensionToolModuleRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionToolModuleRefusal";
  }
}

/** Resolve the package root a (name, version) is materialized at, or null. */
export type PinnedPackageRootResolver = (input: {
  packageName: string;
  packageVersion: string;
  /** The run's own organisation — the scope the trusted install row is read in. */
  orgId: string | null;
}) => Promise<string | null>;

export type ExtensionToolModuleLoaderDeps = {
  resolvePackageRoot?: PinnedPackageRootResolver;
  /** Dynamically import a resolved absolute path → module namespace. */
  importModule?: (absPath: string) => Promise<unknown>;
};

/**
 * The declared path resolved against the package's own root, or `null` when it
 * is refused. String-level only — the realpath gate below is the second half.
 */
export function resolveDeclaredToolModulePath(
  packageRoot: string,
  modulePath: string,
): string | null {
  if (declaredToolModulePathIssue(modulePath) !== null) return null;
  const root = path.resolve(packageRoot);
  const abs = path.resolve(root, modulePath.trim().slice(2));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * The package's own SOURCE DIRECTORY at the pinned version, as the GENERATED
 * static manifest records it — the second road, and it exists because on a
 * development installation nothing ever materializes a package that lives in
 * the source tree, so the store road below can only ever refuse it.
 *
 * IT IS LIMITED TO A DEVELOPMENT INSTALLATION, and the limit is the narrow
 * rule the evidence supports: the record's own field documentation says that
 * directory is repo-relative in development and a package-store path in
 * production, so the field does not mean the same thing in both modes; the
 * manifest's mere presence is no evidence of a development installation, since
 * an image build regenerates that file too; and the directory is not carried
 * into a production runtime image anyway, so the limit costs nothing there and
 * keeps a directory a deployment might later mount at that path from becoming
 * an import road.
 *
 * THE PIN BINDS ON BOTH SIDES, exactly as it does on the store road: the
 * generated record's own version and the package.json actually lying in that
 * directory must both carry the version the run is bound to, and a record
 * carrying no version is a refusal rather than a pass.
 */
const sourceDirPackageRoot = async (
  packageName: string,
  packageVersion: string,
): Promise<string | null> => {
  const { isAppDevelopmentMode } = await import("@/lib/runtime-mode");
  if (!isAppDevelopmentMode()) return null;
  const { STATIC_EXTENSION_MANIFEST } = await import("@/lib/generated/extensions.server");
  const manifest: Record<string, { version?: unknown; sourceDir?: unknown } | undefined> =
    STATIC_EXTENSION_MANIFEST;
  const record = manifest[packageName];
  if (!record) return null;
  // EXACT equality and no normalisation: the record's own string IS the
  // version it pins, so a padded one is not the pinned version either.
  const generatedVersion = typeof record.version === "string" ? record.version : "";
  if (generatedVersion.trim() === "" || generatedVersion !== packageVersion) return null;
  const sourceDir = typeof record.sourceDir === "string" ? record.sourceDir.trim() : "";
  if (sourceDir === "") return null;
  // The repo-root-relative convention the host already resolves a package's own
  // files by: the directory is taken against the process's working directory.
  const root = path.resolve(process.cwd(), sourceDir);
  let parsed: { name?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
  } catch {
    return null;
  }
  if (parsed.name !== packageName || parsed.version !== packageVersion) return null;
  return root;
};

/**
 * The materialized package at the pinned version, read off the store itself.
 *
 * THE PIN IS CHECKED AGAINST THE PACKAGE ON DISK, not against a record field:
 * discovery builds its records from the manifests it finds, and the version an
 * admission is bound to has to be the version whose code is about to run.
 */
const defaultPackageRootResolver: PinnedPackageRootResolver = async ({
  packageName,
  packageVersion,
  orgId,
}) => {
  const [
    { discoverStoreRecordsV2, realStoreFs },
    { resolveExtensionDataRoot },
    { makeDefaultInstallAnchorsResolver },
  ] = await Promise.all([
    import("@/lib/extension-store-io"),
    import("@/lib/extension-data-root"),
    import("@/lib/extension-install-anchor"),
  ]);
  // THE TRUSTED ANCHOR DECIDES WHICH DIRECTORY RUNS. The canonical install row
  // — read from OUTSIDE the writable store — owns the live digest for this
  // organisation, and the boot loader imports nothing that is not bound to it.
  // Reading only the package.json lying in the store would accept ANY retained
  // digest dir that self-reports the same name and version, including one
  // activation refuses, so this road holds a record to the SAME two bindings
  // the boot loader does before it hands a path to the import seam.
  const resolveAnchors = await makeDefaultInstallAnchorsResolver(orgId);
  const anchors = await resolveAnchors(packageName);
  const anchor = anchors.find((a) => (a.version ?? null) === packageVersion);
  const records = (await discoverStoreRecordsV2(resolveExtensionDataRoot(), realStoreFs)).filter(
    (record) => record.packageName === packageName,
  );
  // A STORE RECORD, WHEREVER THERE IS ONE, REMAINS THE ONLY ROAD: with one or
  // more records for this package the anchor and digest bindings below decide
  // alone and every refusal of theirs stands, so no running flow can ever be
  // moved off a materialized install onto a source tree. ONLY a store holding
  // no record for it at all — what a development installation always reads —
  // reaches the second road.
  if (records.length === 0) return sourceDirPackageRoot(packageName, packageVersion);
  if (!anchor) return null;
  // Anchor KIND binding: the canonical row's kind against the store path's kind.
  const kindBound = records.filter((record) =>
    anchor.kind == null ? true : anchor.kind === record.kind,
  );
  // Anchor DIGEST binding: a bound anchor selects exactly its own digest dir;
  // an unbound (legacy) anchor proceeds only while the disk is unambiguous.
  const digestBound = anchor.digest
    ? kindBound.filter((record) => record.declaredDigest === anchor.digest)
    : kindBound;
  if (digestBound.length !== 1) return null;
  const record = digestBound[0];
  let parsed: { name?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(await realStoreFs.readFile(path.join(record.storeDir, "package.json"))) as {
      name?: unknown;
      version?: unknown;
    };
  } catch {
    return null;
  }
  if (parsed.name !== packageName || parsed.version !== packageVersion) return null;
  return record.storeDir;
};

/**
 * Load one declared module from the calling package's own tree at the pinned
 * lock. Every refusal is stated; nothing is imported before both path gates
 * have passed.
 */
export async function loadDeclaredToolModule(
  input: {
    packageName: string;
    packageVersion: string;
    /** The run's own organisation — the scope the trusted install row is read in. */
    orgId: string | null;
    toolName: string;
    modulePath: string;
  },
  deps: ExtensionToolModuleLoaderDeps = {},
): Promise<unknown> {
  const resolveRoot = deps.resolvePackageRoot ?? defaultPackageRootResolver;
  const root = await resolveRoot({
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    orgId: input.orgId,
  });
  if (root === null) {
    throw new ExtensionToolModuleRefusal(
      `extension_tool: the calling extension is not materialized at the pinned version, so the ` +
        `module it declares for \`${input.toolName}\` cannot be loaded`,
    );
  }
  const abs = resolveDeclaredToolModulePath(root, input.modulePath);
  if (abs === null) {
    throw new ExtensionToolModuleRefusal(
      `extension_tool: the module declared for \`${input.toolName}\` leaves the calling ` +
        `extension's own tree — refusing to load it`,
    );
  }
  let realAbs: string;
  let realRoot: string;
  try {
    [realAbs, realRoot] = await Promise.all([realpath(abs), realpath(root)]);
  } catch {
    throw new ExtensionToolModuleRefusal(
      `extension_tool: the module declared for \`${input.toolName}\` does not exist in the ` +
        `materialized package — a declared tool names a BUILT artifact inside the package`,
    );
  }
  if (!isContainedRealpath(realAbs, realRoot)) {
    throw new ExtensionToolModuleRefusal(
      `extension_tool: the module declared for \`${input.toolName}\` resolves outside the calling ` +
        `extension's own tree — refusing to load it`,
    );
  }
  // THE IMPORT ITSELF GOES THROUGH THE ONE SANCTIONED RUNTIME-STORE SEAM
  // (`runtime-package-loader`), the same seam a bundled serverEntry is reached
  // by: the variable-URL `import()` ratchet allows that file and no other, and
  // this road does not grow its allowlist — it reuses the seam, so the
  // realpath containment is enforced in exactly one place. The seam module is
  // reached by a LITERAL specifier and only once both path gates above have
  // passed.
  const importModule =
    deps.importModule ??
    (async (p: string) => {
      const { importFileFromPackageDirRealpathBound } = await import("@/lib/runtime-package-loader");
      return importFileFromPackageDirRealpathBound(p, realRoot);
    });
  return importModule(realAbs);
}
