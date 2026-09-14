import "server-only";

// LOADING THE CALLING PACK'S OWN DECLARED MODULE (cinatra#3249, epic #3023).
//
// The generic dispatch tool runs a module the CALLING package declares in its
// own manifest. This module is the road to that file, and it is the SAME road a
// bundled `serverEntry` is reached by today, generalised from one well-known
// entry to a caller-declared one:
//
//   - the package root is the MATERIALIZED package at the PINNED version. The
//     version comes from the run's binding (never a request field), and the
//     store dir is only accepted when the package.json actually lying there
//     carries that exact name and version — a floating "whatever is on disk for
//     this package" read would let a reinstall move a running flow's code;
//   - the declared path is package-relative and carries no traversal (the
//     declaration gate in `@cinatra-ai/sdk-extensions/manifest` states the rule;
//     it is applied AGAIN here, so the two gates cannot disagree);
//   - the resolved file is REALPATH-BOUND to the package dir, the same defence
//     `runtime-package-loader`'s serverEntry import is held to: a link inside
//     the tree that resolves outside it is refused before anything is imported.
//
// Nothing here names a package, a table, a type or a state.

import path from "node:path";
import { realpath } from "node:fs/promises";

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
 * The materialized package at the pinned version, read off the store itself.
 *
 * THE PIN IS CHECKED AGAINST THE PACKAGE ON DISK, not against a record field:
 * discovery builds its records from the manifests it finds, and the version an
 * admission is bound to has to be the version whose code is about to run.
 */
const defaultPackageRootResolver: PinnedPackageRootResolver = async ({
  packageName,
  packageVersion,
}) => {
  const [{ discoverStoreRecordsV2, realStoreFs }, { resolveExtensionDataRoot }] = await Promise.all([
    import("@/lib/extension-store-io"),
    import("@/lib/extension-data-root"),
  ]);
  const records = await discoverStoreRecordsV2(resolveExtensionDataRoot(), realStoreFs);
  for (const record of records) {
    if (record.packageName !== packageName) continue;
    let parsed: { name?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(await realStoreFs.readFile(path.join(record.storeDir, "package.json"))) as {
        name?: unknown;
        version?: unknown;
      };
    } catch {
      continue;
    }
    if (parsed.name === packageName && parsed.version === packageVersion) return record.storeDir;
  }
  return null;
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
    toolName: string;
    modulePath: string;
  },
  deps: ExtensionToolModuleLoaderDeps = {},
): Promise<unknown> {
  const resolveRoot = deps.resolvePackageRoot ?? defaultPackageRootResolver;
  const root = await resolveRoot({
    packageName: input.packageName,
    packageVersion: input.packageVersion,
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
