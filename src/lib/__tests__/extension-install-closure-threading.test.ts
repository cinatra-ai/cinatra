// cinatra#181 — SIGNED MATERIALIZATION PLAN threading through BOTH install
// paths (the registry install pipeline AND the workflow install saga), plus
// the install-time downgrade-refusal trust wiring and the backfill's
// closure-awareness. Pure DI tests — no registry, no DB, no filesystem.

import { describe, it, expect, afterEach } from "vitest";
import { installExtensionFromRegistry,
  makeTestInstallPipelineDeps, type InstallPipelineDeps } from "@/lib/extension-install-pipeline";
import {
  installWorkflowExtensionSaga,
  type WorkflowInstallSagaDeps,
} from "@/lib/extension-workflow-install-saga";
import {
  generateExtensionSigningKeyPair,
  resolveSignatureVerdict,
  signExtension,
  signExtensionV2,
} from "@/lib/extension-signature";
import {
  computeClosureHash,
  parseMaterializationPlan,
} from "@/lib/extension-materialization-plan-core";
import { sriForBytes } from "@/lib/extension-package-store-core";
import { runExtensionSignatureBackfill } from "@/lib/extension-signature-backfill";

const REGISTRY = "https://registry.cinatra.ai";
const PKG = "@cinatra-ai/closure-pkg";
const VER = "1.0.0";
const INTEGRITY = sriForBytes(Buffer.from("the-extension-tarball"));

/** A valid v1 transport plan bound to (PKG, VER) with one root node. */
function transportPlan(pkg = PKG, version = VER): unknown {
  return {
    format: "cinatra-materialization-plan/v1",
    package: { name: pkg, version },
    rootDependencies: [{ name: "left-pad", placementPath: "node_modules/left-pad" }],
    nodes: [
      {
        name: "left-pad",
        version: "1.3.0",
        integrity: sriForBytes(Buffer.from("left-pad-tarball")),
        placementPath: "node_modules/left-pad",
        dependencies: [],
      },
    ],
  };
}
const PLAN_CLOSURE_HASH = computeClosureHash(parseMaterializationPlan(transportPlan()));

/** Trusted keypair + v2 signature binding the fixture plan (the verified-plan happy path). */
function signedV2Env(version = VER, closureHash = PLAN_CLOSURE_HASH) {
  const kp = generateExtensionSigningKeyPair();
  const v2 = signExtensionV2({ packageName: PKG, version, integrity: INTEGRITY, closureHash }, kp.privateKeyPkcs8DerB64);
  process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
  return { kp, v2 };
}

function fakePipelineDeps(overrides: Partial<InstallPipelineDeps> = {}) {
  const calls = { materialize: [] as unknown[], provenance: [] as unknown[], approved: [] as unknown[] };
  const deps: InstallPipelineDeps = {
    ...makeTestInstallPipelineDeps(),
    resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, materializationPlan: transportPlan() }),
    materialize: async (i) => {
      calls.materialize.push(i);
      return { storeDir: "/store/dir", digest: "dgst", integrity: INTEGRITY, contentHash: "ch" };
    },
    readRequestedPorts: async () => [],
    recordProvenance: async (i) => {
      calls.provenance.push(i);
    },
    recordRequestedGrant: async () => undefined,
    approveGrant: async (i) => {
      calls.approved.push(i);
    },
    ...overrides,
  };
  return { deps, calls };
}

afterEach(() => {
  delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
  delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
});

