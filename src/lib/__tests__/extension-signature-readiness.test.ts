import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assessSignatureReadiness,
  classifyRowReadiness,
  type SignatureReadinessDeps,
} from "@/lib/extension-signature-readiness";
import type { ExtensionSourceVerdaccio } from "@cinatra-ai/extensions/canonical-types";

const HASH_A = "a".repeat(128); // a valid-shape 128-hex sha512 closureHash

function vsource(over: Partial<ExtensionSourceVerdaccio> = {}): ExtensionSourceVerdaccio {
  return {
    type: "verdaccio",
    registryUrl: "https://registry.cinatra.ai",
    packageName: "@cinatra-ai/notes-connector",
    version: "3.4.0",
    integrity: "sha512-STORED",
    ...over,
  };
}

/** A live row with its CANONICAL packageName column defaulting to source.packageName. */
function vrow(
  id: string,
  sourceOver: Partial<ExtensionSourceVerdaccio> = {},
  canonicalPackageName?: string,
): { id: string; packageName: string; source: ExtensionSourceVerdaccio } {
  const source = vsource(sourceOver);
  return { id, packageName: canonicalPackageName ?? source.packageName, source };
}

/** A full deps object so assessSignatureReadiness never builds the real (server-only) deps. */
function deps(over: Partial<SignatureReadinessDeps> = {}): SignatureReadinessDeps {
  return {
    loadTrustedKeyCount: () => 1,
    listLiveVerdaccioRows: async () => [vrow("inst-1", { signature: "SIG" })],
    // Default: everything verifies (the all-ready fleet).
    simulateRequiredVerdict: () => true,
    ...over,
  };
}

describe("classifyRowReadiness (pure)", () => {
  it("a verified verdict is READY", () => {
    const r = classifyRowReadiness(true, true);
    expect(r.ready).toBe(true);
    expect(r.verdict).toBe("verified");
  });

  it("a false verdict WITH a stored signature is NOT-READY (unverified)", () => {
    const r = classifyRowReadiness(false, true);
    expect(r.ready).toBe(false);
    expect(r.verdict).toBe("unverified");
    expect(r.reason).toMatch(/does NOT verify/);
  });

  it("a false verdict with NO stored signature is NOT-READY (unsigned)", () => {
    const r = classifyRowReadiness(false, false);
    expect(r.ready).toBe(false);
    expect(r.verdict).toBe("unsigned");
    expect(r.reason).toMatch(/no signature stored/);
  });

  it("an undefined verdict (no signing configured) with no signature is NOT-READY (unsigned)", () => {
    // Under the require=true simulation resolveSignatureVerdict collapses undefined
    // to a refusal, but classifyRowReadiness must independently treat undefined as
    // NOT-READY (never ready) — fail-closed.
    const r = classifyRowReadiness(undefined, false);
    expect(r.ready).toBe(false);
    expect(r.verdict).toBe("unsigned");
  });

  it("an undefined verdict WITH a stored signature is NOT-READY (unverified)", () => {
    const r = classifyRowReadiness(undefined, true);
    expect(r.ready).toBe(false);
    expect(r.verdict).toBe("unverified");
  });
});

