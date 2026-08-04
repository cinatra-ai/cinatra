import { describe, it, expect, vi } from "vitest";
import {
  casUpdateInstanceIdentityRow,
  type InstanceIdentityCasDeps,
} from "@/lib/instance-identity-cas";
import {
  updateInstanceIdentityRegistries,
  applyInstanceIdentityProvisioningWrite,
  type InstanceRegistries,
} from "@/lib/instance-identity-store";

// ---------------------------------------------------------------------------
// Fake byte-accurate CAS store. `compareAndSwap` lands the write ONLY when the
// caller's `expectedRaw` still byte-equals the stored value — exactly the SQL
// `UPDATE ... WHERE value=$expected` semantics — so these are true deterministic
// interleaving harnesses for the lost-update fix (cinatra#850), no wall clock.
// ---------------------------------------------------------------------------

function fakeStore(initial: Record<string, unknown>) {
  const state = { raw: JSON.stringify(initial) };
  return {
    get raw() {
      return state.raw;
    },
    set(raw: string) {
      state.raw = raw;
    },
    parsed() {
      return JSON.parse(state.raw) as Record<string, unknown>;
    },
    deps(overrides?: Partial<InstanceIdentityCasDeps>): InstanceIdentityCasDeps {
      return {
        readRawSnapshot: () => state.raw,
        compareAndSwap: (next, expected) => {
          if (state.raw === expected) {
            state.raw = JSON.stringify(next);
            return true;
          }
          return false;
        },
        ...overrides,
      };
    },
  };
}

describe("casUpdateInstanceIdentityRow (pure engine)", () => {
  it("returns 'no-identity' when there is no row", () => {
    const outcome = casUpdateInstanceIdentityRow(
      { readRawSnapshot: () => null, compareAndSwap: () => true },
      (p) => p,
    );
    expect(outcome).toBe("no-identity");
  });

  it("returns 'unparseable' when the stored value is not valid JSON", () => {
    const cas = vi.fn(() => true);
    const outcome = casUpdateInstanceIdentityRow(
      { readRawSnapshot: () => "{not json", compareAndSwap: cas },
      (p) => p,
    );
    expect(outcome).toBe("unparseable");
    expect(cas).not.toHaveBeenCalled();
  });

  it("returns 'aborted' (no write) when mutateRow returns null", () => {
    const cas = vi.fn(() => true);
    const outcome = casUpdateInstanceIdentityRow(
      { readRawSnapshot: () => JSON.stringify({ a: 1 }), compareAndSwap: cas },
      () => null,
    );
    expect(outcome).toBe("aborted");
    expect(cas).not.toHaveBeenCalled();
  });

  it("returns 'exhausted' after maxAttempts CAS conflicts (bounded, no fallback)", () => {
    const cas = vi.fn(() => false); // every swap conflicts
    const onSwapped = vi.fn();
    const outcome = casUpdateInstanceIdentityRow(
      { readRawSnapshot: () => JSON.stringify({ a: 1 }), compareAndSwap: cas, onSwapped },
      (p) => ({ ...p, a: 2 }),
      3,
    );
    expect(outcome).toBe("exhausted");
    expect(cas).toHaveBeenCalledTimes(3);
    expect(onSwapped).not.toHaveBeenCalled();
  });

  it("re-applies mutateRow onto fresh bytes after a CAS conflict — no lost update", () => {
    const store = fakeStore({ a: 0 });
    let firstCas = true;
    const onSwapped = vi.fn();
    const deps = store.deps({
      compareAndSwap: (next, expected) => {
        if (firstCas) {
          firstCas = false;
          // A concurrent writer commits `b:1` in the gap between our snapshot
          // read and our swap — flipping the stored bytes so our first CAS
          // must conflict.
          store.set(JSON.stringify({ ...store.parsed(), b: 1 }));
        }
        if (store.raw === expected) {
          store.set(JSON.stringify(next));
          return true;
        }
        return false;
      },
      onSwapped,
    });
    const outcome = casUpdateInstanceIdentityRow(deps, (parsed) => ({ ...parsed, a: 1 }));
    expect(outcome).toBe("swapped");
    // Both the concurrent `b:1` AND our `a:1` survive — the update is not lost.
    expect(store.parsed()).toEqual({ a: 1, b: 1 });
    expect(onSwapped).toHaveBeenCalledTimes(1);
  });
});

