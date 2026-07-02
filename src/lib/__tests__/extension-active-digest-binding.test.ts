// cinatra#792 — DB-authoritative active digest: the shared journal-gated
// selector, the anchor resolver's fail-closed cross-check, and the install
// pipeline's outcome-seam writes (forward bind, finalize-time cross-check,
// durable-rollback re-pin).
import { describe, it, expect } from "vitest";
import {
  resolveInstallAnchor,
  selectActiveDigest,
  type ResolveInstallAnchorDeps,
} from "@/lib/extension-install-anchor";
import {
  installExtensionFromRegistry,
  makeTestInstallPipelineDeps,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";

const REGISTRY = "https://registry.cinatra.ai";
const OLD_DIGEST = "a".repeat(128);
const NEW_DIGEST = "b".repeat(128);

describe("selectActiveDigest (the shared journal-gated selector)", () => {
  it("row digest absent → the journal digest alone (legacy rows)", () => {
    expect(selectActiveDigest({ activeDigest: null, journalDigest: NEW_DIGEST })).toEqual({
      ok: true,
      digest: NEW_DIGEST,
    });
    expect(selectActiveDigest({ activeDigest: undefined, journalDigest: null })).toEqual({
      ok: true,
      digest: null,
    });
  });

  it("row digest confirmed by the journal → that digest", () => {
    expect(selectActiveDigest({ activeDigest: NEW_DIGEST, journalDigest: NEW_DIGEST })).toEqual({
      ok: true,
      digest: NEW_DIGEST,
    });
  });

  it("row digest MISMATCHING the journal → FAIL CLOSED", () => {
    const out = selectActiveDigest({ activeDigest: NEW_DIGEST, journalDigest: OLD_DIGEST });
    expect(out.ok).toBe(false);
  });

  it("row digest with NO journal digest to confirm it → FAIL CLOSED (the row can never outrank the journal)", () => {
    const out = selectActiveDigest({ activeDigest: NEW_DIGEST, journalDigest: null });
    expect(out.ok).toBe(false);
  });
});

describe("resolveInstallAnchor — journal-gated activeDigest + row kind (cinatra#792)", () => {
  const base = (
    over: Partial<{ activeDigest: string; journalDigest: string | null; kind: string }> = {},
  ): ResolveInstallAnchorDeps => ({
    readActiveInstall: async () => ({
      status: "active",
      ...(over.kind ? { kind: over.kind } : {}),
      source: {
        type: "verdaccio",
        registryUrl: REGISTRY,
        integrity: "sha512-abc",
        contentHash: "deadbeef",
        ...(over.activeDigest ? { activeDigest: over.activeDigest } : {}),
      },
    }),
    readGrant: async () => null,
    readInstallOp: async () => ({
      phase: "finalized",
      digest: over.journalDigest === undefined ? NEW_DIGEST : over.journalDigest,
    }),
  });

  it("activeDigest confirmed by the finalized journal → the anchor binds it", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", base({ activeDigest: NEW_DIGEST }));
    expect(a?.digest).toBe(NEW_DIGEST);
  });

  it("activeDigest MISMATCHING the finalized journal digest → NULL anchor (fail closed)", async () => {
    const a = await resolveInstallAnchor(
      "@cinatra-ai/foo",
      base({ activeDigest: OLD_DIGEST /* journal says NEW */ }),
    );
    expect(a).toBeNull();
  });

  it("activeDigest with a digest-less finalized journal op → NULL anchor (fail closed)", async () => {
    const a = await resolveInstallAnchor(
      "@cinatra-ai/foo",
      base({ activeDigest: NEW_DIGEST, journalDigest: null }),
    );
    expect(a).toBeNull();
  });

  it("no activeDigest on the row → journal-digest fallback (legacy rows, unchanged)", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", base());
    expect(a?.digest).toBe(NEW_DIGEST);
  });

  it("carries the canonical row's KIND onto the anchor (unbound when the row view omits it)", async () => {
    const withKind = await resolveInstallAnchor("@cinatra-ai/foo", base({ kind: "connector" }));
    expect(withKind?.kind).toBe("connector");
    const without = await resolveInstallAnchor("@cinatra-ai/foo", base());
    expect(without?.kind).toBeNull();
  });
});

