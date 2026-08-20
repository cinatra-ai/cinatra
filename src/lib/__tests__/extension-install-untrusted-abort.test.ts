// The pipeline acceptance item: an untrusted or unactivatable install must
// abort BEFORE any durable mutation.
//
// The hole this closes: the trust verdict was computed before durable mutation,
// but the activation probe only ran when the verdict was ALREADY trusted, and it
// only aborted for an UPDATE. So an untrusted fresh install skipped the probe
// entirely, walked past the journal, the grant and the provenance write, and
// finalized. The refusal surfaced afterwards, leaving a live finalized row that
// could never serve and that held the package identity away from the version
// bundled in the image.
//
// These tests assert the durable seams were never reached. That is the whole
// point: not that an error was thrown, but that nothing was written before it.
import { describe, it, expect, afterEach } from "vitest";
import {
  installExtensionFromRegistry,
  makeTestInstallPipelineDeps,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import {
  UNTRUSTED_INSTALL_REFUSED,
  UntrustedInstallRefusedError,
} from "@/lib/extension-trust";
import { sriForBytes } from "@/lib/extension-package-store-core";
import {
  generateExtensionSigningKeyPair,
  signExtension,
} from "@/lib/extension-signature";

const REGISTRY = "https://registry.cinatra.ai";
const PKG = "@cinatra-ai/google-appointment-schedules-connector";
const VER = "0.1.1";
const INTEGRITY = sriForBytes(Buffer.from("the-extension-tarball"));

/** Every DURABLE seam the pipeline can touch, recorded so a test can assert the
 *  refusal happened before all of them. */
function harness(overrides: Partial<InstallPipelineDeps> = {}) {
  const durable = {
    beginInstallOp: [] as unknown[],
    recordProvenance: [] as unknown[],
    recordRequestedGrant: [] as unknown[],
    approveGrant: [] as unknown[],
    finalizeInstallOp: [] as unknown[],
    persistDependencyEdges: [] as unknown[],
  };
  const gcd: string[] = [];
  const deps: InstallPipelineDeps = {
    ...makeTestInstallPipelineDeps(),
    resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY }),
    materialize: async () => ({
      storeDir: "/store/dir",
      digest: "dgst",
      integrity: INTEGRITY,
      contentHash: "ch",
    }),
    readRequestedPorts: async () => [],
    // This suite is ABOUT the trust gate, so it states the host policy instead
    // of inheriting the permissive fixture default.
    trustedActivationHosts: () => [],
    allowMarketplaceBootstrapTrust: () => false,
    gcStoreDir: async (d) => {
      gcd.push(d);
    },
    beginInstallOp: async (i) => {
      durable.beginInstallOp.push(i);
    },
    recordProvenance: async (i) => {
      durable.recordProvenance.push(i);
    },
    recordRequestedGrant: async (i) => {
      durable.recordRequestedGrant.push(i);
    },
    approveGrant: async (i) => {
      durable.approveGrant.push(i);
    },
    finalizeInstallOp: async (i) => {
      durable.finalizeInstallOp.push(i);
    },
    persistDependencyEdges: async (i) => {
      durable.persistDependencyEdges.push(i);
    },
    ...overrides,
  };
  return { deps, durable, gcd };
}

const nothingWritten = (durable: Record<string, unknown[]>) =>
  Object.entries(durable).filter(([, calls]) => calls.length > 0).map(([seam]) => seam);

/** The host policy for the cases where the REGISTRY is admitted and only the
 *  package's own activation is under test. */
const trustsTheRegistry = {
  trustedActivationHosts: () => ["registry.cinatra.ai"],
  allowMarketplaceBootstrapTrust: () => true,
};

afterEach(() => {
  delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
});

