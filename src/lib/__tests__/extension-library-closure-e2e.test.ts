// cinatra#181 ACCEPTANCE battery — library dependency closure, host side.
//
// Proves, end-to-end against the REAL builder + materializer + loader:
//   (a) byte-DETERMINISM with a COMMITTED GOLDEN HASH: the fixture closure
//       (root + 4 nodes covering BOTH duplicate classes — same name at two
//       versions, same name@version at two placement paths — and a hoisted
//       edge) materialized into two distinct store roots yields the IDENTICAL
//       content hash, equal to the committed cross-machine pin;
//   (b) same-store-root re-install → closureHash-checked REUSE, same hash;
//   (c) transport-shuffle invariance: a reordered/whitespaced transport plan
//       yields the same canonical bytes, closureHash, and tree;
//   (d) FULL E2E: a closure-mode-BUILT fixture extension (the real
//       scripts/extensions/build-server-entry.mjs, declare-and-closure) with
//       a real library dependency installs to the store and ACTIVATES through
//       the real RuntimePackageLoader under REQUIRE_SIGNATURES=true with a v2
//       signature — `register()` imports the dep from the materialized
//       node_modules via plain file:// Node resolution (zero loader changes);
//   (e) negatives: plan tamper ⇒ v2 signature refusal at the loader; a
//       v1-signed closure package ⇒ refusal; library-file tamper ⇒ boot
//       integrity refusal; closure-LESS fixture ⇒ golden-pinned hash
//       (regression: today's behavior byte-for-byte).
//
// GOLDEN REGENERATION (only when the fixture INPUTS deliberately change):
//   CINATRA_REGENERATE_CLOSURE_GOLDENS=1 pnpm vitest run \
//     src/lib/__tests__/extension-library-closure-e2e.test.ts --no-coverage

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { buildServerEntryPack } from "../../../scripts/extensions/build-server-entry.mjs";
import { materializePackageToStore, type FetchTarball } from "@/lib/extension-package-store";
import { resolveInstallAnchor } from "@/lib/extension-install-anchor";
import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import {
  computeClosureHash,
  canonicalMaterializationPlanBytes,
  parseMaterializationPlan,
  type MaterializationPlan,
} from "@/lib/extension-materialization-plan-core";
import { sriForBytes } from "@/lib/extension-package-store-core";
import { generateExtensionSigningKeyPair, signExtension, signExtensionV2 } from "@/lib/extension-signature";

const REGISTRY = "https://registry.cinatra.ai";
const GOLDEN_PATH = path.join(__dirname, "fixtures", "library-closure-golden", "golden-hashes.json");

let workDir: string;
const kp = generateExtensionSigningKeyPair();
const savedEnv = {
  pub: process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS,
  req: process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES,
};

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-closure-e2e-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});
afterEach(() => {
  if (savedEnv.pub === undefined) delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
  else process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = savedEnv.pub;
  if (savedEnv.req === undefined) delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  else process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = savedEnv.req;
});

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(workDir, prefix));
}

/**
 * Deterministic npm-layout tarball: `portable` + `noMtime` strip every
 * machine-varying header (uid/gid/uname/mtime), so the BYTES — and therefore
 * the per-node SRIs inside the plan and the golden closureHash — are
 * cross-machine stable. (The CONTENT hash never depends on tar metadata; the
 * plan's integrity fields do.)
 */
