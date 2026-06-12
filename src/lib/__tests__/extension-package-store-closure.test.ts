// materializePackageToStore × SIGNED MATERIALIZATION PLANS (cinatra#181):
// step 4.7 (plan execution before the content hash), the evolved bundled-deps
// gate (bundled XOR planned), the residual-coverage check (4.8), the sidecar
// closureHash, and the FAIL-LOUD non-destructive reuse rule.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  materializePackageToStore,
  readStoreSidecar,
  verifyMaterializedPackageIntegrity,
  type FetchTarball,
} from "@/lib/extension-package-store";
import {
  computeClosureHash,
  parseMaterializationPlan,
  type MaterializationPlan,
} from "@/lib/extension-materialization-plan-core";
import { sriForBytes, validateBundledDependencies } from "@/lib/extension-package-store-core";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-store-closure-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(workDir, prefix));
}

/** npm-layout tarball from a manifest + file map. */
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
  await tar.c({ gzip: true, cwd: src, file: out, portable: true }, ["package"]);
  return readFile(out);
}

const EXT = "@cinatra-test/closure-ext";
const VER = "1.0.0";

/** A closure-mode extension: declares left-pad, bundles nothing, built entry imports it. */
async function makeClosureExtension(entrySource = 'import leftPad from "left-pad";\nexport function register() { return leftPad("x", 3); }\n'): Promise<Buffer> {
  return makeTarball(
    {
      name: EXT,
      version: VER,
      dependencies: { "left-pad": "^1.3.0" },
      cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" },
    },
    { "register.mjs": entrySource },
  );
}

function makePlanFor(extName: string, extVersion: string, nodeBytes: Buffer): { plan: MaterializationPlan; closureHash: string } {
  const plan = parseMaterializationPlan({
    format: "cinatra-materialization-plan/v1",
    package: { name: extName, version: extVersion },
    rootDependencies: [{ name: "left-pad", placementPath: "node_modules/left-pad" }],
    nodes: [
      {
        name: "left-pad",
        version: "1.3.0",
        integrity: sriForBytes(nodeBytes),
        placementPath: "node_modules/left-pad",
        dependencies: [],
      },
    ],
  });
  return { plan, closureHash: computeClosureHash(plan) };
}

function fetchFor(extBytes: Buffer, nodeBytes: Buffer): FetchTarball {
  return async (input) => {
    if (input.packageName === EXT) return { bytes: extBytes, integrity: sriForBytes(extBytes) };
    if (input.packageName === "left-pad") return { bytes: nodeBytes, integrity: sriForBytes(nodeBytes) };
    throw new Error(`unexpected fetch ${input.packageName}`);
  };
}

let leftPadBytesMemo: Buffer | null = null;
async function leftPadBytes(): Promise<Buffer> {
  leftPadBytesMemo ??= await makeTarball(
    { name: "left-pad", version: "1.3.0" },
    { "index.js": "module.exports = function leftPad(s){return s};\n" },
  );
  return leftPadBytesMemo;
}

