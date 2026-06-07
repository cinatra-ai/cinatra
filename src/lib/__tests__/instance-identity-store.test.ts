// Tests instance identity metadata read/write behavior and compatibility shims.
//
// Covers the InstanceIdentity shape (instanceNamespace, instanceDisplayName,
// oldInstanceNamespaces) and back-compat shim tests for legacy vendorName rows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
  type InstanceIdentity,
  type RemoteRegistryConnection,
} from "@/lib/instance-identity-store";
// Cache invalidation lives in a SEPARATE module so we can spy on it via
// vi.mock — same-module mocking is unreliable.
import * as cache from "@/lib/instance-identity-cache";

vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: vi.fn(),
  writeMetadataValueToDatabase: vi.fn(),
}));

vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));

import { readMetadataValueFromDatabase, writeMetadataValueToDatabase } from "@/lib/database";

const SAMPLE_IDENTITY: InstanceIdentity = {
  instanceNamespace: "example-namespace",
  instanceDisplayName: "OSS Flywheel",
  tokenCiphertext: "ct-base64",
  tokenIv: "iv-base64",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pw-ct-base64",
  passwordIv: "pw-iv-base64",
  registryUrl: "https://registry.cinatra.ai",
  firstPublishedAt: null,
  createdAt: "2026-05-07T15:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readInstanceIdentity", () => {
  it("returns null when the metadata row has not been written", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValueOnce(null);
    const result = readInstanceIdentity();
    expect(result).toBeNull();
  });

  it("returns the parsed payload when the metadata row exists with new keys", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValueOnce(SAMPLE_IDENTITY);
    const result = readInstanceIdentity();
    expect(result).not.toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        instanceNamespace: "example-namespace",
        instanceDisplayName: "OSS Flywheel",
        tokenCiphertext: "ct-base64",
        tokenIv: "iv-base64",
        tokenAlgo: "aes-256-gcm",
        passwordCiphertext: "pw-ct-base64",
        passwordIv: "pw-iv-base64",
        firstPublishedAt: null,
        createdAt: "2026-05-07T15:00:00.000Z",
      }),
    );
  });

  it("transparently maps legacy 'vendorName' rows to instanceNamespace (back-compat shim)", () => {
    // Simulate a legacy row that still uses vendorName.
    vi.mocked(readMetadataValueFromDatabase).mockReturnValueOnce({
      vendorName: "example-namespace",
      tokenCiphertext: "ct-base64",
      tokenIv: "iv-base64",
      tokenAlgo: "aes-256-gcm",
      passwordCiphertext: "pw-ct-base64",
      passwordIv: "pw-iv-base64",
      firstPublishedAt: null,
      createdAt: "2026-05-07T15:00:00.000Z",
    });
    const result = readInstanceIdentity();
    expect(result).not.toBeNull();
    expect(result?.instanceNamespace).toBe("example-namespace");
    // Legacy rows have no instanceDisplayName; shim defaults to "".
    expect(result?.instanceDisplayName).toBe("");
  });

  it("transparently maps legacy 'oldVendorNames' to oldInstanceNamespaces (back-compat shim)", () => {
    const legacyOldVendorNames = [
      {
        name: "legacyvendor",
        frozenAt: "2026-01-01T00:00:00.000Z",
        lastTokenCiphertext: "old-ct",
        lastTokenIv: "old-iv",
      },
    ];
    vi.mocked(readMetadataValueFromDatabase).mockReturnValueOnce({
      vendorName: "example-namespace",
      tokenCiphertext: "ct",
      tokenIv: "iv",
      tokenAlgo: "aes-256-gcm",
      passwordCiphertext: "pct",
      passwordIv: "piv",
      firstPublishedAt: null,
      createdAt: "2026-05-07T15:00:00.000Z",
      oldVendorNames: legacyOldVendorNames,
    });
    const result = readInstanceIdentity();
    expect(result?.oldInstanceNamespaces).toEqual(legacyOldVendorNames);
  });

  it("returns null when raw row has neither instanceNamespace nor vendorName", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValueOnce({
      tokenCiphertext: "ct",
      // no instanceNamespace, no vendorName
    });
    const result = readInstanceIdentity();
    expect(result).toBeNull();
  });
});

