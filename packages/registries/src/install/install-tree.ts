// Generic result collection lets callers collect per-node results (e.g. template
// IDs) without a second loop.
//
// Pure orchestrator that invokes a caller-supplied install side-effect once
// per resolved node. Iteration order is deterministic (sorted alphabetically
// by package name) so CLI logs and UI progress remain stable across runs.

import type { DependencyTree, InstallSideEffect } from "../types";

export async function installResolvedTree<T = void>(input: {
  tree: DependencyTree;
  install: InstallSideEffect<T>;
}): Promise<{ installedCount: number; results: T[] }> {
  const sortedNames = [...input.tree.all.keys()].sort();
  let count = 0;
  const results: T[] = [];
  for (const name of sortedNames) {
    const node = input.tree.all.get(name)!;
    const result = await input.install(node);
    results.push(result);
    count += 1;
  }
  return { installedCount: count, results };
}
