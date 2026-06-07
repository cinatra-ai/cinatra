import { describe, it, expect } from "vitest";
import {
  acquireLease,
  releaseLease,
  listActiveLeases,
  reapStore,
  type SnapshotLeaseDeps,
} from "@/lib/extension-snapshot-lease";
import { digestKey, type OnDiskDigest } from "@/lib/extension-store-gc";

const PKG = "@cinatra-ai/foo-connector";

// ---------------------------------------------------------------------------
// Fake in-memory lease store driven by the module's raw SQL. We pattern-match
// the statement verb. The DB "server clock" is a fixed, controllable instant so
// `now() + ttl` (acquire) and `expires_at > now()` (listActive) are deterministic.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  package_name: string;
  digest: string;
  lease_holder: string;
  acquired_at: string;
  expires_at: string; // epoch-ms as string (sortable + comparable)
};

function fakeDb(serverNowMs: number) {
  const rows = new Map<string, Row>();
  let idSeq = 0;

  const query = async <T,>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    const v = values ?? [];
    const t = text.trimStart();

    if (t.startsWith("INSERT")) {
      // INSERT (package_name $1, digest $2, lease_holder $3, expires_at now()+ $4ms)
      const ttlMs = Number(v[3]);
      const id = `lease-${++idSeq}`;
      const row: Row = {
        id,
        package_name: String(v[0]),
        digest: String(v[1]),
        lease_holder: String(v[2]),
        acquired_at: String(serverNowMs),
        expires_at: String(serverNowMs + ttlMs),
      };
      rows.set(id, row);
      return [{ id }] as T[];
    }

    if (t.startsWith("DELETE")) {
      rows.delete(String(v[0]));
      return [] as T[];
    }

    if (t.startsWith("SELECT")) {
      // listActiveLeases: WHERE expires_at > ($1 | now())
      const cutoffMs = /\$1/.test(text) ? Date.parse(String(v[0])) : serverNowMs;
      const live = [...rows.values()].filter((r) => Number(r.expires_at) > cutoffMs);
      return live as T[];
    }

    throw new Error(`unexpected SQL: ${text}`);
  };

  return { query: query as SnapshotLeaseDeps["query"], rows };
}

const NOW = 1_000_000;

describe("acquireLease / releaseLease", () => {
  it("inserts a lease and returns its id", async () => {
    const db = fakeDb(NOW);
    const deps: SnapshotLeaseDeps = { query: db.query };
    const id = await acquireLease(
      { packageName: PKG, digest: "abc", leaseHolder: "run-1", ttlMs: 5000 },
      deps,
    );
    expect(id).toBe("lease-1");
    expect(db.rows.get("lease-1")?.expires_at).toBe(String(NOW + 5000));
  });

  it("release deletes the row (idempotent for unknown ids)", async () => {
    const db = fakeDb(NOW);
    const deps: SnapshotLeaseDeps = { query: db.query };
    const id = await acquireLease(
      { packageName: PKG, digest: "abc", leaseHolder: "run-1", ttlMs: 5000 },
      deps,
    );
    await releaseLease(id, deps);
    expect(db.rows.has(id)).toBe(false);
    // releasing an unknown id does not throw
    await expect(releaseLease("nope", deps)).resolves.toBeUndefined();
  });
});

describe("listActiveLeases (expiry filter)", () => {
  it("returns only leases whose expires_at > now", async () => {
    const db = fakeDb(NOW);
    const deps: SnapshotLeaseDeps = { query: db.query };
    await acquireLease({ packageName: PKG, digest: "live", leaseHolder: "r1", ttlMs: 10_000 }, deps);
    await acquireLease({ packageName: PKG, digest: "stale", leaseHolder: "r2", ttlMs: 0 }, deps);

    // Default "now" = server clock NOW: the ttl:0 lease (expires_at == NOW) is NOT > NOW.
    const live = await listActiveLeases({}, deps);
    expect(live.map((l) => l.digest)).toEqual(["live"]);
    expect(live[0]).toMatchObject({ packageName: PKG, leaseHolder: "r1" });
  });

  it("honors an explicit now override (expired leases excluded)", async () => {
    const db = fakeDb(NOW);
    const deps: SnapshotLeaseDeps = { query: db.query };
    await acquireLease({ packageName: PKG, digest: "short", leaseHolder: "r1", ttlMs: 1000 }, deps);

    // At NOW+2000 the lease (expires_at = NOW+1000) is expired.
    const future = new Date(NOW + 2000).toISOString();
    const live = await listActiveLeases({ now: future }, deps);
    expect(live).toEqual([]);
  });
});

describe("reapStore", () => {
  it("deletes only digest dirs that are neither active nor live-leased", async () => {
    const db = fakeDb(NOW);
    const deps: SnapshotLeaseDeps = { query: db.query };

    // A live lease on the "old" digest, plus an expired lease on "ancient".
    await acquireLease({ packageName: PKG, digest: "old", leaseHolder: "r1", ttlMs: 10_000 }, deps);
    await acquireLease({ packageName: PKG, digest: "ancient", leaseHolder: "r2", ttlMs: 0 }, deps);

    const onDisk: OnDiskDigest[] = [
      { packageName: PKG, digest: "new" }, // active → protected
      { packageName: PKG, digest: "old" }, // live lease → protected
      { packageName: PKG, digest: "ancient" }, // only an EXPIRED lease → eligible
      { packageName: PKG, digest: "orphan" }, // nothing → eligible
    ];
    const removed: OnDiskDigest[] = [];

    const result = await reapStore(
      {
        listOnDiskDigests: async () => onDisk,
        activeDigests: new Set([digestKey(PKG, "new")]),
        rmDir: async (entry) => {
          removed.push(entry);
        },
      },
      deps,
    );

    expect(result.deleted).toEqual([
      { packageName: PKG, digest: "ancient" },
      { packageName: PKG, digest: "orphan" },
    ]);
    expect(removed).toEqual(result.deleted);
  });

  it("deletes nothing when every on-disk digest is active or leased", async () => {
    const db = fakeDb(NOW);
    const deps: SnapshotLeaseDeps = { query: db.query };
    await acquireLease({ packageName: PKG, digest: "leased", leaseHolder: "r1", ttlMs: 10_000 }, deps);

    const removed: OnDiskDigest[] = [];
    const result = await reapStore(
      {
        listOnDiskDigests: async () => [
          { packageName: PKG, digest: "active" },
          { packageName: PKG, digest: "leased" },
        ],
        activeDigests: new Set([digestKey(PKG, "active")]),
        rmDir: async (entry) => {
          removed.push(entry);
        },
      },
      deps,
    );
    expect(result.deleted).toEqual([]);
    expect(removed).toEqual([]);
  });
});
