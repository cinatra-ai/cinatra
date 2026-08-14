// cinatra#2747 — the package-store INSTALL INTEGRITY check for runtime
// dependencies, proved at the MATERIALIZER seam (not just over the pure
// verdict function) for BOTH dependency shapes a published tarball can carry:
//
//   shape A — declared AND bundled (`node_modules/<dep>` inside the tarball):
//             materializes, and the bundled tree survives into the store dir;
//   shape B — declared and NOT bundled: REFUSED, fail-closed, with the
//             offending dependency NAMED in the message (the diagnosability
//             half the issue asks to keep).
//
// Plus the two boundary shapes that decide the fix's contract question:
//   - a signed materialization plan is the ONLY other satisfier the verifier
//     can accept, and it is only reachable when the plan is threaded in;
//   - a HOST-PROVIDED SDK peer in `dependencies` is refused in every shape.
//
// The grounded verdict recorded by these tests: what the verifier can actually
// verify about shape B is NOTHING — the tarball bytes carry no dependency and
// no publish path emits a signed plan today — so the packaging contract, not
// the installer, has to guarantee shape A. See
// `scripts/extensions/build-server-entry.mjs` (inline mode inlines-and-prunes
// on EVERY emit path + the packed-manifest self-check).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { materializePackageToStore, type FetchTarball } from "@/lib/extension-package-store";
import { sriForBytes, validateBundledDependencies, HOST_PROVIDED_PACKAGES } from "@/lib/extension-package-store-core";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-store-runtime-deps-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

const EXT = "@cinatra-test/runtime-deps-ext";
const VER = "1.0.0";