describe("assessSignatureReadiness — fleet verdict", () => {
  it("READY when ≥1 trusted key and every live row verifies", async () => {
    const res = await assessSignatureReadiness(deps());
    expect(res.ready).toBe(true);
    expect(res.trustedKeyCount).toBe(1);
    expect(res.scanned).toBe(1);
    expect(res.readyCount).toBe(1);
    expect(res.notReadyCount).toBe(0);
    expect(res.blockingReason).toBeUndefined();
  });

  it("NOT-READY with zero trusted keys EVEN IF rows would (vacuously) pass — the key guard", async () => {
    // With zero keys nothing can verify; but assert the explicit key guard sets
    // blockingReason and ready:false independent of per-row outcomes.
    const res = await assessSignatureReadiness(
      deps({
        loadTrustedKeyCount: () => 0,
        listLiveVerdaccioRows: async () => [],
        simulateRequiredVerdict: () => true,
      }),
    );
    expect(res.ready).toBe(false);
    expect(res.blockingReason).toBe("no-trusted-keys");
    expect(res.scanned).toBe(0);
  });

  it("zero live rows + ≥1 trusted key is trivially READY (nothing to deny)", async () => {
    const res = await assessSignatureReadiness(
      deps({ loadTrustedKeyCount: () => 1, listLiveVerdaccioRows: async () => [] }),
    );
    expect(res.ready).toBe(true);
    expect(res.scanned).toBe(0);
    expect(res.readyCount).toBe(0);
    expect(res.notReadyCount).toBe(0);
  });

  it("NOT-READY when ANY live row fails to verify — reports the blocker", async () => {
    const rows = [
      vrow("ok-1", { signature: "SIG-OK" }),
      vrow("bad-1", { packageName: "@cinatra-ai/tasks-connector", signature: "SIG-BAD" }),
      vrow("unsigned-1", { packageName: "@cinatra-ai/legacy-connector" }), // no signature
    ];
    const res = await assessSignatureReadiness(
      deps({
        listLiveVerdaccioRows: async () => rows,
        // ok-1 verifies; bad-1 has a sig but fails; unsigned-1 has no sig → undefined→deny.
        simulateRequiredVerdict: ({ signature }) =>
          signature === "SIG-OK" ? true : signature ? false : undefined,
      }),
    );
    expect(res.ready).toBe(false);
    expect(res.readyCount).toBe(1);
    expect(res.notReadyCount).toBe(2);
    const blockers = res.rows.filter((r) => !r.ready);
    expect(blockers.map((r) => r.id).sort()).toEqual(["bad-1", "unsigned-1"]);
    expect(blockers.find((r) => r.id === "bad-1")?.verdict).toBe("unverified");
    expect(blockers.find((r) => r.id === "unsigned-1")?.verdict).toBe("unsigned");
  });

  it("NOT-READY on canonical-vs-source packageName drift — never reaches the crypto verdict", async () => {
    let verdictCalls = 0;
    const res = await assessSignatureReadiness(
      deps({
        // canonical column says notes-connector; source.packageName says evil-connector.
        listLiveVerdaccioRows: async () => [
          vrow("drift-1", { packageName: "@cinatra-ai/evil-connector", signature: "SIG" }, "@cinatra-ai/notes-connector"),
        ],
        simulateRequiredVerdict: () => {
          verdictCalls++;
          return true; // would falsely pass if reached
        },
      }),
    );
    expect(res.ready).toBe(false);
    expect(res.notReadyCount).toBe(1);
    expect(verdictCalls).toBe(0); // drift short-circuits BEFORE the crypto verdict
    const drift = res.rows.find((r) => r.id === "drift-1");
    expect(drift?.verdict).toBe("identity-drift");
    expect(drift?.packageName).toBe("@cinatra-ai/notes-connector"); // reports the CANONICAL identity
  });

  it("feeds the CANONICAL packageName column into the verdict (matching activation)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await assessSignatureReadiness(
      deps({
        // canonical and source agree here, but assert the canonical column flows through.
        listLiveVerdaccioRows: async () => [
          vrow("c-1", { signature: "SIG" }, "@cinatra-ai/notes-connector"),
        ],
        simulateRequiredVerdict: (fields) => {
          seen.push(fields);
          return true;
        },
      }),
    );
    expect(seen[0]).toMatchObject({ packageName: "@cinatra-ai/notes-connector" });
  });

  it("threads stored closureHash + signature into the exact verdict (no normalization)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await assessSignatureReadiness(
      deps({
        listLiveVerdaccioRows: async () => [vrow("c-1", { signature: "v2:SIG", closureHash: HASH_A })],
        simulateRequiredVerdict: (fields) => {
          seen.push(fields);
          return true;
        },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      packageName: "@cinatra-ai/notes-connector",
      version: "3.4.0",
      integrity: "sha512-STORED",
      signature: "v2:SIG",
      closureHash: HASH_A,
    });
  });

  it("coalesces absent signature/closureHash to null when threading the verdict", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await assessSignatureReadiness(
      deps({
        listLiveVerdaccioRows: async () => [vrow("n-1")], // no sig, no closure
        simulateRequiredVerdict: (fields) => {
          seen.push(fields);
          return false;
        },
      }),
    );
    expect(seen[0]).toMatchObject({ signature: null, closureHash: null });
  });

  it("logs each NOT-READY row", async () => {
    const logged: string[] = [];
    await assessSignatureReadiness(
      deps({
        listLiveVerdaccioRows: async () => [vrow("bad-1")],
        simulateRequiredVerdict: () => false,
        log: (m) => logged.push(m),
      }),
    );
    expect(logged.some((l) => l.includes("NOT-READY") && l.includes("bad-1"))).toBe(true);
  });

  it("propagates an enumeration throw (fail-closed — caller treats it as NOT-READY)", async () => {
    await expect(
      assessSignatureReadiness(
        deps({
          listLiveVerdaccioRows: async () => {
            throw new Error("db down");
          },
        }),
      ),
    ).rejects.toThrow(/db down/);
  });

  it("classifies a WHITESPACE-ONLY signature as 'unsigned' (mirroring the verdict's trim)", async () => {
    // resolveSignatureVerdict trims the signature, so "   " is treated as absent;
    // the readiness label must agree → 'unsigned', not 'unverified'.
    const res = await assessSignatureReadiness(
      deps({
        listLiveVerdaccioRows: async () => [vrow("ws-1", { signature: "   " })],
        simulateRequiredVerdict: () => undefined, // no signing => undefined under require=true
      }),
    );
    expect(res.ready).toBe(false);
    const row = res.rows.find((r) => r.id === "ws-1");
    expect(row?.verdict).toBe("unsigned");
  });
});

describe("assessSignatureReadiness — partial deps override safety", () => {
  it("a PARTIAL override (missing simulateRequiredVerdict) merges over defaults — does not crash", async () => {
    // Override loadTrustedKeyCount + listLiveVerdaccioRows but NOT
    // simulateRequiredVerdict. The old gate (truthy loadTrustedKeyCount) would
    // have treated this as a COMPLETE injection and left simulateRequiredVerdict
    // undefined → crash on the first row. The full-deps gate instead merges over
    // the real defaults, so simulateRequiredVerdict is defined. We give zero keys
    // so the assessment never needs the DB and returns the blocker cleanly.
    const res = await assessSignatureReadiness({
      loadTrustedKeyCount: () => 0,
      listLiveVerdaccioRows: async () => [],
    });
    expect(res.ready).toBe(false);
    expect(res.blockingReason).toBe("no-trusted-keys");
  });
});
