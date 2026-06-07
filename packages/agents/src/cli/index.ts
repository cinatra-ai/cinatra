// CLI-safe re-exports for the cinatra agents install command.
// NO "server-only" imports anywhere in this module tree — safe for plain Node.js.
//
// Server-side callers should continue to use @cinatra/agent-builder (index.ts)
// which keeps its server-only guard.

// Verdaccio config is env-only with no DB fallback, provided by @cinatra-ai/registries.
export {
  loadVerdaccioConfig,
  requireVerdaccioConfig,
  requireVerdaccioToken,
} from "@cinatra-ai/registries";
export type { VerdaccioConfig } from "@cinatra-ai/registries";

// installAgentFromPackage — CLI-safe implementation (no server-only chain)
export { installAgentFromPackage } from "./install-from-package-cli";
export type {
  InstallAgentFromPackageInput,
  InstallAgentFromPackageResult,
} from "./install-from-package-cli";

// Dependency resolver exports with Agent* compatibility aliases for CLI callers.
export {
  resolveDependencyTree as resolveAgentDependencyTree,
  PluginDependencyCycleError as AgentDependencyCycleError,
  PluginDependencyConflictError as AgentDependencyConflictError,
  PluginDependencyResolutionError as AgentDependencyResolutionError,
  PluginDependencyLimitError as AgentDependencyLimitError,
  PluginDependencyScopeError as AgentDependencyScopeError,
} from "@cinatra-ai/registries";
export type {
  ResolvedNode,
  DependencyTree,
  FetchPackument,
  Packument,
  PackumentVersionEntry,
} from "@cinatra-ai/registries";

// Lockfile exports for CLI callers.
export {
  LOCKFILE_VERSION,
  readLockfile,
  writeLockfile,
  lockfileFromTree,
  stableStringifyLockfile,
  lockfileShapeSchema,
} from "@cinatra-ai/registries";
export type { LockfileShape } from "@cinatra-ai/registries";

// Install orchestrator exports for CLI callers.
export { installResolvedTree } from "@cinatra-ai/registries";
export type { InstallSideEffect } from "@cinatra-ai/registries";
