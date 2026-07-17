/**
 * INSTALL ADMISSION caller for runtime artifact-renderer client bundles (epic
 * #1620 M1 Slice B, cinatra#1630 §3.1). Proves the "no admission caller" dormancy
 * gap is closed: a published client-bundle manifest drives the FULL atomic
 * admission chain and — on a green verdict — activates the runtime binding so the
 * two-path predicate resolves it `loadable`. Fail-closed on EVERY verification
 * miss (unsigned / wrong-key / tampered bytes / bad digest / integrity mismatch).
 *
 * Uses a REAL Ed25519 keypair + the REAL signer payload + a REAL on-disk store
 * fixture — the security-critical verification runs for real, not mocked.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildClientBundleSignaturePayload,
  type AdmittedClientBundleTuple,
} from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import { admitRuntimeArtifactRenderersForStoreDir } from "@/lib/artifacts/admit-runtime-artifact-renderers";

const PKG = "@cinatra-ai/json-artifact";
const BUNDLE_BYTES = Buffer.from("export default function JsonArtifact(){return null}\n", "utf8");

function sha512Hex(b: Buffer): string {
  return createHash("sha512").update(b).digest("hex");
}
function sha512Sri(b: Buffer): string {
  return `sha512-${createHash("sha512").update(b).digest("base64")}`;
}

// One shared keypair for the suite; the public key is the host trust root.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_DER_B64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: PKG,
    slot: "detail",
    digest: sha512Hex(BUNDLE_BYTES),
    entry: "bundle.js",
    propsApiVersion: 1,
    sdkAbiRange: "^2.4.0",
    reactPeerRange: "^19.0.0",
    reactDomPeerRange: "^19.0.0",
    tokenModuleAbi: "1.0.0",
    ...over,
  };
}

function signBundle(t: AdmittedClientBundleTuple, integrity: string): string {
  const payload = buildClientBundleSignaturePayload({ ...t, integrity });
  return cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
}

let storeDir: string;
let dataRoot: string;

/** Write a published-package store dir: a top-level client-bundle manifest +
 * its bundle bytes, exactly as the client-bundle builder's `--out` emits. */
function writeManifest(opts: {
  tuple: AdmittedClientBundleTuple;
  integrity: string;
  signature: string | null;
  bytes?: Buffer;
}): void {
  writeFileSync(path.join(storeDir, opts.tuple.entry), opts.bytes ?? BUNDLE_BYTES);
  writeFileSync(
    path.join(storeDir, "client-bundle.manifest.json"),
    JSON.stringify({ tuple: opts.tuple, integrity: opts.integrity, signature: opts.signature, scheme: "cinatra-artifact-client-bundle/v1" }),
  );
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "admit-renderer-"));
  storeDir = path.join(base, "store");
  dataRoot = path.join(base, "data");
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  process.env.CINATRA_EXTENSION_DATA_ROOT = dataRoot;
  process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = PUBLIC_KEY_DER_B64;
  process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES = "true";
  runtimeAssetRegistry._clearForTests();
});

