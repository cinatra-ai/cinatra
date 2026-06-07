import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { sriForBytes } from "@/lib/extension-package-store-core";
import { materializePackageToStore } from "@/lib/extension-package-store";
import { resolveInstallAnchor } from "@/lib/extension-install-anchor";
import { loadRuntimePackageExtensions } from "@/lib/runtime-package-loader";
import { generateExtensionSigningKeyPair, signExtension } from "@/lib/extension-signature";

// SIGNED install E2E through the REAL loader. Proves the signing
// trust gate end-to-end: a correctly-signed extension activates under
// CINATRA_EXTENSION_REQUIRE_SIGNATURES=true; an unsigned or wrong-key install is
// refused. Same loader path the prod container runs (extension-signature.ts →
// resolveSignatureVerdict → classifyExtensionTrust). No registry, no publish.

const PKG = "@cinatra-ai/signed-e2e-fixture";
const VERSION = "1.0.0";
// The live catalog (the 79 cinatra-ai extensions) is pinned at 0.1.0 — the
// install path must resolve a CONCRETE pinned version, not only "latest". This
// fixture mirrors that shape so the version-aware signed-install gate is proven
// against a 0.1.0-shaped packument/source (still locally-packed, no registry).
const CATALOG_VERSION = "0.1.0";
const REGISTRY = "https://registry.cinatra.ai";
const REGISTER_MJS = `export function register(ctx) { ctx.logger.info("signed-e2e fixture registered"); }\n`;

type PackedFixture = { bytes: Buffer; integrity: string; version: string };

let workDir: string;
let tarballBytes: Buffer;
let integrity: string;
let catalogFixture: PackedFixture;
const kp = generateExtensionSigningKeyPair();
const wrongKp = generateExtensionSigningKeyPair();
const savedEnv = {
  pub: process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS,
  req: process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES,
};

async function packFixture(version: string): Promise<PackedFixture> {
  const src = path.join(workDir, `src-${version}`, "package");
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, "package.json"),
    JSON.stringify({ name: PKG, version, cinatra: { kind: "connector", serverEntry: "./register.mjs", sdkAbiRange: "^2" } }),
  );
  await writeFile(path.join(src, "register.mjs"), REGISTER_MJS);
  const out = path.join(workDir, `fixture-${version}.tgz`);
  await tar.c({ gzip: true, cwd: path.join(workDir, `src-${version}`), file: out }, ["package"]);
  const bytes = await readFile(out);
  return { bytes, integrity: sriForBytes(bytes, "sha512"), version };
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "cinatra-signed-e2e-"));
  const base = await packFixture(VERSION);
  tarballBytes = base.bytes;
  integrity = base.integrity;
  catalogFixture = await packFixture(CATALOG_VERSION);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  // restore env so one case never leaks into the next / other suites
  if (savedEnv.pub === undefined) delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
  else process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = savedEnv.pub;
  if (savedEnv.req === undefined) delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  else process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = savedEnv.req;
});

async function materializeAndLoad(opts: { signature?: string | null; requireSignatures: boolean; trustedPubKeys?: string[]; fixture?: PackedFixture }) {
  const fx = opts.fixture ?? { bytes: tarballBytes, integrity, version: VERSION };
  const storeRoot = path.join(workDir, `store-${Math.random().toString(36).slice(2)}`, "extensions", "packages");
  const mat = await materializePackageToStore(
    { packageName: PKG, version: fx.version, expectedIntegrity: fx.integrity, registryUrl: REGISTRY, storeRoot },
    { fetchTarball: async () => ({ bytes: fx.bytes, integrity: fx.integrity }), now: () => "2026-06-04T00:00:00.000Z" },
  );
  process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = opts.requireSignatures ? "true" : "false";
  if (opts.trustedPubKeys) process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = opts.trustedPubKeys.join(",");
  else delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;

  const resolver = (packageName: string) =>
    resolveInstallAnchor(packageName, {
      orgId: null,
      readActiveInstall: async () => ({
        status: "active",
        source: { type: "verdaccio", registryUrl: REGISTRY, integrity: mat.integrity, contentHash: mat.contentHash, version: fx.version, signature: opts.signature ?? undefined },
      }),
      readGrant: async () => ({ status: "approved", approvedPorts: [], orgId: null }),
      readInstallOp: async () => ({ phase: "finalized" }),
    });
  return loadRuntimePackageExtensions(storeRoot, { resolveInstallAnchor: resolver });
}

