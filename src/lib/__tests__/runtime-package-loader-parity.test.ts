import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import {
  runRuntimePackageActivation,
  runStaticBundleActivation,
  discoverPackageStoreRecords,
  recordFromManifest,
  type PackageStoreFs,
} from "@cinatra-ai/sdk-extensions";
import { sriForBytes } from "@/lib/extension-package-store-core";
import {
  materializePackageToStore,
  verifyMaterializedPackageIntegrity,
  assertNoHostPeerValueImports,
  type MaterializedPackage,
} from "@/lib/extension-package-store";
import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import { generateExtensionSigningKeyPair, signExtension } from "@/lib/extension-signature";

// A real ESM register module imported via file:// from the materialized store.
// Uses only the AMBIENT `logger` port so it activates against the real host ctx.
const REGISTER_MJS = `
export function register(ctx) {
  ctx.logger.info("parity-fixture registered");
}
`;

const PKG = "@cinatra-ai/parity-fixture";
const VERSION = "0.0.1";
const REGISTRY = "https://registry.cinatra.ai";

const realFs: PackageStoreFs = {
  exists: async (p) => { try { await stat(p); return true; } catch { return false; } },
  isDirectory: async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } },
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
};

let workDir: string;
let tarballBytes: Buffer;
let integrity: string;

async function buildFixtureTarball(): Promise<Buffer> {
  const src = path.join(workDir, "src", "package");
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, "package.json"),
    JSON.stringify({
      name: PKG,
      version: VERSION,
      cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: [], sdkAbiRange: "^2" },
    }),
  );
  await writeFile(path.join(src, "register.mjs"), REGISTER_MJS);
  const out = path.join(workDir, "fixture.tgz");
  await tar.c({ gzip: true, cwd: path.join(workDir, "src"), file: out }, ["package"]);
  return readFile(out);
}

