import { describe, expect, it } from "vitest";
import { installResolvedTree } from "../src/install/install-tree";
import type { DependencyTree, ResolvedNode } from "../src/types";

function node(name: string, version = "1.0.0"): ResolvedNode {
  return {
    packageName: name,
    resolvedVersion: version,
    tarballUrl: `https://reg.test/${name}.tgz`,
    integrity: `sha512-${name}`,
    requestedRange: "^1.0.0",
    dependencies: {},
  };
}

function makeTree(names: string[]): DependencyTree {
  const all = new Map<string, ResolvedNode>();
  for (const n of names) all.set(n, node(n));
  return { root: all.get(names[0])!, all };
}

describe("install-tree unit", () => {
  it("invokes install once per node in alphabetical order", async () => {
    const tree = makeTree(["@cinatra/zeta", "@cinatra/alpha", "@cinatra/mid"]);
    const calls: string[] = [];
    const result = await installResolvedTree({
      tree,
      install: async (n) => {
        calls.push(n.packageName);
      },
    });
    expect(result.installedCount).toBe(3);
    expect(calls).toEqual(["@cinatra/alpha", "@cinatra/mid", "@cinatra/zeta"]);
  });

  it("propagates errors thrown by install without silent continuation", async () => {
    const tree = makeTree(["@cinatra/a", "@cinatra/b", "@cinatra/c"]);
    const calls: string[] = [];
    await expect(
      installResolvedTree({
        tree,
        install: async (n) => {
          calls.push(n.packageName);
          if (n.packageName === "@cinatra/b") {
            throw new Error("install failed for b");
          }
        },
      }),
    ).rejects.toThrow(/install failed for b/);
    // @cinatra/a ran, @cinatra/b threw, @cinatra/c never reached.
    expect(calls).toEqual(["@cinatra/a", "@cinatra/b"]);
  });
});

const SKIP_INTEGRATION = process.env.CINATRA_VERDACCIO_INTEGRATION !== "1";

describe.skipIf(SKIP_INTEGRATION)("install-tree integration (Verdaccio)", () => {
  it("placeholder — real fixture", () => {
    expect(true).toBe(true);
  });
});