describe("materializePackageToStore — step 4.7 plan execution", () => {
  it("materializes the closure BEFORE the content hash: libraries land at the plan's exact paths, the sidecar records the closureHash, and boot re-verify covers the closure tree", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeClosureExtension();
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    const storeRoot = await tempDir("store-");
    const mat = await materializePackageToStore(
      { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot, plan, expectedClosureHash: closureHash },
      { fetchTarball: fetchFor(ext, leftPad) },
    );
    expect(mat.reused).toBe(false);
    // exact placement (REAL nested dirs — Node file:// resolution works unchanged)
    expect(existsSync(path.join(mat.storeDir, "node_modules/left-pad/index.js"))).toBe(true);
    // sidecar records the closureHash
    const sidecar = await readStoreSidecar(mat.storeDir);
    expect(sidecar?.closureHash).toBe(closureHash);
    // the recorded content hash COVERS the post-closure tree: boot verify passes…
    const record = { packageName: EXT, serverEntry: null, requestedHostPorts: [], storeDir: mat.storeDir, declaredDigest: mat.digest };
    expect(
      await verifyMaterializedPackageIntegrity(record, { trustedIntegrity: sriForBytes(ext), trustedContentHash: mat.contentHash }),
    ).toBe(true);
    // …and tampering a LIBRARY file (not the extension's own) breaks it.
    await writeFile(path.join(mat.storeDir, "node_modules/left-pad/index.js"), "module.exports = () => 'tampered';\n");
    expect(
      await verifyMaterializedPackageIntegrity(record, { trustedIntegrity: sriForBytes(ext), trustedContentHash: mat.contentHash }),
    ).toBe(false);
  });

  it("DETERMINISM: the same (tarball, plan) materialized into two distinct store roots yields the IDENTICAL content hash", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeClosureExtension();
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    const matA = await materializePackageToStore(
      { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-a-"), plan, expectedClosureHash: closureHash },
      { fetchTarball: fetchFor(ext, leftPad) },
    );
    const matB = await materializePackageToStore(
      { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-b-"), plan, expectedClosureHash: closureHash },
      { fetchTarball: fetchFor(ext, leftPad) },
    );
    expect(matA.contentHash).toBe(matB.contentHash);
    expect(matA.reused).toBe(false);
    expect(matB.reused).toBe(false);
  });

  it("REUSE: a second call with the SAME plan reuses the dir (closureHash-checked)", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeClosureExtension();
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    const storeRoot = await tempDir("store-");
    const input = { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot, plan, expectedClosureHash: closureHash };
    const first = await materializePackageToStore(input, { fetchTarball: fetchFor(ext, leftPad) });
    const second = await materializePackageToStore(input, { fetchTarball: fetchFor(ext, leftPad) });
    expect(second.reused).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.storeDir).toBe(first.storeDir);
  });

  it("REUSE mismatch FAILS LOUD and NON-DESTRUCTIVELY: a same-digest dir materialized under a DIFFERENT/ABSENT plan is refused, never deleted, never silently reused", async () => {
    const leftPad = await leftPadBytes();
    // An extension whose manifest carries NO unbundled deps, so it ALSO
    // materializes plan-less (simulating a pre-closure installer's dir).
    const ext = await makeTarball(
      { name: EXT, version: VER, cinatra: { kind: "connector", serverEntry: "./register.mjs" } },
      { "register.mjs": "export function register() {}\n" },
    );
    const storeRoot = await tempDir("store-");
    const planless = await materializePackageToStore(
      { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot },
      { fetchTarball: fetchFor(ext, leftPad) },
    );
    expect(planless.reused).toBe(false);
    // Same digest, but NOW a plan is expected → FAIL-LOUD refusal…
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    await expect(
      materializePackageToStore(
        { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot, plan, expectedClosureHash: closureHash },
        { fetchTarball: fetchFor(ext, leftPad) },
      ),
    ).rejects.toThrow(/does not match the expected plan/);
    // …and the possibly-live dir was NOT destroyed (non-destructive).
    expect(existsSync(path.join(planless.storeDir, "package.json"))).toBe(true);
    // The inverse direction (dir HAS a closureHash, caller expects none) also fails loud.
    const ext2 = await makeClosureExtension();
    const storeRoot2 = await tempDir("store-");
    const withPlan = await materializePackageToStore(
      { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext2), storeRoot: storeRoot2, plan, expectedClosureHash: closureHash },
      { fetchTarball: fetchFor(ext2, leftPad) },
    );
    expect(withPlan.reused).toBe(false);
    await expect(
      materializePackageToStore(
        { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext2), storeRoot: storeRoot2 },
        { fetchTarball: fetchFor(ext2, leftPad) },
      ),
    ).rejects.toThrow(/does not match the expected plan/);
    expect(existsSync(path.join(withPlan.storeDir, "node_modules/left-pad/index.js"))).toBe(true);
  });

  it("THREADING preconditions: a plan without its verified hash (and vice versa) is refused before any fetch", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeClosureExtension();
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    const storeRoot = await tempDir("store-");
    await expect(
      materializePackageToStore({ packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot, plan }, { fetchTarball: fetchFor(ext, leftPad) }),
    ).rejects.toThrow(/without its verified closureHash/);
    await expect(
      materializePackageToStore({ packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot, expectedClosureHash: closureHash }, { fetchTarball: fetchFor(ext, leftPad) }),
    ).rejects.toThrow(/without its plan/);
  });

  it("PLAN-IDENTITY: a plan bound to another (name, version) is refused", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeClosureExtension();
    const { plan, closureHash } = makePlanFor("@cinatra-test/other-ext", VER, leftPad);
    await expect(
      materializePackageToStore(
        { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-"), plan, expectedClosureHash: closureHash },
        { fetchTarball: fetchFor(ext, leftPad) },
      ),
    ).rejects.toThrow(/must bind the exact package/);
  });
});