async function materializeInto(storeRoot: string): Promise<MaterializedPackage> {
  return materializePackageToStore(
    { packageName: PKG, version: VERSION, expectedIntegrity: integrity, registryUrl: REGISTRY, storeRoot },
    { fetchTarball: async () => ({ bytes: tarballBytes, integrity }), now: () => "2026-06-03T00:00:00.000Z" },
  );
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-parity-"));
  tarballBytes = await buildFixtureTarball();
  integrity = sriForBytes(tarballBytes, "sha512");
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("RuntimePackageLoader materialize → discover → verify (the loader contract)", () => {
  it("materializes a verified package into the digest-pinned store and re-verifies against a trusted anchor", async () => {
    const storeRoot = path.join(workDir, "store-1");
    const result = await materializeInto(storeRoot);
    expect(result.reused).toBe(false);
    expect(result.storeDir).toContain("cinatra-ai__parity-fixture@0.0.1");
    expect(result.contentHash).toMatch(/^[a-f0-9]{128}$/);

    const records = await discoverPackageStoreRecords(storeRoot, realFs);
    expect(records).toHaveLength(1);
    expect(records[0].packageName).toBe(PKG);
    expect(records[0].declaredDigest).toBe(result.digest);
    expect(records[0].serverEntry).toBe("./register.mjs");

    // verifies against the TRUSTED anchor (not just the in-store sidecar)
    expect(
      await verifyMaterializedPackageIntegrity(records[0], {
        trustedIntegrity: result.integrity,
        trustedContentHash: result.contentHash,
      }),
    ).toBe(true);

    // second materialize with the same bytes is idempotent
    const again = await materializeInto(storeRoot);
    expect(again.reused).toBe(true);
    expect(again.storeDir).toBe(result.storeDir);
  });

  it("refuses to materialize on an SRI mismatch (D2 — verify before write)", async () => {
    const storeRoot = path.join(workDir, "store-bad");
    await expect(
      materializePackageToStore(
        { packageName: PKG, version: VERSION, expectedIntegrity: sriForBytes(Buffer.from("other"), "sha512"), storeRoot },
        { fetchTarball: async () => ({ bytes: tarballBytes, integrity }) },
      ),
    ).rejects.toThrow(/integrity mismatch/);
  });

  it("verifyIntegrity returns FALSE after on-disk tampering + on a missing tarball (fail closed)", async () => {
    const storeRoot = path.join(workDir, "store-tamper");
    const result = await materializeInto(storeRoot);
    const records = await discoverPackageStoreRecords(storeRoot, realFs);
    const anchor = { trustedIntegrity: result.integrity, trustedContentHash: result.contentHash };
    expect(await verifyMaterializedPackageIntegrity(records[0], anchor)).toBe(true);

    // tamper a file → content hash mismatch
    await writeFile(path.join(result.storeDir, "register.mjs"), REGISTER_MJS + "\n// injected");
    expect(await verifyMaterializedPackageIntegrity(records[0], anchor)).toBe(false);

    // remove the persisted tarball → fail closed even if files look fine
    await rm(`${result.storeDir}.tgz`, { force: true });
    expect(await verifyMaterializedPackageIntegrity(records[0], anchor)).toBe(false);
  });

  it("refuses an extracted tarball containing a symlink (escape vector)", async () => {
    const storeRoot = path.join(workDir, "store-symlink");
    const src = path.join(workDir, "evil", "package");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "package.json"), JSON.stringify({ name: "@cinatra-ai/evil", version: "0.0.1", cinatra: { serverEntry: "./register.mjs" } }));
    await writeFile(path.join(src, "dist.mjs"), "export function register(){}");
    const { symlink } = await import("node:fs/promises");
    await symlink("dist.mjs", path.join(src, "register.mjs"));
    const evilTgz = path.join(workDir, "evil.tgz");
    await tar.c({ gzip: true, cwd: path.join(workDir, "evil"), file: evilTgz }, ["package"]);
    const evilBytes = await readFile(evilTgz);
    await expect(
      materializePackageToStore(
        { packageName: "@cinatra-ai/evil", version: "0.0.1", expectedIntegrity: sriForBytes(evilBytes, "sha512"), storeRoot },
        { fetchTarball: async () => ({ bytes: evilBytes, integrity: sriForBytes(evilBytes, "sha512") }) },
      ),
    ).rejects.toThrow(/symlink/);
  });
});

