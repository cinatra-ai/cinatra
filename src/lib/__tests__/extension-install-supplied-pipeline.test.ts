/**
 * THE SOURCE-AGNOSTIC PIPELINE ENTRY (cinatra#3204 D1 — criteria 18, 19, 20, 26
 * and the pipeline half of 31).
 *
 * The claim under test is not "a supplied package installs". It is that a
 * supplied package goes through THE SAME gate set a registry package goes
 * through — not an abbreviated version of it — and comes out with HONEST
 * provenance rather than a registry row.
 *
 * So the central assertion is a comparison: run a registry install and a
 * supplied install against the same recording deps and require the two gate
 * sequences to be identical.
 */
import { describe, expect, it } from "vitest";

import {
  installExtensionFromRegistry,
  installExtensionFromSuppliedSnapshot,
  makeTestInstallPipelineDeps,
  SUPPLIED_PACKAGE_ORIGIN,
  type InstallPipelineDeps,
  type SuppliedInstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import { makeTestSuppliedInstallPipelineDeps } from "@/lib/extension-install-pipeline-deps";

const DIGEST = "a".repeat(64);
const TARBALL = new TextEncoder().encode("supplied-tarball-bytes");
const TRUSTED_REGISTRY = "https://registry.cinatra.ai";

const localProvenance = {
  type: "local" as const,
  path: "snapshots/thing.tgz",
  contentDigest: DIGEST,
};
const githubProvenance = {
  type: "github" as const,
  repo: "owner/repo",
  ref: "v1.0.0",
  resolvedSha: "b".repeat(40),
  contentDigest: DIGEST,
};

/**
 * The default supplied install below names a METADATA-ONLY kind, which is the
 * kind set that imports nothing in this process. The kinds that DO import are
 * admitted by the supplied road's own activation standing (the operator supplied
 * the bytes and the road re-verified their content digest) — never by a
 * signature it does not have, and never at the privileged tier. Both halves have
 * tests below.
 */
const suppliedInstall = (over: Record<string, unknown> = {}) =>
  ({
    packageName: "@acme/thing",
    version: "1.0.0",
    orgId: null,
    expectedKind: "skill",
    supplied: { tarball: TARBALL, provenance: localProvenance },
    ...over,
  }) as unknown as Parameters<typeof installExtensionFromSuppliedSnapshot>[0];

/** Record the ORDER in which the pipeline's gates run. */
function recordingDeps(gates: string[]): Partial<InstallPipelineDeps> {
  const note = (name: string) => gates.push(name);
  return {
    readRequestedPorts: async () => {
      note("readRequestedPorts");
      return ["settings"];
    },
    readDeclaredCompat: async () => {
      note("readDeclaredCompat");
      return { sdkAbiRange: null };
    },
    readDependencyEdges: async () => {
      note("readDependencyEdges");
      return [];
    },
    readAccessDeclaration: async () => {
      note("readAccessDeclaration");
      return null;
    },
    readInstallOp: async () => {
      note("readInstallOp");
      return null;
    },
    verifyActivatableBeforeFinalize: async () => {
      note("verifyActivatableBeforeFinalize");
      return { supersedes: false, ok: true };
    },
    beginInstallOp: async () => {
      note("beginInstallOp");
    },
    recordRequestedGrant: async () => {
      note("recordRequestedGrant");
    },
    approveGrant: async () => {
      note("approveGrant");
    },
    preflightMigrations: async () => {
      note("preflightMigrations");
      return false;
    },
    persistDependencyEdges: async () => {
      note("persistDependencyEdges");
    },
    assertForwardInstallClosure: async () => {
      note("assertForwardInstallClosure");
    },
    advanceInstallOpPhase: async () => {
      note("advanceInstallOpPhase");
    },
    finalizeInstallOp: async () => {
      note("finalizeInstallOp");
    },
  };
}

describe("installExtensionFromSuppliedSnapshot — the complete gate set (criterion 18)", () => {
  it("runs the SAME gate sequence a registry install runs", async () => {
    const registryGates: string[] = [];
    const registryDeps: InstallPipelineDeps = makeTestInstallPipelineDeps({
      // An ALLOW-LISTED registry, so the registry install is admitted and the
      // comparison is between two installs that both reach the end.
      resolveIntegrity: async () => ({ integrity: "sha512-test", registryUrl: TRUSTED_REGISTRY }),
      ...recordingDeps(registryGates),
      recordProvenance: async () => {
        registryGates.push("recordProvenance");
      },
    });
    await installExtensionFromRegistry(
      { packageName: "@acme/thing", version: "1.0.0", orgId: null },
      registryDeps,
    );

    const suppliedGates: string[] = [];
    const suppliedDeps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      ...recordingDeps(suppliedGates),
      recordSuppliedProvenance: async () => {
        suppliedGates.push("recordProvenance");
      },
    });
    await installExtensionFromSuppliedSnapshot(
      suppliedInstall(),
      suppliedDeps,
    );

    expect(suppliedGates).toEqual(registryGates);
    // And it is not an empty comparison: the gate set is really there.
    expect(registryGates).toContain("readDeclaredCompat");
    expect(registryGates).toContain("verifyActivatableBeforeFinalize");
    expect(registryGates).toContain("finalizeInstallOp");
  });

  it("returns installed:true only after the journal is finalized", async () => {
    let finalized = false;
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      finalizeInstallOp: async () => {
        finalized = true;
      },
    });
    const result = await installExtensionFromSuppliedSnapshot(
      suppliedInstall(),
      deps,
    );
    expect(result.installed).toBe(true);
    expect(finalized).toBe(true);
  });
});

