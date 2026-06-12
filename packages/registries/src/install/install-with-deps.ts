// High-level API that resolves a dependency tree and invokes the caller's
// install side-effect once per resolved node. Provides a default
// pacote-based fetchPackument when none is injected.

import * as pacote from "pacote";
import { registryScopedAuthOptions } from "../verdaccio/registry-auth";
import { resolveDependencyTree } from "../dep-resolver/resolver";
import { installResolvedTree } from "./install-tree";
import type {
  DependencyTree,
  FetchPackument,
  InstallSideEffect,
  Packument,
  PluginTypeConfig,
  VerdaccioConfig,
} from "../types";

function defaultFetchPackument(config: VerdaccioConfig): FetchPackument {
  return async (name) =>
    (await pacote.packument(name, {
      registry: config.registryUrl,
      // Registry-scoped auth key — npm-registry-fetch ignores a flat `token`
      // option (#179), so credentials must be nerf-dart-scoped.
      ...registryScopedAuthOptions(config.registryUrl, config.token),
      fullMetadata: true,
    })) as unknown as Packument;
}

export async function installPackageWithDependencies<T>(input: {
  packageName: string;
  packageRange: string;
  typeConfig: PluginTypeConfig;
  config: VerdaccioConfig;
  install: InstallSideEffect<T>;
  /** Override for tests. Default uses pacote against config.registryUrl. */
  fetchPackument?: FetchPackument;
  conflictPolicy?: "strict-reject" | "prefer-newer";
}): Promise<{
  tree: DependencyTree;
  installedCount: number;
  results: T[];
}> {
  const fetchPackument =
    input.fetchPackument ?? defaultFetchPackument(input.config);

  const tree = await resolveDependencyTree({
    rootPackageName: input.packageName,
    rootRange: input.packageRange,
    fetchPackument,
    typeConfig: input.typeConfig,
    conflictPolicy: input.conflictPolicy,
  });

  const { installedCount, results } = await installResolvedTree<T>({
    tree,
    install: input.install,
  });

  return { tree, installedCount, results };
}
