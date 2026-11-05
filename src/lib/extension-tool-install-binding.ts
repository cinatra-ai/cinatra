import "server-only";

// THE EXACT INSTALLATIONS A STEP'S TOOL CODE MAY COME FROM (cinatra#4154).
//
// A later change lets a step of an embedded child flow reach a tool of the
// child's own package. That code must then come from the EXACT installation the
// parent's dependency edge resolved to, at the root that installation's own
// anchor names, never from "a package with this name and version". This module
// states that binding over injected reads; nothing calls it yet. A row counts
// in the run's organisation, or with an explicit null organisation only where
// the anchor read in the run's organisation carries that exact install id. Each
// refusal is a fixed code: no path, install id, digest or version. A read that
// throws, package.json fields included, is `origin-unreadable`, logged without its text.

import path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  InstalledExtension,
  ResolvedDependencyEdge,
} from "@cinatra-ai/extensions/canonical-types";
import { satisfiesVersionRange } from "@cinatra-ai/registries/src/version-compare";

import {
  readInstallAnchorForOrg,
  resolvePinnedPackageRoot,
  type InstallAnchorReader,
  type PinnedPackageRootResolver,
} from "@/lib/extension-tool-module-loader";
import { logFailure } from "@/lib/failure-log";

/** Every code this binding refuses with; a later 403 gives each a fixed sentence. */
export const INSTALL_BINDING_CODES = [
  "parent-install-missing", "parent-install-not-live", "parent-install-mismatch",
  "parent-not-materialized", "parent-manifest-mismatch", "parent-manifest-invalid",
  "edge-list-invalid", "edge-missing", "edge-duplicate", "edge-wrong-kind", "edge-unresolved",
  "edge-dangling", "edge-not-live", "edge-target-mismatch", "edge-target-unversioned",
  "edge-constraint-unmet", "edge-target-scope", "child-not-materialized",
  "child-manifest-mismatch", "child-manifest-invalid", "origin-unreadable",
] as const;
export type InstallBindingCode = (typeof INSTALL_BINDING_CODES)[number];

export type InstallBindingOutcome<T> = { ok: true; value: T } | { ok: false; code: InstallBindingCode };

/** One validated installation and the materialized root its exact anchor names. */
export type BoundInstall = {
  row: InstalledExtension;
  root: string;
  /** The anchor digest the root is bound to; null for a digest-unbound legacy anchor. */
  digest: string | null;
  /** The `cinatra` block of the package.json lying at `root`. */
  cinatra: Record<string, unknown>;
};

/** The child's validated installation and the parent edge that resolved to it. */
export type BoundChildInstall = BoundInstall & { edge: ResolvedDependencyEdge };

export type InstallBindingDeps = {
  readInstalledExtensionById?: (id: string) => Promise<InstalledExtension | null>;
  readInstallAnchor?: InstallAnchorReader;
  resolvePackageRoot?: PinnedPackageRootResolver;
  /** The parsed package.json at a root; a throw is `origin-unreadable`. */
  readPackageJson?: (root: string) => Promise<unknown>;
};

type Readers = Required<InstallBindingDeps>;

const LIVE_STATUSES: ReadonlySet<string> = new Set(["active", "locked"]);

const refuse = (code: InstallBindingCode) => ({ ok: false as const, code });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function readersOf(deps: InstallBindingDeps): Readers {
  return {
    readInstalledExtensionById:
      deps.readInstalledExtensionById ??
      (async (id: string) =>
        (await import("@cinatra-ai/extensions/canonical-store")).readInstalledExtensionById(id)),
    readInstallAnchor: deps.readInstallAnchor ?? readInstallAnchorForOrg,
    resolvePackageRoot: deps.resolvePackageRoot ?? resolvePinnedPackageRoot,
    readPackageJson:
      deps.readPackageJson ??
      (async (root: string) => JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))),
  };
}

/** One injected read; a throw becomes `{ ok: false }`, logged without its text. */
async function guarded<T>(
  read: string,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    logFailure("[extension_tool] an install binding read failed", { read }, e);
    return { ok: false };
  }
}

/** Per side: the organisation, not-materialized, manifest-mismatch and manifest-invalid codes. */
type SideCodes = readonly [InstallBindingCode, InstallBindingCode, InstallBindingCode, InstallBindingCode];
const SIDE_CODES = {
  parent: ["parent-install-mismatch", "parent-not-materialized", "parent-manifest-mismatch",
    "parent-manifest-invalid"],
  child: ["edge-target-scope", "child-not-materialized", "child-manifest-mismatch", "child-manifest-invalid"],
} as const satisfies Record<string, SideCodes>;

/**
 * The organisation rule, the exact anchor, the root it names and the package.json
 * lying there, for a row already checked for status, package, kind and version.
 */
async function materialize(
  side: keyof typeof SIDE_CODES,
  row: InstalledExtension,
  version: string,
  orgId: string,
  r: Readers,
): Promise<InstallBindingOutcome<BoundInstall>> {
  const [scope, notMaterialized, manifestMismatch, manifestInvalid] = SIDE_CODES[side];
  // Only an explicit null is platform-wide; a missing field is refused.
  const rowOrg: unknown = row.organizationId;
  if (rowOrg !== null && rowOrg !== orgId) return refuse(scope);
  const anchor = await guarded("install-anchor", () =>
    r.readInstallAnchor({ packageName: row.packageName, orgId, installId: row.id }),
  );
  if (!anchor.ok) return refuse("origin-unreadable");
  if (anchor.value === null || anchor.value.version !== version) return refuse(notMaterialized);
  const digest = anchor.value.digest;
  const root = await guarded("package-root", () =>
    r.resolvePackageRoot({
      packageName: row.packageName,
      packageVersion: version,
      orgId,
      installId: row.id,
      installDigest: digest,
    }),
  );
  if (!root.ok) return refuse("origin-unreadable");
  const rootDir = root.value;
  if (rootDir === null) return refuse(notMaterialized);
  // The read and every field read of what it returns: a throw is `origin-unreadable`.
  const checked = await guarded("package-json", async (): Promise<InstallBindingOutcome<BoundInstall>> => {
    const manifest = await r.readPackageJson(rootDir);
    if (!isPlainObject(manifest)) return refuse(manifestInvalid);
    if (manifest.name !== row.packageName || manifest.version !== version) return refuse(manifestMismatch);
    const cinatra = manifest.cinatra;
    if (!isPlainObject(cinatra)) return refuse(manifestInvalid);
    return { ok: true, value: { row, root: rootDir, digest, cinatra } };
  });
  return checked.ok ? checked.value : refuse("origin-unreadable");
}

