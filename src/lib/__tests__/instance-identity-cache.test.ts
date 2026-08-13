// cinatra#2539 — the in-process `instance_identity` read cache.
//
// The row is read by the setup gate, the approvals nav sources, the Verdaccio
// read-config, the marketplace/extensions screens, and the agent-template
// reads, and EVERY read is a `runPostgresQueriesSync` call: a fresh worker
// thread, a fresh `pg` require, a fresh connection, and an `Atomics.wait` that
// blocks the whole event loop until it answers. One authenticated
// `/configuration/marketplace` render issued twelve of them for the same row.
//
// These tests pin the two properties that make the cache safe to have: reads
// inside the window collapse to ONE database read, and nothing that could
// legitimately observe a NEWER row is served from it (the write path's own
// pre-read, and anything after a landed write or CAS).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: vi.fn(),
  writeMetadataValueToDatabase: vi.fn(),
  compareAndSwapMetadataValueFromDatabase: vi.fn(),
  readRawMetadataStringFromDatabase: vi.fn(),
  getPostgresConnectionString: vi.fn(() => "postgres://unused"),
  postgresSchema: "cinatra",
}));

import {
  compareAndSwapMetadataValueFromDatabase,
  readMetadataValueFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";
import {
  INSTANCE_IDENTITY_CACHE_TTL_MS,
  invalidateInstanceIdentityCache,
  readInstanceIdentityCacheEntry,
  storeInstanceIdentityCacheEntry,
} from "@/lib/instance-identity-cache";
import {
  compareAndSwapInstanceIdentity,
  readInstanceIdentity,
  writeInstanceIdentity,
  type InstanceIdentity,
} from "@/lib/instance-identity-store";

const IDENTITY: InstanceIdentity = {
  instanceNamespace: "example-namespace",
  instanceDisplayName: "Acme Workspace",
  tokenCiphertext: "ct-base64",
  tokenIv: "iv-base64",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pw-ct-base64",
  passwordIv: "pw-iv-base64",
  registryUrl: "https://registry.cinatra.ai",
  firstPublishedAt: null,
  createdAt: "2026-05-07T15:00:00.000Z",
};

/** The persisted row shape (what the metadata reader hands back). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...IDENTITY, ...overrides } as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceIdentityCache();
});

afterEach(() => {
  invalidateInstanceIdentityCache();
  vi.useRealTimers();
});

describe("instance-identity read cache", () => {
  it("collapses repeated reads in the same window to ONE database read", () => {
    vi.mocked(readMetadataValueFromDatabase).mockImplementation(() => row());

    const first = readInstanceIdentity();
    const second = readInstanceIdentity();
    const third = readInstanceIdentity();

    expect(readMetadataValueFromDatabase).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(first?.instanceNamespace).toBe("example-namespace");
  });

  it("caches the ABSENCE of a row — an unconfigured instance is not re-read either", () => {
    vi.mocked(readMetadataValueFromDatabase).mockImplementation(() => null);

    expect(readInstanceIdentity()).toBeNull();
    expect(readInstanceIdentity()).toBeNull();

    expect(readMetadataValueFromDatabase).toHaveBeenCalledTimes(1);
  });

  it("hands every reader its own copy — one caller's mutation cannot leak into the next read", () => {
    vi.mocked(readMetadataValueFromDatabase).mockImplementation(() =>
      row({ consumerAttachment: { instanceNamespace: "attached" } }),
    );

    const first = readInstanceIdentity();
    // A caller mutating what it was handed must not rewrite the shared entry.
    (first?.consumerAttachment as Record<string, unknown>).instanceNamespace = "tampered";

    const second = readInstanceIdentity();

    expect(
      (second?.consumerAttachment as Record<string, unknown>).instanceNamespace,
    ).toBe("attached");
  });

  it("re-reads once the entry ages past the TTL (a cross-process write self-heals)", () => {
    vi.useFakeTimers();
    vi.mocked(readMetadataValueFromDatabase)
      .mockImplementationOnce(() => row({ instanceDisplayName: "Before" }))
      .mockImplementationOnce(() => row({ instanceDisplayName: "After" }));

    expect(readInstanceIdentity()?.instanceDisplayName).toBe("Before");
    vi.advanceTimersByTime(INSTANCE_IDENTITY_CACHE_TTL_MS - 1);
    expect(readInstanceIdentity()?.instanceDisplayName).toBe("Before");
    expect(readMetadataValueFromDatabase).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    expect(readInstanceIdentity()?.instanceDisplayName).toBe("After");
    expect(readMetadataValueFromDatabase).toHaveBeenCalledTimes(2);
  });

  it("serves a fresh row after a write invalidates the entry", () => {
    vi.mocked(readMetadataValueFromDatabase)
      .mockImplementationOnce(() => row({ instanceDisplayName: "Before" }))
      // the write path's own authoritative pre-read
      .mockImplementationOnce(() => row({ instanceDisplayName: "Before" }))
      .mockImplementationOnce(() => row({ instanceDisplayName: "After" }));

    expect(readInstanceIdentity()?.instanceDisplayName).toBe("Before");
    writeInstanceIdentity({ ...IDENTITY, instanceDisplayName: "After" });
    expect(readInstanceIdentity()?.instanceDisplayName).toBe("After");
  });
});

describe("instance-identity write paths bypass the cache", () => {
  it("derives durable-field preservation from the AUTHORITATIVE row, never a cached one", () => {
    // Prime the cache with a row whose durable instanceId is already stale.
    vi.mocked(readMetadataValueFromDatabase).mockImplementationOnce(() =>
      row({ instanceId: "stale-cached-id" }),
    );
    expect(readInstanceIdentity()?.instanceId).toBe("stale-cached-id");

    // Another writer has since advanced the row. The write path must see THIS.
    vi.mocked(readMetadataValueFromDatabase).mockImplementation(() =>
      row({ instanceId: "authoritative-id" }),
    );

    // The caller's payload omits instanceId, so the merge supplies it.
    writeInstanceIdentity({ ...IDENTITY });

    const [, written] = vi.mocked(writeMetadataValueToDatabase).mock.calls[0] as [
      string,
      InstanceIdentity,
    ];
    expect(written.instanceId).toBe("authoritative-id");
  });

  it("invalidates the entry when a byte-equal CAS lands, and leaves it when the CAS is refused", () => {
    vi.mocked(readMetadataValueFromDatabase).mockImplementation(() => row());
    readInstanceIdentity();
    expect(readInstanceIdentityCacheEntry()).not.toBeNull();

    vi.mocked(compareAndSwapMetadataValueFromDatabase).mockReturnValueOnce(false);
    expect(compareAndSwapInstanceIdentity(row(), "{}")).toBe(false);
    expect(readInstanceIdentityCacheEntry()).not.toBeNull();

    vi.mocked(compareAndSwapMetadataValueFromDatabase).mockReturnValueOnce(true);
    expect(compareAndSwapInstanceIdentity(row(), "{}")).toBe(true);
    expect(readInstanceIdentityCacheEntry()).toBeNull();
  });
});

describe("cache primitives", () => {
  it("distinguishes a cached null row from a cache miss", () => {
    expect(readInstanceIdentityCacheEntry()).toBeNull();
    storeInstanceIdentityCacheEntry(null);
    expect(readInstanceIdentityCacheEntry()).toEqual({ value: null });
  });

  it("drops the entry on invalidation", () => {
    storeInstanceIdentityCacheEntry(row());
    invalidateInstanceIdentityCache();
    expect(readInstanceIdentityCacheEntry()).toBeNull();
  });
});
