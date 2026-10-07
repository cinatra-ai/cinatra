// The claimed object type vocabulary (cinatra#3821).
//
// The application border gates read which object type ids belong to an
// extension. That vocabulary is DERIVED, never typed by hand: it is the set of
// well-formed `cinatra.artifact.objectTypes[].type` claims of the extension
// packages the two locks name, read from the materialized tree
// (`extensions/<scope>/<name>`, the shape the pinned sync writes) with the
// produces gate's own discovery and claim readers. This module names no
// extension package.
//
// FAIL CLOSED. An absent tree, a tree with fewer extension packages than
// package.json's `cinatra.devExtensions` declares (the floor
// assert-extensions-cloned.mjs reads), a package whose manifest is unreadable
// or names no package, or a tree that yields no claimed id
// would make a gate scan with an empty vocabulary and pass vacuously. Each of
// those THROWS a ClaimedTypeVocabularyError; a gate's CLI maps it to exit 2
// (scanner error, never a pass). It throws rather than ending the process so a
// test that calls it in-process fails one case with its reason.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverExtensionDirs, readArtifactClaimIds } from "../extension-produces-deps-gate.mjs";

export class ClaimedTypeVocabularyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaimedTypeVocabularyError";
  }
}

const SYNC_HINT =
  "clone the extension tree back first (scripts/ci/sync-dev-extensions.mjs --pinned; CI: the clone-extensions action)";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The number of extension packages package.json's `cinatra.devExtensions` declares. */
export function declaredExtensionCount(repoRoot) {
  const pkg = readJson(join(repoRoot, "package.json"));
  return Object.keys(pkg?.cinatra?.devExtensions ?? {}).length;
}

/** The namespace of a type id: the part before its first colon. */
export function namespaceOf(typeId) {
  const at = typeId.indexOf(":");
  return at === -1 ? typeId : typeId.slice(0, at);
}

/**
 * Read the claimed vocabulary from the materialized tree under `repoRoot`.
 * Returns {
 *   ids:        Map<claimed type id, claiming package name>,
 *   namespaces: Map<claimed namespace, claiming package names (sorted)>,
 *   extensionCount, declaredCount,
 * }. Throws ClaimedTypeVocabularyError when the tree is absent, under-populated
 * or yields no claimed id.
 */
export function loadClaimedTypeVocabulary(repoRoot) {
  const dirs = discoverExtensionDirs(join(repoRoot, "extensions"));
  const declaredCount = declaredExtensionCount(repoRoot);
  if (dirs.length === 0) {
    throw new ClaimedTypeVocabularyError(
      `no extension package under extensions/ — ${SYNC_HINT}; refusing to scan with an empty vocabulary.`,
    );
  }
  if (dirs.length < declaredCount) {
    throw new ClaimedTypeVocabularyError(
      `found ${dirs.length} extension package(s) under extensions/, but cinatra.devExtensions declares ` +
        `${declaredCount} — ${SYNC_HINT}; refusing to scan with a partial vocabulary.`,
    );
  }
  const ids = new Map();
  const namespaces = new Map();
  for (const dir of dirs) {
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg || typeof pkg.name !== "string" || !pkg.name) {
      throw new ClaimedTypeVocabularyError(
        `the manifest of the extension package at ${dir} is unreadable or names no package — ${SYNC_HINT}; ` +
          `refusing to scan with a partial vocabulary.`,
      );
    }
    for (const id of readArtifactClaimIds(pkg)) {
      if (!ids.has(id)) ids.set(id, pkg.name);
      const ns = namespaceOf(id);
      const owners = namespaces.get(ns) ?? new Set();
      owners.add(pkg.name);
      namespaces.set(ns, owners);
    }
  }
  if (ids.size === 0) {
    throw new ClaimedTypeVocabularyError(
      `the ${dirs.length} extension package(s) under extensions/ claim no object type id — ${SYNC_HINT}; ` +
        `refusing to scan with an empty vocabulary.`,
    );
  }
  const sortedIds = new Map([...ids.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const sortedNamespaces = new Map(
    [...namespaces.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ns, owners]) => [ns, [...owners].sort()]),
  );
  return { ids: sortedIds, namespaces: sortedNamespaces, extensionCount: dirs.length, declaredCount };
}
