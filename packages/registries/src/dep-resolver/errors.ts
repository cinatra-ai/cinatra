export class PluginDependencyCycleError extends Error {
  constructor(public cyclePath: string[]) {
    super(`Dependency cycle detected: ${cyclePath.join(" -> ")}`);
    this.name = "PluginDependencyCycleError";
  }
}

export class PluginDependencyConflictError extends Error {
  constructor(
    public packageName: string,
    public existingVersion: string,
    public attemptedVersion: string,
  ) {
    super(
      `Incompatible versions required for ${packageName}: already pinned at ${existingVersion}, attempted ${attemptedVersion}`,
    );
    this.name = "PluginDependencyConflictError";
  }
}

export class PluginDependencyResolutionError extends Error {
  constructor(
    public packageName: string,
    public range: string,
    public availableVersions: string[],
  ) {
    super(
      `No version satisfying ${packageName}@${range} (available: ${availableVersions.join(", ") || "<none>"})`,
    );
    this.name = "PluginDependencyResolutionError";
  }
}

export class PluginDependencyLimitError extends Error {
  constructor(public kind: "nodes" | "depth", public limit: number) {
    super(`Dependency resolver exceeded ${kind} limit of ${limit}`);
    this.name = "PluginDependencyLimitError";
  }
}

export class PluginDependencyScopeError extends Error {
  constructor(public packageName: string, scopePrefix?: string) {
    super(
      `Only ${scopePrefix ?? "@cinatra/"}* packages may appear in dependencies; received: ${packageName}`,
    );
    this.name = "PluginDependencyScopeError";
  }
}