describe("install pipeline × materialization plan (cinatra#181)", () => {
  it("THREADS the parsed plan + recomputed closureHash into materialize and records the closureHash in provenance", async () => {
    const { v2 } = signedV2Env();
    const { deps, calls } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, signature: v2, materializationPlan: transportPlan() }),
    });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(calls.materialize).toHaveLength(1);
    const mat = calls.materialize[0] as { plan?: { package?: { name?: string } }; expectedClosureHash?: string | null; version?: string };
    expect(mat.plan?.package?.name).toBe(PKG);
    expect(mat.expectedClosureHash).toBe(PLAN_CLOSURE_HASH);
    expect(calls.provenance[0]).toMatchObject({ closureHash: PLAN_CLOSURE_HASH });
  });

  it("passes the RESOLVED version into materialize (a dist-tag input never names the store dir)", async () => {
    const resolvedHash = computeClosureHash(parseMaterializationPlan(transportPlan(PKG, "2.0.0")));
    const { v2 } = signedV2Env("2.0.0", resolvedHash);
    const { deps, calls } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, signature: v2, resolvedVersion: "2.0.0", materializationPlan: transportPlan(PKG, "2.0.0") }),
    });
    await installExtensionFromRegistry({ packageName: PKG, version: "latest", orgId: null }, deps);
    expect((calls.materialize[0] as { version: string }).version).toBe("2.0.0");
  });

  it("REFUSES a plan bound to a different (name, version) than the resolved package", async () => {
    const { deps } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, materializationPlan: transportPlan("@cinatra-ai/other", VER) }),
    });
    await expect(installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps)).rejects.toThrow(
      /must bind the exact resolved package/,
    );
  });

  it("REFUSES a malformed plan FAIL-CLOSED (never a silent downgrade to closure-less semantics)", async () => {
    const { deps, calls } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, materializationPlan: { format: "cinatra-materialization-plan/v1" } }),
    });
    await expect(installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps)).rejects.toThrow(
      /\[materialization-plan\]/,
    );
    expect(calls.materialize).toHaveLength(0); // refused BEFORE any store write
  });

  it("a closure-LESS package threads plan:null/closureHash:null (today's behavior unchanged)", async () => {
    const { deps, calls } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY }),
    });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    const mat = calls.materialize[0] as { plan?: unknown; expectedClosureHash?: unknown };
    expect(mat.plan).toBeNull();
    expect(mat.expectedClosureHash).toBeNull();
    expect(calls.provenance[0]).not.toHaveProperty("closureHash");
  });

  it("DOWNGRADE REFUSAL at install: a closure package with a VALID v1 signature is REFUSED BEFORE any fetch/write (plan never executes)", async () => {
    const kp = generateExtensionSigningKeyPair();
    const v1 = signExtension({ packageName: PKG, version: VER, integrity: INTEGRITY }, kp.privateKeyPkcs8DerB64);
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const { deps, calls } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, signature: v1, materializationPlan: transportPlan() }),
    });
    await expect(installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null, actorUserId: "u1" }, deps)).rejects.toThrow(
      /no VERIFIED v2 signature binding its closureHash/,
    );
    expect(calls.materialize).toHaveLength(0); // the plan never executed
    expect(calls.provenance).toHaveLength(0);
    expect(calls.approved).toEqual([]);
  });

  it("UNSIGNED closure package: refused before any fetch/write too (absent signature = hard false)", async () => {
    const { deps, calls } = fakePipelineDeps(); // plan present, NO signature, no keys
    await expect(installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps)).rejects.toThrow(
      /no VERIFIED v2 signature binding its closureHash/,
    );
    expect(calls.materialize).toHaveLength(0);
    expect(calls.provenance).toHaveLength(0);
  });

  it("PROBE GATING: an UNTRUSTED closure-LESS package never reaches verifyActivatableBeforeFinalize (no code execution from the probe)", async () => {
    // A closure package never even materializes (refused above); the probe
    // gate matters for the closure-LESS untrusted case: an invalid signature
    // (hard false) must not get probe code execution either.
    const kp = generateExtensionSigningKeyPair();
    const wrong = generateExtensionSigningKeyPair();
    const badSig = signExtension({ packageName: PKG, version: VER, integrity: INTEGRITY }, wrong.privateKeyPkcs8DerB64);
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const probed: unknown[] = [];
    const { deps } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, signature: badSig }),
      verifyActivatableBeforeFinalize: async (i) => {
        probed.push(i);
        return { supersedes: false };
      },
    });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(probed).toEqual([]); // invalid signature = untrusted -> the import/register probe must NOT run
  });

  it("a v2 signature binding the recomputed closureHash IS trusted-signed (grant auto-approves)", async () => {
    const kp = generateExtensionSigningKeyPair();
    const v2 = signExtensionV2(
      { packageName: PKG, version: VER, integrity: INTEGRITY, closureHash: PLAN_CLOSURE_HASH },
      kp.privateKeyPkcs8DerB64,
    );
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const { deps, calls } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, signature: v2, materializationPlan: transportPlan() }),
      readRequestedPorts: async () => ["settings"],
    });
    const r = await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null, actorUserId: "u1" }, deps);
    expect(r.grantStatus).toBe("approved");
    expect(calls.approved).toHaveLength(1);
    expect(calls.provenance[0]).toMatchObject({ closureHash: PLAN_CLOSURE_HASH, signature: v2 });
  });
});

