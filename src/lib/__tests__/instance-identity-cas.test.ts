import { describe, it, expect, vi } from "vitest";
import {
  casUpdateInstanceIdentityRow,
  type InstanceIdentityCasDeps,
} from "@/lib/instance-identity-cas";
import {
  updateInstanceIdentityRegistries,
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
