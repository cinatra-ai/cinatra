import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
// The builder is SELF-CONTAINED by contract (design §4.1: release CI runs it
// standalone, outside the monorepo workspace), so its resolver/classifier are
// INLINED copies of the SDK exports. This suite is the lockstep pin: both
// sides run over ONE shared case table — if either side changes semantics,
// the parity cases fail.
import {
  buildServerEntryPack,
  classifyServerEntryArtifact as builderClassify,
  resolveDeclaredServerEntry as builderResolveDeclared,
  resolveExportsSubpath as builderResolveSubpath,
  resolveDependencyMode,
  DEPENDENCY_MODES,
  HOST_PROVIDED_PEERS,
} from "../build-server-entry.mjs";
import {
  classifyServerEntryArtifact,
  resolveDeclaredServerEntry,
  resolveExportsSubpath,
} from "@cinatra-ai/sdk-extensions";
import { HOST_PROVIDED_PACKAGES } from "@/lib/extension-package-store-core";
import { materializePackageToStore } from "@/lib/extension-package-store";
import { sriForBytes } from "@/lib/extension-package-store-core";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "../../..");
const BUILDER_CLI = path.join(REPO_ROOT, "scripts/extensions/build-server-entry.mjs");

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

// ---------------------------------------------------------------------------
// Parity table — the pinned Cinatra resolver semantics (design §2), recorded
// once and run against BOTH the SDK export and the builder's inlined copy.
// ---------------------------------------------------------------------------

describe("inlined resolver parity with the SDK (the §4.1 lockstep pin)", () => {
  const SUBPATH_CASES: Array<{ label: string; map: unknown; key: string }> = [
    { label: "plain string target", map: { "./register": "./src/register.ts" }, key: "./register" },
    { label: "root key", map: { ".": "./src/index.ts" }, key: "." },
    { label: "missing key", map: { ".": "./src/index.ts" }, key: "./register" },
    { label: "target without ./ prefix", map: { "./register": "src/register.ts" }, key: "./register" },
    { label: "target ../ escape (not ./-prefixed)", map: { "./register": "../evil.mjs" }, key: "./register" },
    { label: "absolute target", map: { "./register": "/abs/evil.mjs" }, key: "./register" },
    { label: "conditional import", map: { "./register": { import: "./a.mjs" } }, key: "./register" },
    { label: "conditional default", map: { "./register": { default: "./b.mjs" } }, key: "./register" },
    { label: "conditional require", map: { "./register": { require: "./c.cjs" } }, key: "./register" },
    { label: "conditional unsupported condition only", map: { "./register": { node: "./d.mjs" } }, key: "./register" },
    { label: "conditional import:null falls to default", map: { "./register": { import: null, default: "./e.mjs" } }, key: "./register" },
    { label: "NESTED condition object does NOT fall through", map: { "./register": { import: { default: "./nested.mjs" } } }, key: "./register" },
    { label: "conditional array value", map: { "./register": { import: ["./x.mjs"] } }, key: "./register" },
    { label: "array target", map: { "./register": ["./x.mjs"] }, key: "./register" },
    { label: "null target", map: { "./register": null }, key: "./register" },
    { label: "exports map absent", map: undefined, key: "./register" },
    { label: "exports map is a string", map: "./index.mjs", key: "./register" },
    { label: "exports map is an array", map: ["./index.mjs"], key: "./register" },
    { label: "wildcard key is NOT pattern-matched", map: { "./*": "./src/*.ts" }, key: "./register" },
  ];

  it.each(SUBPATH_CASES)("resolveExportsSubpath parity: $label", ({ map, key }) => {
    expect(builderResolveSubpath(map, key)).toEqual(resolveExportsSubpath(map, key));
  });

  const DECLARED_CASES: Array<{ label: string; map: unknown; serverEntry: string }> = [
    { label: "declared valid key", map: { "./register": "./src/register.ts" }, serverEntry: "./register" },
    { label: "declared INVALID target (array) → refusal, never literal fallback", map: { "./register": ["./x.mjs"] }, serverEntry: "./register" },
    { label: "declared INVALID target (null)", map: { "./register": null }, serverEntry: "./register" },
    { label: "declared INVALID target (non-./)", map: { "./register": "src/register.ts" }, serverEntry: "./register" },
    { label: "undeclared key → literal fallback", map: { ".": "./src/index.ts" }, serverEntry: "./register.mjs" },
    { label: "no exports map → literal fallback", map: undefined, serverEntry: "./register.mjs" },
    { label: "exports map is an array → literal fallback", map: ["./x.mjs"], serverEntry: "./register.mjs" },
    { label: "wildcard-only map → literal fallback (exact keys only)", map: { "./*": "./src/*.ts" }, serverEntry: "./register" },
  ];

  it.each(DECLARED_CASES)("resolveDeclaredServerEntry parity: $label", ({ map, serverEntry }) => {
    expect(builderResolveDeclared(map, serverEntry)).toEqual(resolveDeclaredServerEntry(map, serverEntry));
  });

  const CLASSIFY_CASES = [
    "./register.mjs", "./dist/a.cjs", "./b.js", "./src/register.ts", "./x.tsx",
    "./x.mts", "./x.cts", "./register", "./x.json", "./x.node", "./X.MJS",
  ];

  it.each(CLASSIFY_CASES)("classifyServerEntryArtifact parity: %s", (rel) => {
    expect(builderClassify(rel)).toEqual(classifyServerEntryArtifact(rel));
  });

  it("the builder's inlined host-peer externals equal the host's HOST_PROVIDED_PACKAGES", () => {
    expect(new Set(HOST_PROVIDED_PEERS)).toEqual(HOST_PROVIDED_PACKAGES);
  });
});