describe("materialize-time host-peer value-import gate (fail-closed)", () => {
  // Build + materialize a fixture with arbitrary files. `exportsMap`/`serverEntry`
  // let a test exercise both the direct-path (`./register.ts`) and exports-key
  // (`./register` → `exports["./register"]`) serverEntry resolution forms.
  async function materializeFixture(opts: {
    storeRoot: string;
    files: Record<string, string>;
    serverEntry: string | null;
    exportsMap?: Record<string, string>;
  }): Promise<MaterializedPackage> {
    const srcRoot = await mkdtemp(path.join(tmpdir(), "cinatra-gate-src-"));
    const pkgDir = path.join(srcRoot, "package");
    for (const [rel, contents] of Object.entries(opts.files)) {
      const abs = path.join(pkgDir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, contents);
    }
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@cinatra-ai/gate-fixture",
        version: "0.0.1",
        ...(opts.exportsMap ? { exports: opts.exportsMap } : {}),
        cinatra: { kind: "connector", serverEntry: opts.serverEntry, requestedHostPorts: [], sdkAbiRange: "^2" },
      }),
    );
    const tgz = path.join(srcRoot, "fixture.tgz");
    await tar.c({ gzip: true, cwd: srcRoot, file: tgz }, ["package"]);
    const bytes = await readFile(tgz);
    const sri = sriForBytes(bytes, "sha512");
    try {
      return await materializePackageToStore(
        { packageName: "@cinatra-ai/gate-fixture", version: "0.0.1", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: opts.storeRoot },
        { fetchTarball: async () => ({ bytes, integrity: sri }), now: () => "2026-06-03T00:00:00.000Z" },
      );
    } finally {
      await rm(srcRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  it("REJECTS a serverEntry that value-imports a host peer directly", async () => {
    const storeRoot = path.join(workDir, "store-gate-direct");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register.ts",
        files: {
          "register.ts": `import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";\nexport function register() { requireExtensionAction(); }`,
        },
      }),
    ).rejects.toThrow(/host-internal SDK peer @cinatra-ai\/sdk-extensions at VALUE position/);
  });

  it("REJECTS when a transitively-imported file value-imports a host peer", async () => {
    const storeRoot = path.join(workDir, "store-gate-transitive");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register.ts",
        files: {
          "register.ts": `import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";\nimport { helper } from "./actions";\nexport function register(ctx: ExtensionHostContext) { helper(); }`,
          "actions.ts": `import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";\nexport function helper() { requireExtensionAction(); }`,
        },
      }),
    ).rejects.toThrow(/actions\.ts/);
  });

  it("REJECTS a mixed `{ type X, valueY }` brace import in the graph", async () => {
    const storeRoot = path.join(workDir, "store-gate-mixed");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register.ts",
        files: {
          "register.ts": `import { type ExtensionHostContext, requireExtensionAction } from "@cinatra-ai/sdk-extensions";\nexport function register(ctx: ExtensionHostContext) { requireExtensionAction(); }`,
        },
      }),
    ).rejects.toThrow(/requireExtensionAction/);
  });

  it("MATERIALIZES a serverEntry whose graph imports the host peer TYPE-ONLY", async () => {
    const storeRoot = path.join(workDir, "store-gate-typeonly");
    const result = await materializeFixture({
      storeRoot,
      serverEntry: "./register.ts",
      files: {
        "register.ts": `import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";\nimport { run } from "./impl";\nexport function register(ctx: ExtensionHostContext) { run(ctx); }`,
        "impl.ts": `import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";\nexport function run(ctx: ExtensionHostContext) { ctx.logger.info("ok"); }`,
      },
    });
    expect(result.reused).toBe(false);
    expect(result.storeDir).toContain("gate-fixture");
  });

  it("resolves an exports-key serverEntry (`./register` → exports map) before scanning", async () => {
    const storeRoot = path.join(workDir, "store-gate-exports");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register",
        exportsMap: { ".": "./src/index.ts", "./register": "./src/register.ts" },
        files: {
          "src/register.ts": `import { registerCrmProvider } from "@cinatra-ai/sdk-extensions";\nexport function register() { registerCrmProvider(); }`,
        },
      }),
    ).rejects.toThrow(/@cinatra-ai\/sdk-extensions at VALUE position/);
  });

  it("does not scan when serverEntry is null (nothing to gate)", async () => {
    const storeRoot = path.join(workDir, "store-gate-noentry");
    const result = await materializeFixture({
      storeRoot,
      serverEntry: null,
      files: {
        // an actions.ts with a value import that is NOT reachable from any
        // serverEntry must NOT block materialization.
        "actions.ts": `import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";\nexport function helper() { requireExtensionAction(); }`,
      },
    });
    expect(result.reused).toBe(false);
  });

  it("does NOT follow a `import type` relative edge (type-only edges have no runtime graph presence)", async () => {
    // register.ts imports `./contract` TYPE-ONLY. contract.ts value-imports a
    // host peer, but a type-only edge is erased at compile and is NOT in the
    // runtime graph the file:// loader follows — so the trace must skip it and
    // materialize cleanly (the false-positive fix).
    const storeRoot = path.join(workDir, "store-gate-typeedge");
    const result = await materializeFixture({
      storeRoot,
      serverEntry: "./register.ts",
      files: {
        "register.ts": `import type { Thing } from "./contract";\nexport function register(): Thing | null { return null; }`,
        "contract.ts": `import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";\nexport type Thing = ReturnType<typeof requireExtensionAction>;`,
      },
    });
    expect(result.reused).toBe(false);
  });

  it("DOES follow a value relative edge even when a type edge to the same file precedes it", async () => {
    // register.ts has BOTH `import type { T } from "./impl"` and a value
    // `import { run } from "./impl"`. impl.ts value-imports a host peer → reject
    // (the value edge IS followed; the type edge does not suppress it).
    const storeRoot = path.join(workDir, "store-gate-mixededge");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register.ts",
        files: {
          "register.ts": `import type { T } from "./impl";\nimport { run } from "./impl";\nexport function register(): T | void { run(); }`,
          "impl.ts": `import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";\nexport function run() { requireExtensionAction(); }\nexport type T = string;`,
        },
      }),
    ).rejects.toThrow(/impl\.ts/);
  });

  it("REJECTS a value edge through the package's OWN name subpath (self-reference resolved via exports)", async () => {
    // register.ts value-imports `@cinatra-ai/gate-fixture/internal` — a Node
    // self-reference, NOT a third-party dep — whose subpath resolves through the
    // exports map to ./src/internal.ts which value-imports a host peer. The trace
    // must resolve the self-subpath and follow it (the false-negative fix), NOT
    // stop at it as if it were third-party.
    const storeRoot = path.join(workDir, "store-gate-selfref");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register",
        exportsMap: {
          ".": "./src/index.ts",
          "./register": "./src/register.ts",
          "./internal": "./src/internal.ts",
        },
        files: {
          "src/register.ts": `import type { Ctx } from "@cinatra-ai/sdk-extensions";\nimport { run } from "@cinatra-ai/gate-fixture/internal";\nexport function register(ctx: Ctx) { run(); }`,
          "src/internal.ts": `import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";\nexport function run() { requireExtensionAction(); }`,
        },
      }),
    ).rejects.toThrow(/internal\.ts/);
  });

  it("does NOT follow a TRUE third-party bare specifier (only the package's own name self-resolves)", async () => {
    // register.ts value-imports `other-pkg/internal` — a third-party specifier,
    // NOT the package's own name — so the trace must stop at it (bundled deps are
    // out of scope) and materialize cleanly even though a same-named file exists
    // under node_modules.
    const storeRoot = path.join(workDir, "store-gate-thirdparty");
    const result = await materializeFixture({
      storeRoot,
      serverEntry: "./register.ts",
      files: {
        "register.ts": `import type { Ctx } from "@cinatra-ai/sdk-extensions";\nimport { run } from "other-pkg/internal";\nexport function register(ctx: Ctx) { run(); }`,
        "node_modules/other-pkg/internal.js": `const sdk = require("@cinatra-ai/sdk-extensions");\nexports.run = () => sdk;`,
      },
    });
    expect(result.reused).toBe(false);
  });

  it("FAILS LOUD when a file that resolved INTO the graph cannot be read (vs a silent skip for no/missing serverEntry)", async () => {
    // A "no serverEntry" or "serverEntry points at a missing file" case stays a
    // silent skip. But a file that successfully entered the graph and then fails
    // to read must THROW — otherwise a hazardous import could
    // be silently deferred to a later loader failure. We craft an extracted dir
    // by hand, make an in-graph file unreadable, and call the exported gate.
    const extractDir = await mkdtemp(path.join(tmpdir(), "cinatra-readfail-"));
    const { chmod } = await import("node:fs/promises");
    try {
      const pkgJson = { name: "@cinatra-ai/rf", version: "0.0.1", cinatra: { serverEntry: "./register.ts" } };
      await writeFile(path.join(extractDir, "package.json"), JSON.stringify(pkgJson));
      await writeFile(
        path.join(extractDir, "register.ts"),
        `import type { Ctx } from "@cinatra-ai/sdk-extensions";\nimport { helper } from "./helper";\nexport function register(ctx: Ctx) { helper(); }`,
      );
      const helperFile = path.join(extractDir, "helper.ts");
      await writeFile(helperFile, `export function helper() {}`);
      await chmod(helperFile, 0o000); // unreadable → readFile throws EACCES
      // Skip the assertion if the test runs as root (chmod 000 is a no-op there).
      let readable = true;
      try {
        await readFile(helperFile, "utf8");
      } catch {
        readable = false;
      }
      if (!readable) {
        await expect(assertNoHostPeerValueImports(extractDir, pkgJson, "@cinatra-ai/rf")).rejects.toThrow(
          /cannot be read/,
        );
      }
    } finally {
      const helperFile = path.join(extractDir, "helper.ts");
      await chmod(helperFile, 0o644).catch(() => undefined);
      await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("ignores a value import inside node_modules (bundled third-party deps are out of scope)", async () => {
    const storeRoot = path.join(workDir, "store-gate-nm");
    const result = await materializeFixture({
      storeRoot,
      serverEntry: "./register.ts",
      files: {
        "register.ts": `import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";\nimport { dep } from "some-dep";\nexport function register(ctx: ExtensionHostContext) { dep(); }`,
        // a bundled dep that itself value-imports a host peer is NOT the
        // extension's own source — the scanner must not follow into node_modules.
        "node_modules/some-dep/package.json": JSON.stringify({ name: "some-dep", version: "1.0.0", main: "index.js" }),
        "node_modules/some-dep/index.js": `const sdk = require("@cinatra-ai/sdk-extensions");\nexports.dep = () => sdk;`,
      },
    });
    expect(result.reused).toBe(false);
  });

  // ---- parser-only edge cases, proven
  //      end-to-end through the real materialize pipeline ---------------------
  it("REJECTS a dynamic `import(\"<peer>\")` inside a template-literal interpolation", async () => {
    const storeRoot = path.join(workDir, "store-gate-tmpl");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register.ts",
        files: {
          "register.ts":
            "export async function register() { return `${await import(\"@cinatra-ai/sdk-extensions\")}`; }",
        },
      }),
    ).rejects.toThrow(/@cinatra-ai\/sdk-extensions at VALUE position/);
  });

  it("REJECTS `import { type as t }` (a value import of an export literally named `type`)", async () => {
    const storeRoot = path.join(workDir, "store-gate-typeas");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register.ts",
        files: {
          "register.ts": `import { type as t } from "@cinatra-ai/sdk-extensions";\nexport function register() { return t; }`,
        },
      }),
    ).rejects.toThrow(/@cinatra-ai\/sdk-extensions at VALUE position/);
  });

  it("MATERIALIZES cleanly when the only host-peer mention is inside a regex literal", async () => {
    const storeRoot = path.join(workDir, "store-gate-regex");
    const result = await materializeFixture({
      storeRoot,
      serverEntry: "./register.ts",
      files: {
        "register.ts":
          `import type { Ctx } from "@cinatra-ai/sdk-extensions";\n` +
          `const r = /import { x } from "@cinatra-ai\\/sdk-extensions"/;\n` +
          `export function register(ctx: Ctx) { return r; }`,
      },
    });
    expect(result.reused).toBe(false);
  });

  // ---- further edge cases: real-filename ScriptKind + module.require ---------
  it("REJECTS a `.tsx` graph file whose JSX embeds a value `import(\"<peer>\")` (real-filename ScriptKind)", async () => {
    // The serverEntry is a `.tsx` file; its JSX embeds a dynamic
    // `import("<peer>")`. The scanner MUST thread the real path so the parser
    // uses TSX ScriptKind — otherwise the JSX fails to parse and the value
    // import is silently missed (a fail-open gap).
    const storeRoot = path.join(workDir, "store-gate-tsx");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register.tsx",
        files: {
          "register.tsx":
            `export function Register() { return <div>{import("@cinatra-ai/sdk-extensions")}</div>; }`,
        },
      }),
    ).rejects.toThrow(/@cinatra-ai\/sdk-extensions at VALUE position/);
  });

  it("REJECTS a `module.require(\"<peer>\")` member call in the graph", async () => {
    const storeRoot = path.join(workDir, "store-gate-modreq");
    await expect(
      materializeFixture({
        storeRoot,
        serverEntry: "./register.ts",
        files: {
          "register.ts":
            `export function register() { return module.require("@cinatra-ai/sdk-extensions"); }`,
        },
      }),
    ).rejects.toThrow(/@cinatra-ai\/sdk-extensions at VALUE position/);
  });
});

