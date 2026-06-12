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