describe("failed-UPDATE restore carries the prior closureHash (merge-safe finding)", () => {
  it("a post-begin update failure re-records the OLD provenance INCLUDING its closureHash", async () => {
    const { v2 } = signedV2Env();
    const provenance: unknown[] = [];
    const priorClosureHash = "ab".repeat(64);
    const { deps } = fakePipelineDeps({
      resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, signature: v2, materializationPlan: transportPlan() }),
      recordProvenance: async (i) => {
        provenance.push(i);
      },
      // a prior FINALIZED install exists (this is an UPDATE)...
      readInstallOp: async () => ({ installOpId: "old-op", packageName: PKG, orgId: null, phase: "finalized", digest: "old-digest" }) as never,
      readCurrentSource: async () => ({
        registryUrl: REGISTRY,
        version: "0.9.0",
        integrity: "sha512-old",
        contentHash: "old-ch",
        signature: "old-sig",
        closureHash: priorClosureHash,
      }),
      // ...and a post-begin step throws (migration preflight refusal).
      preflightMigrations: async () => {
        throw new Error("boom mid-update");
      },
    });
    await expect(installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps)).rejects.toThrow(/boom mid-update/);
    // the restore write (the LAST provenance call) carries the OLD closureHash
    const restore = provenance[provenance.length - 1] as Record<string, unknown>;
    expect(restore.version).toBe("0.9.0");
    expect(restore.closureHash).toBe(priorClosureHash);
  });
});

describe("workflow install saga × materialization plan (the SECOND install path)", () => {
  function makeSagaDeps(resolveOverride?: WorkflowInstallSagaDeps["resolveIntegrity"]) {
    const calls = { materialize: [] as unknown[], provenance: [] as unknown[], grantRequests: [] as unknown[], gc: [] as unknown[] };
    const journal = new Map<string, { installOpId: string; phase: string }>();
    const deps: WorkflowInstallSagaDeps = {
      gcStoreDir: async (dir) => {
        calls.gc.push(dir);
      },
      withInstallLock: async (_pkg, fn) => fn(),
      beginInstallOp: async ({ installOpId, packageName, orgId }) => {
        journal.set(`${packageName}::${orgId}`, { installOpId, phase: "materialized" });
      },
      advanceInstallOpPhase: async () => undefined,
      finalizeInstallOp: async () => undefined,
      failInstallOp: async () => undefined,
      emitOperationalEvent: () => undefined,
      readInstallOp: async (pkg, org) => journal.get(`${pkg}::${org}`) ?? null,
      resolveIntegrity:
        resolveOverride ?? (async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY, materializationPlan: transportPlan() })),
      materialize: async (i) => {
        calls.materialize.push(i);
        return { storeDir: "/store/dir", digest: "dgst", integrity: INTEGRITY, contentHash: "ch" };
      },
      preflightFromStore: async () => ({ manifest: { key: "wf" }, dashboardConfig: null }),
      installWorkflowTemplate: async () => ({ templateId: "tpl-1", wasReinstall: false }),
      materializeDashboardTemplate: async () => undefined,
      listOrgProjectIds: async () => [],
      materializeInstanceForProject: async () => undefined,
      restoreDashboards: async () => undefined,
      readRequestedPorts: async () => [],
      recordRequestedGrant: async (g) => {
        calls.grantRequests.push(g);
      },
      approveGrant: async () => undefined,
      recordProvenance: async (i) => {
        calls.provenance.push(i);
      },
      archiveDashboards: async () => undefined,
      deleteWorkflowTemplate: async () => ({ deleted: true }),
    };
    return { deps, calls, journal };
  }

  it("THREADS the plan + closureHash into materialize and provenance (parity with the pipeline — codex finding 2)", async () => {
    // The saga's trust gate runs BEFORE writes and the closure downgrade
    // refusal makes an unsigned closure package hard-untrusted — so the
    // happy path needs a v2 signature binding the recomputed hash.
    const kp = generateExtensionSigningKeyPair();
    const v2 = signExtensionV2(
      { packageName: PKG, version: VER, integrity: INTEGRITY, closureHash: PLAN_CLOSURE_HASH },
      kp.privateKeyPkcs8DerB64,
    );
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const { deps, calls } = makeSagaDeps(async () => ({
      integrity: INTEGRITY,
      registryUrl: REGISTRY,
      signature: v2,
      materializationPlan: transportPlan(),
    }));
    const r = await installWorkflowExtensionSaga({ packageName: PKG, version: VER, actor: { orgId: "org-1", userId: "u1" } }, deps);
    expect(r.status).toBe("installed");
    const mat = calls.materialize[0] as { plan?: { package?: { name?: string } }; expectedClosureHash?: string | null };
    expect(mat.plan?.package?.name).toBe(PKG);
    expect(mat.expectedClosureHash).toBe(PLAN_CLOSURE_HASH);
    expect(calls.provenance[0]).toMatchObject({ closureHash: PLAN_CLOSURE_HASH });
  });

  it("DOWNGRADE REFUSAL in the saga: an UNSIGNED closure package is refused BEFORE materialize (fully inert — plan never executes)", async () => {
    const { deps, calls, journal } = makeSagaDeps(); // plan present, NO signature
    await expect(
      installWorkflowExtensionSaga({ packageName: PKG, version: VER, actor: { orgId: "org-1", userId: "u1" } }, deps),
    ).rejects.toThrow(/no VERIFIED v2 signature binding its closureHash/);
    // PR-4 review HIGH 1 + rounds 0/1: the refusal happens BEFORE materialize
    // (the plan never executes — zero fetches/writes), BEFORE the journal
    // begin (the previous install's `finalized` boot anchor survives), and
    // BEFORE any grant mutation. Nothing was created, so nothing to GC.
    expect(calls.materialize).toHaveLength(0);
    expect(calls.provenance).toHaveLength(0);
    expect(calls.grantRequests).toHaveLength(0);
    expect(journal.size).toBe(0);
    expect(calls.gc).toHaveLength(0);
  });

  it("REFUSES a plan bound to another package BEFORE any journal/template write", async () => {
    const { deps, calls } = makeSagaDeps(async () => ({
      integrity: INTEGRITY,
      registryUrl: REGISTRY,
      materializationPlan: transportPlan("@cinatra-ai/other", VER),
    }));
    await expect(installWorkflowExtensionSaga({ packageName: PKG, version: VER, actor: { orgId: "org-1", userId: "u1" } }, deps)).rejects.toThrow(
      /must bind the exact resolved package/,
    );
    expect(calls.materialize).toHaveLength(0);
  });
});