describe("RuntimePackageLoader host wrapper — trust gate + real activation (the loader-parity contract, D3/D10)", () => {
  it("FAILS CLOSED with no trusted install-record resolver (deny-all default)", async () => {
    const storeRoot = path.join(workDir, "store-deny");
    await materializeInto(storeRoot);
    const results = await loadRuntimePackageExtensions(storeRoot); // no resolver
    expect(results).toEqual([]);
  });

  it("activates a first-party package end-to-end when a trusted anchor resolves", async () => {
    const storeRoot = path.join(workDir, "store-trust");
    const mat = await materializeInto(storeRoot);
    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async (name) =>
        name === PKG
          ? { integrity: mat.integrity, contentHash: mat.contentHash, registryUrl: REGISTRY, trustDecision: true }
          : null,
    });
    const registered = results.find((r) => r.packageName === PKG);
    expect(registered?.status).toBe("registered");
  });

  it("refuses activation from a non-allowlisted registry even with valid integrity (D3)", async () => {
    const storeRoot = path.join(workDir, "store-evilreg");
    const mat = await materializeInto(storeRoot);
    const results = await loadRuntimePackageExtensions(storeRoot, {
      // valid integrity/contentHash so the integrity gate passes — the registry
      // allowlist is what must refuse activation.
      resolveInstallAnchor: async () => ({ integrity: mat.integrity, contentHash: mat.contentHash, registryUrl: "https://evil.example", trustDecision: true }),
    });
    expect(results.find((r) => r.status === "registered")).toBeUndefined();
  });

  it("refuses activation when trust is explicitly revoked (D3)", async () => {
    const storeRoot = path.join(workDir, "store-revoked");
    const mat = await materializeInto(storeRoot);
    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async () => ({ integrity: mat.integrity, contentHash: mat.contentHash, registryUrl: REGISTRY, trustDecision: false }),
    });
    expect(results.find((r) => r.status === "registered")).toBeUndefined();
  });
});

