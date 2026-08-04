// Unit tests for the pending-provision credential stash
// (@/lib/instance-identity-pending-provision): the metadata KV roundtrip,
// namespace-keyed reads, the fail-toward-fresh-mint shape validation, and the
// clear semantics. The action-level reuse behaviour (skip the duplicate
// createNpmUser on retry) is covered in
// src/app/configuration/instance/__tests__/rename-pending-provision-reuse.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
}));
vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: vi.fn((key: string, fallback: unknown) =>
    dbState.store.has(key) ? dbState.store.get(key) : fallback,
  ),
  writeMetadataValueToDatabase: vi.fn((key: string, value: unknown) => {
    dbState.store.set(key, value);
  }),
}));

import {
  readPendingProvisionedCredentials,
  writePendingProvisionedCredentials,
  clearPendingProvisionedCredentials,
  type PendingProvisionedCredentials,
} from "@/lib/instance-identity-pending-provision";

const RECORD: PendingProvisionedCredentials = {
  instanceNamespace: "vendorb",
  tokenCiphertext: "tok-ct",
  tokenIv: "tok-iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pw-ct",
  passwordIv: "pw-iv",
  mintedAt: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  dbState.store.clear();
});

describe("pending-provision credential stash", () => {
  it("round-trips a stashed record for the same target namespace", () => {
    writePendingProvisionedCredentials(RECORD);
    expect(readPendingProvisionedCredentials("vendorb")).toEqual(RECORD);
  });

  it("returns null when nothing is stashed", () => {
    expect(readPendingProvisionedCredentials("vendorb")).toBeNull();
  });

  it("returns null for a different target namespace (stale mint is superseded, not reused)", () => {
    writePendingProvisionedCredentials(RECORD);
    expect(readPendingProvisionedCredentials("vendorc")).toBeNull();
  });

  it("returns null after clear", () => {
    writePendingProvisionedCredentials(RECORD);
    clearPendingProvisionedCredentials();
    expect(readPendingProvisionedCredentials("vendorb")).toBeNull();
  });

  it("overwrites the single slot on a subsequent write", () => {
    writePendingProvisionedCredentials(RECORD);
    const next = { ...RECORD, instanceNamespace: "vendorc", tokenCiphertext: "tok-ct-2" };
    writePendingProvisionedCredentials(next);
    expect(readPendingProvisionedCredentials("vendorb")).toBeNull();
    expect(readPendingProvisionedCredentials("vendorc")).toEqual(next);
  });

  it.each([
    ["tokenCiphertext", ""],
    ["tokenIv", ""],
    ["tokenAlgo", "aes-128-gcm"],
    ["passwordCiphertext", ""],
    ["passwordIv", ""],
  ] as const)(
    "returns null (fresh-mint fallback) when the stored %s is unusable",
    (field, badValue) => {
      dbState.store.set("instance_identity_pending_provision", {
        ...RECORD,
        [field]: badValue,
      });
      expect(readPendingProvisionedCredentials("vendorb")).toBeNull();
    },
  );
});
