/**
 * Runtime asset registry (epic #1620 M1 Slice A — cinatra#1630, plan §2.4):
 * exact-tuple identity, atomic materialize→verify→activate, monotonic
 * generation (ABA-safe), digest-specific quarantine, DB-authoritative
 * reconstruct on cache miss, and the archive-position teardown (owner ruling 8).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";
import {
  runtimeAssetRegistry,
  RUNTIME_RENDERER_QUARANTINE_THRESHOLD,
  type RuntimeRendererActivation,
} from "../runtime-renderer-registry";

const DIGEST_A = "a".repeat(128);
const DIGEST_B = "b".repeat(128);

function tuple(over: Partial<AdmittedClientBundleTuple> = {}): AdmittedClientBundleTuple {
  return {
    packageName: "@cinatra-ai/json-artifact",
    slot: "detail",
    digest: DIGEST_A,
    entry: "client/detail.js",
    propsApiVersion: 1,
    sdkAbiRange: "^2.4.0",
    reactPeerRange: "^19.0.0",
    reactDomPeerRange: "^19.0.0",
    tokenModuleAbi: "1.0.0",
    ...over,
  };
}

const ok = { materialize: async () => {}, verify: async () => true };

afterEach(() => runtimeAssetRegistry._clearForTests());

describe("two-path membership + resolveActive", () => {
  it("a key is absent until activated, then present + resolvable", async () => {
    const t = tuple();
    const key = runtimeAssetRegistry.keyFor(t.packageName, t.slot);
    expect(runtimeAssetRegistry.inRuntimeAssetRegistry(key)).toBe(false);
    const res = await runtimeAssetRegistry.admitAndActivate({ tuple: t, generation: 1, ...ok });
    expect(res.ok).toBe(true);
    expect(runtimeAssetRegistry.inRuntimeAssetRegistry(key)).toBe(true);
    expect(runtimeAssetRegistry.resolveActive(key)).toEqual(t);
    expect(runtimeAssetRegistry.isActiveTuple(t)).toBe(true);
  });

  // G1 tuple-identity regression (plan §5.3 G1): identity is the EXACT tuple —
  // never "package installed", never "same (package, slot) key". A tuple sharing
  // the key but differing in ANY signed field is NOT the active binding, so a
  // superseded/tampered descriptor can never masquerade as admitted.
  it("isActiveTuple is false for a tuple that shares the key but differs in any field", async () => {
    const active = tuple();
    await runtimeAssetRegistry.admitAndActivate({ tuple: active, generation: 1, ...ok });
    expect(runtimeAssetRegistry.isActiveTuple(active)).toBe(true);
    // Same (package, slot) key, but a different value in each signed field.
    for (const drift of [
      { digest: DIGEST_B },
      { entry: "client/other.js" },
      { propsApiVersion: 2 },
      { sdkAbiRange: "^2.5.0" },
      { reactPeerRange: "^18.0.0" },
      { reactDomPeerRange: "^18.0.0" },
      { tokenModuleAbi: "2.0.0" },
    ] satisfies Partial<AdmittedClientBundleTuple>[]) {
      const mutated = tuple(drift);
      expect(runtimeAssetRegistry.keyFor(mutated.packageName, mutated.slot)).toBe(
        runtimeAssetRegistry.keyFor(active.packageName, active.slot),
      );
      expect(runtimeAssetRegistry.isActiveTuple(mutated)).toBe(false);
    }
  });
});

describe("atomic materialize → verify → activate", () => {
  it("does NOT activate when materialize throws (no half-materialized selection)", async () => {
    const t = tuple();
    const res = await runtimeAssetRegistry.admitAndActivate({
      tuple: t,
      generation: 1,
      materialize: async () => {
        throw new Error("disk full");
      },
      verify: async () => true,
    });
    expect(res).toEqual({ ok: false, reason: "materialize-failed" });
    expect(runtimeAssetRegistry.inRuntimeAssetRegistry(runtimeAssetRegistry.keyFor(t.packageName, t.slot))).toBe(false);
  });

  it("does NOT activate when verify is false (fail-closed admission)", async () => {
    const t = tuple();
    const res = await runtimeAssetRegistry.admitAndActivate({ tuple: t, generation: 1, materialize: async () => {}, verify: async () => false });
    expect(res).toEqual({ ok: false, reason: "verify-failed" });
    expect(runtimeAssetRegistry.resolveActive(runtimeAssetRegistry.keyFor(t.packageName, t.slot))).toBeNull();
  });

  it("materialize runs BEFORE verify, and both before the cache write", async () => {
    const order: string[] = [];
    const t = tuple();
    await runtimeAssetRegistry.admitAndActivate({
      tuple: t,
      generation: 1,
      materialize: async () => void order.push("materialize"),
      verify: async () => {
        order.push("verify");
        return true;
      },
    });
    expect(order).toEqual(["materialize", "verify"]);
  });
});

describe("monotonic generation (ABA-safe)", () => {
  it("a higher generation supersedes; a lower/equal one is rejected stale", async () => {
    const key = runtimeAssetRegistry.keyFor("@cinatra-ai/json-artifact", "detail");
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple({ digest: DIGEST_A }), generation: 5, ...ok });
    // equal generation on a live binding → stale
    expect((await runtimeAssetRegistry.admitAndActivate({ tuple: tuple({ digest: DIGEST_B }), generation: 5, ...ok })).ok).toBe(false);
    // lower generation → stale
    expect((await runtimeAssetRegistry.admitAndActivate({ tuple: tuple({ digest: DIGEST_B }), generation: 4, ...ok })).ok).toBe(false);
    expect(runtimeAssetRegistry.resolveActive(key)!.digest).toBe(DIGEST_A);
    // strictly higher → upgrade
    expect((await runtimeAssetRegistry.admitAndActivate({ tuple: tuple({ digest: DIGEST_B }), generation: 6, ...ok })).ok).toBe(true);
    expect(runtimeAssetRegistry.resolveActive(key)!.digest).toBe(DIGEST_B);
  });
});

describe("concurrent-overwrite prevention (re-check after async)", () => {
  it("a SLOW lower-generation admission cannot overwrite a committed higher generation", async () => {
    const key = runtimeAssetRegistry.keyFor("@cinatra-ai/json-artifact", "detail");
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    // gen 6 starts first with a materialize that blocks until released.
    const p6 = runtimeAssetRegistry.admitAndActivate({
      tuple: tuple({ digest: DIGEST_A }),
      generation: 6,
      materialize: () => slow,
      verify: async () => true,
    });
    // gen 7 admits + commits while gen 6 is still blocked.
    const r7 = await runtimeAssetRegistry.admitAndActivate({ tuple: tuple({ digest: DIGEST_B }), generation: 7, ...ok });
    expect(r7.ok).toBe(true);
    expect(runtimeAssetRegistry.resolveActive(key)!.digest).toBe(DIGEST_B);
    // Now release gen 6: its post-await re-check sees floor 7 and refuses stale —
    // it must NOT overwrite the newer binding or lower the floor.
    releaseSlow();
    expect(await p6).toEqual({ ok: false, reason: "stale-generation" });
    expect(runtimeAssetRegistry.resolveActive(key)!.digest).toBe(DIGEST_B);
  });
});

describe("digest-specific quarantine (3-strike, ruling 8 containment)", () => {
  it("quarantines a digest after the threshold of verify failures and refuses re-admission", async () => {
    for (let i = 0; i < RUNTIME_RENDERER_QUARANTINE_THRESHOLD; i++) {
      // each failed verify records a digest failure
      await runtimeAssetRegistry.admitAndActivate({
        tuple: tuple({ digest: DIGEST_A }),
        generation: i + 1,
        materialize: async () => {},
        verify: async () => false,
      });
    }
    expect(runtimeAssetRegistry.isDigestQuarantined(DIGEST_A)).toBe(true);
    // even a valid verify is refused for a quarantined digest
    const res = await runtimeAssetRegistry.admitAndActivate({ tuple: tuple({ digest: DIGEST_A }), generation: 99, ...ok });
    expect(res).toEqual({ ok: false, reason: "quarantined" });
    // a DIFFERENT digest is unaffected (digest-specific, not package-wide)
    expect(runtimeAssetRegistry.isDigestQuarantined(DIGEST_B)).toBe(false);
  });
});

describe("DB-authoritative reconstruct on cache miss (cross-process convergence)", () => {
  it("resolveActive rebuilds from the authority hook and warms the cache", () => {
    const key = runtimeAssetRegistry.keyFor("@cinatra-ai/json-artifact", "detail");
    const authority = vi.fn((): RuntimeRendererActivation | null => ({ tuple: tuple(), generation: 7 }));
    expect(runtimeAssetRegistry.inRuntimeAssetRegistry(key)).toBe(false);
    const resolved = runtimeAssetRegistry.resolveActive(key, authority);
    expect(resolved).toEqual(tuple());
    expect(authority).toHaveBeenCalledWith(key);
    // warmed — a second resolve does not re-consult the authority
    runtimeAssetRegistry.resolveActive(key, authority);
    expect(authority).toHaveBeenCalledTimes(1);
  });

  it("does NOT warm a reconstructed binding whose digest is quarantined", async () => {
    const key = runtimeAssetRegistry.keyFor("@cinatra-ai/json-artifact", "detail");
    for (let i = 0; i < RUNTIME_RENDERER_QUARANTINE_THRESHOLD; i++) runtimeAssetRegistry.recordDigestFailure(DIGEST_A);
    const resolved = runtimeAssetRegistry.resolveActive(key, () => ({ tuple: tuple({ digest: DIGEST_A }), generation: 1 }));
    expect(resolved).toBeNull();
  });

  it("reconstruct at the tombstoned floor generation cannot resurrect a retired epoch", async () => {
    const key = runtimeAssetRegistry.keyFor("@cinatra-ai/json-artifact", "detail");
    await runtimeAssetRegistry.admitAndActivate({ tuple: tuple(), generation: 5, ...ok }); // floor 5
    runtimeAssetRegistry.retireByPackage("@cinatra-ai/json-artifact"); // byKey cleared, floor 5 tombstone
    // A stale authority view still reporting the retired binding at gen 5 (== floor)
    // must NOT resurrect it.
    expect(runtimeAssetRegistry.resolveActive(key, () => ({ tuple: tuple(), generation: 5 }))).toBeNull();
    // A genuine reinstall at a strictly higher generation reconstructs.
    expect(runtimeAssetRegistry.resolveActive(key, () => ({ tuple: tuple(), generation: 6 }))).toEqual(tuple());
  });
});

describe("archive-position teardown = the revocation path (owner ruling 8)", () => {
  it("retireByPackage drops the active binding so the key stops being loadable", async () => {
    const t = tuple();
    const key = runtimeAssetRegistry.keyFor(t.packageName, t.slot);
    await runtimeAssetRegistry.admitAndActivate({ tuple: t, generation: 1, ...ok });
    expect(runtimeAssetRegistry.inRuntimeAssetRegistry(key)).toBe(true);
    expect(runtimeAssetRegistry.retireByPackage(t.packageName)).toBe(1);
    expect(runtimeAssetRegistry.inRuntimeAssetRegistry(key)).toBe(false);
    expect(runtimeAssetRegistry.resolveActive(key)).toBeNull();
  });

  it("a straggler re-activation at a tombstoned generation cannot resurrect", async () => {
    const t = tuple();
    const key = runtimeAssetRegistry.keyFor(t.packageName, t.slot);
    await runtimeAssetRegistry.admitAndActivate({ tuple: t, generation: 5, ...ok });
    runtimeAssetRegistry.retireByPackage(t.packageName);
    // a delayed straggler at generation <= the tombstoned floor is rejected
    expect((await runtimeAssetRegistry.admitAndActivate({ tuple: t, generation: 5, ...ok })).ok).toBe(false);
    expect(runtimeAssetRegistry.inRuntimeAssetRegistry(key)).toBe(false);
    // a genuine reinstall at a strictly higher generation opens a new epoch
    expect((await runtimeAssetRegistry.admitAndActivate({ tuple: t, generation: 6, ...ok })).ok).toBe(true);
  });
});