describe("updateInstanceIdentityRegistries (store wrapper — production logic)", () => {
  it("LOST-UPDATE: a concurrent non-registries commit is preserved while our remote-slot write lands", () => {
    const store = fakeStore({
      instanceNamespace: "ns",
      instanceId: "iid",
      instanceDisplayName: "Original",
      registries: {
        remote: { status: "pending" },
        local: { url: "loc", tokenCiphertext: "c", tokenIv: "i", tokenAlgo: "aes-256-gcm", tokenUpdatedAt: null },
      },
    });
    let firstCas = true;
    const deps = store.deps({
      compareAndSwap: (next, expected) => {
        if (firstCas) {
          firstCas = false;
          // Concurrent commit lands a DISPLAY-NAME change (a different field)
          // between our snapshot and our swap.
          store.set(JSON.stringify({ ...store.parsed(), instanceDisplayName: "CONCURRENT" }));
        }
        if (store.raw === expected) {
          store.set(JSON.stringify(next));
          return true;
        }
        return false;
      },
    });

    const outcome = updateInstanceIdentityRegistries(
      (reg) => ({ ...reg, remote: { url: "https://registry.example", namespace: "ns", status: "connected" } }),
      deps,
    );

    expect(outcome).toBe("swapped");
    const final = store.parsed() as {
      instanceDisplayName: string;
      instanceId: string;
      registries: { remote: { status: string }; local: { url: string } };
    };
    expect(final.instanceDisplayName).toBe("CONCURRENT"); // concurrent write NOT lost
    expect(final.registries.remote.status).toBe("connected"); // our write landed
    expect(final.registries.local.url).toBe("loc"); // sibling slot preserved
    expect(final.instanceId).toBe("iid"); // durable field preserved verbatim
  });

  it("LEGACY ROW: a registries slot inferred from legacy top-level fields survives a remote-slot write", () => {
    // No explicit `registries`; a local slot is DERIVED from legacy top-level
    // token + loopback registryUrl. The raw `parsed.registries ?? {}` approach
    // would drop it; deriving via the store shim preserves it.
    const store = fakeStore({
      instanceNamespace: "ns",
      registryUrl: "http://localhost:4873",
      tokenCiphertext: "ct",
      tokenIv: "iv",
      tokenAlgo: "aes-256-gcm",
      tokenUpdatedAt: null,
    });

    const outcome = updateInstanceIdentityRegistries(
      (reg) => ({ ...reg, remote: { url: "https://registry.example", namespace: "ns", status: "pending" } }),
      store.deps(),
    );

    expect(outcome).toBe("swapped");
    const final = store.parsed() as {
      registries: {
        local?: { url: string; tokenCiphertext: string };
        remote?: { status: string };
      };
    };
    expect(final.registries.local?.url).toBe("http://localhost:4873"); // derived local NOT lost
    expect(final.registries.local?.tokenCiphertext).toBe("ct");
    expect(final.registries.remote?.status).toBe("pending"); // remote added
  });

  it("aborts (no write) when the row has no usable namespace", () => {
    const store = fakeStore({ registries: { remote: { status: "pending" } } });
    const before = store.raw;
    const outcome = updateInstanceIdentityRegistries(
      (reg) => ({ ...reg, remote: { url: "https://registry.example", namespace: "ns", status: "connected" } }),
      store.deps(),
    );
    expect(outcome).toBe("aborted");
    expect(store.raw).toBe(before); // unchanged
  });

  it("delete-remote-slot preserves the sibling local slot and other fields", () => {
    const store = fakeStore({
      instanceNamespace: "ns",
      instanceId: "iid",
      registries: { remote: { status: "not_connected" }, local: { url: "loc", tokenCiphertext: "c", tokenIv: "i", tokenAlgo: "aes-256-gcm", tokenUpdatedAt: null } },
    });
    const outcome = updateInstanceIdentityRegistries((reg) => {
      const updated: InstanceRegistries = { ...reg };
      delete updated.remote;
      return updated;
    }, store.deps());
    expect(outcome).toBe("swapped");
    const final = store.parsed() as {
      instanceId: string;
      registries: { remote?: unknown; local?: { url: string } };
    };
    expect(final.registries.remote).toBeUndefined();
    expect(final.registries.local?.url).toBe("loc");
    expect(final.instanceId).toBe("iid");
  });

  it("back-compat: resolves the namespace from a legacy `vendorName` key and preserves it", () => {
    const store = fakeStore({
      vendorName: "legacy-ns",
      registries: { remote: { status: "pending" } },
    });
    const outcome = updateInstanceIdentityRegistries(
      (reg) => ({ ...reg, remote: { url: "https://registry.example", namespace: "ns", status: "connected" } }),
      store.deps(),
    );
    expect(outcome).toBe("swapped");
    const final = store.parsed() as { vendorName: string; registries: { remote: { status: string } } };
    expect(final.vendorName).toBe("legacy-ns");
    expect(final.registries.remote.status).toBe("connected");
  });
});