afterEach(() => {
  runtimeAssetRegistry._clearForTests();
  delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
  delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  try {
    rmSync(path.dirname(storeDir), { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

describe("admitRuntimeArtifactRenderersForStoreDir — the full admission chain", () => {
  it("a signed, integrity-clean bundle ADMITS + activates the runtime binding + materializes into the CAS store", async () => {
    const t = tuple();
    const integrity = sha512Sri(BUNDLE_BYTES);
    writeManifest({ tuple: t, integrity, signature: signBundle(t, integrity) });

    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes).toEqual([{ packageName: PKG, slot: "detail", digest: t.digest, ok: true }]);

    // The runtime binding is now the ACTIVE admitted tuple → loadable.
    expect(runtimeAssetRegistry.isActiveTuple(t)).toBe(true);
    expect(runtimeAssetRegistry.inRuntimeAssetRegistry(runtimeAssetRegistry.keyFor(PKG, "detail"))).toBe(true);

    // Materialized into the content-addressed serving store (<root>/artifact/<slug>/<digest>/<entry>).
    const served = path.join(dataRoot, "artifact", "cinatra-ai", "json-artifact", t.digest, "bundle.js");
    expect(existsSync(served)).toBe(true);
    expect(readFileSync(served)).toEqual(BUNDLE_BYTES);
  });

  it("an UNSIGNED bundle is REFUSED (fail-closed — a dynamic in-page renderer requires a genuine verification)", async () => {
    const t = tuple();
    const integrity = sha512Sri(BUNDLE_BYTES);
    writeManifest({ tuple: t, integrity, signature: null });

    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.reason).toBe("verify-failed");
    expect(runtimeAssetRegistry.isActiveTuple(t)).toBe(false);
  });

  it("a WRONG-KEY signature is REFUSED (verify-failed)", async () => {
    const t = tuple();
    const integrity = sha512Sri(BUNDLE_BYTES);
    const otherKey = generateKeyPairSync("ed25519").privateKey;
    const wrongSig = cryptoSign(null, Buffer.from(buildClientBundleSignaturePayload({ ...t, integrity }), "utf8"), otherKey).toString("base64");
    writeManifest({ tuple: t, integrity, signature: wrongSig });

    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.reason).toBe("verify-failed");
    expect(runtimeAssetRegistry.isActiveTuple(t)).toBe(false);
  });

  it("TAMPERED bytes (bytes != tuple.digest) are REFUSED and never materialized", async () => {
    // Sign the ORIGINAL tuple, but ship DIFFERENT bytes on disk.
    const t = tuple();
    const integrity = sha512Sri(BUNDLE_BYTES);
    const sig = signBundle(t, integrity);
    const tampered = Buffer.from("export default function Evil(){return null}\n", "utf8");
    writeManifest({ tuple: t, integrity, signature: sig, bytes: tampered });

    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes[0]?.ok).toBe(false);
    // Integrity is the materialize root of trust → mismatch throws in materialize.
    expect(outcomes[0]?.reason).toBe("materialize-failed");
    expect(runtimeAssetRegistry.isActiveTuple(t)).toBe(false);
    // Nothing written into the CAS for a tampered bundle.
    expect(existsSync(path.join(dataRoot, "artifact", "cinatra-ai", "json-artifact", t.digest, "bundle.js"))).toBe(false);
  });

  it("an INTEGRITY-mismatched manifest (wrong SRI) is REFUSED at materialize", async () => {
    const t = tuple();
    const wrongIntegrity = sha512Sri(Buffer.from("something-else", "utf8"));
    // Sign the wrong-integrity fields so the signature itself is valid — the
    // integrity ROOT OF TRUST must still reject at materialize.
    writeManifest({ tuple: t, integrity: wrongIntegrity, signature: signBundle(t, wrongIntegrity) });

    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.reason).toBe("materialize-failed");
    expect(runtimeAssetRegistry.isActiveTuple(t)).toBe(false);
  });

  it("a package that ships NO client bundle is a clean no-op", async () => {
    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes).toEqual([]);
  });

  it("POISONING GUARD: bytes that do not hash to tuple.digest never overwrite an already-active digest's CAS entry", async () => {
    // 1. Admit a LEGITIMATE bundle at its real digest.
    const legit = tuple();
    const integrity = sha512Sri(BUNDLE_BYTES);
    writeManifest({ tuple: legit, integrity, signature: signBundle(legit, integrity) });
    expect((await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir }))[0]?.ok).toBe(true);
    const servedLegit = path.join(dataRoot, "artifact", "cinatra-ai", "json-artifact", legit.digest, "bundle.js");
    expect(readFileSync(servedLegit)).toEqual(BUNDLE_BYTES);

    // 2. An attacker manifest targets the ALREADY-ACTIVE legit digest with
    //    malicious bytes whose SRI it also controls (so the integrity check would
    //    pass) — the digest content-address check must reject BEFORE any write.
    const malicious = Buffer.from("export default function Evil(){window.pwn=1;return null}\n", "utf8");
    const attacker = tuple({ digest: legit.digest }); // points at the live digest
    const attackerIntegrity = sha512Sri(malicious); // attacker controls integrity
    writeManifest({ tuple: attacker, integrity: attackerIntegrity, signature: signBundle(attacker, attackerIntegrity), bytes: malicious });

    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.reason).toBe("materialize-failed");
    // The live bundle at the legit digest is UNTOUCHED (not poisoned).
    expect(readFileSync(servedLegit)).toEqual(BUNDLE_BYTES);
  });

  it("TRAVERSAL GUARD: a `..` entry is refused as invalid-manifest before any filesystem access", async () => {
    const t = tuple({ entry: "../../../../etc/evil.js" });
    const integrity = sha512Sri(BUNDLE_BYTES);
    // Write ONLY the manifest (never the bundle at the traversal path) — the guard
    // must refuse from the manifest alone, before any read/write.
    writeFileSync(
      path.join(storeDir, "client-bundle.manifest.json"),
      JSON.stringify({ tuple: t, integrity, signature: signBundle(t, integrity), scheme: "cinatra-artifact-client-bundle/v1" }),
    );

    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.reason).toBe("invalid-manifest");
    expect(runtimeAssetRegistry.isActiveTuple(t)).toBe(false);
  });

  it("a manifest whose package does not match the store dir's package is REFUSED (invalid-manifest)", async () => {
    const t = tuple({ packageName: "@evil/imposter", digest: sha512Hex(BUNDLE_BYTES) });
    const integrity = sha512Sri(BUNDLE_BYTES);
    writeManifest({ tuple: t, integrity, signature: signBundle(t, integrity) });

    const outcomes = await admitRuntimeArtifactRenderersForStoreDir({ packageName: PKG, storeDir });
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.reason).toBe("invalid-manifest");
  });
});