/**
 * Validate the install row the run executes as (the parent) and bind it to the
 * root its exact anchor names. The caller supplies the install id and the
 * package and version the run's template binds.
 */
export async function bindParentInstall(
  input: { installId: string; packageName: string; packageVersion: string; orgId: string },
  deps: InstallBindingDeps = {},
): Promise<InstallBindingOutcome<BoundInstall>> {
  const r = readersOf(deps);
  const read = await guarded("install-row", () => r.readInstalledExtensionById(input.installId));
  if (!read.ok) return refuse("origin-unreadable");
  const row = read.value;
  if (!row) return refuse("parent-install-missing");
  if (!LIVE_STATUSES.has(row.status)) return refuse("parent-install-not-live");
  if (
    !nonEmpty(input.packageVersion) ||
    row.id !== input.installId ||
    row.kind !== "agent" ||
    row.packageName !== input.packageName ||
    row.version !== input.packageVersion
  ) {
    return refuse("parent-install-mismatch");
  }
  return materialize("parent", row, input.packageVersion, input.orgId, r);
}

/** The parent's one agent edge for the child's package and the install id it resolved to. */
export function selectChildEdge(
  parent: InstalledExtension,
  childPackageName: string,
): InstallBindingOutcome<{ edge: ResolvedDependencyEdge; resolvedInstallId: string }> {
  const edges: unknown = parent.dependencyEdges;
  if (!Array.isArray(edges) || !edges.every(isPlainObject)) return refuse("edge-list-invalid");
  const matching = (edges as ResolvedDependencyEdge[]).filter((e) => e.packageName === childPackageName);
  if (matching.length === 0) return refuse("edge-missing");
  if (matching.length > 1) return refuse("edge-duplicate");
  const edge = matching[0];
  // An edge with no kind is not an agent edge.
  if (edge.kind !== "agent") return refuse("edge-wrong-kind");
  const resolvedInstallId: unknown = edge.resolvedInstallId;
  if (!nonEmpty(resolvedInstallId)) return refuse("edge-unresolved");
  return { ok: true, value: { edge, resolvedInstallId } };
}

/** Whether a version satisfies an edge's constraint; `git-ref` and anything malformed do not. */
function satisfiesConstraint(version: string, constraint: unknown): boolean {
  if (!isPlainObject(constraint)) return false;
  if (constraint.kind === "exact") return nonEmpty(constraint.version) && constraint.version === version;
  if (constraint.kind !== "semver-range" || !nonEmpty(constraint.range)) return false;
  try {
    return satisfiesVersionRange(version, constraint.range);
  } catch {
    return false;
  }
}

/**
 * Validate the child installation the bound parent's edge resolved to — the
 * install the edge names, even where it is not the package's default — and bind
 * it to the root its exact anchor names.
 */
export async function bindChildInstall(
  input: { parent: BoundInstall; childPackageName: string; orgId: string },
  deps: InstallBindingDeps = {},
): Promise<InstallBindingOutcome<BoundChildInstall>> {
  const r = readersOf(deps);
  const selected = selectChildEdge(input.parent.row, input.childPackageName);
  if (!selected.ok) return selected;
  const { edge, resolvedInstallId } = selected.value;
  const read = await guarded("install-row", () => r.readInstalledExtensionById(resolvedInstallId));
  if (!read.ok) return refuse("origin-unreadable");
  const row = read.value;
  if (!row) return refuse("edge-dangling");
  if (!LIVE_STATUSES.has(row.status)) return refuse("edge-not-live");
  if (row.id !== resolvedInstallId || row.packageName !== input.childPackageName || row.kind !== "agent") {
    return refuse("edge-target-mismatch");
  }
  const version: unknown = row.version;
  if (!nonEmpty(version)) return refuse("edge-target-unversioned");
  if (!satisfiesConstraint(version, edge.versionConstraint)) return refuse("edge-constraint-unmet");
  const bound = await materialize("child", row, version, input.orgId, r);
  return bound.ok ? { ok: true, value: { ...bound.value, edge } } : bound;
}

/**
 * The edge re-check for the loader's `stillBound`, just before an import: the
 * parent row is still live and its one edge for the child still resolves to the
 * bound child install. Anything else, or a read that throws, is `false` (the
 * loader also answers any throw of this re-check as a change).
 */
export async function childEdgeStillResolvesTo(
  input: { parentInstallId: string; childPackageName: string; childInstallId: string },
  deps: InstallBindingDeps = {},
): Promise<boolean> {
  const r = readersOf(deps);
  const read = await guarded("install-row", () => r.readInstalledExtensionById(input.parentInstallId));
  if (!read.ok || !read.value || !LIVE_STATUSES.has(read.value.status)) return false;
  const selected = selectChildEdge(read.value, input.childPackageName);
  return selected.ok && selected.value.resolvedInstallId === input.childInstallId;
}