describe("signature backfill \u00d7 closure rows", () => {
  it("recomputes the closureHash from the served plan, threads it into the verdict: a served v1 signature can NEVER backfill a closure row", async () => {
    const kp = generateExtensionSigningKeyPair();
    const v1 = signExtension({ packageName: PKG, version: VER, integrity: INTEGRITY }, kp.privateKeyPkcs8DerB64);
    const writes: unknown[] = [];
    const seenFields: unknown[] = [];
    const result = await runExtensionSignatureBackfill({
      loadTrustedKeyCount: () => 1,
      listLiveVerdaccioRowsMissingSignature: async () => [
        {
          id: "row-1",
          source: { type: "verdaccio", registryUrl: REGISTRY, packageName: PKG, version: VER, integrity: INTEGRITY, closureHash: PLAN_CLOSURE_HASH },
        },
      ],
      // the registry serves the matching plan (so the recomputed hash === the
      // row's recorded one, Case C) but only a v1 signature.
      resolveServed: async () => ({ signature: v1, materializationPlan: transportPlan() }),
      recomputeClosureHash: (plan, expected) => {
        const parsed = parseMaterializationPlan(plan);
        if (parsed.package.name !== expected.packageName || parsed.package.version !== expected.version) {
          throw new Error("plan identity mismatch");
        }
        return computeClosureHash(parsed);
      },
      verifySignature: (fields, signature) => {
        seenFields.push(fields);
        return resolveSignatureVerdict(
          { ...fields, signature, closureHash: fields.closureHash ?? null },
          { trustedKeys: [{ keyId: kp.keyId, publicKeyDerB64: kp.publicKeyDerB64 }], required: false },
        );
      },
      writeBackfilledSignature: async (id, _verified, signature) => {
        writes.push({ id, signature });
        return "written";
      },
    });
    // the verdict was computed against the RECOMPUTED hash (not the row's trust)
    expect(seenFields[0]).toMatchObject({ closureHash: PLAN_CLOSURE_HASH });
    expect(result.written).toBe(0); // the v1 signature was REFUSED for the closure row
    expect(result.skipped).toBe(1);
    expect(writes).toEqual([]);
  });
});
