import { describe, expect, it } from "vitest";

describe("no server-only chain", () => {
  it("imports @cinatra-ai/registries without triggering server-only error", async () => {
    const mod = await import("@cinatra-ai/registries");
    expect(mod).toBeDefined();
  });
  it("exports the expected named surface", async () => {
    const mod = await import("@cinatra-ai/registries");
    const keys = Object.keys(mod);
    expect(keys).toContain("resolveDependencyTree");
    expect(keys).toContain("installResolvedTree");
    // installPackageWithDependencies (the prefer-newer full-tree convenience
    // wrapper) was DELETED with the cinatra#1039 Phase-2 reroute: the agent
    // path now plans through the unified dependency planner.
    expect(keys).not.toContain("installPackageWithDependencies");
    expect(keys).toContain("comparePluginVersions");
    expect(keys).toContain("listAgentPackages");
    expect(keys).toContain("extractAgentPackage");
    expect(keys).toContain("loadVerdaccioConfig");
    expect(keys).toContain("PluginDependencyCycleError");
    expect(keys).toContain("PluginDependencyConflictError");
    expect(keys).toContain("PluginDependencyScopeError");
  });
});
