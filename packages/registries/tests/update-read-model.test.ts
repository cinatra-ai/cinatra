import { describe, expect, it } from "vitest";
// Deep-path import (NOT the top-level barrel) so this module stays out of the
// registries barrel graph — mirrors how the read model's real consumers import
// it, and keeps the route-graph ratchet's locked-route ceilings intact.
import {
  buildUpdateEntry,
  extractLatestSdkAbiRange,
  isUpdateEntryStale,
  readUpdateModelForInstalled,
  InMemoryExtensionUpdateReadModelStore,
  type ExtensionUpdateEntry,
} from "../src/update-read-model";

const HOUR = 60 * 60 * 1000;

describe("extractLatestSdkAbiRange (ABI-range read)", () => {
  it("reads cinatra.sdkAbiRange from a packument version manifest", () => {
    expect(
      extractLatestSdkAbiRange({ name: "@acme/a", version: "1.2.0", cinatra: { sdkAbiRange: "^2" } }),
    ).toBe("^2");
  });

  it("trims surrounding whitespace", () => {
    expect(extractLatestSdkAbiRange({ cinatra: { sdkAbiRange: "  >=2.2  " } })).toBe(">=2.2");
  });

  it("returns null when the range is absent, empty, or whitespace-only", () => {
    expect(extractLatestSdkAbiRange({ cinatra: {} })).toBeNull();
    expect(extractLatestSdkAbiRange({ cinatra: { sdkAbiRange: "" } })).toBeNull();
    expect(extractLatestSdkAbiRange({ cinatra: { sdkAbiRange: "   " } })).toBeNull();
    expect(extractLatestSdkAbiRange({})).toBeNull();
  });

  it("returns null for non-object / non-string inputs (never throws)", () => {
    expect(extractLatestSdkAbiRange(null)).toBeNull();
    expect(extractLatestSdkAbiRange(undefined)).toBeNull();
    expect(extractLatestSdkAbiRange("nope")).toBeNull();
    expect(extractLatestSdkAbiRange({ cinatra: null })).toBeNull();
    expect(extractLatestSdkAbiRange({ cinatra: { sdkAbiRange: 42 } })).toBeNull();
  });

  it("preserves a malformed-but-present range verbatim (ABI check rejects, not this)", () => {
    expect(extractLatestSdkAbiRange({ cinatra: { sdkAbiRange: "not-a-range" } })).toBe("not-a-range");
  });
});

describe("buildUpdateEntry", () => {
  it("normalises a Date `now` to an ISO refreshedAt", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const entry = buildUpdateEntry({
      packageName: "@acme/a",
      latestVersion: "1.5.0",
      latestSdkAbiRange: "^2",
      now,
    });
    expect(entry).toEqual({
      packageName: "@acme/a",
      latestVersion: "1.5.0",
      latestSdkAbiRange: "^2",
      refreshedAt: "2026-07-10T12:00:00.000Z",
    });
  });

  it("accepts an ISO-string `now` verbatim", () => {
    const entry = buildUpdateEntry({
      packageName: "@acme/a",
      latestVersion: "1.5.0",
      latestSdkAbiRange: null,
      now: "2026-07-10T12:00:00.000Z",
    });
    expect(entry.refreshedAt).toBe("2026-07-10T12:00:00.000Z");
  });

  it("collapses empty/undefined version + range to null", () => {
    const entry = buildUpdateEntry({
      packageName: "@acme/a",
      latestVersion: "",
      latestSdkAbiRange: undefined,
      now: new Date(),
    });
    expect(entry.latestVersion).toBeNull();
    expect(entry.latestSdkAbiRange).toBeNull();
  });
});