describe("the evolved bundled-deps gate (bundled XOR in the signed plan)", () => {
  it("pure verdicts: closure-less behavior is BYTE-FOR-BYTE unchanged; plan coverage satisfies; overlap + plan-only-undeclared refuse", () => {
    const pkg = { dependencies: { "left-pad": "^1.3.0" } } as Record<string, unknown>;
    // closure-less: missing stays missing
    expect(validateBundledDependencies(pkg, new Set())).toEqual({ ok: false, missing: ["left-pad"], hostProvidedInDeps: [] });
    expect(validateBundledDependencies(pkg, new Set(["left-pad"]))).toEqual({ ok: true });
    // plan coverage satisfies the declaration
    expect(validateBundledDependencies(pkg, new Set(), new Set(["left-pad"]))).toEqual({ ok: true });
    // bundled AND planned → overlap refusal (one source of truth)
    expect(validateBundledDependencies(pkg, new Set(["left-pad"]), new Set(["left-pad"]))).toMatchObject({ ok: false, bundledAndPlanned: ["left-pad"] });
    // plan covers an UNDECLARED name → refusal (both-direction reconciliation)
    expect(validateBundledDependencies(pkg, new Set(["left-pad"]), new Set(["sneaky"]))).toMatchObject({ ok: false, planOnlyUndeclared: ["sneaky"] });
    // …also when the manifest declares NO dependencies at all
    expect(validateBundledDependencies({}, new Set(), new Set(["sneaky"]))).toMatchObject({ ok: false, planOnlyUndeclared: ["sneaky"] });
    // host peer refusal unchanged in plan mode
    expect(
      validateBundledDependencies({ dependencies: { "@cinatra-ai/sdk-extensions": "^2.0.0" } }, new Set(), new Set()),
    ).toMatchObject({ ok: false, hostProvidedInDeps: ["@cinatra-ai/sdk-extensions"] });
  });

  it("END-TO-END refusal: a declared dep neither bundled nor planned refuses at materialize", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeTarball(
      {
        name: EXT,
        version: VER,
        dependencies: { "left-pad": "^1.3.0", "not-covered": "^1.0.0" },
        cinatra: { kind: "connector", serverEntry: "./register.mjs", dependencyMode: "closure" },
      },
      { "register.mjs": "export function register() {}\n" },
    );
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    await expect(
      materializePackageToStore(
        { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-"), plan, expectedClosureHash: closureHash },
        { fetchTarball: fetchFor(ext, leftPad) },
      ),
    ).rejects.toThrow(/neither bundled in the tarball nor covered by a signed materialization plan \(not-covered\)/);
  });
});

