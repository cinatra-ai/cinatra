import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  runExtensionSignatureBackfill,
  casShouldWrite,
  closureHashCasOk,
  type SignatureBackfillDeps,
} from "@/lib/extension-signature-backfill";
import type { ExtensionSourceVerdaccio } from "@cinatra-ai/extensions/canonical-types";

const HASH_A = "a".repeat(128); // a valid-shape 128-hex sha512 closureHash
const HASH_B = "b".repeat(128);

function vsource(over: Partial<ExtensionSourceVerdaccio> = {}): ExtensionSourceVerdaccio {
  return {
    type: "verdaccio",
    registryUrl: "https://registry.cinatra.ai",
    packageName: "@cinatra-ai/notes-connector",
    version: "1.2.0",
    integrity: "sha512-STORED",
    ...over,
  };
}

type WriteFn = SignatureBackfillDeps["writeBackfilledSignature"];

/** A full deps object so runExtensionSignatureBackfill never builds the real (server-only) deps. */
function deps(over: Partial<SignatureBackfillDeps> = {}): SignatureBackfillDeps {
  return {
    loadTrustedKeyCount: () => 1,
    listLiveVerdaccioRowsMissingSignature: async () => [{ id: "inst-1", source: vsource() }],
    resolveServed: async () => ({ signature: "SIG-OK", materializationPlan: null }),
    recomputeClosureHash: () => HASH_A,
    verifySignature: () => true,
    writeBackfilledSignature: async () => "written",
    perRowTimeoutMs: 50,
    ...over,
  };
}

const KILL = "CINATRA_EXTENSION_SIGNATURE_BACKFILL";
afterEach(() => {
  delete process.env[KILL];
  vi.restoreAllMocks();
});

describe("runExtensionSignatureBackfill — fail-closed instance signature backfill", () => {
  it("kill switch: CINATRA_EXTENSION_SIGNATURE_BACKFILL=off → flat no-op, scans nothing", async () => {
    process.env[KILL] = "off";
    const list = vi.fn(deps().listLiveVerdaccioRowsMissingSignature);
    const r = await runExtensionSignatureBackfill(deps({ listLiveVerdaccioRowsMissingSignature: list }));
    expect(r).toEqual({ scanned: 0, written: 0, skipped: 0, failed: 0, skippedReason: "kill-switch" });
    expect(list).not.toHaveBeenCalled();
  });

  it("key guard: no trusted keys → inert no-op (Window-1 default), never lists rows", async () => {
    const list = vi.fn(deps().listLiveVerdaccioRowsMissingSignature);
    const r = await runExtensionSignatureBackfill(deps({ loadTrustedKeyCount: () => 0, listLiveVerdaccioRowsMissingSignature: list }));
    expect(r.skippedReason).toBe("no-trusted-keys");
    expect(list).not.toHaveBeenCalled();
  });

  it("served + verifies (closure-less) → CAS-writes with the VERIFIED stored fields + signature + null closureHash", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(deps({ writeBackfilledSignature: write }));
    expect(r).toEqual({ scanned: 1, written: 1, skipped: 0, failed: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]).toEqual([
      "inst-1",
      { packageName: "@cinatra-ai/notes-connector", version: "1.2.0", integrity: "sha512-STORED", closureHash: null },
      "SIG-OK",
    ]);
  });

  it("CAS miss: the row changed between scan and write → counted skipped, not written", async () => {
    const write = vi.fn<WriteFn>(async () => "skipped-changed");
    const r = await runExtensionSignatureBackfill(deps({ writeBackfilledSignature: write }));
    expect(r).toEqual({ scanned: 1, written: 0, skipped: 1, failed: 0 });
  });

  it("no signature served (still null in packument) → skip, no write", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({ resolveServed: async () => ({ signature: null, materializationPlan: null }), writeBackfilledSignature: write }),
    );
    expect(r).toEqual({ scanned: 1, written: 0, skipped: 1, failed: 0 });
    expect(write).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: served signature does NOT verify against the stored integrity (verdict false) → skip, never write", async () => {
    const verify = vi.fn(() => false as boolean | undefined);
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(deps({ verifySignature: verify, writeBackfilledSignature: write }));
    expect(r).toEqual({ scanned: 1, written: 0, skipped: 1, failed: 0 });
    expect(write).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(
      // closureHash: null — a legacy (closure-less) row keeps v1 semantics (#181)
      { packageName: "@cinatra-ai/notes-connector", version: "1.2.0", integrity: "sha512-STORED", closureHash: null },
      "SIG-OK",
    );
  });

  it("FAIL-CLOSED: unverifiable (verdict undefined) → skip, never write", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(deps({ verifySignature: () => undefined, writeBackfilledSignature: write }));
    expect(r.skipped).toBe(1);
    expect(r.written).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("per-row timeout: a hung registry resolve is bounded → counted failed, does not block the pass", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({
        perRowTimeoutMs: 20,
        resolveServed: () => new Promise<{ signature: string | null; materializationPlan: unknown }>(() => {}), // never resolves
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 1, written: 0, skipped: 0, failed: 1 });
    expect(write).not.toHaveBeenCalled();
  });

  it("registry error → soft-fail (counted failed), never throws", async () => {
    const r = await runExtensionSignatureBackfill(
      deps({ resolveServed: async () => { throw new Error("ECONNREFUSED registry"); } }),
    );
    expect(r.failed).toBe(1);
    expect(r.written).toBe(0);
  });

  it("enumeration failure → NEVER throws; returns a soft failed result", async () => {
    let threw = false;
    const r = await runExtensionSignatureBackfill(
      deps({ listLiveVerdaccioRowsMissingSignature: async () => { throw new Error("DB down"); } }),
    ).catch(() => { threw = true; return null; });
    expect(threw).toBe(false);
    expect(r).toEqual({ scanned: 0, written: 0, skipped: 0, failed: 1 });
  });

  it("idempotent: an empty missing-signature list (already backfilled) → no writes", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(deps({ listLiveVerdaccioRowsMissingSignature: async () => [], writeBackfilledSignature: write }));
    expect(r).toEqual({ scanned: 0, written: 0, skipped: 0, failed: 0 });
    expect(write).not.toHaveBeenCalled();
  });

  it("mixed fleet: writes the verifying rows, skips null + non-verifying, counts independently", async () => {
    const rows = [
      { id: "a", source: vsource({ packageName: "@cinatra-ai/a", integrity: "sha512-A" }) },
      { id: "b", source: vsource({ packageName: "@cinatra-ai/b", integrity: "sha512-B" }) },
      { id: "c", source: vsource({ packageName: "@cinatra-ai/c", integrity: "sha512-C" }) },
    ];
    const served: Record<string, string | null> = { "@cinatra-ai/a": "SIG-A", "@cinatra-ai/b": null, "@cinatra-ai/c": "SIG-C-BAD" };
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({
        listLiveVerdaccioRowsMissingSignature: async () => rows,
        resolveServed: async ({ packageName }) => ({ signature: served[packageName] ?? null, materializationPlan: null }),
        verifySignature: (_f, sig) => sig === "SIG-A", // only A verifies
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 3, written: 1, skipped: 2, failed: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("a");
  });
});