describe("dual-loader PARITY: runtime record + activation == static (the loader-parity contract)", () => {
  it("the runtime-discovered record matches recordFromManifest, and both drivers activate identically", async () => {
    const storeRoot = path.join(workDir, "store-parity");
    await materializeInto(storeRoot);
    const records = await discoverPackageStoreRecords(storeRoot, realFs);
    const runtimeRec = records[0];

    // The SAME normalizer the loaders share, applied to the materialized
    // package.json, must reproduce the discovered record's normalized fields.
    const pkgJsonText = await readFile(path.join(runtimeRec.storeDir, "package.json"), "utf8");
    const reNormalized = recordFromManifest(runtimeRec.storeDir, pkgJsonText, runtimeRec.declaredDigest);
    expect(reNormalized).toEqual(runtimeRec);
    expect(runtimeRec.serverEntry).toBe("./register.mjs");
    expect(runtimeRec.requestedHostPorts).toEqual([]);
    expect(runtimeRec.sdkAbiRange).toBe("^2");

    const abs = path.join(runtimeRec.storeDir, "register.mjs");
    const runtimeRecorded: string[] = [];
    const runtimeResults = await runRuntimePackageActivation(storeRoot, {
      fs: realFs,
      importModule: (p) => import(pathToFileURL(p).href),
      makeContext: ((name: string) => ({ logger: { info: () => runtimeRecorded.push(name) } }) as never),
      verifyIntegrity: async () => true,
    });

    const staticRecorded: string[] = [];
    const staticResults = await runStaticBundleActivation(
      [{ packageName: runtimeRec.packageName, serverEntry: runtimeRec.serverEntry, requestedHostPorts: runtimeRec.requestedHostPorts, sdkAbiRange: runtimeRec.sdkAbiRange }],
      {
        importServerEntry: () => import(pathToFileURL(abs).href),
        makeContext: ((name: string) => ({ logger: { info: () => staticRecorded.push(name) } }) as never),
        abiCompatible: () => true,
      },
    );

    const norm = (rs: { packageName: string; status: string }[]) => rs.map((r) => `${r.packageName}:${r.status}`).sort();
    expect(norm(runtimeResults)).toEqual(norm(staticResults));
    expect(runtimeResults.some((r) => r.status === "registered")).toBe(true);
    expect(runtimeRecorded).toEqual([PKG]);
    expect(runtimeRecorded).toEqual(staticRecorded);
  });
});