// ---------------------------------------------------------------------------
// Builder behavior over synthetic fixtures
// ---------------------------------------------------------------------------

type FixtureManifest = Record<string, unknown>;

async function writeFixture(
  dir: string,
  manifest: FixtureManifest,
  files: Record<string, string>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
}

const SOURCE_SHAPE_MANIFEST: FixtureManifest = {
  name: "@cinatra-test/builder-fixture",
  version: "0.0.1",
  type: "module",
  files: ["src", "!src/__tests__"],
  exports: { ".": "./src/index.ts", "./register": "./src/register.ts" },
  dependencies: { "fixture-dep": "1.0.0" },
  peerDependencies: { "@cinatra-ai/sdk-extensions": "*", react: "^19.2.3" },
  cinatra: { apiVersion: "cinatra.ai/v1", kind: "connector", serverEntry: "./register", requestedHostPorts: [] },
};

const SOURCE_SHAPE_FILES: Record<string, string> = {
  // The REAL in-tree shape: extensionless ESM-illegal relative import (only a
  // bundler can activate this — design §1.4) + an inlinable npm dependency.
  "src/register.ts":
    'import { greeting } from "./impl";\nimport { dep } from "fixture-dep";\n' +
    "export function register(ctx: { logger: { info(msg: string): void } }): void {\n" +
    "  ctx.logger.info(`${greeting} ${dep}`);\n}\n",
  "src/impl.ts": 'export const greeting = "built";\n',
  "src/index.ts": "export {};\n",
  "node_modules/fixture-dep/package.json": JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.js" }),
  "node_modules/fixture-dep/index.js": 'exports.dep = "dep-inlined";\n',
};