describe("install pipeline — activeDigest outcome seam (cinatra#792)", () => {
  function fakeDeps(overrides: Partial<InstallPipelineDeps> = {}) {
    const provenance: Array<Record<string, unknown>> = [];
    const journal: string[] = [];
    const deps: InstallPipelineDeps = {
      ...makeTestInstallPipelineDeps(),
      resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: REGISTRY }),
      materialize: async () => ({
        storeDir: `/store/foo/${NEW_DIGEST}`,
        digest: NEW_DIGEST,
        integrity: "sha512-abc",
        contentHash: "ch",
      }),
      recordProvenance: async (i) => {
        provenance.push(i as unknown as Record<string, unknown>);
      },
      advanceInstallOpPhase: async (i) => {
        journal.push(i.phase);
      },
      finalizeInstallOp: async () => {
        journal.push("finalized");
      },
      ...overrides,
    };
    return { deps, provenance, journal };
  }

  it("forward install binds mat.digest through recordProvenance", async () => {
    const { deps, provenance } = fakeDeps();
    await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      deps,
    );
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ digest: NEW_DIGEST });
  });

  it("FINALIZE-TIME CROSS-CHECK: a row digest that does not match the journaled digest refuses to finalize", async () => {
    const { deps, journal } = fakeDeps({
      // the read-back row digest is WRONG (torn/clobbered write)
      readActiveDigest: async () => OLD_DIGEST,
    });
    await expect(
      installExtensionFromRegistry(
        { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
        deps,
      ),
    ).rejects.toThrow(/does not match this install's journaled digest/);
    // never finalized; the aborted op is terminalized
    expect(journal).not.toContain("finalized");
    expect(journal).toContain("failed");
    expect(journal).toContain("rolled_back");
  });

  it("FINALIZE-TIME CROSS-CHECK passes when the row digest reads back as the journaled digest", async () => {
    const { deps, journal } = fakeDeps({ readActiveDigest: async () => NEW_DIGEST });
    const r = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      deps,
    );
    expect(r.installed).toBe(true);
    expect(journal).toContain("finalized");
  });

  it("post-commit DURABLE ROLLBACK re-pins the OLD activeDigest through recordProvenance", async () => {
    const { deps, provenance } = fakeDeps({
      // a prior FINALIZED install (an UPDATE) at the OLD digest
      readInstallOp: async () => ({ installOpId: "op-old", phase: "finalized", digest: OLD_DIGEST }),
      readCurrentSource: async () => ({
        registryUrl: REGISTRY,
        version: "0.9.0",
        integrity: "sha512-old",
        contentHash: "ch-old",
        activeDigest: OLD_DIGEST,
      }),
      // the NEW digest fails live activation → the activator runs the durable restore
      activateUpdateWithRollback: async (i) => {
        const outcome = await i.restoreDurableAnchor();
        return {
          activated: false,
          rolledBack: true,
          rollbackComplete: outcome.complete,
          reason: "live-activation-failed",
        };
      },
    });
    const r = await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      deps,
    );
    expect(r.rolledBack).toBe(true);
    // forward write bound NEW; the rollback re-record re-pinned OLD
    expect(provenance.at(0)).toMatchObject({ digest: NEW_DIGEST });
    expect(provenance.at(-1)).toMatchObject({ version: "0.9.0", digest: OLD_DIGEST });
  });

  it("rollback of a LEGACY prior source (no activeDigest) falls back to the OLD journal digest", async () => {
    const { deps, provenance } = fakeDeps({
      readInstallOp: async () => ({ installOpId: "op-old", phase: "finalized", digest: OLD_DIGEST }),
      readCurrentSource: async () => ({
        registryUrl: REGISTRY,
        version: "0.9.0",
        integrity: "sha512-old",
        contentHash: "ch-old",
        // no activeDigest recorded (legacy row)
      }),
      activateUpdateWithRollback: async (i) => {
        const outcome = await i.restoreDurableAnchor();
        return {
          activated: false,
          rolledBack: true,
          rollbackComplete: outcome.complete,
          reason: "live-activation-failed",
        };
      },
    });
    await installExtensionFromRegistry(
      { packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null },
      deps,
    );
    expect(provenance.at(-1)).toMatchObject({ version: "0.9.0", digest: OLD_DIGEST });
  });
});
