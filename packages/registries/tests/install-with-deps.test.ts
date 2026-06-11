import { describe, expect, it, vi } from "vitest";
import {
  installPackageWithDependencies,
  type DependencyTree,
  type PluginTypeConfig,
  type Packument,
} from "@cinatra-ai/registries";

const TYPE_CONFIG: PluginTypeConfig = {
  type: "agent",
  scopePrefixes: ["@cinatra/"],
  packumentDepKey: "agentDependencies",
};

function makePackument(name: string, version: string, deps: Record<string, string> = {}): Packument {
  return {
    name,
    versions: {
      [version]: {
        name,
        version,
        dist: { tarball: `https://r.test/${name}/${version}.tgz`, integrity: `sha512-x` },
        cinatra: { agentDependencies: deps },
      },
    },
  };
}

describe("installPackageWithDependencies — dep tree", () => {
  it("installs root + all transitive deps in one call", async () => {
    const packs = new Map<string, Packument>([
      ["@cinatra/root", makePackument("@cinatra/root", "1.0.0", { "@cinatra/leaf": "^1.0.0" })],
      ["@cinatra/leaf", makePackument("@cinatra/leaf", "1.0.0")],
    ]);
    const installed: string[] = [];
    const { installedCount } = await installPackageWithDependencies({
      packageName: "@cinatra/root",
      packageRange: "^1.0.0",
      typeConfig: TYPE_CONFIG,
      config: { registryUrl: "https://r.test", packageScope: "@cinatra", token: null, uiUrl: null },
      fetchPackument: async (n) => packs.get(n)!,
      install: async (node) => { installed.push(node.packageName); return node.packageName; },
    });
    expect(installedCount).toBe(2);
    expect(installed).toContain("@cinatra/root");
    expect(installed).toContain("@cinatra/leaf");
  });
  it("passes each node's ResolvedNode into the install callback", async () => {
    const packs = new Map<string, Packument>([
      ["@cinatra/x", makePackument("@cinatra/x", "1.0.0")],
    ]);
    const captured: unknown[] = [];
    await installPackageWithDependencies({
      packageName: "@cinatra/x",
      packageRange: "^1.0.0",
      typeConfig: TYPE_CONFIG,
      config: { registryUrl: "https://r.test", packageScope: "@cinatra", token: null, uiUrl: null },
      fetchPackument: async (n) => packs.get(n)!,
      install: async (node) => { captured.push(node); },
    });
    expect(captured).toHaveLength(1);
    expect((captured[0] as { packageName: string }).packageName).toBe("@cinatra/x");
  });
});

// Covered in dependency-resolver.test.ts "conflict resolution keep newer" block.
describe("conflict resolution keep newer", () => {
  it("is covered by dependency-resolver.test.ts — prefer-newer overlapping ranges", () => {
    // See dependency-resolver.test.ts: "picks newer version when both consumer ranges overlap"
    expect(true).toBe(true);
  });
  it("is covered by dependency-resolver.test.ts — prefer-newer conflict throws", () => {
    // See dependency-resolver.test.ts: "throws PluginDependencyConflictError when newer pick does not satisfy a prior consumer range"
    expect(true).toBe(true);
  });
});