/** npm-layout tarball (`package/…`) from a manifest + a relative-path file map. */
async function makeTarball(manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<Buffer> {
  const src = await mkdtemp(path.join(workDir, "tgz-"));
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

function manifestFor(dependencies: Record<string, string>): Record<string, unknown> {
  return {
    name: EXT,
    version: VER,
    dependencies,
    cinatra: { kind: "connector", serverEntry: "./register.mjs" },
  };
}

/** The entry the store's built-artifact gate accepts: importable, no bare imports. */
const ENTRY = 'export function register() { return "ok"; }\n';

async function materialize(bytes: Buffer, storeRoot: string) {
  const fetchTarball: FetchTarball = async () => ({ bytes, integrity: sriForBytes(bytes) });
  return materializePackageToStore(
    {
      packageName: EXT,
      version: VER,
      expectedIntegrity: sriForBytes(bytes),
      registryUrl: "https://registry.cinatra.ai",
      storeRoot,
      expectedKind: "connector",
    },
    { fetchTarball, now: () => "2026-08-14T00:00:00.000Z" },
  );
}

describe("package-store install integrity — runtime dependency shapes (cinatra#2747)", () => {
  it("shape A: a declared dependency BUNDLED in the tarball materializes, and the bundled tree lands in the store", async () => {
    const bytes = await makeTarball(manifestFor({ "left-pad": "^1.3.0" }), {
      "register.mjs": ENTRY,
      "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", version: "1.3.0", main: "./index.js" }),
      "node_modules/left-pad/index.js": "module.exports = () => 'padded';\n",
    });
    const storeRoot = await mkdtemp(path.join(workDir, "store-a-"));
    const mat = await materialize(bytes, storeRoot);
    expect(existsSync(path.join(mat.storeDir, "node_modules", "left-pad", "index.js"))).toBe(true);
    expect(existsSync(path.join(mat.storeDir, "register.mjs"))).toBe(true);
  });

  it("shape A holds for a SCOPED bundled dependency (the `@scope/name` path split is a real placement)", async () => {
    const bytes = await makeTarball(manifestFor({ "@acme/util": "^2.0.0" }), {
      "register.mjs": ENTRY,
      "node_modules/@acme/util/package.json": JSON.stringify({ name: "@acme/util", version: "2.0.0" }),
    });
    const storeRoot = await mkdtemp(path.join(workDir, "store-a-scoped-"));
    const mat = await materialize(bytes, storeRoot);
    expect(existsSync(path.join(mat.storeDir, "node_modules", "@acme", "util", "package.json"))).toBe(true);
  });

  it("shape B: a declared dependency that is NOT bundled is REFUSED, and the message NAMES it", async () => {
    const bytes = await makeTarball(manifestFor({ "server-only": "^0.0.1" }), { "register.mjs": ENTRY });
    const storeRoot = await mkdtemp(path.join(workDir, "store-b-"));
    await expect(materialize(bytes, storeRoot)).rejects.toThrow(
      /runtime dependencies are neither bundled in the tarball nor covered by a signed materialization plan \(server-only\)/,
    );
  });

  it("shape B names EVERY offending dependency, not just the first (the fleet-wide control shape)", async () => {
    const bytes = await makeTarball(manifestFor({ "server-only": "^0.0.1", zod: "^4.4.3" }), {
      "register.mjs": ENTRY,
    });
    const storeRoot = await mkdtemp(path.join(workDir, "store-b2-"));
    await expect(materialize(bytes, storeRoot)).rejects.toThrow(/\(server-only, zod\)/);
  });

  it("shape B is refused per-dependency: bundling one of two still fails, naming only the missing one", async () => {
    const bytes = await makeTarball(manifestFor({ "left-pad": "^1.3.0", zod: "^4.4.3" }), {
      "register.mjs": ENTRY,
      "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", version: "1.3.0" }),
    });
    const storeRoot = await mkdtemp(path.join(workDir, "store-b3-"));
    await expect(materialize(bytes, storeRoot)).rejects.toThrow(/materialization plan \(zod\)/);
  });

  it("shape B writes NOTHING under the store root — the refusal is fail-closed, not a partial install", async () => {
    const bytes = await makeTarball(manifestFor({ zod: "^4.4.3" }), { "register.mjs": ENTRY });
    const storeRoot = await mkdtemp(path.join(workDir, "store-b4-"));
    await expect(materialize(bytes, storeRoot)).rejects.toThrow();
    expect(existsSync(path.join(storeRoot, "connector"))).toBe(false);
  });

  it("no runtime dependencies at all is the clean published shape inline mode produces", async () => {
    const bytes = await makeTarball(
      { name: EXT, version: VER, cinatra: { kind: "connector", serverEntry: "./register.mjs" } },
      { "register.mjs": ENTRY },
    );
    const storeRoot = await mkdtemp(path.join(workDir, "store-clean-"));
    const mat = await materialize(bytes, storeRoot);
    expect(existsSync(path.join(mat.storeDir, "register.mjs"))).toBe(true);
  });

  it("a HOST-PROVIDED SDK peer in `dependencies` is refused with its OWN direction (peerDependencies), never the missing-dep message", async () => {
    const bytes = await makeTarball(manifestFor({ "@cinatra-ai/sdk-extensions": "^2.0.0" }), {
      "register.mjs": ENTRY,
    });
    const storeRoot = await mkdtemp(path.join(workDir, "store-peer-"));
    await expect(materialize(bytes, storeRoot)).rejects.toThrow(
      /host-provided SDK package\(s\) in "dependencies" \(@cinatra-ai\/sdk-extensions\)/,
    );
  });

  it("the ONLY two satisfiers the verifier accepts are bundled-presence and a plan ROOT — nothing else", () => {
    const pkg = { dependencies: { "server-only": "^0.0.1" } };
    // Neither: refused, named.
    expect(validateBundledDependencies(pkg, new Set())).toEqual({
      ok: false,
      missing: ["server-only"],
      hostProvidedInDeps: [],
    });
    // Bundled: accepted.
    expect(validateBundledDependencies(pkg, new Set(["server-only"]))).toEqual({ ok: true });
    // Plan root: accepted — but ONLY when a plan was threaded (null = closure-less).
    expect(validateBundledDependencies(pkg, new Set(), new Set(["server-only"]))).toEqual({ ok: true });
    expect(validateBundledDependencies(pkg, new Set(), null)).toMatchObject({ ok: false, missing: ["server-only"] });
    // `bundledDependencies` is NOT a satisfier anywhere in the contract: the
    // gate reads the tarball's physical node_modules, never a manifest field.
    expect(
      validateBundledDependencies({ ...pkg, bundledDependencies: ["server-only"] }, new Set()),
    ).toMatchObject({ ok: false, missing: ["server-only"] });
    // Host peers are not satisfiable by bundling either.
    for (const peer of HOST_PROVIDED_PACKAGES) {
      expect(validateBundledDependencies({ dependencies: { [peer]: "*" } }, new Set([peer]))).toMatchObject({
        ok: false,
        hostProvidedInDeps: [peer],
      });
    }
  });
});