describe("the supplied digest is VERIFIED, not believed", () => {
  it("refuses when the materialized tree does not match the declared digest", async () => {
    const deps = makeTestSuppliedInstallPipelineDeps({ treeDigest: "c".repeat(64) });
    await expect(
      installExtensionFromSuppliedSnapshot(
        suppliedInstall(),
        deps,
      ),
    ).rejects.toThrow(/content digest does not match the delivered tree/);
  });

  it("a digest mismatch is fully INERT — no journal, no grant, no provenance", async () => {
    const touched: string[] = [];
    let gcd = false;
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: "c".repeat(64),
      beginInstallOp: async () => {
        touched.push("beginInstallOp");
      },
      recordRequestedGrant: async () => {
        touched.push("recordRequestedGrant");
      },
      recordSuppliedProvenance: async () => {
        touched.push("recordSuppliedProvenance");
      },
      gcStoreDir: async () => {
        gcd = true;
      },
    });
    await expect(
      installExtensionFromSuppliedSnapshot(
        suppliedInstall(),
        deps,
      ),
    ).rejects.toThrow();
    expect(touched).toEqual([]);
    expect(gcd).toBe(true);
  });

  it("refuses provenance with no content digest before anything is fetched or written", async () => {
    let materialized = false;
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      materializeSupplied: async () => {
        materialized = true;
        return { storeDir: "/tmp/x", digest: "d", integrity: "sha512-x", contentHash: "c" };
      },
    });
    await expect(
      installExtensionFromSuppliedSnapshot(
        suppliedInstall({ supplied: { tarball: TARBALL, provenance: { type: "local", path: "s.tgz" } } }),
        deps,
      ),
    ).rejects.toThrow(/requires complete provenance/);
    expect(materialized).toBe(false);
  });
});

describe("honest provenance (criterion 20)", () => {
  it("records LOCAL provenance with the content digest — never a registry row", async () => {
    const writes: Record<string, unknown>[] = [];
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      recordSuppliedProvenance: async (p) => {
        writes.push(p as unknown as Record<string, unknown>);
      },
      recordProvenance: async () => {
        throw new Error("the registry provenance writer must never run on the supplied road");
      },
    });
    await installExtensionFromSuppliedSnapshot(
      suppliedInstall(),
      deps,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].provenance).toEqual(localProvenance);
    expect(JSON.stringify(writes[0])).not.toContain("verdaccio");
    expect(JSON.stringify(writes[0])).not.toContain("dispatcher-install");
  });

  it("records GITHUB provenance with the resolved sha AND the content digest", async () => {
    const writes: Record<string, unknown>[] = [];
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      recordSuppliedProvenance: async (p) => {
        writes.push(p as unknown as Record<string, unknown>);
      },
    });
    await installExtensionFromSuppliedSnapshot(
      suppliedInstall({ supplied: { tarball: TARBALL, provenance: githubProvenance } }),
      deps,
    );
    expect(writes[0].provenance).toEqual(githubProvenance);
    // The revision identifier and the content digest are BOTH recorded, and they
    // are different values answering different questions.
    expect(githubProvenance.resolvedSha).not.toBe(githubProvenance.contentDigest);
  });

  it("names a non-registry origin instead of inventing a registry URL", () => {
    expect(SUPPLIED_PACKAGE_ORIGIN).toBe("supplied:operator");
    expect(SUPPLIED_PACKAGE_ORIGIN).not.toMatch(/^https?:/);
  });
});

describe("a supplied package stays untrusted (criterion 26)", () => {
  it("leaves the host-port grant PENDING — it never self-grants", async () => {
    let approved = false;
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      readRequestedPorts: async () => ["settings"],
      approveGrant: async () => {
        approved = true;
      },
      // The most permissive host policy the classifier accepts. A supplied
      // package still cannot reach `trusted-signed` — it carries no signature
      // and its origin is not an activation host — so the grant stays pending.
      allowMarketplaceBootstrapTrust: () => true,
    });
    const result = await installExtensionFromSuppliedSnapshot(
      suppliedInstall(),
      deps,
    );
    expect(result.grantStatus).toBe("pending");
    expect(approved).toBe(false);
  });

  it("refuses to finalize a supplied package that declares host migrations", async () => {
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      preflightMigrations: async () => true,
    });
    await expect(
      installExtensionFromSuppliedSnapshot(
        suppliedInstall(),
        deps,
      ),
    ).rejects.toThrow(/trusted-signed/);
  });
});