describe("isUpdateEntryStale (staleness / refresh)", () => {
  const base: ExtensionUpdateEntry = {
    packageName: "@acme/a",
    latestVersion: "1.0.0",
    latestSdkAbiRange: "^2",
    refreshedAt: "2026-07-10T12:00:00.000Z",
  };

  it("is fresh within the ttl", () => {
    const now = new Date("2026-07-10T12:30:00.000Z"); // +30m, ttl 1h
    expect(isUpdateEntryStale(base, now, HOUR)).toBe(false);
  });

  it("is stale once older than the ttl", () => {
    const now = new Date("2026-07-10T13:30:00.000Z"); // +90m, ttl 1h
    expect(isUpdateEntryStale(base, now, HOUR)).toBe(true);
  });

  it("treats an unparseable refreshedAt as stale (fail-safe)", () => {
    const bad = { ...base, refreshedAt: "not-a-date" };
    expect(isUpdateEntryStale(bad, new Date(), HOUR)).toBe(true);
  });

  it("ttl<=0 makes any entry stale", () => {
    expect(isUpdateEntryStale(base, base.refreshedAt, 0)).toBe(true);
  });
});

describe("InMemoryExtensionUpdateReadModelStore", () => {
  it("upserts last-writer-wins and reads only requested names", async () => {
    const store = new InMemoryExtensionUpdateReadModelStore();
    await store.upsert([
      buildUpdateEntry({ packageName: "@acme/a", latestVersion: "1.0.0", latestSdkAbiRange: "^2", now: new Date() }),
      buildUpdateEntry({ packageName: "@acme/b", latestVersion: "2.0.0", latestSdkAbiRange: null, now: new Date() }),
    ]);
    // Overwrite @acme/a.
    await store.upsert([
      buildUpdateEntry({ packageName: "@acme/a", latestVersion: "1.1.0", latestSdkAbiRange: "^2", now: new Date() }),
    ]);
    expect(store.size()).toBe(2);
    const read = await store.read(["@acme/a", "@acme/missing"]);
    expect(read.get("@acme/a")?.latestVersion).toBe("1.1.0");
    expect(read.has("@acme/b")).toBe(false); // not requested
    expect(read.has("@acme/missing")).toBe(false); // never synced
  });
});

describe("readUpdateModelForInstalled (gatekept read path)", () => {
  const now = new Date("2026-07-10T13:00:00.000Z");

  async function seed(): Promise<InMemoryExtensionUpdateReadModelStore> {
    const store = new InMemoryExtensionUpdateReadModelStore();
    await store.upsert([
      // fresh (+0m)
      buildUpdateEntry({ packageName: "@acme/fresh", latestVersion: "1.5.0", latestSdkAbiRange: "^2", now }),
      // stale (2h old, ttl 1h)
      buildUpdateEntry({
        packageName: "@acme/old",
        latestVersion: "1.5.0",
        latestSdkAbiRange: "^2",
        now: "2026-07-10T11:00:00.000Z",
      }),
    ]);
    return store;
  }

  it("returns cached entries and derives staleness, preserving input order", async () => {
    const store = await seed();
    const out = await readUpdateModelForInstalled(
      store,
      ["@acme/old", "@acme/fresh", "@acme/never"],
      { now, ttlMs: HOUR },
    );
    expect(out.map((r) => r.packageName)).toEqual(["@acme/old", "@acme/fresh", "@acme/never"]);

    const [old, fresh, never] = out;
    expect(fresh.entry?.latestVersion).toBe("1.5.0");
    expect(fresh.stale).toBe(false);

    expect(old.entry).not.toBeNull();
    expect(old.stale).toBe(true); // aged out

    // Never-synced package: null entry, and ALWAYS stale so callers gate
    // uniformly on `stale` (the gatekept "no data yet" case).
    expect(never.entry).toBeNull();
    expect(never.stale).toBe(true);
  });

  it("surfaces latestSdkAbiRange for the ABI-compat consumer", async () => {
    const store = await seed();
    const [row] = await readUpdateModelForInstalled(store, ["@acme/fresh"], { now, ttlMs: HOUR });
    expect(row.entry?.latestSdkAbiRange).toBe("^2");
  });

  it("returns an empty array for no installed packages", async () => {
    const store = await seed();
    expect(await readUpdateModelForInstalled(store, [], { now, ttlMs: HOUR })).toEqual([]);
  });
});