describe("writeInstanceIdentity round-trip", () => {
  it("persists the payload under the 'instance_identity' metadata key", () => {
    writeInstanceIdentity(SAMPLE_IDENTITY);
    expect(vi.mocked(writeMetadataValueToDatabase)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeMetadataValueToDatabase)).toHaveBeenCalledWith(
      "instance_identity",
      expect.objectContaining({
        instanceNamespace: "example-namespace",
        instanceDisplayName: "OSS Flywheel",
        tokenCiphertext: "ct-base64",
      }),
    );
  });

  it("invalidates the in-process cache after writing (cache lives in a separate module)", () => {
    writeInstanceIdentity(SAMPLE_IDENTITY);
    expect(vi.mocked(cache.invalidateInstanceIdentityCache)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// RemoteRegistryConnection read shim
// ---------------------------------------------------------------------------

describe("RemoteRegistryConnection read shim", () => {
  it("normalizes a legacy row with `registries.remote.tokenCiphertext` to status:not_connected and drops secret fields", () => {
    // Legacy rows may contain secret fields on the remote slot. Those fields
    // must be stripped on read, and status must flip to not_connected.
    vi.mocked(readMetadataValueFromDatabase).mockReturnValueOnce({
      instanceNamespace: "example-namespace",
      instanceDisplayName: "OSS Flywheel",
      tokenCiphertext: "ct",
      tokenIv: "iv",
      tokenAlgo: "aes-256-gcm",
      passwordCiphertext: "pct",
      passwordIv: "piv",
      firstPublishedAt: null,
      createdAt: "2026-05-07T15:00:00.000Z",
      registries: {
        remote: {
          url: "https://registry.cinatra.ai",
          tokenCiphertext: "legacy-ct",
          tokenIv: "legacy-iv",
          tokenAlgo: "aes-256-gcm",
          status: "connected",
          contactEmail: "ops@example.com",
        },
      },
    });

    const result = readInstanceIdentity();
    expect(result).not.toBeNull();
    const remote = result?.registries?.remote as RemoteRegistryConnection | undefined;
    expect(remote).toBeDefined();
    expect(remote?.url).toBe("https://registry.cinatra.ai");
    expect(remote?.namespace).toBe("example-namespace");
    expect(remote?.status).toBe("not_connected");
    // Legacy secret fields must be absent from the returned shape.
    expect((remote as Record<string, unknown>).tokenCiphertext).toBeUndefined();
    expect((remote as Record<string, unknown>).tokenIv).toBeUndefined();
    expect((remote as Record<string, unknown>).tokenAlgo).toBeUndefined();
  });

  it("round-trips a new-shape pending remote slot through read → write → read unchanged", () => {
    // A row already written in the new shape (status: pending, requestId,
    // expiresAt, namespace) round-trips unchanged.
    const newRemote: RemoteRegistryConnection = {
      url: "https://registry.cinatra.ai",
      namespace: "example-namespace",
      requestId: "req-abc",
      expiresAt: "2026-05-16T15:00:00.000Z",
      status: "pending",
      contactEmail: "ops@example.com",
      requestedAt: "2026-05-09T15:00:00.000Z",
      lastPolledAt: null,
      nextPollAt: "2026-05-09T15:00:30.000Z",
    };
    vi.mocked(readMetadataValueFromDatabase).mockReturnValueOnce({
      instanceNamespace: "example-namespace",
      instanceDisplayName: "OSS Flywheel",
      tokenCiphertext: "ct",
      tokenIv: "iv",
      tokenAlgo: "aes-256-gcm",
      passwordCiphertext: "pct",
      passwordIv: "piv",
      firstPublishedAt: null,
      createdAt: "2026-05-07T15:00:00.000Z",
      registries: { remote: newRemote },
    });

    const result = readInstanceIdentity();
    expect(result?.registries?.remote).toEqual(newRemote);
  });

  it("does NOT touch registries.local when normalizing the remote slot", () => {
    // A paste-token local slot still uses RegistryConnection with
    // tokenCiphertext and must pass through unchanged.
    const localSlot = {
      url: "http://127.0.0.1:4873",
      tokenCiphertext: "local-ct",
      tokenIv: "local-iv",
      tokenAlgo: "aes-256-gcm" as const,
      tokenUpdatedAt: "2026-05-09T15:00:00.000Z",
    };
    vi.mocked(readMetadataValueFromDatabase).mockReturnValueOnce({
      instanceNamespace: "example-namespace",
      instanceDisplayName: "OSS Flywheel",
      tokenCiphertext: "ct",
      tokenIv: "iv",
      tokenAlgo: "aes-256-gcm",
      passwordCiphertext: "pct",
      passwordIv: "piv",
      firstPublishedAt: null,
      createdAt: "2026-05-07T15:00:00.000Z",
      registries: {
        local: localSlot,
        remote: {
          url: "https://registry.cinatra.ai",
          tokenCiphertext: "legacy-ct",
          tokenIv: "legacy-iv",
          tokenAlgo: "aes-256-gcm",
          status: "connected",
        },
      },
    });

    const result = readInstanceIdentity();
    expect(result?.registries?.local).toEqual(localSlot);
    // Remote was degraded; local is untouched.
    expect(result?.registries?.remote?.status).toBe("not_connected");
  });

  it("preserves the invalidateInstanceIdentityCache hook on writeInstanceIdentity (cache hook regression guard)", () => {
    // writeInstanceIdentity still calls invalidateInstanceIdentityCache; the
    // new shape must not break the cache invalidation contract.
    writeInstanceIdentity(SAMPLE_IDENTITY);
    expect(vi.mocked(cache.invalidateInstanceIdentityCache)).toHaveBeenCalledTimes(1);
  });
});
