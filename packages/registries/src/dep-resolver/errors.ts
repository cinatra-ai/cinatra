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
  public allowedScopePrefixes: readonly string[];

  // Accepts a single prefix as well as the allowlist shape so pre-allowlist
  // callers of the exported class (`new PluginDependencyScopeError(name, "@x/")`)
  // keep working at runtime.
  constructor(public packageName: string, scopePrefixes?: readonly string[] | string) {
    const normalized =
      typeof scopePrefixes === "string" ? [scopePrefixes] : scopePrefixes;
    const allowed =
      normalized && normalized.length > 0 ? normalized : ["@cinatra-ai/"];
    super(
      `Only ${allowed.map((prefix) => `${prefix}*`).join(", ")} packages may appear in dependencies; received: ${packageName}`,
    );
    this.name = "PluginDependencyScopeError";
    this.allowedScopePrefixes = allowed;
  }
}