// Build + materialize a self-contained fixture under `storeRoot` with a chosen
// package name and (optionally) a declared `cinatra.migrations[]`. Mirrors
// buildFixtureTarball but lets each capability-split case vary the manifest.
async function materializeNamedFixture(opts: {
  storeRoot: string;
  packageName: string;
  declareMigration?: boolean;
}): Promise<MaterializedPackage> {
  const srcRoot = await mkdtemp(path.join(tmpdir(), "cinatra-capsplit-src-"));
  const pkgDir = path.join(srcRoot, "package");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: opts.packageName,
      version: VERSION,
      cinatra: {
        kind: "connector",
        serverEntry: "./register.mjs",
        requestedHostPorts: [],
        sdkAbiRange: "^2",
        ...(opts.declareMigration
          ? { migrations: [{ id: "0001-init", path: "./migrations/0001-init.json" }] }
          : {}),
      },
    }),
  );
  await writeFile(path.join(pkgDir, "register.mjs"), REGISTER_MJS);
  if (opts.declareMigration) {
    // The migration BODY never runs in these tests — a bootstrap-trusted package
    // that DECLARES a migration is refused for import BEFORE any DDL is applied
    // (the capability split). The file only needs to exist for materialization.
    await mkdir(path.join(pkgDir, "migrations"), { recursive: true });
    await writeFile(
      path.join(pkgDir, "migrations", "0001-init.json"),
      JSON.stringify({ id: "0001-init", up: [] }),
    );
  }
  const tgz = path.join(srcRoot, "fixture.tgz");
  await tar.c({ gzip: true, cwd: srcRoot, file: tgz }, ["package"]);
  const bytes = await readFile(tgz);
  const sri = sriForBytes(bytes, "sha512");
  try {
    return await materializePackageToStore(
      { packageName: opts.packageName, version: VERSION, expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: opts.storeRoot },
      { fetchTarball: async () => ({ bytes, integrity: sri }), now: () => "2026-06-03T00:00:00.000Z" },
    );
  } finally {
    await rm(srcRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("RuntimePackageLoader capability split — DDL/import gated on the trust tier", () => {
  afterEach(() => {
    delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  });

  it("REFUSES a BOOTSTRAP-trusted package (no signature) that DECLARES a host migration — DDL requires a verified signature", async () => {
    // No signing key configured → resolveSignatureVerdict() returns undefined →
    // an integrity-verified, persisted-decision, trusted-host package classifies
    // `trusted-bootstrap`. The loader must REFUSE it for in-process import because
    // it declares host DDL (its owned tables would never be created — running DDL
    // is a privileged capability gated on a verified signature).
    const storeRoot = path.join(workDir, "store-capsplit-bootstrap-ddl");
    const mat = await materializeNamedFixture({
      storeRoot,
      packageName: "@example-vendor/needs-ddl",
      declareMigration: true,
    });
    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async (name) =>
        name === "@example-vendor/needs-ddl"
          ? { integrity: mat.integrity, contentHash: mat.contentHash, registryUrl: REGISTRY, trustDecision: true, version: VERSION }
          : null,
    });
    // refused for import → never registered (no DDL ran; the in-process import is denied).
    expect(results.find((r) => r.status === "registered")).toBeUndefined();
  });

  it("ACTIVATES a BOOTSTRAP-trusted package that declares NO migration (import-only is allowed; the split only gates privileged capability)", async () => {
    const storeRoot = path.join(workDir, "store-capsplit-bootstrap-noddl");
    const mat = await materializeNamedFixture({
      storeRoot,
      packageName: "@example-vendor/import-only",
      declareMigration: false,
    });
    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async (name) =>
        name === "@example-vendor/import-only"
          ? { integrity: mat.integrity, contentHash: mat.contentHash, registryUrl: REGISTRY, trustDecision: true, version: VERSION }
          : null,
    });
    expect(results.find((r) => r.packageName === "@example-vendor/import-only")?.status).toBe("registered");
  });

  it("ACTIVATES a TRUSTED-SIGNED package (valid signature, no migration) — the vendor-agnostic root reaches the loader's trusted-signed tier", async () => {
    // A valid Ed25519 signature over {packageName, version, integrity} verified
    // against the host-configured key → `trusted-signed`. With no declared
    // migration the loader's DDL pass is a no-op, so the package activates without
    // any DB I/O while proving the SIGNED path is wired end-to-end through the
    // loader's classify call (not just the install pipeline).
    const storeRoot = path.join(workDir, "store-capsplit-signed");
    const mat = await materializeNamedFixture({
      storeRoot,
      packageName: "@example-vendor/signed",
      declareMigration: false,
    });
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension(
      { packageName: "@example-vendor/signed", version: VERSION, integrity: mat.integrity },
      kp.privateKeyPkcs8DerB64,
    );
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async (name) =>
        name === "@example-vendor/signed"
          ? {
              integrity: mat.integrity,
              contentHash: mat.contentHash,
              registryUrl: REGISTRY,
              trustDecision: true,
              version: VERSION,
              signature,
            }
          : null,
    });
    expect(results.find((r) => r.packageName === "@example-vendor/signed")?.status).toBe("registered");
  });

  it("REFUSES even a TRUSTED-SIGNED package whose signature does NOT verify (wrong key) — fail-closed", async () => {
    // Producer attests a signature but it was made with a DIFFERENT key than the
    // host trusts → signatureVerified === false → untrusted (refused), regardless
    // of integrity + persisted decision + trusted host.
    const storeRoot = path.join(workDir, "store-capsplit-wrongkey");
    const mat = await materializeNamedFixture({
      storeRoot,
      packageName: "@example-vendor/wrongkey",
      declareMigration: false,
    });
    const signerKp = generateExtensionSigningKeyPair();
    const hostKp = generateExtensionSigningKeyPair();
    const signature = signExtension(
      { packageName: "@example-vendor/wrongkey", version: VERSION, integrity: mat.integrity },
      signerKp.privateKeyPkcs8DerB64,
    );
    // host trusts a DIFFERENT key than the one that signed
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = hostKp.publicKeyDerB64;
    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async (name) =>
        name === "@example-vendor/wrongkey"
          ? {
              integrity: mat.integrity,
              contentHash: mat.contentHash,
              registryUrl: REGISTRY,
              trustDecision: true,
              version: VERSION,
              signature,
            }
          : null,
    });
    expect(results.find((r) => r.status === "registered")).toBeUndefined();
  });
});
