import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
import {
  STORE_SIDECAR_FILENAME,
  contentHashOfEntries,
  sriForBytes,
  storePackageDir,
  tarballDigestSegment,
  type ContentHashEntry,
} from "@/lib/extension-package-store-core";
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

// The unsigned bootstrap path is opt-IN now. This parity suite uses an UNSIGNED
// fixture package to exercise the loader contract / capability split, so it opts
// in by default. Signed cases set their own keys (opt-in does not downgrade a
// verified signature); REQUIRE_SIGNATURES=true cases still refuse unsigned
// packages (the two flags are independent — both must permit).
let prevAllowUnsignedParity: string | undefined;
beforeEach(() => {
  prevAllowUnsignedParity = process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
  process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = "true";
});
afterEach(() => {
  if (prevAllowUnsignedParity === undefined) delete process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP;
  else process.env.CINATRA_EXTENSION_ALLOW_UNSIGNED_BOOTSTRAP = prevAllowUnsignedParity;
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

  it("refuses to materialize on an SRI mismatch (verify before write)", async () => {
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
  //
  // NOTE (cinatra#161): a TS-source serverEntry can no longer MATERIALIZE — the
  // built-artifacts-only gate (step 4.6) refuses it AFTER this host-peer gate
  // (step 4.5). REJECTION cases still run end-to-end through the materializer
  // (4.5 throws first); gate-PASS cases over TS graphs are asserted at the gate
  // level via the exported `assertNoHostPeerValueImports` (the same call the
  // materializer makes), with `writeGateFixtureDir` below.
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

  // Write a gate-fixture dir WITHOUT materializing (for gate-PASS cases over TS
  // graphs, which the built-artifacts-only step would otherwise refuse). The
  // caller runs `assertNoHostPeerValueImports` — the exact materializer call.
  async function writeGateFixtureDir(opts: {
    files: Record<string, string>;
    serverEntry: string | null;
    exportsMap?: Record<string, string>;
  }): Promise<{ extractDir: string; pkgJson: Record<string, unknown> }> {
    const extractDir = await mkdtemp(path.join(tmpdir(), "cinatra-gate-dir-"));
    for (const [rel, contents] of Object.entries(opts.files)) {
      const abs = path.join(extractDir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, contents);
    }
    const pkgJson: Record<string, unknown> = {
      name: "@cinatra-ai/gate-fixture",
      version: "0.0.1",
      ...(opts.exportsMap ? { exports: opts.exportsMap } : {}),
      cinatra: { kind: "connector", serverEntry: opts.serverEntry, requestedHostPorts: [], sdkAbiRange: "^2" },
    };
    await writeFile(path.join(extractDir, "package.json"), JSON.stringify(pkgJson));
    return { extractDir, pkgJson };
  }

  async function expectGatePasses(opts: {
    files: Record<string, string>;
    serverEntry: string | null;
    exportsMap?: Record<string, string>;
  }): Promise<void> {
    const { extractDir, pkgJson } = await writeGateFixtureDir(opts);
    try {
      await expect(
        assertNoHostPeerValueImports(extractDir, pkgJson, "@cinatra-ai/gate-fixture"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
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

  it("PASSES the gate for a serverEntry whose graph imports the host peer TYPE-ONLY", async () => {
    await expectGatePasses({
      serverEntry: "./register.ts",
      files: {
        "register.ts": `import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";\nimport { run } from "./impl";\nexport function register(ctx: ExtensionHostContext) { run(ctx); }`,
        "impl.ts": `import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";\nexport function run(ctx: ExtensionHostContext) { ctx.logger.info("ok"); }`,
      },
    });
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
    // pass the gate cleanly (the false-positive fix).
    await expectGatePasses({
      serverEntry: "./register.ts",
      files: {
        "register.ts": `import type { Thing } from "./contract";\nexport function register(): Thing | null { return null; }`,
        "contract.ts": `import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";\nexport type Thing = ReturnType<typeof requireExtensionAction>;`,
      },
    });
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
    // out of scope) and pass the gate cleanly even though a same-named file exists
    // under node_modules.
    await expectGatePasses({
      serverEntry: "./register.ts",
      files: {
        "register.ts": `import type { Ctx } from "@cinatra-ai/sdk-extensions";\nimport { run } from "other-pkg/internal";\nexport function register(ctx: Ctx) { run(); }`,
        "node_modules/other-pkg/internal.js": `const sdk = require("@cinatra-ai/sdk-extensions");\nexports.run = () => sdk;`,
      },
    });
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
    await expectGatePasses({
      serverEntry: "./register.ts",
      files: {
        "register.ts": `import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";\nimport { dep } from "some-dep";\nexport function register(ctx: ExtensionHostContext) { dep(); }`,
        // a bundled dep that itself value-imports a host peer is NOT the
        // extension's own source — the scanner must not follow into node_modules.
        "node_modules/some-dep/package.json": JSON.stringify({ name: "some-dep", version: "1.0.0", main: "index.js" }),
        "node_modules/some-dep/index.js": `const sdk = require("@cinatra-ai/sdk-extensions");\nexports.dep = () => sdk;`,
      },
    });
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

  it("PASSES the gate when the only host-peer mention is inside a regex literal", async () => {
    await expectGatePasses({
      serverEntry: "./register.ts",
      files: {
        "register.ts":
          `import type { Ctx } from "@cinatra-ai/sdk-extensions";\n` +
          `const r = /import { x } from "@cinatra-ai\\/sdk-extensions"/;\n` +
          `export function register(ctx: Ctx) { return r; }`,
      },
    });
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

  // ---- the built-artifacts-only serverEntry gate (cinatra#161, step 4.6) ----
  // The PRIMARY refusal: a source-mirror / missing / extensionless / escaping
  // serverEntry is refused at INSTALL (materialize) time with an actionable
  // [package-store] error — never deferred to an opaque activation failure.
  describe("built-artifacts-only serverEntry gate (install-time refusal)", () => {
    it("REFUSES a TS source-mirror serverEntry (exports key → ./src/register.ts) with the pinned error head", async () => {
      const storeRoot = path.join(workDir, "store-built-source");
      await expect(
        materializeFixture({
          storeRoot,
          serverEntry: "./register",
          exportsMap: { ".": "./src/index.ts", "./register": "./src/register.ts" },
          files: {
            // model-B clean (type-only) so the host-peer gate (4.5) PASSES and
            // the refusal provably comes from the built-artifact gate (4.6).
            "src/register.ts": `import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";\nexport function register(ctx: ExtensionHostContext) { ctx.logger.info("src"); }`,
          },
        }),
      ).rejects.toThrow(
        '[package-store] @cinatra-ai/gate-fixture: cinatra.serverEntry "./register" resolves to ' +
          '"./src/register.ts" — a TypeScript source entry. The runtime store accepts BUILT artifacts only:',
      );
    });

    it("REFUSES an EXTENSIONLESS resolution (no exports key; the literal fallback)", async () => {
      const storeRoot = path.join(workDir, "store-built-extless");
      await expect(
        materializeFixture({
          storeRoot,
          serverEntry: "./register",
          files: { "register.mjs": REGISTER_MJS },
        }),
      ).rejects.toThrow(/has no importable extension \(\.mjs\/\.cjs\/\.js\)/);
    });

    it("REFUSES a DECLARED entry whose resolved file is missing from the tarball", async () => {
      const storeRoot = path.join(workDir, "store-built-missing");
      await expect(
        materializeFixture({
          storeRoot,
          serverEntry: "./register.mjs",
          files: { "other.mjs": REGISTER_MJS },
        }),
      ).rejects.toThrow(/does not exist in the tarball/);
    });

    it("REFUSES a HOSTILE exports TARGET that escapes the package dir", async () => {
      const storeRoot = path.join(workDir, "store-built-escape");
      await expect(
        materializeFixture({
          storeRoot,
          serverEntry: "./register",
          // starts with "./" (passes the resolver's target-language check) but
          // traverses out — the SAFETY guard must reject the RESULT.
          exportsMap: { "./register": "./../evil.mjs" },
          files: { "register.mjs": REGISTER_MJS },
        }),
      ).rejects.toThrow(/escapes the package dir/);
    });

    it("REFUSES an internal `..` segment EVEN IF it normalizes back inside the package (scanner/loader agreement)", async () => {
      // "./dist/../register.mjs" normalizes to an EXISTING top-level file — but
      // the loader's resolveServerEntryPath rejects any `..` segment, so the
      // install-time gate must refuse it too (codex AB-r0 finding 2: a package
      // must never materialize and then fail activation as unsafe).
      const storeRoot = path.join(workDir, "store-built-dotdot");
      await expect(
        materializeFixture({
          storeRoot,
          serverEntry: "./register",
          exportsMap: { "./register": "./dist/../register.mjs" },
          files: { "register.mjs": REGISTER_MJS, "dist/index.mjs": "export {};\n" },
        }),
      ).rejects.toThrow(/escapes the package dir/);
    });

    it("REFUSES a DECLARED exports key with an out-of-contract target — never a silent literal fallback (codex AB-r0 finding 1)", async () => {
      // serverEntry "./register.mjs" + a PRESENT register.mjs would pass as a
      // literal — but the manifest DECLARES exports["./register.mjs"] with a
      // hostile absolute target. The gate must refuse, matching the loader.
      const storeRoot = path.join(workDir, "store-built-badtarget");
      await expect(
        materializeFixture({
          storeRoot,
          serverEntry: "./register.mjs",
          exportsMap: { "./register.mjs": "/abs/evil.mjs" },
          files: { "register.mjs": REGISTER_MJS },
        }),
      ).rejects.toThrow(/declared exports key whose target is outside the supported exports forms/);
    });

    it("MATERIALIZES a package with NO serverEntry (agents/skills/artifacts unaffected)", async () => {
      const storeRoot = path.join(workDir, "store-built-noentry");
      const result = await materializeFixture({
        storeRoot,
        serverEntry: null,
        files: { "data.json": "{}" },
      });
      expect(result.reused).toBe(false);
    });
  });
});

describe("RuntimePackageLoader host wrapper — trust gate + real activation (the loader-parity contract)", () => {
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

  it("refuses activation from a non-allowlisted registry even with valid integrity", async () => {
    const storeRoot = path.join(workDir, "store-evilreg");
    const mat = await materializeInto(storeRoot);
    const results = await loadRuntimePackageExtensions(storeRoot, {
      // valid integrity/contentHash so the integrity gate passes — the registry
      // allowlist is what must refuse activation.
      resolveInstallAnchor: async () => ({ integrity: mat.integrity, contentHash: mat.contentHash, registryUrl: "https://evil.example", trustDecision: true }),
    });
    expect(results.find((r) => r.status === "registered")).toBeUndefined();
  });

  it("refuses activation when trust is explicitly revoked", async () => {
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

describe("exports-key + built artifact is a FIRST-CLASS store citizen (the cinatra#161 contract pin)", () => {
  // The REAL first-party shape: `serverEntry: "./register"` declared as an
  // `exports`-map KEY whose target is a BUILT file under dist/. This is what
  // the release pipeline publishes after its build step (Stage C) — it must
  // materialize AND activate, proving the two scanners (materialize-time and
  // activation-time) agree via the ONE shared resolver.
  const FP_PKG = "@cinatra-ai/first-party-shape";

  async function buildFirstPartyShapeTarball(): Promise<{ bytes: Buffer; sri: string }> {
    const srcRoot = await mkdtemp(path.join(tmpdir(), "cinatra-fpshape-src-"));
    const pkgDir = path.join(srcRoot, "package");
    await mkdir(path.join(pkgDir, "dist"), { recursive: true });
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: FP_PKG,
        version: VERSION,
        exports: { ".": "./dist/index.mjs", "./register": "./dist/register.mjs" },
        cinatra: { kind: "connector", serverEntry: "./register", requestedHostPorts: [], sdkAbiRange: "^2" },
      }),
    );
    await writeFile(path.join(pkgDir, "dist", "register.mjs"), REGISTER_MJS);
    await writeFile(path.join(pkgDir, "dist", "index.mjs"), "export {};\n");
    const tgz = path.join(srcRoot, "fixture.tgz");
    await tar.c({ gzip: true, cwd: srcRoot, file: tgz }, ["package"]);
    const bytes = await readFile(tgz);
    await rm(srcRoot, { recursive: true, force: true }).catch(() => undefined);
    return { bytes, sri: sriForBytes(bytes, "sha512") };
  }

  it("materializes AND activates `registered` end-to-end; the discovered record carries the exports resolution (serverEntryRel)", async () => {
    const storeRoot = path.join(workDir, "store-fpshape");
    const { bytes, sri } = await buildFirstPartyShapeTarball();
    const mat = await materializePackageToStore(
      { packageName: FP_PKG, version: VERSION, expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot },
      { fetchTarball: async () => ({ bytes, integrity: sri }), now: () => "2026-06-12T00:00:00.000Z" },
    );
    expect(mat.reused).toBe(false);

    // The runtime-discovered record resolves the SAME exports target the
    // materializer accepted — the shared-resolver agreement, observable.
    const records = await discoverPackageStoreRecords(storeRoot, realFs);
    expect(records).toHaveLength(1);
    expect(records[0].serverEntry).toBe("./register");
    expect(records[0].serverEntryRel).toBe("./dist/register.mjs");

    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async (name) =>
        name === FP_PKG
          ? { integrity: mat.integrity, contentHash: mat.contentHash, registryUrl: REGISTRY, trustDecision: true }
          : null,
    });
    expect(results.find((r) => r.packageName === FP_PKG)?.status).toBe("registered");
  });
});

describe("legacy-store defense (store dirs written by OLDER installers — fail LOUD, never opaque ENOENT)", () => {
  // Hand-write a COMPLETE store entry (files + sidecar + persisted tarball),
  // bypassing the materializer — exactly what a store written by an older
  // installer looks like: integrity verifies (the old anchor was recorded over
  // these very files), but the entry violates the built-artifacts-only
  // contract. The LOADER must record an actionable `failed`, not an ENOENT.
  async function handWriteLegacyStore(opts: {
    storeRoot: string;
    packageName: string;
    files: Record<string, string>;
    pkgJson: Record<string, unknown>;
  }): Promise<{ integrity: string; contentHash: string; bytes: Buffer }> {
    const srcRoot = await mkdtemp(path.join(tmpdir(), "cinatra-legacy-src-"));
    const pkgDir = path.join(srcRoot, "package");
    const allFiles: Record<string, string> = {
      ...opts.files,
      "package.json": JSON.stringify(opts.pkgJson),
    };
    for (const [rel, contents] of Object.entries(allFiles)) {
      const abs = path.join(pkgDir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, contents);
    }
    const tgz = path.join(srcRoot, "legacy.tgz");
    await tar.c({ gzip: true, cwd: srcRoot, file: tgz }, ["package"]);
    const bytes = await readFile(tgz);
    const integrity = sriForBytes(bytes, "sha512");
    const digest = tarballDigestSegment(bytes);

    const entries: ContentHashEntry[] = Object.entries(allFiles).map(([relPath, contents]) => ({
      relPath,
      bytes: Buffer.from(contents),
    }));
    const contentHash = contentHashOfEntries(entries);

    const targetDir = storePackageDir(opts.storeRoot, opts.packageName, VERSION, digest);
    for (const [rel, contents] of Object.entries(allFiles)) {
      const abs = path.join(targetDir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, contents);
    }
    await writeFile(
      path.join(targetDir, STORE_SIDECAR_FILENAME),
      JSON.stringify({
        integrity,
        tarballDigest: digest,
        contentHash,
        packageName: opts.packageName,
        version: VERSION,
        registryUrl: REGISTRY,
        materializedAt: "2026-06-12T00:00:00.000Z",
      }),
    );
    await writeFile(`${targetDir}.tgz`, bytes);
    await rm(srcRoot, { recursive: true, force: true }).catch(() => undefined);
    return { integrity, contentHash, bytes };
  }

  it("a TS-source entry in a legacy store records an ACTIONABLE failed activation (the loader classification)", async () => {
    const storeRoot = path.join(workDir, "store-legacy-ts");
    const PKG_TS = "@cinatra-ai/legacy-source-mirror";
    const anchor = await handWriteLegacyStore({
      storeRoot,
      packageName: PKG_TS,
      pkgJson: {
        name: PKG_TS,
        version: VERSION,
        exports: { "./register": "./src/register.ts" },
        cinatra: { kind: "connector", serverEntry: "./register", requestedHostPorts: [], sdkAbiRange: "^2" },
      },
      files: {
        "src/register.ts": `export function register(ctx) { ctx.logger.info("legacy"); }`,
      },
    });
    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async (name) =>
        name === PKG_TS
          ? { integrity: anchor.integrity, contentHash: anchor.contentHash, registryUrl: REGISTRY, trustDecision: true }
          : null,
    });
    const r = results.find((x) => x.packageName === PKG_TS);
    expect(r?.status).toBe("failed");
    expect(String(r?.error)).toMatch(/BUILT artifacts only/);
    expect(String(r?.error)).toMatch(/TypeScript source/);
    expect(String(r?.error)).not.toMatch(/ENOENT/);
  });

  it("the materializer REUSE path applies the built-artifact gate too — a pre-contract same-digest dir is REFUSED, not silently reused (codex AB-r1 finding 2)", async () => {
    // Hand-write an integrity-valid SOURCE-MIRROR store dir (what an old
    // installer left behind), then re-install the SAME bytes through the real
    // materializer: the idempotency branch finds the dir, integrity verifies —
    // and the gate must still refuse with the install-time error.
    const storeRoot = path.join(workDir, "store-legacy-reuse");
    const PKG_REUSE = "@cinatra-ai/legacy-reuse-mirror";
    const pkgJson = {
      name: PKG_REUSE,
      version: VERSION,
      exports: { "./register": "./src/register.ts" },
      cinatra: { kind: "connector", serverEntry: "./register", requestedHostPorts: [], sdkAbiRange: "^2" },
    };
    const files = { "src/register.ts": `export function register(ctx) { ctx.logger.info("legacy"); }` };
    const { integrity, bytes } = await handWriteLegacyStore({ storeRoot, packageName: PKG_REUSE, pkgJson, files });
    await expect(
      materializePackageToStore(
        { packageName: PKG_REUSE, version: VERSION, expectedIntegrity: integrity, registryUrl: REGISTRY, storeRoot },
        { fetchTarball: async () => ({ bytes, integrity }), now: () => "2026-06-12T00:00:00.000Z" },
      ),
    ).rejects.toThrow(/a TypeScript source entry/);
  });

  it("the pre-finalize hot-update PROBE refuses what the loader refuses — a declared-invalid exports target never executes top-level code (codex AB-r1 finding 1)", async () => {
    // serverEntry "./register.mjs" + a PRESENT literal register.mjs would import
    // fine as a literal — but the manifest DECLARES exports["./register.mjs"]
    // with an out-of-contract target, which the real loader refuses. The probe
    // (verifyDigestImportsAndRegisters → importStoreModule) must refuse too,
    // not pass the probe and then fail live activation.
    const { verifyDigestImportsAndRegisters } = await import("@/lib/extension-runtime-activate");
    const storeRoot = path.join(workDir, "store-legacy-probe");
    const PKG_PROBE = "@cinatra-ai/legacy-probe-mirror";
    const probeMarker = `globalThis.__cinatra161ProbeImported = true;\n`;
    const anchor = await handWriteLegacyStore({
      storeRoot,
      packageName: PKG_PROBE,
      pkgJson: {
        name: PKG_PROBE,
        version: VERSION,
        exports: { "./register.mjs": "/abs/evil.mjs" },
        cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: [], sdkAbiRange: "^2" },
      },
      files: { "register.mjs": probeMarker + REGISTER_MJS },
    });
    const verdict = await verifyDigestImportsAndRegisters(PKG_PROBE, storeRoot, undefined, {
      integrity: anchor.integrity,
      contentHash: anchor.contentHash,
      approvedPorts: [],
    });
    expect(verdict).toEqual({ ok: false, reason: "import-failed" });
    // the refusal happened BEFORE import — no top-level code ran.
    expect((globalThis as Record<string, unknown>).__cinatra161ProbeImported).toBeUndefined();
  });

  it("a MISSING built entry in a legacy store fails with the wrapped actionable message, not a bare ENOENT (host importModule)", async () => {
    const storeRoot = path.join(workDir, "store-legacy-missing");
    const PKG_MISS = "@cinatra-ai/legacy-missing-entry";
    const anchor = await handWriteLegacyStore({
      storeRoot,
      packageName: PKG_MISS,
      pkgJson: {
        name: PKG_MISS,
        version: VERSION,
        cinatra: { kind: "connector", serverEntry: "./register.mjs", requestedHostPorts: [], sdkAbiRange: "^2" },
      },
      // classification says importable, integrity verifies (anchor recorded over
      // these files) — but the file the entry names was never shipped. The bare
      // realpath ENOENT must be wrapped into the actionable shape.
      files: { "readme.txt": "no register.mjs here" },
    });
    const results = await loadRuntimePackageExtensions(storeRoot, {
      resolveInstallAnchor: async (name) =>
        name === PKG_MISS
          ? { integrity: anchor.integrity, contentHash: anchor.contentHash, registryUrl: REGISTRY, trustDecision: true }
          : null,
    });
    const r = results.find((x) => x.packageName === PKG_MISS);
    expect(r?.status).toBe("failed");
    expect(String(r?.error)).toMatch(/does not exist in the materialized package/);
    expect(String(r?.error)).toMatch(/BUILT artifacts only/);
    expect(String(r?.error)).toMatch(/reinstall the package from the marketplace/);
    expect(String(r?.error)).not.toMatch(/ENOENT/);
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
