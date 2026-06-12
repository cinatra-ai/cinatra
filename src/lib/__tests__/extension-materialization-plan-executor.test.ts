// Executor tests for SIGNED MATERIALIZATION PLANS (cinatra#181) — the verbatim
// unpack-to-path engine + its refusal battery. Tarballs are generated on the
// fly and served through an injected fetchTarball (the SAME seam shape the
// materializer injects), so every byte is test-controlled.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, link, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  executeMaterializationPlan,
  extractTarballHardened,
  MaterializationExecutorError,
} from "@/lib/extension-materialization-plan-executor";
import {
  computeClosureHash,
  parseMaterializationPlan,
  type MaterializationPlan,
} from "@/lib/extension-materialization-plan-core";
import { sriForBytes } from "@/lib/extension-package-store-core";
import type { FetchTarball } from "@/lib/extension-package-store";

let workDir: string;
const tempDirs: string[] = [];

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-plan-exec-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  for (const d of tempDirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(workDir, prefix));
  return d;
}

/** Build an npm-layout tarball (`package/` prefix) from a file map. */
async function makeTarball(
  name: string,
  version: string,
  files: Record<string, string> = {},
  opts: { scripts?: Record<string, string>; mutate?: (pkgDir: string) => Promise<void> } = {},
): Promise<Buffer> {
  const src = await tempDir(`tgz-src-`);
  const pkgDir = path.join(src, "package");
  await mkdir(pkgDir, { recursive: true });
  const manifest: Record<string, unknown> = { name, version };
  if (opts.scripts) manifest.scripts = opts.scripts;
  await writeFile(path.join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(pkgDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await opts.mutate?.(pkgDir);
  const out = path.join(src, "out.tgz");
  await tar.c({ gzip: true, cwd: src, file: out, portable: true }, ["package"]);
  return readFile(out);
}

type NodeSpec = {
  name: string;
  version: string;
  placementPath: string;
  deps?: Array<{ name: string; placementPath: string }>;
  bytes: Buffer;
};

/** Assemble a parsed+validated plan + a fetchTarball serving the node bytes. */
function makePlanAndFetch(
  pkg: { name: string; version: string },
  roots: Array<{ name: string; placementPath: string }>,
  nodes: NodeSpec[],
): { plan: MaterializationPlan; closureHash: string; fetchTarball: FetchTarball; fetched: string[] } {
  const transport = {
    format: "cinatra-materialization-plan/v1",
    package: pkg,
    rootDependencies: roots,
    nodes: nodes.map((n) => ({
      name: n.name,
      version: n.version,
      integrity: sriForBytes(n.bytes),
      placementPath: n.placementPath,
      dependencies: n.deps ?? [],
    })),
  };
  const plan = parseMaterializationPlan(transport);
  const fetched: string[] = [];
  const fetchTarball: FetchTarball = async (input) => {
    fetched.push(`${input.packageName}@${input.packageVersion}`);
    const node = nodes.find((n) => n.name === input.packageName && n.version === input.packageVersion);
    if (!node) throw new Error(`unexpected fetch: ${input.packageName}@${input.packageVersion}`);
    return { bytes: node.bytes, integrity: sriForBytes(node.bytes) };
  };
  return { plan, closureHash: computeClosureHash(plan), fetchTarball, fetched };
}

describe("executeMaterializationPlan — verbatim placement", () => {
  it("places every node at its EXACT placementPath (incl. nested duplicate versions + hoisted edges) and reports the closure", async () => {
    const libB1 = await makeTarball("lib-b", "1.0.0", { "index.js": "module.exports = 'b1';\n" });
    const libB2 = await makeTarball("lib-b", "2.0.0", { "index.js": "module.exports = 'b2';\n" });
    const libA = await makeTarball("lib-a", "1.0.0", { "index.js": "module.exports = require('lib-b');\n" });
    const { plan, closureHash, fetchTarball, fetched } = makePlanAndFetch(
      { name: "@cinatra-test/ext", version: "1.0.0" },
      [
        { name: "lib-a", placementPath: "node_modules/lib-a" },
        { name: "lib-b", placementPath: "node_modules/lib-b" },
      ],
      [
        { name: "lib-a", version: "1.0.0", placementPath: "node_modules/lib-a", bytes: libA, deps: [{ name: "lib-b", placementPath: "node_modules/lib-a/node_modules/lib-b" }] },
        { name: "lib-b", version: "1.0.0", placementPath: "node_modules/lib-b", bytes: libB1 },
        { name: "lib-b", version: "2.0.0", placementPath: "node_modules/lib-a/node_modules/lib-b", bytes: libB2 },
      ],
    );
    const packageDir = await tempDir("pkg-");
    const result = await executeMaterializationPlan(
      { plan, expectedClosureHash: closureHash, packageDir, packageName: "@cinatra-test/ext" },
      { fetchTarball },
    );
    expect(result.nodesPlaced).toBe(3);
    expect(result.closureHash).toBe(closureHash);
    expect(fetched).toHaveLength(3);
    // Exact npm-style nested placement: REAL directories, duplicate versions nested.
    expect(JSON.parse(await readFile(path.join(packageDir, "node_modules/lib-b/package.json"), "utf8")).version).toBe("1.0.0");
    expect(JSON.parse(await readFile(path.join(packageDir, "node_modules/lib-a/node_modules/lib-b/package.json"), "utf8")).version).toBe("2.0.0");
    expect(await readFile(path.join(packageDir, "node_modules/lib-a/index.js"), "utf8")).toContain("require('lib-b')");
  });

  it("REFUSES caller-threading drift: an expectedClosureHash that is not the plan's re-derived hash", async () => {
    const lib = await makeTarball("lib-x", "1.0.0", { "index.js": "x\n" });
    const { plan, fetchTarball } = makePlanAndFetch(
      { name: "@cinatra-test/ext", version: "1.0.0" },
      [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
      [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes: lib }],
    );
    const packageDir = await tempDir("pkg-");
    await expect(
      executeMaterializationPlan(
        { plan, expectedClosureHash: "0".repeat(128), packageDir, packageName: "@cinatra-test/ext" },
        { fetchTarball },
      ),
    ).rejects.toThrow(/does not equal the verified expected hash/);
    expect(existsSync(path.join(packageDir, "node_modules"))).toBe(false);
  });

  it("REFUSES a per-node SRI mismatch over the FETCHED bytes (one flipped byte)", async () => {
    const lib = await makeTarball("lib-x", "1.0.0", { "index.js": "x\n" });
    const { plan, closureHash } = makePlanAndFetch(
      { name: "@cinatra-test/ext", version: "1.0.0" },
      [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
      [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes: lib }],
    );
    const tampered = Buffer.from(lib);
    tampered[tampered.length - 9] ^= 0xff;
    const fetchTampered: FetchTarball = async () => ({ bytes: tampered, integrity: sriForBytes(tampered) });
    const packageDir = await tempDir("pkg-");
    await expect(
      executeMaterializationPlan(
        { plan, expectedClosureHash: closureHash, packageDir, packageName: "@cinatra-test/ext" },
        { fetchTarball: fetchTampered },
      ),
    ).rejects.toThrow(/does not match the plan's integrity/);
  });

  it("REFUSES name/version drift between the plan node and the extracted package.json", async () => {
    const impostor = await makeTarball("lib-other", "9.9.9", { "index.js": "evil\n" });
    const { plan, closureHash } = makePlanAndFetch(
      { name: "@cinatra-test/ext", version: "1.0.0" },
      [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
      [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes: impostor }],
    );
    const packageDir = await tempDir("pkg-");
    await expect(
      executeMaterializationPlan(
        { plan, expectedClosureHash: closureHash, packageDir, packageName: "@cinatra-test/ext" },
        { fetchTarball: async () => ({ bytes: impostor, integrity: sriForBytes(impostor) }) },
      ),
    ).rejects.toThrow(/must equal the plan node exactly/);
  });

  it("REFUSES lifecycle scripts in a plan node (preinstall/install/postinstall/prepare)", async () => {
    for (const script of ["preinstall", "install", "postinstall", "prepare"]) {
      const lib = await makeTarball("lib-x", "1.0.0", { "index.js": "x\n" }, { scripts: { [script]: "echo pwned" } });
      const { plan, closureHash, fetchTarball } = makePlanAndFetch(
        { name: "@cinatra-test/ext", version: "1.0.0" },
        [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
        [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes: lib }],
      );
      const packageDir = await tempDir("pkg-");
      await expect(
        executeMaterializationPlan(
          { plan, expectedClosureHash: closureHash, packageDir, packageName: "@cinatra-test/ext" },
          { fetchTarball },
        ),
        `script ${script}`,
      ).rejects.toThrow(/lifecycle script/);
    }
  });

  it("REFUSES native addons: a *.node binary, a binding.gyp, and node-gyp/prebuild-install in ANY script", async () => {
    const withBinary = await makeTarball("lib-x", "1.0.0", { "build/Release/addon.node": "\x7fELF" });
    const withGyp = await makeTarball("lib-x", "1.0.0", { "binding.gyp": "{}" });
    const withTooling = await makeTarball("lib-x", "1.0.0", { "index.js": "x\n" }, { scripts: { build: "node-gyp rebuild" } });
    for (const [bytes, re] of [
      [withBinary, /native-addon artifact "build\/Release\/addon\.node"/],
      [withGyp, /native-addon artifact "binding\.gyp"/],
      [withTooling, /native-addon build tooling/],
    ] as const) {
      const { plan, closureHash, fetchTarball } = makePlanAndFetch(
        { name: "@cinatra-test/ext", version: "1.0.0" },
        [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
        [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes }],
      );
      const packageDir = await tempDir("pkg-");
      await expect(
        executeMaterializationPlan(
          { plan, expectedClosureHash: closureHash, packageDir, packageName: "@cinatra-test/ext" },
          { fetchTarball },
        ),
      ).rejects.toThrow(re);
    }
  });

  it("REFUSES a node_modules segment INSIDE a plan-node tarball (bundled deps in libraries)", async () => {
    const withBundled = await makeTarball("lib-x", "1.0.0", {
      "index.js": "x\n",
      "node_modules/sneaky/package.json": JSON.stringify({ name: "sneaky", version: "0.0.1" }),
    });
    const { plan, closureHash, fetchTarball } = makePlanAndFetch(
      { name: "@cinatra-test/ext", version: "1.0.0" },
      [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
      [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes: withBundled }],
    );
    const packageDir = await tempDir("pkg-");
    await expect(
      executeMaterializationPlan(
        { plan, expectedClosureHash: closureHash, packageDir, packageName: "@cinatra-test/ext" },
        { fetchTarball },
      ),
    ).rejects.toThrow(/node_modules segment in entry/);
  });

  it("REFUSES symlink AND hardlink tar entries at the HEADER (tar-header-level filter)", async () => {
    const withSymlink = await makeTarball("lib-x", "1.0.0", { "index.js": "x\n" }, {
      mutate: async (pkgDir) => {
        await symlink("/etc/passwd", path.join(pkgDir, "escape"));
      },
    });
    const withHardlink = await makeTarball("lib-x", "1.0.0", { "index.js": "x\n" }, {
      mutate: async (pkgDir) => {
        await link(path.join(pkgDir, "index.js"), path.join(pkgDir, "hard.js"));
      },
    });
    for (const [bytes, re] of [
      [withSymlink, /SymbolicLink entry/],
      [withHardlink, /Link entry/],
    ] as const) {
      const { plan, closureHash, fetchTarball } = makePlanAndFetch(
        { name: "@cinatra-test/ext", version: "1.0.0" },
        [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
        [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes }],
      );
      const packageDir = await tempDir("pkg-");
      await expect(
        executeMaterializationPlan(
          { plan, expectedClosureHash: closureHash, packageDir, packageName: "@cinatra-test/ext" },
          { fetchTarball },
        ),
      ).rejects.toThrow(re);
    }
  });

  it("REFUSES a placement collision (target already exists) — never overwrites", async () => {
    const lib = await makeTarball("lib-x", "1.0.0", { "index.js": "x\n" });
    const { plan, closureHash, fetchTarball } = makePlanAndFetch(
      { name: "@cinatra-test/ext", version: "1.0.0" },
      [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
      [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes: lib }],
    );
    const packageDir = await tempDir("pkg-");
    await mkdir(path.join(packageDir, "node_modules/lib-x"), { recursive: true });
    await writeFile(path.join(packageDir, "node_modules/lib-x/preexisting.js"), "evil\n");
    await expect(
      executeMaterializationPlan(
        { plan, expectedClosureHash: closureHash, packageDir, packageName: "@cinatra-test/ext" },
        { fetchTarball },
      ),
    ).rejects.toThrow(/placement target already exists/);
    // and the pre-existing content was NOT touched
    expect(await readFile(path.join(packageDir, "node_modules/lib-x/preexisting.js"), "utf8")).toBe("evil\n");
  });

  it("error class: every refusal is a MaterializationExecutorError (fail-closed contract)", async () => {
    const lib = await makeTarball("lib-x", "1.0.0", { "index.js": "x\n" });
    const { plan, fetchTarball } = makePlanAndFetch(
      { name: "@cinatra-test/ext", version: "1.0.0" },
      [{ name: "lib-x", placementPath: "node_modules/lib-x" }],
      [{ name: "lib-x", version: "1.0.0", placementPath: "node_modules/lib-x", bytes: lib }],
    );
    const packageDir = await tempDir("pkg-");
    await expect(
      executeMaterializationPlan(
        { plan, expectedClosureHash: "f".repeat(128), packageDir, packageName: "@cinatra-test/ext" },
        { fetchTarball },
      ),
    ).rejects.toBeInstanceOf(MaterializationExecutorError);
  });
});

describe("extractTarballHardened — shared hardened extraction", () => {
  it("extracts regular files/dirs and allows node_modules when not forbidden (extension tarballs)", async () => {
    const bytes = await makeTarball("ext", "1.0.0", {
      "register.mjs": "export function register() {}\n",
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0" }),
    });
    const dest = await tempDir("hx-");
    await extractTarballHardened({ bytes, destDir: dest, label: "ext@1.0.0", forbidNodeModules: false });
    expect(existsSync(path.join(dest, "node_modules/dep/package.json"))).toBe(true);
  });

  it("DECOMPRESSION-BOMB caps: entry-count and declared-unpacked-size breaches refuse at the header", async () => {
    const manyFiles: Record<string, string> = {};
    for (let i = 0; i < 6; i++) manyFiles[`f${i}.js`] = "x\n";
    const bytes = await makeTarball("lib-x", "1.0.0", manyFiles);
    const destA = await tempDir("hx-");
    await expect(
      extractTarballHardened({ bytes, destDir: destA, label: "lib-x@1.0.0", forbidNodeModules: true, caps: { maxEntries: 3, maxUnpackedBytes: 1024 * 1024 } }),
    ).rejects.toThrow(/more than 3 entries/);
    const big = await makeTarball("lib-x", "1.0.0", { "big.js": "A".repeat(4096) });
    const destB = await tempDir("hx-");
    await expect(
      extractTarballHardened({ bytes: big, destDir: destB, label: "lib-x@1.0.0", forbidNodeModules: true, caps: { maxEntries: 100, maxUnpackedBytes: 1000 } }),
    ).rejects.toThrow(/declared unpacked size above 1000 bytes/);
  });

  it("caps count SKIPPED headers too: a symlink-header flood hits the entry cap, never streams on", async () => {
    const bytes = await makeTarball("lib-x", "1.0.0", {}, {
      mutate: async (pkgDir) => {
        for (let i = 0; i < 6; i++) await symlink("/etc", path.join(pkgDir, `s${i}`));
      },
    });
    const dest = await tempDir("hx-");
    await expect(
      extractTarballHardened({ bytes, destDir: dest, label: "lib-x@1.0.0", forbidNodeModules: true, caps: { maxEntries: 3, maxUnpackedBytes: 1024 * 1024 } }),
    ).rejects.toThrow(/more than 3 entries/);
  });

  it("names EVERY violation in one refusal", async () => {
    const bytes = await makeTarball("ext", "1.0.0", { "index.js": "x\n" }, {
      mutate: async (pkgDir) => {
        await symlink("/etc", path.join(pkgDir, "s1"));
        await symlink("/tmp", path.join(pkgDir, "s2"));
      },
    });
    const dest = await tempDir("hx-");
    await expect(
      extractTarballHardened({ bytes, destDir: dest, label: "ext@1.0.0", forbidNodeModules: false }),
    ).rejects.toThrow(/s1[\s\S]*s2|s2[\s\S]*s1/);
  });
});