describe("install pipeline: an UNTRUSTED fresh install never commits", () => {
  it("refuses before the journal, the grant, the provenance and the finalize", async () => {
    // No deployment registry configured, so the activation allow-list is empty
    // and the classifier refuses this package outright.
    const { deps, durable, gcd } = harness();

    await expect(
      installExtensionFromRegistry(
        { packageName: PKG, version: VER, orgId: "org-1" },
        deps,
      ),
    ).rejects.toThrow(/refused before anything was committed/i);

    // The load-bearing assertion: NOTHING durable ran.
    expect(nothingWritten(durable)).toEqual([]);
    // And the bytes it had already materialized are gone.
    expect(gcd).toEqual(["/store/dir"]);
  });

  it("carries the stable code and the EXACT classifier verdict, not a generic summary", async () => {
    const { deps } = harness();
    const err = await installExtensionFromRegistry(
      { packageName: PKG, version: VER, orgId: "org-1" },
      deps,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UntrustedInstallRefusedError);
    const typed = err as UntrustedInstallRefusedError;
    expect(typed.code).toBe(UNTRUSTED_INSTALL_REFUSED);
    expect(typed.packageName).toBe(PKG);
    expect(typed.operation).toBe("install");
    // "anchor-refused" hid WHICH condition failed. The refusal must carry one of
    // the classifier's OWN verdicts instead, so an operator learns what to fix.
    // Which one depends on how this host is configured; that it is a precise
    // verdict and never the generic summary is the contract.
    expect(typed.verdictReason).toMatch(
      /not a trusted activation host|signature required|did not verify|no persisted host trust decision/i,
    );
    expect(typed.verdictReason).not.toMatch(/anchor-refused/i);
    expect(typed.message).not.toMatch(/anchor-refused/i);
    // The verdict is threaded into the message the operator actually reads.
    expect(typed.message).toContain(typed.verdictReason);
  });

  it("says the bundled version is still in service, because it is", async () => {
    const { deps } = harness();
    const err = await installExtensionFromRegistry(
      { packageName: PKG, version: VER, orgId: "org-1" },
      deps,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/bundled in the image stays in service/i);
  });

  it("a signature that does NOT verify is refused the same way", async () => {
    const wrongKey = generateExtensionSigningKeyPair();
    const otherKey = generateExtensionSigningKeyPair();
    const sig = signExtension(
      { packageName: PKG, version: VER, integrity: INTEGRITY },
      wrongKey.privateKeyPkcs8DerB64,
    );
    // The host trusts a DIFFERENT key, so the present signature cannot verify.
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = otherKey.publicKeyDerB64;
    const { deps, durable } = harness({
      ...trustsTheRegistry,
      resolveIntegrity: async () => ({
        integrity: INTEGRITY,
        registryUrl: REGISTRY,
        signature: sig,
      }),
    });

    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: "org-1" }, deps),
    ).rejects.toThrow(/refused before anything was committed/i);
    expect(nothingWritten(durable)).toEqual([]);
  });
});

describe("install pipeline: a FRESH install that cannot activate never commits", () => {
  it("the pre-finalize probe now runs for a fresh install and aborts it", async () => {
    // Trusted bytes, but the probe proves the module does not register.
    const { deps, durable, gcd } = harness({
      ...trustsTheRegistry,
      // supersedes:false is the FRESH install shape. It used to mean "skip".
      verifyActivatableBeforeFinalize: async () => ({
        supersedes: false,
        ok: false,
        reason: "register() threw",
      }),
    });

    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: "org-1" }, deps),
    ).rejects.toThrow(/could not activate/i);

    expect(nothingWritten(durable)).toEqual([]);
    expect(gcd).toEqual(["/store/dir"]);
  });

  it("the fresh-install refusal states that nothing was committed", async () => {
    const { deps } = harness({
      ...trustsTheRegistry,
      verifyActivatableBeforeFinalize: async () => ({
        supersedes: false,
        ok: false,
        reason: "register() threw",
      }),
    });
    const err = await installExtensionFromRegistry(
      { packageName: PKG, version: VER, orgId: "org-1" },
      deps,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/nothing was committed/i);
    expect((err as Error).message).toMatch(/bundled in the image stays in service/i);
  });

  it("a probe that PASSES lets the fresh install commit as before", async () => {
    const { deps, durable } = harness({
      ...trustsTheRegistry,
      verifyActivatableBeforeFinalize: async () => ({ supersedes: false, ok: true }),
    });
    await installExtensionFromRegistry(
      { packageName: PKG, version: VER, orgId: "org-1" },
      deps,
    );
    expect(durable.beginInstallOp).toHaveLength(1);
    expect(durable.finalizeInstallOp).toHaveLength(1);
  });
});

