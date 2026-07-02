// cinatra#791 — the materializer on the V2 kind-segregated, content-addressed
// layout: identity binding (manifest name+version == requested install), kind
// resolution (caller expectedKind authoritative, manifest cross-checked, no
// silent default), the `<root>/<kind>/<slug>/<digest>` target + `<digest>.tgz`
// sibling + `<root>/.staging` staging, and the POST-GATES valid-existing reuse.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";

import {
  STORE_SIDECAR_FILENAME,
  STORE_STAGING_DIRNAME,
  sriForBytes,
  tarballDigestSegment,
} from "@/lib/extension-package-store-core";
import { materializePackageToStore, readStoreSidecar } from "@/lib/extension-package-store";
import { discoverStoreRecordsV2 } from "@/lib/extension-store-io";

const REGISTER_MJS = `export function register(ctx) { ctx.logger.info("v2-layout"); }\n`;
const REGISTRY = "https://registry.cinatra.ai";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-store-v2-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

async function buildTarball(opts: {
  name: string;
  version?: string;
  kind?: string | null;
  marker?: string;
}): Promise<{ bytes: Buffer; sri: string; digest: string }> {
  const srcRoot = await mkdtemp(path.join(workDir, "src-"));
  const pkgDir = path.join(srcRoot, "package");
  await mkdir(pkgDir, { recursive: true });
  const cinatra: Record<string, unknown> = {
    serverEntry: "./register.mjs",
    requestedHostPorts: [],
    sdkAbiRange: "^2",
  };
  if (opts.kind !== null) cinatra.kind = opts.kind ?? "connector";
  await writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: opts.name, version: opts.version ?? "1.0.0", cinatra }),
  );
  await writeFile(path.join(pkgDir, "register.mjs"), REGISTER_MJS + (opts.marker ? `// ${opts.marker}\n` : ""));
  const tgz = path.join(srcRoot, "pkg.tgz");
  await tar.c({ gzip: true, cwd: srcRoot, file: tgz }, ["package"]);
  const bytes = await readFile(tgz);
  return { bytes, sri: sriForBytes(bytes, "sha512"), digest: tarballDigestSegment(bytes) };
}

function fetcher(bytes: Buffer, sri: string) {
  return { fetchTarball: async () => ({ bytes, integrity: sri }) };
}