async function makeTarball(manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<Buffer> {
  const src = await tempDir("tgz-");
  const pkgDir = path.join(src, "package");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(path.join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(pkgDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const out = path.join(src, "out.tgz");
  // EXPLICIT SORTED entry list (review r0 finding 1): recursive directory
  // enumeration order is filesystem-dependent and would leak into the tarball
  // bytes -> the plan SRIs -> the committed golden closureHash.
  const entries = ["package.json", ...Object.keys(files)].sort().map((rel) => `package/${rel}`);
  await tar.c({ gzip: true, cwd: src, file: out, portable: true, noMtime: true }, entries);
  return readFile(out);
}

// ---------------------------------------------------------------------------
// The GOLDEN fixture closure: root extension + 5 nodes.
//   lib-a@1.0.0 at node_modules/lib-a                      (root dep)
//   lib-b@1.0.0 at node_modules/lib-b                      (root dep)
//   lib-b@2.0.0 at node_modules/lib-a/node_modules/lib-b   (same NAME, two VERSIONS)
//   lib-c@1.0.0 at node_modules/lib-c                      (root dep)
//   lib-c@1.0.0 at node_modules/lib-a/node_modules/lib-c   (same name@version, TWO PLACEMENTS)
// Edges: lib-a -> nested lib-b@2.0.0 AND -> TOP-LEVEL lib-c (a HOISTED edge:
// a nested package resolving an ancestor placement); nested lib-b@2.0.0 ->
// the NESTED lib-c copy (which makes the duplicate placement reachable).
// Every byte below is FIXED so the goldens are machine-independent.
// ---------------------------------------------------------------------------

const GOLDEN_EXT = "@cinatra-test/closure-golden";
const GOLDEN_VER = "1.0.0";

type GoldenFixture = {
  extBytes: Buffer;
  plan: MaterializationPlan;
  closureHash: string;
  fetchTarball: FetchTarball;
  transportShuffled: string;
};

let goldenMemo: GoldenFixture | null = null;
async function goldenFixture(): Promise<GoldenFixture> {
  if (goldenMemo) return goldenMemo;
  const libB1 = await makeTarball({ name: "lib-b", version: "1.0.0" }, { "index.js": "module.exports = 'b1';\n" });
  const libB2 = await makeTarball({ name: "lib-b", version: "2.0.0" }, { "index.js": "module.exports = 'b2';\n" });
  const libC = await makeTarball({ name: "lib-c", version: "1.0.0" }, { "index.js": "module.exports = 'c';\n" });
  const libA = await makeTarball(
    { name: "lib-a", version: "1.0.0" },
    { "index.js": "module.exports = require('lib-b') + require('lib-c');\n" },
  );
  const extBytes = await makeTarball(
    {
      name: GOLDEN_EXT,
      version: GOLDEN_VER,
      dependencies: { "lib-a": "^1.0.0", "lib-b": "^1.0.0", "lib-c": "^1.0.0" },
      cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure", sdkAbiRange: "^2" },
    },
    {
      "register.mjs":
        'import { createRequire } from "node:module";\n' +
        "const require = createRequire(import.meta.url);\n" +
        'const a = require("lib-a");\nconst b = require("lib-b");\nconst c = require("lib-c");\n' +
        "export function register(ctx) { ctx.logger.info(`closure-golden ${a}|${b}|${c}`); }\n",
    },
  );
  // Transport DELIBERATELY out of canonical order (keys + arrays + whitespace).
  const transport = {
    nodes: [
      {
        placementPath: "node_modules/lib-a/node_modules/lib-b",
        version: "2.0.0",
        name: "lib-b",
        integrity: sriForBytes(libB2),
        // The NESTED lib-c duplicate placement, reachable through this edge
        // (Node-resolution-valid: node_modules/lib-a/node_modules/lib-c is on
        // lib-b's walk-up path).
        dependencies: [{ name: "lib-c", placementPath: "node_modules/lib-a/node_modules/lib-c" }],
      },
      {
        name: "lib-a",
        version: "1.0.0",
        integrity: sriForBytes(libA),
        placementPath: "node_modules/lib-a",
        dependencies: [
          // HOISTED edge: lib-a resolves lib-c at the TOP-LEVEL placement.
          { name: "lib-c", placementPath: "node_modules/lib-c" },
          { name: "lib-b", placementPath: "node_modules/lib-a/node_modules/lib-b" },
        ],
      },
      { name: "lib-c", version: "1.0.0", integrity: sriForBytes(libC), placementPath: "node_modules/lib-c", dependencies: [] },
      {
        name: "lib-c",
        version: "1.0.0",
        integrity: sriForBytes(libC),
        placementPath: "node_modules/lib-a/node_modules/lib-c",
        dependencies: [],
      },
      { name: "lib-b", version: "1.0.0", integrity: sriForBytes(libB1), placementPath: "node_modules/lib-b", dependencies: [] },
    ],
    rootDependencies: [
      { name: "lib-c", placementPath: "node_modules/lib-c" },
      { name: "lib-a", placementPath: "node_modules/lib-a" },
      { name: "lib-b", placementPath: "node_modules/lib-b" },
    ],
    package: { name: GOLDEN_EXT, version: GOLDEN_VER },
    format: "cinatra-materialization-plan/v1",
  };
  const plan = parseMaterializationPlan(transport);
  const byName = new Map<string, Buffer>([
    [`lib-a@1.0.0`, libA],
    [`lib-b@1.0.0`, libB1],
    [`lib-b@2.0.0`, libB2],
    [`lib-c@1.0.0`, libC],
  ]);
  const fetchTarball: FetchTarball = async (i) => {
    if (i.packageName === GOLDEN_EXT) return { bytes: extBytes, integrity: sriForBytes(extBytes) };
    const hit = byName.get(`${i.packageName}@${i.packageVersion}`);
    if (!hit) throw new Error(`unexpected fetch ${i.packageName}@${i.packageVersion}`);
    return { bytes: hit, integrity: sriForBytes(hit) };
  };
  goldenMemo = {
    extBytes,
    plan,
    closureHash: computeClosureHash(plan),
    fetchTarball,
    transportShuffled: JSON.stringify(transport, null, 4),
  };
  return goldenMemo;
}

async function readGoldens(): Promise<Record<string, string>> {
  return JSON.parse(await readFile(GOLDEN_PATH, "utf8")) as Record<string, string>;
}

describe("(a)+(b) determinism — committed golden hash", () => {
  it("two distinct store roots ⇒ IDENTICAL content hash == the committed golden; same root ⇒ closureHash-checked reuse", async () => {
    const fx = await goldenFixture();
    const input = (storeRoot: string) => ({
      packageName: GOLDEN_EXT,
      version: GOLDEN_VER,
      expectedIntegrity: sriForBytes(fx.extBytes),
      registryUrl: REGISTRY,
      storeRoot,
      plan: fx.plan,
      expectedClosureHash: fx.closureHash,
    });
    const rootA = await tempDir("store-a-");
    const rootB = await tempDir("store-b-");
    const matA = await materializePackageToStore(input(rootA), { fetchTarball: fx.fetchTarball });
    const matB = await materializePackageToStore(input(rootB), { fetchTarball: fx.fetchTarball });
    expect(matA.contentHash).toBe(matB.contentHash);

    if (process.env.CINATRA_REGENERATE_CLOSURE_GOLDENS === "1") {
      const prev = await readGoldens().catch(() => ({}) as Record<string, string>);
      await mkdir(path.dirname(GOLDEN_PATH), { recursive: true });
      await writeFile(
        GOLDEN_PATH,
        JSON.stringify({ ...prev, closureContentHash: matA.contentHash, closureHash: fx.closureHash }, null, 2) + "\n",
      );
    }
    const goldens = await readGoldens();
    expect(matA.contentHash).toBe(goldens.closureContentHash); // cross-machine pin
    expect(fx.closureHash).toBe(goldens.closureHash);

    // (b) same store root again ⇒ reuse, same hash, closureHash-checked.
    const matA2 = await materializePackageToStore(input(rootA), { fetchTarball: fx.fetchTarball });
    expect(matA2.reused).toBe(true);
    expect(matA2.contentHash).toBe(matA.contentHash);
  });

  it("closure-LESS regression: the plain fixture's hash equals ITS committed golden (today's behavior byte-for-byte)", async () => {
    const extBytes = await makeTarball(
      { name: "@cinatra-test/closureless-golden", version: "1.0.0", cinatra: { kind: "connector", serverEntry: "./register.mjs" } },
      { "register.mjs": "export function register(ctx) { ctx.logger.info('closureless-golden'); }\n" },
    );
    const mat = await materializePackageToStore(
      {
        packageName: "@cinatra-test/closureless-golden",
        version: "1.0.0",
        expectedIntegrity: sriForBytes(extBytes),
        registryUrl: REGISTRY,
        storeRoot: await tempDir("store-"),
      },
      { fetchTarball: async () => ({ bytes: extBytes, integrity: sriForBytes(extBytes) }) },
    );
    if (process.env.CINATRA_REGENERATE_CLOSURE_GOLDENS === "1") {
      const prev = await readGoldens().catch(() => ({}) as Record<string, string>);
      await writeFile(GOLDEN_PATH, JSON.stringify({ ...prev, closurelessContentHash: mat.contentHash }, null, 2) + "\n");
    }
    const goldens = await readGoldens();
    expect(mat.contentHash).toBe(goldens.closurelessContentHash);
  });
});

describe("(c) transport-shuffle invariance", () => {
  it("a reordered/whitespaced transport yields the same canonical bytes, closureHash, and materialized tree", async () => {
    const fx = await goldenFixture();
    const reparsed = parseMaterializationPlan(JSON.parse(fx.transportShuffled));
    expect(Buffer.from(canonicalMaterializationPlanBytes(reparsed)).toString("hex")).toBe(
      Buffer.from(canonicalMaterializationPlanBytes(fx.plan)).toString("hex"),
    );
    expect(computeClosureHash(reparsed)).toBe(fx.closureHash);
    const mat = await materializePackageToStore(
      {
        packageName: GOLDEN_EXT,
        version: GOLDEN_VER,
        expectedIntegrity: sriForBytes(fx.extBytes),
        registryUrl: REGISTRY,
        storeRoot: await tempDir("store-"),
        plan: reparsed,
        expectedClosureHash: fx.closureHash,
      },
      { fetchTarball: fx.fetchTarball },
    );
    const goldens = await readGoldens();
    expect(mat.contentHash).toBe(goldens.closureContentHash);
  });
});

// ---------------------------------------------------------------------------
// (d)+(e) FULL E2E through the real BUILDER + LOADER.
// ---------------------------------------------------------------------------

const E2E_EXT = "@cinatra-test/closure-e2e";
const E2E_VER = "1.0.0";

type E2eFixture = { extBytes: Buffer; plan: MaterializationPlan; closureHash: string; fetchTarball: FetchTarball };

let e2eMemo: E2eFixture | null = null;
async function e2eFixture(): Promise<E2eFixture> {
  if (e2eMemo) return e2eMemo;
  // 1. A SOURCE package in declare-and-closure mode whose built entry imports
  //    the library — run the REAL builder (passthrough + residual validation).
  const srcDir = path.join(await tempDir("e2e-src-"), "pkg");
  await mkdir(path.join(srcDir, "src"), { recursive: true });
  await writeFile(
    path.join(srcDir, "package.json"),
    JSON.stringify({
      name: E2E_EXT,
      version: E2E_VER,
      dependencies: { "left-pad-fixture": "^1.0.0" },
      exports: { "./register": "./src/register.ts" },
      cinatra: { kind: "connector", serverEntry: "./register", dependencyMode: "closure", sdkAbiRange: "^2" },
    }),
  );
  // TS SOURCE entry (review r0 finding 3): forces the REAL esbuild bundle
  // path — the builder must EXTERNALIZE the declared dep (closure mode),
  // emit a built register.mjs, rewrite the packed manifest, and KEEP
  // `dependencies` for the signed plan.
  await writeFile(
    path.join(srcDir, "src", "register.ts"),
    'import leftPad from "left-pad-fixture";\nexport function register(ctx: { logger: { info(msg: string): void } }): void { ctx.logger.info(`closure-e2e ${leftPad("x", 5)}`); }\n',
  );
  const built = await buildServerEntryPack({ packageDir: srcDir });
  expect(built.dependencyMode).toBe("closure");
  expect(built.mode).toBe("bundled"); // the REAL source-built path, not passthrough
  const packedManifest = JSON.parse(await readFile(path.join(built.packDir, "package.json"), "utf8")) as Record<string, unknown>;
  expect(packedManifest.dependencies).toEqual({ "left-pad-fixture": "^1.0.0" }); // KEPT (closure mode)
  // 2. Tar the BUILT pack dir (npm layout).
  const tarSrc = await tempDir("e2e-pack-");
  const pkgDir = path.join(tarSrc, "package");
  await rm(pkgDir, { recursive: true, force: true }).catch(() => undefined);
  const { cp } = await import("node:fs/promises");
  await cp(built.packDir, pkgDir, { recursive: true });
  const out = path.join(tarSrc, "out.tgz");
  await tar.c({ gzip: true, cwd: tarSrc, file: out, portable: true, noMtime: true }, ["package"]);
  const extBytes = await readFile(out);
  // 3. The library node (ESM default export so the import binds cleanly).
  const lib = await makeTarball(
    { name: "left-pad-fixture", version: "1.0.0", type: "module" },
    { "index.js": "export default function leftPad(s, n) { return String(s).padStart(n, ' '); }\n" },
  );
  const plan = parseMaterializationPlan({
    format: "cinatra-materialization-plan/v1",
    package: { name: E2E_EXT, version: E2E_VER },
    rootDependencies: [{ name: "left-pad-fixture", placementPath: "node_modules/left-pad-fixture" }],
    nodes: [
      {
        name: "left-pad-fixture",
        version: "1.0.0",
        integrity: sriForBytes(lib),
        placementPath: "node_modules/left-pad-fixture",
        dependencies: [],
      },
    ],
  });
  const fetchTarball: FetchTarball = async (i) => {
    if (i.packageName === E2E_EXT) return { bytes: extBytes, integrity: sriForBytes(extBytes) };
    if (i.packageName === "left-pad-fixture") return { bytes: lib, integrity: sriForBytes(lib) };
    throw new Error(`unexpected fetch ${i.packageName}`);
  };
  e2eMemo = { extBytes, plan, closureHash: computeClosureHash(plan), fetchTarball };
  return e2eMemo;
}

async function materializeE2e(fx: E2eFixture): Promise<{ storeRoot: string; mat: Awaited<ReturnType<typeof materializePackageToStore>> }> {
  const storeRoot = path.join(await tempDir("e2e-store-"), "extensions", "packages");
  const mat = await materializePackageToStore(
    {
      packageName: E2E_EXT,
      version: E2E_VER,
      expectedIntegrity: sriForBytes(fx.extBytes),
      registryUrl: REGISTRY,
      storeRoot,
      plan: fx.plan,
      expectedClosureHash: fx.closureHash,
    },
    { fetchTarball: fx.fetchTarball },
  );
  return { storeRoot, mat };
}

function loaderFor(storeRoot: string, anchorSource: Record<string, unknown>) {
  return loadRuntimePackageExtensions(storeRoot, {
    resolveInstallAnchor: (packageName: string) =>
      resolveInstallAnchor(packageName, {
        orgId: null,
        readActiveInstall: async () => ({ status: "active", source: anchorSource as never }),
        readGrant: async () => ({ status: "approved", approvedPorts: [], orgId: null }),
        readInstallOp: async () => ({ phase: "finalized" }),
      }),
  });
}

describe("(d) full e2e — closure-mode-BUILT extension ACTIVATES; the dep resolves from the materialized node_modules", () => {
  it("REQUIRE_SIGNATURES=true + v2 signature binding the closureHash ⇒ status 'registered' (register imported the library)", async () => {
    const fx = await e2eFixture();
    const { storeRoot, mat } = await materializeE2e(fx);
    // Determinism through the REAL BUILT artifact too: a second store root.
    const second = await materializeE2e(fx);
    expect(second.mat.contentHash).toBe(mat.contentHash);

    process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "true";
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const v2 = signExtensionV2(
      { packageName: E2E_EXT, version: E2E_VER, integrity: mat.integrity, closureHash: fx.closureHash },
      kp.privateKeyPkcs8DerB64,
    );
    const acts = await loaderFor(storeRoot, {
      type: "verdaccio",
      registryUrl: REGISTRY,
      packageName: E2E_EXT,
      integrity: mat.integrity,
      contentHash: mat.contentHash,
      version: E2E_VER,
      signature: v2,
      closureHash: fx.closureHash,
    });
    expect(acts.some((a) => a.packageName === E2E_EXT && a.status === "registered")).toBe(true);
  });

  it("(e) plan TAMPER ⇒ the recorded v2 signature no longer binds ⇒ loader refuses (zero activations)", async () => {
    const fx = await e2eFixture();
    const { storeRoot, mat } = await materializeE2e(fx);
    process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "true";
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const v2 = signExtensionV2(
      { packageName: E2E_EXT, version: E2E_VER, integrity: mat.integrity, closureHash: fx.closureHash },
      kp.privateKeyPkcs8DerB64,
    );
    // One mutated plan field (a node version bump) ⇒ a DIFFERENT closureHash
    // ⇒ the recorded signature (over the original hash) must refuse.
    const tamperedPlan = JSON.parse(JSON.stringify({
      format: "cinatra-materialization-plan/v1",
      package: { name: E2E_EXT, version: E2E_VER },
      rootDependencies: fx.plan.rootDependencies,
      nodes: fx.plan.nodes.map((n) => ({ ...n, version: "1.0.1" })),
    })) as unknown;
    const tamperedHash = computeClosureHash(parseMaterializationPlan(tamperedPlan));
    expect(tamperedHash).not.toBe(fx.closureHash);
    const acts = await loaderFor(storeRoot, {
      type: "verdaccio",
      registryUrl: REGISTRY,
      packageName: E2E_EXT,
      integrity: mat.integrity,
      contentHash: mat.contentHash,
      version: E2E_VER,
      signature: v2,
      closureHash: tamperedHash,
    });
    expect(acts).toHaveLength(0);
  });

  it("(e) a closure package signed V1 ⇒ refusal even with the right key (downgrade refusal at boot)", async () => {
    const fx = await e2eFixture();
    const { storeRoot, mat } = await materializeE2e(fx);
    process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "false"; // refusal must hold even when not required
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const v1 = signExtension({ packageName: E2E_EXT, version: E2E_VER, integrity: mat.integrity }, kp.privateKeyPkcs8DerB64);
    const acts = await loaderFor(storeRoot, {
      type: "verdaccio",
      registryUrl: REGISTRY,
      packageName: E2E_EXT,
      integrity: mat.integrity,
      contentHash: mat.contentHash,
      version: E2E_VER,
      signature: v1,
      closureHash: fx.closureHash,
    });
    expect(acts).toHaveLength(0);
  });

  it("(e) post-install LIBRARY tamper ⇒ boot integrity re-verify refuses (the content hash covers the closure tree)", async () => {
    const fx = await e2eFixture();
    const { storeRoot, mat } = await materializeE2e(fx);
    process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "true";
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const v2 = signExtensionV2(
      { packageName: E2E_EXT, version: E2E_VER, integrity: mat.integrity, closureHash: fx.closureHash },
      kp.privateKeyPkcs8DerB64,
    );
    await writeFile(
      path.join(mat.storeDir, "node_modules/left-pad-fixture/index.js"),
      "export default function leftPad() { return 'pwned'; }\n",
    );
    const acts = await loaderFor(storeRoot, {
      type: "verdaccio",
      registryUrl: REGISTRY,
      packageName: E2E_EXT,
      integrity: mat.integrity,
      contentHash: mat.contentHash,
      version: E2E_VER,
      signature: v2,
      closureHash: fx.closureHash,
    });
    expect(acts).toHaveLength(0);
  });
});