describe("install pipeline: a refused probe never deletes the LIVE install's bytes", () => {
  it("a same-digest re-install whose probe fails KEEPS the dir and says so", async () => {
    // A same-version re-install materializes to the SAME dir as the live install.
    // GC'ing it on a probe failure would destroy the working install that this
    // very refusal exists to protect.
    const { deps, gcd } = harness({
      ...trustsTheRegistry,
      // A finalized prior op at the SAME digest: the materialized dir IS live.
      readInstallOp: async () => ({ installOpId: "op-1", phase: "finalized", digest: "dgst" }),
      verifyActivatableBeforeFinalize: async () => ({
        supersedes: false,
        ok: false,
        reason: "register() threw",
      }),
    });

    const err = await installExtensionFromRegistry(
      { packageName: PKG, version: VER, orgId: "org-1" },
      deps,
    ).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/could not activate/i);
    // The load-bearing assertion: the live dir was NOT deleted.
    expect(gcd).toEqual([]);
    expect((err as Error).message).toMatch(/kept because it is the live install's/i);
  });

  it("a superseding update whose probe fails still GCs the NEW digest", async () => {
    const { deps, gcd } = harness({
      ...trustsTheRegistry,
      // A finalized prior op at a DIFFERENT digest: the new dir is disposable.
      readInstallOp: async () => ({ installOpId: "op-1", phase: "finalized", digest: "older" }),
      verifyActivatableBeforeFinalize: async () => ({
        supersedes: true,
        ok: false,
        reason: "register() threw",
      }),
    });

    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: "org-1" }, deps),
    ).rejects.toThrow(/could not activate the new digest/i);
    expect(gcd).toEqual(["/store/dir"]);
  });

  it("a GC failure is reported honestly, never as a removal", async () => {
    const { deps } = harness({
      ...trustsTheRegistry,
      gcStoreDir: async () => {
        throw new Error("EBUSY");
      },
      verifyActivatableBeforeFinalize: async () => ({
        supersedes: false,
        ok: false,
        reason: "register() threw",
      }),
    });
    const err = await installExtensionFromRegistry(
      { packageName: PKG, version: VER, orgId: "org-1" },
      deps,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/still on disk and need clearing/i);
  });
});

describe("the disposable-dir guard is one rule, shared by every refusal seam", () => {
  // A LEGACY finalized op recorded no digest. A strict equality guard reads that
  // as "not the live dir" and would delete a working install on a same-bytes
  // re-install. Both refusal seams must treat an undeterminable prior digest as
  // LIVE: over-keeping a dir is recoverable, over-deleting one is not.
  const legacyFinalizedOp = async () => ({
    installOpId: "op-legacy",
    phase: "finalized",
    digest: null,
  });

  it("the UNTRUSTED gate keeps the dir when the prior digest is undeterminable", async () => {
    const { deps, gcd } = harness({ readInstallOp: legacyFinalizedOp as never });
    const err = await installExtensionFromRegistry(
      { packageName: PKG, version: VER, orgId: "org-1" },
      deps,
    ).catch((e: unknown) => e);
    expect(gcd, "a live install's bytes are never deleted on a refusal").toEqual([]);
    expect((err as Error).message).toMatch(/kept because it is the live install's/i);
  });

  it("the PROBE gate makes the same call on the same input", async () => {
    const { deps, gcd } = harness({
      ...trustsTheRegistry,
      readInstallOp: legacyFinalizedOp as never,
      verifyActivatableBeforeFinalize: async () => ({
        supersedes: false,
        ok: false,
        reason: "register() threw",
      }),
    });
    const err = await installExtensionFromRegistry(
      { packageName: PKG, version: VER, orgId: "org-1" },
      deps,
    ).catch((e: unknown) => e);
    expect(gcd).toEqual([]);
    expect((err as Error).message).toMatch(/kept because it is the live install's/i);
  });
})
