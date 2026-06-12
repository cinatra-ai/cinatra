import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  runExtensionSignatureBackfill,
  casShouldWrite,
  type SignatureBackfillDeps,
} from "@/lib/extension-signature-backfill";
import type { ExtensionSourceVerdaccio } from "@cinatra-ai/extensions/canonical-types";

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
    listActiveVerdaccioRowsMissingSignature: async () => [{ id: "inst-1", source: vsource() }],
    resolveServedSignature: async () => "SIG-OK",
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
    const list = vi.fn(deps().listActiveVerdaccioRowsMissingSignature);
    const r = await runExtensionSignatureBackfill(deps({ listActiveVerdaccioRowsMissingSignature: list }));
    expect(r).toEqual({ scanned: 0, written: 0, skipped: 0, failed: 0, skippedReason: "kill-switch" });
    expect(list).not.toHaveBeenCalled();
  });

  it("key guard: no trusted keys → inert no-op (Window-1 default), never lists rows", async () => {
    const list = vi.fn(deps().listActiveVerdaccioRowsMissingSignature);
    const r = await runExtensionSignatureBackfill(deps({ loadTrustedKeyCount: () => 0, listActiveVerdaccioRowsMissingSignature: list }));
    expect(r.skippedReason).toBe("no-trusted-keys");
    expect(list).not.toHaveBeenCalled();
  });

  it("served + verifies → CAS-writes with the VERIFIED stored fields + signature", async () => {
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
    const r = await runExtensionSignatureBackfill(deps({ resolveServedSignature: async () => null, writeBackfilledSignature: write }));
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
        resolveServedSignature: () => new Promise<string>(() => {}), // never resolves
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 1, written: 0, skipped: 0, failed: 1 });
    expect(write).not.toHaveBeenCalled();
  });

  it("registry error → soft-fail (counted failed), never throws", async () => {
    const r = await runExtensionSignatureBackfill(
      deps({ resolveServedSignature: async () => { throw new Error("ECONNREFUSED registry"); } }),
    );
    expect(r.failed).toBe(1);
    expect(r.written).toBe(0);
  });

  it("enumeration failure → NEVER throws; returns a soft failed result", async () => {
    let threw = false;
    const r = await runExtensionSignatureBackfill(
      deps({ listActiveVerdaccioRowsMissingSignature: async () => { throw new Error("DB down"); } }),
    ).catch(() => { threw = true; return null; });
    expect(threw).toBe(false);
    expect(r).toEqual({ scanned: 0, written: 0, skipped: 0, failed: 1 });
  });

  it("idempotent: an empty missing-signature list (already backfilled) → no writes", async () => {
    const write = vi.fn<WriteFn>(async () => "written");
    const r = await runExtensionSignatureBackfill(deps({ listActiveVerdaccioRowsMissingSignature: async () => [], writeBackfilledSignature: write }));
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
        listActiveVerdaccioRowsMissingSignature: async () => rows,
        resolveServedSignature: async ({ packageName }) => served[packageName] ?? null,
        verifySignature: (_f, sig) => sig === "SIG-A", // only A verifies
        writeBackfilledSignature: write,
      }),
    );
    expect(r).toEqual({ scanned: 3, written: 1, skipped: 2, failed: 0 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("a");
  });
});

describe("casShouldWrite — write-time compare-and-set predicate", () => {
  const verified = { packageName: "@cinatra-ai/notes-connector", version: "1.2.0", integrity: "sha512-STORED" };

  it("true only for an active, verdaccio, unsigned row whose stored fields still match", () => {
    expect(casShouldWrite({ status: "active", source: vsource() }, verified)).toBe(true);
  });
  it("false when null/undefined", () => {
    expect(casShouldWrite(null, verified)).toBe(false);
    expect(casShouldWrite(undefined, verified)).toBe(false);
  });
  it("false when no longer active", () => {
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
});