describe("step 4.8 residual-coverage (closure packages only)", () => {
  it("REFUSES a bare import the materialized tree can never resolve (not builtin, not bundled, not a plan root)", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeClosureExtension(
      'import leftPad from "left-pad";\nimport missing from "totally-uncovered-lib";\nexport function register() { return leftPad(String(missing), 3); }\n',
    );
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    await expect(
      materializePackageToStore(
        { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-"), plan, expectedClosureHash: closureHash },
        { fetchTarball: fetchFor(ext, leftPad) },
      ),
    ).rejects.toThrow(/imports "totally-uncovered-lib"[\s\S]*not a root of the signed/);
  });

  it("REFUSES a direct import of a HOISTED TRANSITIVE plan node (covered only by plan ROOTS, not placement)", async () => {
    // Plan: left-pad is the declared ROOT; hoist-dep is left-pad's transitive
    // dep, legally HOISTED to top-level node_modules. The extension imports
    // hoist-dep DIRECTLY — undeclared, not a root: Node would resolve it
    // today and silently break when the transitive dep dedupes elsewhere.
    const leftPad = await leftPadBytes();
    const hoistDep = await makeTarball({ name: "hoist-dep", version: "1.0.0" }, { "index.js": "module.exports = 1;\n" });
    const ext = await makeClosureExtension(
      'import leftPad from "left-pad";\nimport h from "hoist-dep";\nexport function register() { return leftPad(String(h), 3); }\n',
    );
    const plan = parseMaterializationPlan({
      format: "cinatra-materialization-plan/v1",
      package: { name: EXT, version: VER },
      rootDependencies: [{ name: "left-pad", placementPath: "node_modules/left-pad" }],
      nodes: [
        {
          name: "left-pad", version: "1.3.0", integrity: sriForBytes(leftPad),
          placementPath: "node_modules/left-pad",
          dependencies: [{ name: "hoist-dep", placementPath: "node_modules/hoist-dep" }],
        },
        {
          name: "hoist-dep", version: "1.0.0", integrity: sriForBytes(hoistDep),
          placementPath: "node_modules/hoist-dep", dependencies: [],
        },
      ],
    });
    const closureHash = computeClosureHash(plan);
    const fetch: FetchTarball = async (i) => {
      if (i.packageName === EXT) return { bytes: ext, integrity: sriForBytes(ext) };
      if (i.packageName === "left-pad") return { bytes: leftPad, integrity: sriForBytes(leftPad) };
      if (i.packageName === "hoist-dep") return { bytes: hoistDep, integrity: sriForBytes(hoistDep) };
      throw new Error(`unexpected fetch ${i.packageName}`);
    };
    await expect(
      materializePackageToStore(
        { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-"), plan, expectedClosureHash: closureHash },
        { fetchTarball: fetch },
      ),
    ).rejects.toThrow(/imports "hoist-dep"[\s\S]*not a root of the signed/);
  });

  it("REFUSES an unresolvable SELF-package bare import (would only fail at activation otherwise)", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeClosureExtension(
      `import leftPad from "left-pad";\nimport helper from "${EXT}/not-exported";\nexport function register() { return leftPad(String(helper), 3); }\n`,
    );
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    await expect(
      materializePackageToStore(
        { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-"), plan, expectedClosureHash: closureHash },
        { fetchTarball: fetchFor(ext, leftPad) },
      ),
    ).rejects.toThrow(/SELF subpath [\s\S]* does not resolve/);
  });

  it("ACCEPTS builtins (node: and bare), plan roots, and their subpaths", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeClosureExtension(
      'import { createHash } from "node:crypto";\nimport os from "os";\nimport leftPad from "left-pad";\nexport function register() { return createHash("sha256").update(os.platform() + leftPad("x", 3)).digest("hex"); }\n',
    );
    const { plan, closureHash } = makePlanFor(EXT, VER, leftPad);
    const mat = await materializePackageToStore(
      { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-"), plan, expectedClosureHash: closureHash },
      { fetchTarball: fetchFor(ext, leftPad) },
    );
    expect(mat.reused).toBe(false);
  });
});

describe("hardened EXTENSION-tarball extraction (tar-header entry-type filter)", () => {
  it("keeps bundled node_modules LEGAL for inline-mode extension tarballs (closure-less regression)", async () => {
    const leftPad = await leftPadBytes();
    const ext = await makeTarball(
      {
        name: EXT,
        version: VER,
        dependencies: { "left-pad": "^1.3.0" },
        cinatra: { kind: "connector", serverEntry: "./register.mjs" },
      },
      {
        "register.mjs": "export function register() {}\n",
        "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", version: "1.3.0" }),
        "node_modules/left-pad/index.js": "module.exports = (s) => s;\n",
      },
    );
    const mat = await materializePackageToStore(
      { packageName: EXT, version: VER, expectedIntegrity: sriForBytes(ext), storeRoot: await tempDir("store-") },
      { fetchTarball: fetchFor(ext, leftPad) },
    );
    expect(mat.reused).toBe(false);
    expect(existsSync(path.join(mat.storeDir, "node_modules/left-pad/index.js"))).toBe(true);
  });
});