describe("Gap 1 — locked rows are backfilled (anchor live-status parity)", () => {
  it("a locked row is scanned + CAS-written exactly like an active row", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({
        listLiveVerdaccioRowsMissingSignature: async () => [{ id: "locked-1", source: vsource() }],
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 1, written: 1, skipped: 0, failed: 0 });
    expect(write.mock.calls[0][0]).toBe("locked-1");
  });

  it("casShouldWrite accepts a locked row (not only active)", () => {
    const verified = { packageName: "@cinatra-ai/notes-connector", version: "1.2.0", integrity: "sha512-STORED" };
    expect(casShouldWrite({ status: "locked", source: vsource() }, verified)).toBe(true);
    expect(casShouldWrite({ status: "active", source: vsource() }, verified)).toBe(true);
    expect(casShouldWrite({ status: "archived", source: vsource() }, verified)).toBe(false);
    expect(casShouldWrite({ status: "disabled", source: vsource() }, verified)).toBe(false);
  });
});

describe("Gap 2 — closureHash is recomputed from the served plan, not trusted off the row", () => {
  it("served plan present → recomputes the hash, verdict uses it, writer persists it (UPGRADE null→real)", async () => {
    const seenFields: Array<{ closureHash?: string | null }> = [];
    const recompute = vi.fn(() => HASH_A);
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({
        // legacy row with NO recorded closureHash
        listLiveVerdaccioRowsMissingSignature: async () => [{ id: "upg-1", source: vsource() }],
        resolveServed: async () => ({ signature: "SIG-V2", materializationPlan: { stub: "plan" } }),
        recomputeClosureHash: recompute,
        verifySignature: (fields) => {
          seenFields.push(fields);
          return true;
        },
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 1, written: 1, skipped: 0, failed: 0 });
    expect(recompute).toHaveBeenCalledWith({ stub: "plan" }, { packageName: "@cinatra-ai/notes-connector", version: "1.2.0" });
    // the verdict was computed against the RECOMPUTED hash, not the row's (null)
    expect(seenFields[0].closureHash).toBe(HASH_A);
    // the writer persists the RECOMPUTED hash
    expect(write.mock.calls[0][1]).toEqual({
      packageName: "@cinatra-ai/notes-connector",
      version: "1.2.0",
      integrity: "sha512-STORED",
      closureHash: HASH_A,
    });
  });

  it("served plan present, row already recorded the SAME hash → writes (Case C)", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({
        listLiveVerdaccioRowsMissingSignature: async () => [{ id: "c-1", source: vsource({ closureHash: HASH_A }) }],
        resolveServed: async () => ({ signature: "SIG-V2", materializationPlan: { stub: "plan" } }),
        recomputeClosureHash: () => HASH_A,
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 1, written: 1, skipped: 0, failed: 0 });
    expect(write.mock.calls[0][1].closureHash).toBe(HASH_A);
  });

  it("plan self-identity mismatch (recompute throws) → counted failed (fail-closed), no write", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({
        resolveServed: async () => ({ signature: "SIG-V2", materializationPlan: { stub: "wrong" } }),
        recomputeClosureHash: () => {
          throw new Error("the served materialization plan identifies as @other/x@9.9.9");
        },
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 1, written: 0, skipped: 0, failed: 1 });
    expect(write).not.toHaveBeenCalled();
  });

  it("DOWNGRADE GUARD (Case E): row recorded a closure but registry serves NO plan → skip, never write", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({
        listLiveVerdaccioRowsMissingSignature: async () => [{ id: "e-1", source: vsource({ closureHash: HASH_A }) }],
        resolveServed: async () => ({ signature: "SIG-V1", materializationPlan: null }),
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 1, written: 0, skipped: 1, failed: 0 });
    expect(write).not.toHaveBeenCalled();
  });

  it("REBASE GUARD (Case D): served plan recomputes a DIFFERENT hash than the row recorded → counted failed, no write", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(
      deps({
        listLiveVerdaccioRowsMissingSignature: async () => [{ id: "d-1", source: vsource({ closureHash: HASH_A }) }],
        resolveServed: async () => ({ signature: "SIG-V2", materializationPlan: { stub: "plan" } }),
        recomputeClosureHash: () => HASH_B, // different from the recorded HASH_A
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 1, written: 0, skipped: 0, failed: 1 });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("casShouldWrite — write-time compare-and-set predicate", () => {
  const verified = { packageName: "@cinatra-ai/notes-connector", version: "1.2.0", integrity: "sha512-STORED" };

  it("true only for a live, verdaccio, unsigned row whose stored fields still match", () => {
    expect(casShouldWrite({ status: "active", source: vsource() }, verified)).toBe(true);
  });
  it("false when null/undefined", () => {
    expect(casShouldWrite(null, verified)).toBe(false);
    expect(casShouldWrite(undefined, verified)).toBe(false);
  });
  it("false when no longer live", () => {
    expect(casShouldWrite({ status: "archived", source: vsource() }, verified)).toBe(false);
  });
  it("false when already signed (concurrent backfill / idempotent)", () => {
    expect(casShouldWrite({ status: "active", source: vsource({ signature: "ALREADY" }) }, verified)).toBe(false);
  });
  it("false when the stored version or integrity changed (a reinstall/digest change)", () => {
    expect(casShouldWrite({ status: "active", source: vsource({ version: "1.3.0" }) }, verified)).toBe(false);
    expect(casShouldWrite({ status: "active", source: vsource({ integrity: "sha512-NEW" }) }, verified)).toBe(false);
  });
  it("false when the source is no longer verdaccio", () => {
    expect(casShouldWrite({ status: "active", source: { type: "github" } }, verified)).toBe(false);
  });

  it("closureHash CAS: exact match OK, null→real upgrade OK, real→null + real→different BLOCKED", () => {
    // exact match (both null)
    expect(casShouldWrite({ status: "active", source: vsource() }, { ...verified, closureHash: null })).toBe(true);
    // exact match (both real)
    expect(casShouldWrite({ status: "active", source: vsource({ closureHash: HASH_A }) }, { ...verified, closureHash: HASH_A })).toBe(true);
    // null → real (UPGRADE) allowed
    expect(casShouldWrite({ status: "active", source: vsource() }, { ...verified, closureHash: HASH_A })).toBe(true);
    // real → null (DOWNGRADE) blocked
    expect(casShouldWrite({ status: "active", source: vsource({ closureHash: HASH_A }) }, { ...verified, closureHash: null })).toBe(false);
    // real → different (REBASE) blocked
    expect(casShouldWrite({ status: "active", source: vsource({ closureHash: HASH_A }) }, { ...verified, closureHash: HASH_B })).toBe(false);
  });
});

describe("closureHashCasOk — the closureHash CAS rule", () => {
  it("allows exact match and null→real upgrade only", () => {
    expect(closureHashCasOk(null, null)).toBe(true);
    expect(closureHashCasOk(HASH_A, HASH_A)).toBe(true);
    expect(closureHashCasOk(null, HASH_A)).toBe(true); // upgrade
    expect(closureHashCasOk(undefined, HASH_A)).toBe(true); // upgrade (undefined ~ null)
    expect(closureHashCasOk(HASH_A, null)).toBe(false); // downgrade
    expect(closureHashCasOk(HASH_A, HASH_B)).toBe(false); // rebase
  });
});