describe("applyInstanceIdentityProvisioningWrite (store wrapper)", () => {
  const WRITE = {
    instanceNamespace: "vendorb",
    tokenCiphertext: "new-ct",
    tokenIv: "new-iv",
    tokenAlgo: "aes-256-gcm" as const,
    passwordCiphertext: "new-pwct",
    passwordIv: "new-pwiv",
  };

  it("LOST-UPDATE: a concurrent display-name save that lands mid-CAS is preserved alongside the rename", () => {
    // Reproduces the exact race the review thread flagged: a frozen
    // display-name-only save (editVendorAction) commits between our snapshot
    // read and our swap attempt. The old single-read-then-write
    // provisionAndPersist would have spread its PRE-await snapshot here and
    // silently discarded this concurrent commit.
    const store = fakeStore({
      instanceNamespace: "vendora",
      instanceId: "iid",
      instanceDisplayName: "Vendor A",
      tokenCiphertext: "old-ct",
      tokenIv: "old-iv",
      tokenAlgo: "aes-256-gcm",
      passwordCiphertext: "old-pwct",
      passwordIv: "old-pwiv",
      firstPublishedAt: "2026-05-01T00:00:00.000Z",
    });
    let firstCas = true;
    const deps = store.deps({
      compareAndSwap: (next, expected) => {
        if (firstCas) {
          firstCas = false;
          store.set(
            JSON.stringify({ ...store.parsed(), instanceDisplayName: "Vendor A — Updated Concurrently" }),
          );
        }
        if (store.raw === expected) {
          store.set(JSON.stringify(next));
          return true;
        }
        return false;
      },
    });

    const outcome = applyInstanceIdentityProvisioningWrite(
      WRITE,
      { appendPreviousNamespace: true },
      deps,
    );

    expect(outcome).toBe("swapped");
    const final = store.parsed() as {
      instanceNamespace: string;
      instanceDisplayName: string;
      instanceId: string;
      firstPublishedAt: string | null;
      oldInstanceNamespaces: Array<{ name: string; lastTokenCiphertext: string }>;
    };
    expect(final.instanceNamespace).toBe("vendorb"); // our rename landed
    expect(final.instanceDisplayName).toBe("Vendor A — Updated Concurrently"); // concurrent write NOT lost
    expect(final.instanceId).toBe("iid"); // durable field preserved verbatim
    expect(final.firstPublishedAt).toBeNull();
    expect(final.oldInstanceNamespaces).toEqual([
      expect.objectContaining({ name: "vendora", lastTokenCiphertext: "old-ct" }),
    ]);
  });

  it("LOST-RENAME: two concurrent provisioning writes — the retrying one archives the FRESH namespace/token, not its stale pre-await values", () => {
    // Two renames race: this call's "pre-await" namespace/token (what a
    // caller closure captured before its own registry round-trip) is
    // "vendora"/"old-ct" — but by the time its CAS attempt actually runs,
    // ANOTHER concurrent provisioning write has already landed, moving the
    // row to "vendorx"/"mid-ct". The archived oldInstanceNamespaces entry
    // must record "vendorx"/"mid-ct" (the value live immediately before THIS
    // swap), never the caller's stale "vendora"/"old-ct" — otherwise the
    // rename history silently skips a real transition.
    const store = fakeStore({
      instanceNamespace: "vendora",
      tokenCiphertext: "old-ct",
      tokenIv: "old-iv",
      firstPublishedAt: "2026-05-01T00:00:00.000Z",
    });
    let firstCas = true;
    const deps = store.deps({
      compareAndSwap: (next, expected) => {
        if (firstCas) {
          firstCas = false;
          // A concurrent provisioning write (another rename) commits first.
          store.set(
            JSON.stringify({
              ...store.parsed(),
              instanceNamespace: "vendorx",
              tokenCiphertext: "mid-ct",
              tokenIv: "mid-iv",
            }),
          );
        }
        if (store.raw === expected) {
          store.set(JSON.stringify(next));
          return true;
        }
        return false;
      },
    });

    const outcome = applyInstanceIdentityProvisioningWrite(
      WRITE,
      { appendPreviousNamespace: true },
      deps,
    );

    expect(outcome).toBe("swapped");
    const final = store.parsed() as {
      instanceNamespace: string;
      oldInstanceNamespaces: Array<{ name: string; lastTokenCiphertext: string; lastTokenIv: string }>;
    };
    expect(final.instanceNamespace).toBe("vendorb"); // this write's own target still lands
    // The archived entry reflects the FRESH row this attempt actually swapped
    // against ("vendorx"/"mid-ct"), not the caller's stale pre-await values.
    expect(final.oldInstanceNamespaces).toEqual([
      expect.objectContaining({ name: "vendorx", lastTokenCiphertext: "mid-ct", lastTokenIv: "mid-iv" }),
    ]);
  });

  it("back-compat: archives the prior namespace from a legacy `vendorName`-only row instead of aborting", () => {
    // Deployed legacy rows carry the namespace under `vendorName` (no
    // `instanceNamespace` key). `readInstanceIdentity` resolves the namespace
    // through its shim, so every action-level gate ahead of the CAS write
    // passes on such a row — the append branch must apply the same fallback,
    // or the write declines ("aborted") AFTER the registry user was already
    // provisioned and the rename can never land.
    const store = fakeStore({
      vendorName: "legacy-ns",
      tokenCiphertext: "old-ct",
      tokenIv: "old-iv",
      firstPublishedAt: "2026-05-01T00:00:00.000Z",
    });
    const outcome = applyInstanceIdentityProvisioningWrite(
      WRITE,
      { appendPreviousNamespace: true },
      store.deps(),
    );
    expect(outcome).toBe("swapped");
    const final = store.parsed() as {
      instanceNamespace: string;
      oldInstanceNamespaces: Array<{ name: string; lastTokenCiphertext: string; lastTokenIv: string }>;
    };
    expect(final.instanceNamespace).toBe("vendorb");
    // The archived entry's name is exactly the legacy `vendorName` value.
    expect(final.oldInstanceNamespaces).toEqual([
      expect.objectContaining({
        name: "legacy-ns",
        lastTokenCiphertext: "old-ct",
        lastTokenIv: "old-iv",
      }),
    ]);
  });

  it("aborts (no write) when appendPreviousNamespace is set but the row has no usable prior namespace", () => {
    const store = fakeStore({ tokenCiphertext: "old-ct" });
    const before = store.raw;
    const outcome = applyInstanceIdentityProvisioningWrite(
      WRITE,
      { appendPreviousNamespace: true },
      store.deps(),
    );
    expect(outcome).toBe("aborted");
    expect(store.raw).toBe(before); // unchanged
  });

  it("does not append oldInstanceNamespaces when appendPreviousNamespace is false (pre-publish edit path)", () => {
    const store = fakeStore({
      instanceNamespace: "vendora",
      tokenCiphertext: "old-ct",
      firstPublishedAt: null,
    });
    const outcome = applyInstanceIdentityProvisioningWrite(
      WRITE,
      { appendPreviousNamespace: false },
      store.deps(),
    );
    expect(outcome).toBe("swapped");
    const final = store.parsed() as { instanceNamespace: string; oldInstanceNamespaces?: unknown };
    expect(final.instanceNamespace).toBe("vendorb");
    expect(final.oldInstanceNamespaces).toBeUndefined();
  });

  it("exhausts under sustained CAS contention rather than falling back to a clobbering write", () => {
    const store = fakeStore({
      instanceNamespace: "vendora",
      tokenCiphertext: "old-ct",
      firstPublishedAt: "2026-05-01T00:00:00.000Z",
    });
    const deps = store.deps({
      compareAndSwap: () => false, // every attempt conflicts
    });
    const outcome = applyInstanceIdentityProvisioningWrite(
      WRITE,
      { appendPreviousNamespace: true },
      deps,
    );
    expect(outcome).toBe("exhausted");
    // Nothing was clobbered — the row is exactly what it started as.
    const final = store.parsed() as { instanceNamespace: string };
    expect(final.instanceNamespace).toBe("vendora");
  });
});