describe("V2 target layout", () => {
  it("materializes to <root>/<kind>/<slug>/<digest> with the .tgz sibling + sidecar; discovery sees it", async () => {
    const root = path.join(workDir, "root-layout");
    const PKG = "@cinatra-ai/v2-layout-fixture";
    const { bytes, sri, digest } = await buildTarball({ name: PKG });
    const mat = await materializePackageToStore(
      { packageName: PKG, version: "1.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root },
      fetcher(bytes, sri),
    );
    expect(mat.kind).toBe("connector");
    expect(mat.digest).toBe(digest);
    expect(mat.storeDir).toBe(
      path.join(root, "connector", "@cinatra-ai", "v2-layout-fixture", digest),
    );
    expect((await stat(`${mat.storeDir}.tgz`)).isFile()).toBe(true);
    expect(await readStoreSidecar(mat.storeDir)).toMatchObject({
      packageName: PKG,
      version: "1.0.0",
      tarballDigest: digest,
    });
    const records = await discoverStoreRecordsV2(root);
    expect(records.map((r) => [r.packageName, r.kind])).toEqual([[PKG, "connector"]]);
    // staging lives under <root>/.staging and leaves no residue.
    const staging = await readdir(path.join(root, STORE_STAGING_DIRNAME)).catch(() => []);
    expect(staging).toEqual([]);
  });

  it("reuses a valid existing same-digest dir (reused:true, dir untouched)", async () => {
    const root = path.join(workDir, "root-reuse");
    const PKG = "@cinatra-ai/v2-reuse-fixture";
    const { bytes, sri } = await buildTarball({ name: PKG });
    const first = await materializePackageToStore(
      { packageName: PKG, version: "1.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root },
      fetcher(bytes, sri),
    );
    expect(first.reused).toBe(false);
    const sidecarBefore = await readFile(path.join(first.storeDir, STORE_SIDECAR_FILENAME), "utf8");
    const again = await materializePackageToStore(
      { packageName: PKG, version: "1.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root },
      fetcher(bytes, sri),
    );
    expect(again.reused).toBe(true);
    expect(again.storeDir).toBe(first.storeDir);
    expect(again.contentHash).toBe(first.contentHash);
    // the existing dir was REUSED, not replaced: sidecar bytes identical.
    expect(await readFile(path.join(first.storeDir, STORE_SIDECAR_FILENAME), "utf8")).toBe(sidecarBefore);
  });
});

describe("identity binding (manifest name+version == requested install)", () => {
  it("refuses a tarball whose manifest name differs from the requested package", async () => {
    const root = path.join(workDir, "root-name-bind");
    const { bytes, sri } = await buildTarball({ name: "@cinatra-ai/actual-name" });
    await expect(
      materializePackageToStore(
        { packageName: "@cinatra-ai/claimed-name", version: "1.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root },
        fetcher(bytes, sri),
      ),
    ).rejects.toThrow(/must bind the exact requested install/);
  });

  it("refuses a tarball whose manifest version differs from the requested version", async () => {
    const root = path.join(workDir, "root-ver-bind");
    const PKG = "@cinatra-ai/v2-ver-fixture";
    const { bytes, sri } = await buildTarball({ name: PKG, version: "1.0.0" });
    await expect(
      materializePackageToStore(
        { packageName: PKG, version: "2.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root },
        fetcher(bytes, sri),
      ),
    ).rejects.toThrow(/must bind the exact requested install/);
  });
});

describe("kind resolution (caller authoritative, manifest cross-checked, no default)", () => {
  it("refuses when neither expectedKind nor manifest cinatra.kind exists", async () => {
    const root = path.join(workDir, "root-nokind");
    const PKG = "@cinatra-ai/v2-nokind-fixture";
    const { bytes, sri } = await buildTarball({ name: PKG, kind: null });
    await expect(
      materializePackageToStore(
        { packageName: PKG, version: "1.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root },
        fetcher(bytes, sri),
      ),
    ).rejects.toThrow(/no extension kind/);
  });

  it("caller expectedKind places a kind-less manifest", async () => {
    const root = path.join(workDir, "root-callerkind");
    const PKG = "@cinatra-ai/v2-callerkind-fixture";
    const { bytes, sri } = await buildTarball({ name: PKG, kind: null });
    const mat = await materializePackageToStore(
      { packageName: PKG, version: "1.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root, expectedKind: "workflow" },
      fetcher(bytes, sri),
    );
    expect(mat.kind).toBe("workflow");
    expect(mat.storeDir).toContain(path.join(root, "workflow"));
  });

  it("refuses a manifest kind that contradicts the caller's expectedKind", async () => {
    const root = path.join(workDir, "root-kindclash");
    const PKG = "@cinatra-ai/v2-kindclash-fixture";
    const { bytes, sri } = await buildTarball({ name: PKG, kind: "connector" });
    await expect(
      materializePackageToStore(
        { packageName: PKG, version: "1.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root, expectedKind: "workflow" },
        fetcher(bytes, sri),
      ),
    ).rejects.toThrow(/contradicts the caller's expected kind/);
  });

  it("refuses an unknown manifest kind", async () => {
    const root = path.join(workDir, "root-unknownkind");
    const PKG = "@cinatra-ai/v2-unknownkind-fixture";
    const { bytes, sri } = await buildTarball({ name: PKG, kind: "gizmo" });
    await expect(
      materializePackageToStore(
        { packageName: PKG, version: "1.0.0", expectedIntegrity: sri, registryUrl: REGISTRY, storeRoot: root },
        fetcher(bytes, sri),
      ),
    ).rejects.toThrow(/not a known extension kind/);
  });
});