describe("signed install E2E (real loader)", () => {
  it("REQUIRE_SIGNATURES=true: a correctly-signed extension ACTIVATES from /data", async () => {
    const signature = signExtension({ packageName: PKG, version: VERSION, integrity }, kp.privateKeyPkcs8DerB64);
    const acts = await materializeAndLoad({ signature, requireSignatures: true, trustedPubKeys: [kp.publicKeyDerB64] });
    expect(acts.some((a) => a.packageName === PKG && a.status === "registered")).toBe(true);
  });

  it("REQUIRE_SIGNATURES=true: an UNSIGNED install is REFUSED (zero activations)", async () => {
    const acts = await materializeAndLoad({ signature: null, requireSignatures: true, trustedPubKeys: [kp.publicKeyDerB64] });
    expect(acts).toHaveLength(0);
  });

  it("a WRONG-KEY signature is REFUSED even when signatures are not required", async () => {
    const badSig = signExtension({ packageName: PKG, version: VERSION, integrity }, wrongKp.privateKeyPkcs8DerB64);
    const acts = await materializeAndLoad({ signature: badSig, requireSignatures: false, trustedPubKeys: [kp.publicKeyDerB64] });
    expect(acts).toHaveLength(0);
  });

  it("no signing configured (no keys, not required): unsigned still activates (additive — today's behavior)", async () => {
    const acts = await materializeAndLoad({ signature: null, requireSignatures: false });
    expect(acts.some((a) => a.packageName === PKG && a.status === "registered")).toBe(true);
  });
});

describe("version-aware signed install E2E (real loader, 0.1.0 catalog shape)", () => {
  it("REQUIRE_SIGNATURES=true: a correctly-signed CONCRETE-version (0.1.0) extension ACTIVATES from /data", async () => {
    // Sign the EXACT pinned version + integrity (the payload binds packageName,
    // version, integrity) — proves version-aware resolution still activates a
    // correctly-signed package at the live-catalog version, not only "latest".
    const signature = signExtension(
      { packageName: PKG, version: catalogFixture.version, integrity: catalogFixture.integrity },
      kp.privateKeyPkcs8DerB64,
    );
    const acts = await materializeAndLoad({ signature, requireSignatures: true, trustedPubKeys: [kp.publicKeyDerB64], fixture: catalogFixture });
    expect(acts.some((a) => a.packageName === PKG && a.status === "registered")).toBe(true);
  });

  it("REQUIRE_SIGNATURES=true: an UNSIGNED same-version (0.1.0) install is REFUSED (zero activations)", async () => {
    const acts = await materializeAndLoad({ signature: null, requireSignatures: true, trustedPubKeys: [kp.publicKeyDerB64], fixture: catalogFixture });
    expect(acts).toHaveLength(0);
  });

  it("a 1.0.0-version signature does NOT validate a 0.1.0 install (version is bound into the payload) — REFUSED", async () => {
    // ISOLATE the version field: sign the WRONG version (1.0.0) but the CORRECT
    // 0.1.0 integrity, then install the 0.1.0 fixture. Only the version field
    // mismatches the payload the verifier recomputes — so this case fails iff
    // version is part of the signed payload. (Signing the 1.0.0 integrity too
    // would let an integrity mismatch alone cause the refusal, and the test would
    // still pass even if version were dropped from the payload — defeating its
    // purpose.) Key is trusted, integrity matches → refusal proves version-binding.
    const wrongVersionSig = signExtension(
      { packageName: PKG, version: VERSION, integrity: catalogFixture.integrity },
      kp.privateKeyPkcs8DerB64,
    );
    const acts = await materializeAndLoad({ signature: wrongVersionSig, requireSignatures: true, trustedPubKeys: [kp.publicKeyDerB64], fixture: catalogFixture });
    expect(acts).toHaveLength(0);
  });
});