describe("buildServerEntryPack — bundled mode (source-mirror input)", () => {
  it("stages a pack dir with a self-contained register.mjs and rewrites ONLY the packed manifest", async () => {
    const src = path.join(await tempDir("bse-bundled-"), "pkg");
    await writeFixture(src, SOURCE_SHAPE_MANIFEST, SOURCE_SHAPE_FILES);
    const sourceManifestBefore = await readFile(path.join(src, "package.json"), "utf8");

    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("bundled");
    expect(result.entryRel).toBe("./src/register.ts");
    expect(result.inlinedPackages).toContain("fixture-dep");
    expect(result.prunedDependencies).toEqual(["fixture-dep"]);

    // The packed manifest carries the BUILT shape the runtime store accepts.
    const packed = JSON.parse(await readFile(path.join(result.packDir, "package.json"), "utf8"));
    expect(packed.cinatra.serverEntry).toBe("./register.mjs");
    expect(packed.dependencies).toBeUndefined();
    expect(packed.files).toContain("register.mjs");
    // exports keeps its SOURCE entries (the static path stays host-compiled).
    expect(packed.exports).toEqual(SOURCE_SHAPE_MANIFEST.exports);

    // The bundle is a REAL importable artifact: import + register() works
    // under plain Node from the pack dir (no node_modules anywhere near it).
    await expect(stat(path.join(result.packDir, "node_modules"))).rejects.toThrow();
    const mod = await import(path.join(result.packDir, "register.mjs"));
    const lines: string[] = [];
    mod.register({ logger: { info: (msg: string) => lines.push(msg) } });
    expect(lines).toEqual(["built dep-inlined"]);

    // The SOURCE tree is NEVER touched (design §4.1 step 3).
    expect(await readFile(path.join(src, "package.json"), "utf8")).toBe(sourceManifestBefore);
  });

  it("the CLI surface produces the same contract (what release CI executes), and `npm pack` over the pack dir ships register.mjs", async () => {
    const src = path.join(await tempDir("bse-cli-"), "pkg");
    await writeFixture(src, SOURCE_SHAPE_MANIFEST, SOURCE_SHAPE_FILES);
    const out = path.join(await tempDir("bse-cli-out-"), "package");
    const stdout = execFileSync(process.execPath, [BUILDER_CLI, src, "--out", out, "--json"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    const result = JSON.parse(stdout);
    expect(result.mode).toBe("bundled");
    expect(result.packDir).toBe(out);
    const packed = JSON.parse(await readFile(path.join(out, "package.json"), "utf8"));
    expect(packed.cinatra.serverEntry).toBe("./register.mjs");

    // The EXACT artifact Stage D publishes is `npm pack` FROM the pack dir:
    // the dry-run file list must ship the bundle and the rewritten manifest
    // (the `files` append is what pulls register.mjs in).
    const packJson = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
      cwd: out,
    });
    const [packReport] = JSON.parse(packJson) as Array<{ files: Array<{ path: string }> }>;
    const shipped = packReport.files.map((f) => f.path);
    expect(shipped).toContain("register.mjs");
    expect(shipped).toContain("package.json");
    expect(shipped).toContain("src/register.ts");
    expect(shipped.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });
});

describe("host-runtime build-time inputs (the standalone build contract)", () => {
  it("`server-only` is builder-shimmed: a graph importing it builds WITHOUT server-only being resolvable", async () => {
    const src = path.join(await tempDir("bse-serveronly-"), "pkg");
    await writeFixture(
      src,
      { name: "@cinatra-test/server-only-shim", version: "0.0.1", exports: { "./register": "./src/register.ts" }, cinatra: { kind: "connector", serverEntry: "./register" } },
      {
        "src/register.ts":
          'import "server-only";\nexport function register(ctx: { logger: { info(m: string): void } }): void { ctx.logger.info("ok"); }\n',
      },
    );
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("bundled");
    const mod = await import(path.join(result.packDir, "register.mjs"));
    const lines: string[] = [];
    mod.register({ logger: { info: (m: string) => lines.push(m) } });
    expect(lines).toEqual(["ok"]);
  });

  it("a graph importing next/<api> WITHOUT next provisioned fails LOUD naming the build-time input", async () => {
    const src = path.join(await tempDir("bse-no-next-"), "pkg");
    await writeFixture(
      src,
      { name: "@cinatra-test/needs-next", version: "0.0.1", exports: { "./register": "./src/register.ts" }, cinatra: { kind: "connector", serverEntry: "./register" } },
      {
        "src/register.ts":
          'import { redirect } from "next/navigation";\nexport function register(): void { void redirect; }\n',
      },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(/BUILD-TIME INPUT/);
  });

  it("a graph importing next/<api> WITH next provisioned NEXT TO THE PACKAGE builds (package-dir resolution, not the builder's own location)", async () => {
    const src = path.join(await tempDir("bse-with-next-"), "pkg");
    await writeFixture(
      src,
      { name: "@cinatra-test/has-next", version: "0.0.1", exports: { "./register": "./src/register.ts" }, cinatra: { kind: "connector", serverEntry: "./register" } },
      {
        "src/register.ts":
          'import { redirect } from "next/navigation";\n' +
          "export function register(ctx: { logger: { info(m: string): void } }): void {\n" +
          '  ctx.logger.info(typeof redirect);\n}\n',
      },
    );
    // Provision `next` as the explicit build-time input (what a standalone
    // repo declares as a devDependency) — a symlink to the real package.
    await mkdir(path.join(src, "node_modules"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(REPO_ROOT, "node_modules/next"), path.join(src, "node_modules/next"), "dir");
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("bundled");
    expect(result.inlinedPackages).toContain("next");
    const mod = await import(path.join(result.packDir, "register.mjs"));
    const lines: string[] = [];
    mod.register({ logger: { info: (m: string) => lines.push(m) } });
    expect(lines).toEqual(["function"]); // the SERVER redirect build, inlined
  });
});

describe("buildServerEntryPack — passthrough + none modes (the §4.1 mode split)", () => {
  it("passes an already-built entry through VERBATIM (no rewrite)", async () => {
    const src = path.join(await tempDir("bse-pass-"), "pkg");
    const manifest: FixtureManifest = {
      name: "@cinatra-test/prebuilt",
      version: "0.0.1",
      cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: [] },
    };
    await writeFixture(src, manifest, { "register.mjs": "export function register() {}\n" });
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("passthrough");
    expect(await readFile(path.join(result.packDir, "package.json"), "utf8")).toBe(
      await readFile(path.join(src, "package.json"), "utf8"),
    );
  });

  it("copies a no-serverEntry package verbatim (agents/skills/artifacts)", async () => {
    const src = path.join(await tempDir("bse-none-"), "pkg");
    await writeFixture(src, { name: "@cinatra-test/agent", version: "0.0.1", cinatra: { kind: "agent" } }, {
      "cinatra/agent.yaml": "name: fixture\n",
    });
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("none");
    expect(result.entryRel).toBeNull();
    await expect(stat(path.join(result.packDir, "cinatra/agent.yaml"))).resolves.toBeTruthy();
  });
});

describe("buildServerEntryPack — fail-loud refusals", () => {
  it("REFUSES a declared exports key with an out-of-contract target (never a literal fallback)", async () => {
    const src = path.join(await tempDir("bse-badkey-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", exports: { "./register": ["./src/register.ts"] }, cinatra: { kind: "connector", serverEntry: "./register" } },
      { "src/register.ts": "export function register() {}\n" },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /outside the supported exports forms/,
    );
  });

  it("REFUSES an entry that escapes the package dir", async () => {
    const src = path.join(await tempDir("bse-escape-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", exports: { "./register": "./src/../../evil.ts" }, cinatra: { kind: "connector", serverEntry: "./register" } },
      { "src/register.ts": "export function register() {}\n" },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(/escapes the package dir/);
  });

  it("REFUSES a missing entry file (the build INPUT must exist)", async () => {
    const src = path.join(await tempDir("bse-missing-"), "pkg");
    await writeFixture(src, { name: "x", version: "0.0.1", exports: { "./register": "./src/register.ts" }, cinatra: { kind: "connector", serverEntry: "./register" } }, {});
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(/no such file in the package/);
  });

  it("REFUSES an extensionless resolution (neither built nor buildable)", async () => {
    const src = path.join(await tempDir("bse-extless-"), "pkg");
    await writeFixture(src, { name: "x", version: "0.0.1", cinatra: { kind: "connector", serverEntry: "./register" } }, { register: "export function register() {}\n" });
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /neither a built artifact .* nor buildable TypeScript source/,
    );
  });

  it("REFUSES a bundle that still VALUE-imports a host ABI peer (the residual-import check)", async () => {
    const src = path.join(await tempDir("bse-residual-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", exports: { "./register": "./src/register.ts" }, cinatra: { kind: "connector", serverEntry: "./register" } },
      {
        "src/register.ts":
          'import { recordFromManifest } from "@cinatra-ai/sdk-extensions";\n' +
          "export function register(): void { recordFromManifest('x', 'y'); }\n",
      },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /still imports "@cinatra-ai\/sdk-extensions" at runtime/,
    );
  });
});

// ---------------------------------------------------------------------------
// The source-vs-built ASYMMETRY (design §4.1): the SAME
// source-shaped package is ACCEPTED by the builder and REFUSED by the
// materializer gate + the loader classification.
// ---------------------------------------------------------------------------

describe("source-mode vs built-mode asymmetry parity (builder accepts what the store refuses)", () => {
  async function tarDirAsPackage(dir: string): Promise<Buffer> {
    const staging = await tempDir("bse-tar-");
    const out = path.join(staging, "pkg.tgz");
    await tar.c({ gzip: true, cwd: path.dirname(dir), file: out }, [path.basename(dir)]);
    return readFile(out);
  }

  it("the SAME manifest: builder bundles it; the materializer REFUSES the source tarball; the built pack dir MATERIALIZES", async () => {
    const root = await tempDir("bse-asym-");
    const src = path.join(root, "package");
    await writeFixture(src, SOURCE_SHAPE_MANIFEST, SOURCE_SHAPE_FILES);

    // 1. Builder path: ACCEPTED (source mode is its whole job).
    const built = await buildServerEntryPack({ packageDir: src, outDir: path.join(root, "built", "package") });
    expect(built.mode).toBe("bundled");

    // 2. The loader-side classification calls the same shape "source" — the
    //    class the runtime loader refuses (defense in depth).
    expect(classifyServerEntryArtifact("./src/register.ts")).toBe("source");

    // 3. Materializer path over the SOURCE tarball: REFUSED with the pinned
    //    install-time error head (the PRIMARY gate, design §3.3).
    const srcBytes = await tarDirAsPackage(src);
    await expect(
      materializePackageToStore(
        {
          packageName: SOURCE_SHAPE_MANIFEST.name as string,
          version: "0.0.1",
          expectedIntegrity: sriForBytes(srcBytes, "sha512"),
          registryUrl: "https://registry.cinatra.ai",
          storeRoot: path.join(root, "store-src"),
        },
        { fetchTarball: async () => ({ bytes: srcBytes, integrity: sriForBytes(srcBytes, "sha512") }), now: () => "2026-06-12T00:00:00.000Z" },
      ),
    ).rejects.toThrow(/\[package-store\] .*TypeScript source entry/);

    // 4. Materializer path over the BUILT pack dir: ACCEPTED — the builder's
    //    output satisfies the very gate that refused its input.
    const builtBytes = await tarDirAsPackage(built.packDir);
    const mat = await materializePackageToStore(
      {
        packageName: SOURCE_SHAPE_MANIFEST.name as string,
        version: "0.0.1",
        expectedIntegrity: sriForBytes(builtBytes, "sha512"),
        registryUrl: "https://registry.cinatra.ai",
        storeRoot: path.join(root, "store-built"),
      },
      { fetchTarball: async () => ({ bytes: builtBytes, integrity: sriForBytes(builtBytes, "sha512") }), now: () => "2026-06-12T00:00:00.000Z" },
    );
    expect(mat.reused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dependency modes (cinatra#181): inline-and-prune (default, byte-identical)
// vs declare-and-closure.
// ---------------------------------------------------------------------------

describe("resolveDependencyMode (cinatra#181)", () => {
  it("absent / null → inline (today's behavior)", () => {
    expect(resolveDependencyMode(undefined, null, "x")).toBe("inline");
    expect(resolveDependencyMode({}, null, "x")).toBe("inline");
    expect(resolveDependencyMode({ dependencyMode: undefined }, null, "x")).toBe("inline");
  });
  it("accepts the two declared modes", () => {
    expect(DEPENDENCY_MODES).toEqual(["inline", "closure"]);
    expect(resolveDependencyMode({ dependencyMode: "inline" }, null, "x")).toBe("inline");
    expect(resolveDependencyMode({ dependencyMode: "closure" }, null, "x")).toBe("closure");
  });
  it("the CLI override (tests only) wins over the manifest", () => {
    expect(resolveDependencyMode({ dependencyMode: "inline" }, "closure", "x")).toBe("closure");
    expect(resolveDependencyMode({}, "closure", "x")).toBe("closure");
  });
  it("REFUSES an unsupported mode loudly (a typo must never silently build inline)", () => {
    expect(() => resolveDependencyMode({ dependencyMode: "clozure" }, null, "x")).toThrow(/not a .*supported mode/i);
    expect(() => resolveDependencyMode({ dependencyMode: 7 }, null, "x")).toThrow(/dependencyMode/);
  });
});

const CLOSURE_MANIFEST: FixtureManifest = {
  ...SOURCE_SHAPE_MANIFEST,
  name: "@cinatra-test/closure-fixture",
  cinatra: { ...(SOURCE_SHAPE_MANIFEST.cinatra as Record<string, unknown>), dependencyMode: "closure" },
};

describe("buildServerEntryPack — closure dependency mode (declare-and-closure)", () => {
  it("keeps declared deps EXTERNAL in the bundle and KEPT in the packed manifest; activates once the closure is materialized", async () => {
    const src = path.join(await tempDir("bse-closure-"), "pkg");
    await writeFixture(src, CLOSURE_MANIFEST, SOURCE_SHAPE_FILES);

    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("bundled");
    expect(result.dependencyMode).toBe("closure");
    expect(result.declaredDependencies).toEqual(["fixture-dep"]);
    expect(result.prunedDependencies).toEqual([]); // NOTHING pruned in closure mode

    // The packed manifest KEEPS the declarations (the signed-plan basis) and
    // still satisfies the built-artifacts contract (self-check ran).
    const packed = JSON.parse(await readFile(path.join(result.packDir, "package.json"), "utf8"));
    expect(packed.cinatra.serverEntry).toBe("./register.mjs");
    expect(packed.dependencies).toEqual({ "fixture-dep": "1.0.0" });
    expect(packed.files).toContain("register.mjs");

    // The bundle did NOT inline the declared dep — the import survives as a
    // real external import statement.
    const bundle = await readFile(path.join(result.packDir, "register.mjs"), "utf8");
    expect(bundle).toMatch(/from\s*"fixture-dep"/);
    expect(bundle).not.toContain("dep-inlined");

    // Simulate the host materializing the signed plan: place the library at
    // its node_modules path next to the entry — plain Node file:// resolution
    // then activates the bundle with ZERO loader plan-knowledge.
    const nm = path.join(result.packDir, "node_modules", "fixture-dep");
    await mkdir(nm, { recursive: true });
    await writeFile(path.join(nm, "package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.js" }));
    await writeFile(path.join(nm, "index.js"), 'exports.dep = "dep-from-closure";\n');
    const mod = await import(path.join(result.packDir, "register.mjs"));
    const lines: string[] = [];
    mod.register({ logger: { info: (msg: string) => lines.push(msg) } });
    expect(lines).toEqual(["built dep-from-closure"]);
  });

  it("closure + already-importable entry = PASSTHROUGH + residual validation (never re-bundled)", async () => {
    const src = path.join(await tempDir("bse-closure-pass-"), "pkg");
    const manifest: FixtureManifest = {
      name: "@cinatra-test/closure-prebuilt",
      version: "0.0.1",
      dependencies: { "fixture-dep": "1.0.0" },
      cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" },
    };
    const entry =
      'import { createHash } from "node:crypto";\nimport { dep } from "fixture-dep";\n' +
      "export function register(ctx) { ctx.logger.info(`${typeof createHash} ${dep}`); }\n";
    await writeFixture(src, manifest, { "register.mjs": entry });
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("passthrough");
    expect(result.dependencyMode).toBe("closure");
    // verbatim: manifest AND entry byte-identical to the source tree.
    expect(await readFile(path.join(result.packDir, "package.json"), "utf8")).toBe(
      await readFile(path.join(src, "package.json"), "utf8"),
    );
    expect(await readFile(path.join(result.packDir, "register.mjs"), "utf8")).toBe(entry);
  });

  it("closure passthrough REFUSES an UNDECLARED bare import (must be builtin or declared dep)", async () => {
    const src = path.join(await tempDir("bse-closure-undeclared-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", dependencies: { "fixture-dep": "1.0.0" }, cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" } },
      { "register.mjs": 'import { x } from "left-pad";\nexport function register() { void x; }\n' },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /imports "left-pad" at runtime, which is neither a node builtin nor a declared runtime dependency/,
    );
  });

  it("closure passthrough REFUSES a host ABI peer import (unchanged hazard class)", async () => {
    const src = path.join(await tempDir("bse-closure-peer-pass-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" } },
      { "register.mjs": 'import { recordFromManifest } from "@cinatra-ai/sdk-extensions";\nexport function register() { recordFromManifest("x", "y"); }\n' },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /imports host ABI peer "@cinatra-ai\/sdk-extensions" at runtime/,
    );
  });

  it("closure BUNDLE still REFUSES a residual host ABI peer value import", async () => {
    const src = path.join(await tempDir("bse-closure-peer-bundle-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", exports: { "./register": "./src/register.ts" }, dependencies: {}, cinatra: { kind: "connector", serverEntry: "./register", dependencyMode: "closure" } },
      {
        "src/register.ts":
          'import { recordFromManifest } from "@cinatra-ai/sdk-extensions";\n' +
          "export function register(): void { recordFromManifest('x', 'y'); }\n",
      },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /imports host ABI peer "@cinatra-ai\/sdk-extensions" at runtime/,
    );
  });

  it("closure REFUSES a host ABI peer declared in dependencies (never a closure library)", async () => {
    const src = path.join(await tempDir("bse-closure-peer-dep-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", dependencies: { "@cinatra-ai/sdk-extensions": "*" }, cinatra: { kind: "connector", dependencyMode: "closure" } },
      {},
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /host ABI peer\(s\) declared in "dependencies"/,
    );
  });

  it("closure + NO serverEntry is legal: verbatim copy, declarations intact", async () => {
    const src = path.join(await tempDir("bse-closure-none-"), "pkg");
    await writeFixture(
      src,
      { name: "@cinatra-test/closure-agent", version: "0.0.1", dependencies: { "fixture-dep": "1.0.0" }, cinatra: { kind: "agent", dependencyMode: "closure" } },
      { "cinatra/agent.yaml": "name: fixture\n" },
    );
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("none");
    expect(result.dependencyMode).toBe("closure");
    expect(result.declaredDependencies).toEqual(["fixture-dep"]);
    const packed = JSON.parse(await readFile(path.join(result.packDir, "package.json"), "utf8"));
    expect(packed.dependencies).toEqual({ "fixture-dep": "1.0.0" });
  });

  it("an EXPLICIT inline declaration behaves exactly like the absent default (prunes)", async () => {
    const src = path.join(await tempDir("bse-inline-explicit-"), "pkg");
    await writeFixture(
      src,
      { ...SOURCE_SHAPE_MANIFEST, cinatra: { ...(SOURCE_SHAPE_MANIFEST.cinatra as Record<string, unknown>), dependencyMode: "inline" } },
      SOURCE_SHAPE_FILES,
    );
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("bundled");
    expect(result.dependencyMode).toBe("inline");
    expect(result.prunedDependencies).toEqual(["fixture-dep"]);
    const packed = JSON.parse(await readFile(path.join(result.packDir, "package.json"), "utf8"));
    expect(packed.dependencies).toBeUndefined();
  });

  it("REFUSES an unsupported manifest dependencyMode loudly", async () => {
    const src = path.join(await tempDir("bse-badmode-"), "pkg");
    await writeFixture(src, { name: "x", version: "0.0.1", cinatra: { kind: "agent", dependencyMode: "bundle-everything" } }, {});
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(/dependencyMode "bundle-everything" is not a/);
  });

  it("the CLI --mode override (tests only) drives closure mode end to end", async () => {
    const src = path.join(await tempDir("bse-cli-mode-"), "pkg");
    await writeFixture(src, SOURCE_SHAPE_MANIFEST, SOURCE_SHAPE_FILES); // NO dependencyMode in the manifest
    const out = path.join(await tempDir("bse-cli-mode-out-"), "package");
    const stdout = execFileSync(process.execPath, [BUILDER_CLI, src, "--out", out, "--mode", "closure", "--json"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    const result = JSON.parse(stdout);
    expect(result.dependencyMode).toBe("closure");
    const packed = JSON.parse(await readFile(path.join(out, "package.json"), "utf8"));
    expect(packed.dependencies).toEqual({ "fixture-dep": "1.0.0" });

    // an unsupported --mode fails loudly
    expect(() =>
      execFileSync(process.execPath, [BUILDER_CLI, src, "--mode", "clozure"], { encoding: "utf8", cwd: REPO_ROOT }),
    ).toThrow();
  });

  it("a closure-mode tarball is FAIL-CLOSED at install until the relaxed gate ships (today's bundled-deps gate refuses it)", async () => {
    const root = await tempDir("bse-closure-failclosed-");
    const src = path.join(root, "package");
    await writeFixture(src, CLOSURE_MANIFEST, SOURCE_SHAPE_FILES);
    const built = await buildServerEntryPack({ packageDir: src, outDir: path.join(root, "built", "package") });
    expect(built.dependencyMode).toBe("closure");
    const staging = path.join(root, "tar");
    await mkdir(staging, { recursive: true });
    const out = path.join(staging, "pkg.tgz");
    await tar.c({ gzip: true, cwd: path.dirname(built.packDir), file: out }, [path.basename(built.packDir)]);
    const bytes = await readFile(out);
    await expect(
      materializePackageToStore(
        {
          packageName: CLOSURE_MANIFEST.name as string,
          version: "0.0.1",
          expectedIntegrity: sriForBytes(bytes, "sha512"),
          registryUrl: "https://registry.cinatra.ai",
          storeRoot: path.join(root, "store"),
        },
        { fetchTarball: async () => ({ bytes, integrity: sriForBytes(bytes, "sha512") }), now: () => "2026-06-12T00:00:00.000Z" },
      ),
    ).rejects.toThrow(/runtime dependencies are not bundled in the tarball/);
  });
});

// ---------------------------------------------------------------------------
// Review-round fail-closed pins.
// ---------------------------------------------------------------------------

describe("closure mode — review r0 refusal pins", () => {
  it("F1: a SELF-REFERENCED file cannot smuggle a host peer past the passthrough scan (traced, not allowed)", async () => {
    const src = path.join(await tempDir("bse-self-smuggle-"), "pkg");
    await writeFixture(
      src,
      {
        name: "@cinatra-test/self-smuggle",
        version: "0.0.1",
        exports: { "./inner": "./inner.mjs" },
        cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" },
      },
      {
        "register.mjs": 'import "@cinatra-test/self-smuggle/inner";\nexport function register() {}\n',
        "inner.mjs": 'import { recordFromManifest } from "@cinatra-ai/sdk-extensions";\nvoid recordFromManifest;\nexport {};\n',
      },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /imports host ABI peer "@cinatra-ai\/sdk-extensions" at runtime/,
    );
  });

  it("F1: a BENIGN self-reference (builtins only) passes the passthrough scan", async () => {
    const src = path.join(await tempDir("bse-self-ok-"), "pkg");
    await writeFixture(
      src,
      {
        name: "@cinatra-test/self-ok",
        version: "0.0.1",
        exports: { "./inner": "./inner.mjs" },
        cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" },
      },
      {
        "register.mjs": 'import { tag } from "@cinatra-test/self-ok/inner";\nexport function register(ctx) { ctx.logger.info(tag); }\n',
        "inner.mjs": 'import { createHash } from "node:crypto";\nexport const tag = typeof createHash;\n',
      },
    );
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("passthrough");
  });

  it("F1: an UNRESOLVABLE self-reference fails the passthrough scan loudly (never silently external)", async () => {
    const src = path.join(await tempDir("bse-self-unres-"), "pkg");
    await writeFixture(
      src,
      { name: "@cinatra-test/self-unres", version: "0.0.1", cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" } },
      { "register.mjs": 'import "@cinatra-test/self-unres/inner";\nexport function register() {}\n' },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /self-reference .* does not resolve to a safe in-package file/,
    );
  });

  it("F2: an npm ALIAS of a host ABI peer in dependencies is refused (alias smuggling)", async () => {
    const src = path.join(await tempDir("bse-alias-peer-"), "pkg");
    await writeFixture(
      src,
      {
        name: "x",
        version: "0.0.1",
        dependencies: { "sdk-alias": "npm:@cinatra-ai/sdk-extensions@^2.0.0" },
        cinatra: { kind: "connector", dependencyMode: "closure" },
      },
      {},
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /npm alias of host ABI peer "@cinatra-ai\/sdk-extensions"/,
    );
  });

  it("F2/r1: non-registry dependency specs are refused in closure mode by ALLOWLIST (plan derives from registry sources only)", async () => {
    const refused: Array<string | number> = [
      "file:../local-dep", "link:../local-dep", "workspace:*",
      "git+https://github.com/a/b.git", "github:a/b", "a/b#main",
      "https://example.com/dep.tgz",
      // r1 finding 1 — allowlist coverage: protocols a denylist would miss,
      // non-string and empty specs.
      "portal:../dep", "patch:dep@1.0.0#./p.patch", "catalog:default",
      "ssh://git@host/a/b.git",
      "", 7,
    ];
    for (const spec of refused) {
      const src = path.join(await tempDir("bse-nonreg-"), "pkg");
      await writeFixture(
        src,
        { name: "x", version: "0.0.1", dependencies: { dep: spec }, cinatra: { kind: "connector", dependencyMode: "closure" } },
        {},
      );
      await expect(buildServerEntryPack({ packageDir: src }), `spec ${JSON.stringify(spec)}`).rejects.toThrow(/non-registry spec/);
    }
    // EVERY non-peer npm: alias is refused — well-formed or not (PR-2
    // merge-safe round: cinatra-materialization-plan/v1 carries a SINGLE
    // identity per node — the node_modules placement name IS the registry
    // package name — so an aliased dependency, whose placement name differs
    // from its registry identity, is not expressible).
    for (const spec of ["npm:other-lib@^2.0.0", "npm:@scope/other-lib", "npm:ok-name@file:../x", "npm:Not A Name@^1.0.0"]) {
      const src = path.join(await tempDir("bse-alias-"), "pkg");
      await writeFixture(
        src,
        { name: "x", version: "0.0.1", dependencies: { dep: spec }, cinatra: { kind: "connector", dependencyMode: "closure" } },
        {},
      );
      await expect(buildServerEntryPack({ packageDir: src }), `spec ${JSON.stringify(spec)}`).rejects.toThrow(/npm: alias/);
    }
    // …and a plain registry range, an x-range, a union, and a tag all still pass.
    for (const spec of ["^1.0.0", "1.x", ">=1.0.0 <2", "1.0.0 || 2.0.0", "latest", "*"]) {
      const src = path.join(await tempDir("bse-reg-"), "pkg");
      await writeFixture(
        src,
        { name: "x", version: "0.0.1", dependencies: { dep: spec }, cinatra: { kind: "agent", dependencyMode: "closure" } },
        {},
      );
      const result = await buildServerEntryPack({ packageDir: src });
      tempDirs.push(path.dirname(result.packDir));
      expect(result.mode).toBe("none");
    }
  });

  it("F3: a LITERAL dynamic import IS captured by the passthrough scan (the variable-indirected form is the documented shared blind spot)", async () => {
    const src = path.join(await tempDir("bse-dynamic-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" } },
      { "register.mjs": 'export async function register() { await import("left-pad"); }\n' },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /imports "left-pad" at runtime, which is neither a node builtin nor a declared runtime dependency/,
    );
  });
});

describe("closure mode — review r2: traversal-unsafe declared-dep subpaths", () => {
  it("PASSTHROUGH refuses `dep/../undeclared` (Node resolves it outside the declared package)", async () => {
    const src = path.join(await tempDir("bse-trav-pass-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", dependencies: { "fixture-dep": "1.0.0" }, cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" } },
      { "register.mjs": 'import "fixture-dep/../left-pad/lib/index.js";\nexport function register() {}\n' },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /traversal-unsafe subpath of declared dependency "fixture-dep"/,
    );
  });

  it("BUNDLE refuses `dep/../undeclared` (the `dep/*` external wildcard matches it, the residual check kills it)", async () => {
    const src = path.join(await tempDir("bse-trav-bundle-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", exports: { "./register": "./src/register.ts" }, dependencies: { "fixture-dep": "1.0.0" }, cinatra: { kind: "connector", serverEntry: "./register", dependencyMode: "closure" } },
      { "src/register.ts": 'import "fixture-dep/../left-pad/lib/index.js";\nexport function register(): void {}\n' },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /traversal-unsafe subpath of declared dependency "fixture-dep"/,
    );
  });

  it("a CLEAN declared-dep subpath import stays allowed", async () => {
    const src = path.join(await tempDir("bse-subpath-ok-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", dependencies: { "fixture-dep": "1.0.0" }, cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" } },
      { "register.mjs": 'import "fixture-dep/lib/util.js";\nexport function register() {}\n' },
    );
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("passthrough");
  });
});

describe("closure mode — review r3: builtin recognition is EXACT", () => {
  it('refuses `fs/../left-pad` (a PACKAGE named fs with a traversing subpath, NOT a builtin)', async () => {
    const src = path.join(await tempDir("bse-fakefs-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" } },
      { "register.mjs": 'import "fs/../left-pad/lib/index.js";\nexport function register() {}\n' },
    );
    await expect(buildServerEntryPack({ packageDir: src })).rejects.toThrow(
      /imports "fs\/\.\.\/left-pad\/lib\/index\.js" at runtime, which is neither a node builtin/,
    );
  });

  it("still allows real builtins incl. subpath + node:-prefixed forms", async () => {
    const src = path.join(await tempDir("bse-realfs-"), "pkg");
    await writeFixture(
      src,
      { name: "x", version: "0.0.1", cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" } },
      { "register.mjs": 'import { readFile } from "fs/promises";\nimport { createHash } from "node:crypto";\nexport function register(ctx) { ctx.logger.info(`${typeof readFile}${typeof createHash}`); }\n' },
    );
    const result = await buildServerEntryPack({ packageDir: src });
    tempDirs.push(path.dirname(result.packDir));
    expect(result.mode).toBe("passthrough");
  });
});