describe("per-kind reach (the pipeline half of criterion 31)", () => {
  it("drives each of the four live kinds through the same entry", async () => {
    // ALL FOUR live kinds reach this entry and install through it — the issue's
    // headline claim, and the one the connector could not meet while the origin
    // factor accepted only a registry host.
    for (const kind of ["agent", "skill", "artifact", "connector"] as const) {
      const writes: Record<string, unknown>[] = [];
      const deps: SuppliedInstallPipelineDeps = makeTestSuppliedInstallPipelineDeps({
        treeDigest: DIGEST,
        recordSuppliedProvenance: async (p) => {
          writes.push(p as unknown as Record<string, unknown>);
        },
      });
      const result = await installExtensionFromSuppliedSnapshot(
        suppliedInstall({ packageName: `@acme/thing-${kind}`, expectedKind: kind }),
        deps,
      );
      expect(result.installed).toBe(true);
      expect(writes[0].provenance).toEqual(localProvenance);
    }
  });

  it("threads the caller's kind to the materializer, so store placement is kind-segregated", async () => {
    const seen: (string | undefined)[] = [];
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      materializeSupplied: async (i) => {
        seen.push(i.expectedKind);
        return {
          storeDir: `/tmp/test-store/${i.packageName}`,
          digest: "testdigest",
          integrity: "sha512-x",
          contentHash: "c",
        };
      },
    });
    await installExtensionFromSuppliedSnapshot(
      suppliedInstall({ packageName: "@acme/thing-artifact", expectedKind: "artifact" }),
      deps,
    );
    expect(seen).toEqual(["artifact"]);
  });
});

describe("the trust boundary the supplied road does NOT move", () => {
  it("a supplied METADATA-ONLY package installs, and never activates in process", async () => {
    let activated = false;
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      activateInProcess: async () => {
        activated = true;
        return { activated: true };
      },
    });
    const result = await installExtensionFromSuppliedSnapshot(suppliedInstall(), deps);
    expect(result.installed).toBe(true);
    expect(result.activated).toBe(false);
    // The KIND is why, and the reason says so: this package imports nothing, so
    // the in-process activator is not called at all.
    expect(result.reason).toBe("metadata-only-no-in-process-activation");
    // Not "called and refused" — never called.
    expect(activated).toBe(false);
  });

  it("a supplied CONNECTOR INSTALLS and its row is written — the road is an activation origin", async () => {
    const writes: Record<string, unknown>[] = [];
    let activatedPackage: string | null = null;
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      // The host policy of a deployment with NO configured marketplace: no
      // activation host at all, and the unsigned-bootstrap lever off. A store
      // install reaches nothing under it. The supplied road stands on the supply
      // act instead, so the kind whose install exists to run `register(ctx)`
      // gets to run it.
      trustedActivationHosts: () => [],
      allowMarketplaceBootstrapTrust: () => false,
      recordSuppliedProvenance: async (p) => {
        writes.push(p as unknown as Record<string, unknown>);
      },
      activateInProcess: async (i) => {
        activatedPackage = i.packageName;
        return { activated: true };
      },
    });

    const result = await installExtensionFromSuppliedSnapshot(
      suppliedInstall({ packageName: "@acme/thing-connector", expectedKind: "connector" }),
      deps,
    );

    expect(result.installed).toBe(true);
    expect(result.activated).toBe(true);
    expect(activatedPackage).toBe("@acme/thing-connector");
    // THE ROW: honest supplied provenance, exactly as every other kind records it.
    expect(writes).toHaveLength(1);
    expect(writes[0].provenance).toEqual(localProvenance);
    // Admitted for IMPORT, not for privilege: nothing self-granted.
    expect(result.grantStatus).not.toBe("approved");
  });

  it("the supplied road never widens the host allowlist, and never self-grants", async () => {
    // Stated as a test because it is the one shortcut that would make every
    // assertion above pass for the wrong reason: the road is admitted by its own
    // declared origin, and it neither adds itself to the deployment's activation
    // hosts nor climbs to the privileged tier.
    const seenHosts: string[][] = [];
    const deps = makeTestSuppliedInstallPipelineDeps({
      treeDigest: DIGEST,
      trustedActivationHosts: () => {
        const hosts = ["registry.cinatra.ai"];
        seenHosts.push(hosts);
        return hosts;
      },
      allowMarketplaceBootstrapTrust: () => true,
    });
    const result = await installExtensionFromSuppliedSnapshot(suppliedInstall(), deps);
    expect(result.grantStatus).toBe("pending");
    expect(result.activated).toBe(false);
    expect(seenHosts).toEqual([["registry.cinatra.ai"]]);
  });
});
