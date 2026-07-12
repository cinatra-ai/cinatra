// Pure dependency resolver over Verdaccio packuments. No network I/O here:
// callers inject a `fetchPackument` implementation. Enforces a configurable
// scope-prefix allowlist (dependency-confusion mitigation), caps traversal at
// 500 nodes / depth 20, and rejects pre-release ranges.
//
// The scope allowlist is NOT the root authorization boundary: whether the root
// package may be installed at all is decided upstream by the marketplace/broker
// install grant and the caller's authz gates. The allowlist only confines which
// scopes the resolved tree may pull from (the root's own vendor scope + the
// first-party base scope — see ../scope.ts).
//
// The resolver is package-type agnostic: typeConfig supplies both the allowed
// scope prefixes and the cinatra packument dependency key. Version
// disagreements between consumers are always REJECTED
// (PluginDependencyConflictError): the "prefer-newer" upgrade policy this
// resolver used to carry was a duplicate of the unified dependency planner's
// dedupe-upward semantics (src/lib/extension-dependency-plan.ts) and was
// deleted with the cinatra#1039 Phase-2 reroute of the agent install path —
// install-time conflict handling lives in the planner, on every path.

import * as semver from "semver";
import type {
  DependencyTree,
  FetchPackument,
  Packument,
  PackumentVersionEntry,
  PluginTypeConfig,
  ResolvedNode,
} from "../types";
import {
  PluginDependencyConflictError,
  PluginDependencyCycleError,
  PluginDependencyLimitError,
  PluginDependencyResolutionError,
  PluginDependencyScopeError,
} from "./errors";

type QueueEntry = {
  name: string;
  range: string;
  path: string[];
  depth: number;
};

function isPrereleaseRange(range: string): boolean {
  // Any hyphen followed by a letter signals a pre-release identifier inside a range.
  return /-[a-z]/i.test(range);
}

function is404(err: unknown): boolean {
  if (err && typeof err === "object") {
    const anyErr = err as { statusCode?: number; code?: string };
    if (anyErr.statusCode === 404) return true;
    if (anyErr.code === "E404") return true;
  }
  return false;
}

export async function resolveDependencyTree(input: {
  rootPackageName: string;
  rootRange: string;
  fetchPackument: FetchPackument;
  typeConfig: PluginTypeConfig;
  maxNodes?: number;
  maxDepth?: number;
}): Promise<DependencyTree> {
  const maxNodes = input.maxNodes ?? 500;
  const maxDepth = input.maxDepth ?? 20;
  const { scopePrefixes, packumentDepKey, readPackumentDeps } = input.typeConfig;

  // Single read seam for a node's transitive dependency map. Default reads the
  // legacy `cinatra[packumentDepKey]` map; a typeConfig may inject
  // `readPackumentDeps` to resolve from a different vocabulary (e.g. the agent
  // installer projects the canonical `cinatra.dependencies` array). Used at all
  // three packument read sites so the two paths can never drift.
  const readDeps = (entry: PackumentVersionEntry): Record<string, string> => {
    if (readPackumentDeps) return readPackumentDeps(entry);
    return (
      (entry.cinatra?.[packumentDepKey] as Record<string, string> | undefined) ?? {}
    );
  };

  // Fail closed on a malformed allowlist: an empty list would reject
  // everything cryptically, and a prefix that does not look like "@scope/"
  // signals a caller bug (e.g. a missing trailing slash would let
  // "@cinatra-ai" admit "@cinatra-ai-evil/x").
  if (scopePrefixes.length === 0) {
    throw new Error("typeConfig.scopePrefixes must not be empty");
  }
  for (const prefix of scopePrefixes) {
    if (!/^@[^/@]+\/$/.test(prefix)) {
      throw new Error(
        `Malformed scope prefix in typeConfig.scopePrefixes (expected "@scope/"): ${prefix}`,
      );
    }
  }

  const resolved = new Map<string, ResolvedNode>();
  // Keep the requested ranges per-node so a second pass can populate the
  // dependencies map from each packument snapshot without refetching.
  const pickedManifests = new Map<string, PackumentVersionEntry>();

  const queue: QueueEntry[] = [
    { name: input.rootPackageName, range: input.rootRange, path: [], depth: 0 },
  ];

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const { name, range, path, depth } = entry;

    if (!scopePrefixes.some((prefix) => name.startsWith(prefix))) {
      throw new PluginDependencyScopeError(name, scopePrefixes);
    }

    if (isPrereleaseRange(range)) {
      throw new Error(`Pre-release ranges are not supported in v1: ${range}`);
    }

    if (path.includes(name)) {
      throw new PluginDependencyCycleError([...path, name]);
    }

    if (depth > maxDepth) {
      throw new PluginDependencyLimitError("depth", maxDepth);
    }

    // Packument fetch
    let packument: Packument;
    try {
      packument = await input.fetchPackument(name);
    } catch (err) {
      if (is404(err)) {
        throw new PluginDependencyResolutionError(name, range, []);
      }
      throw err;
    }

    const availableVersions = Object.keys(packument.versions ?? {});
    const pick = semver.maxSatisfying(availableVersions, range, {
      includePrerelease: false,
    });
    if (!pick) {
      throw new PluginDependencyResolutionError(name, range, availableVersions);
    }

    const existing = resolved.get(name);
    if (existing) {
      if (existing.resolvedVersion === pick) continue;
      // Two consumers disagree on a concrete version — always reject. The
      // upgrade path for a version disagreement is the unified dependency
      // planner's dedupe-upward (cinatra#1039), not this walker.
      throw new PluginDependencyConflictError(
        name,
        existing.resolvedVersion,
        pick,
      );
    }

    if (resolved.size >= maxNodes) {
      throw new PluginDependencyLimitError("nodes", maxNodes);
    }

    const pickedManifest = packument.versions[pick];
    if (!pickedManifest) {
      throw new PluginDependencyResolutionError(name, range, availableVersions);
    }

    const node: ResolvedNode = {
      packageName: name,
      resolvedVersion: pick,
      tarballUrl: pickedManifest.dist.tarball,
      integrity: pickedManifest.dist.integrity,
      requestedRange: range,
      dependencies: {},
    };
    resolved.set(name, node);
    pickedManifests.set(name, pickedManifest);

    const childDeps = readDeps(pickedManifest);
    const nextPath = [...path, name];
    for (const [depName, depRange] of Object.entries(childDeps)) {
      queue.push({
        name: depName,
        range: depRange,
        path: nextPath,
        depth: depth + 1,
      });
    }
  }

  // Second pass: populate each node's `dependencies` map from the captured
  // packument manifest so the resolver output is self-describing.
  for (const [name, node] of resolved) {
    const manifest = pickedManifests.get(name);
    const deps = manifest ? readDeps(manifest) : {};
    node.dependencies = { ...deps };
  }

  const root = resolved.get(input.rootPackageName);
  if (!root) {
    // Should be unreachable — the root is always the first enqueued node.
    throw new PluginDependencyResolutionError(
      input.rootPackageName,
      input.rootRange,
      [],
    );
  }

  return { root, all: resolved };
}
