// Minted-credentials-as-recoverable-state for provisionAndPersist's
// self-registration mode (mode b).
//
// The failure this closes: `createNpmUser` mints the Verdaccio npm user for
// the NEW namespace BEFORE the identity-row CAS write. When that write did
// not land, the minted token was discarded with the request — and the
// operator's retry (prompted by the `identity-write-conflict` flash) called
// `createNpmUser` again for the SAME namespace, which Verdaccio 409s
// (VerdaccioUserAlreadyRegisteredError), misreported as `namespace-taken`.
// A transient write conflict became a permanent dead end for that namespace.
//
// The fix under test: the encrypted mint is stashed
// (@/lib/instance-identity-pending-provision) before the CAS attempt; a retry
// targeting the same namespace reuses the stashed ciphertexts and SKIPS the
// duplicate registry call; a landed write clears the stash. The stash module
// itself (metadata KV roundtrip + shape validation) is unit-tested in
// src/lib/__tests__/instance-identity-pending-provision.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
  applyInstanceIdentityProvisioningWrite: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));

// Stateful in-memory stash — the real module's contract (single slot, keyed
// by target namespace) with the DB round-trip replaced by a closure variable.
const pendingState = vi.hoisted(() => ({
  record: null as Record<string, unknown> | null,
}));
vi.mock("@/lib/instance-identity-pending-provision", () => ({
  readPendingProvisionedCredentials: vi.fn((instanceNamespace: string) =>
    pendingState.record && pendingState.record.instanceNamespace === instanceNamespace
      ? pendingState.record
      : null,
  ),
  writePendingProvisionedCredentials: vi.fn((record: Record<string, unknown>) => {
    pendingState.record = record;
  }),
  clearPendingProvisionedCredentials: vi.fn(() => {
    pendingState.record = null;
  }),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@example.com" },
  })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error("REDIRECT:" + url);
    (err as unknown as { __isRedirect: true }).__isRedirect = true;
    throw err;
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: vi.fn((plaintext: string) => ({
    ciphertext: `enc(${plaintext})`,
    iv: "fake-iv",
  })),
}));

// Short-circuits assertNamespaceRenameAllowed's marketplace round-trip: no
// consumer/vendor token available at all is a safe-rename no-op.
const { FakeVendorCredentialsMissingError } = vi.hoisted(() => {
  class FakeVendorCredentialsMissingError extends Error {
    code = "VENDOR_CREDENTIALS_MISSING";
  }
  return { FakeVendorCredentialsMissingError };
});
vi.mock("@/lib/marketplace-credentials", () => ({
  resolveConsumerOrVendorMarketplaceToken: vi.fn(() => {
    throw new FakeVendorCredentialsMissingError("no token");
  }),
  VendorCredentialsMissingError: FakeVendorCredentialsMissingError,
  getEffectiveViewerScope: vi.fn(),
}));

// Each mint yields a DISTINCT token, so a payload carrying the FIRST mint's
// ciphertext after a second action run proves stash reuse (not a re-mint).
const mintCounter = vi.hoisted(() => ({ n: 0 }));
vi.mock("@cinatra-ai/registries", () => ({
  createNpmUser: vi.fn(async () => {
    mintCounter.n += 1;
    return { token: `minted-token-${mintCounter.n}` };
  }),
  VerdaccioUserAlreadyRegisteredError: class extends Error {},
  VerdaccioRegistrationDisabledError: class extends Error {},
  VerdaccioUnexpectedResponseError: class extends Error {},
  listAgentPackages: vi.fn(async () => []),
}));

import { renameInstanceNamespaceAction } from "@/app/configuration/instance/actions";
import {
  readInstanceIdentity,
  applyInstanceIdentityProvisioningWrite,
} from "@/lib/instance-identity-store";
import type { InstanceIdentity } from "@/lib/instance-identity-store";
import {
  readPendingProvisionedCredentials,
  writePendingProvisionedCredentials,
  clearPendingProvisionedCredentials,
} from "@/lib/instance-identity-pending-provision";
import { createNpmUser } from "@cinatra-ai/registries";

const FROZEN_IDENTITY: InstanceIdentity = {
  instanceNamespace: "vendora",
  instanceDisplayName: "Vendor A",
  tokenCiphertext: "ct",
  tokenIv: "iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pwct",
  passwordIv: "pwiv",
  firstPublishedAt: "2026-05-01T00:00:00.000Z",
  createdAt: "2026-05-07T12:00:00.000Z",
};

function buildFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function captureRedirect(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
  } catch (err) {
    const e = err as { __isRedirect?: true; message?: string };
    if (e.__isRedirect && typeof e.message === "string" && e.message.startsWith("REDIRECT:")) {
      return e.message.slice("REDIRECT:".length);
    }
    throw err;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingState.record = null;
  mintCounter.n = 0;
  vi.mocked(readInstanceIdentity).mockReturnValue(FROZEN_IDENTITY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provisionAndPersist — minted-credential stash across a write conflict", () => {
  it("reuses the stashed mint on retry: createNpmUser runs exactly once across both attempts and the retry lands", async () => {
    vi.mocked(applyInstanceIdentityProvisioningWrite)
      .mockReturnValueOnce("exhausted") // attempt 1: identity write conflicts
      .mockReturnValueOnce("swapped"); // attempt 2 (operator retry): lands

    const firstUrl = await captureRedirect(() =>
      renameInstanceNamespaceAction(buildFormData({ instanceNamespace: "vendorb" })),
    );
    expect(firstUrl).toContain("error=identity-write-conflict");
    // The mint was stashed before the failed write attempt.
    expect(writePendingProvisionedCredentials).toHaveBeenCalledTimes(1);
    expect(pendingState.record).toMatchObject({
      instanceNamespace: "vendorb",
      tokenCiphertext: "enc(minted-token-1)",
    });

    const secondUrl = await captureRedirect(() =>
      renameInstanceNamespaceAction(buildFormData({ instanceNamespace: "vendorb" })),
    );
    expect(secondUrl).toContain("saved=1");

    // ONE registry call total — the retry skipped the duplicate adduser that
    // previously 409'd into a spurious namespace-taken.
    expect(createNpmUser).toHaveBeenCalledTimes(1);
    expect(readPendingProvisionedCredentials).toHaveBeenLastCalledWith("vendorb");

    // The retry's write payload carries the FIRST mint's ciphertexts.
    const casCalls = vi.mocked(applyInstanceIdentityProvisioningWrite).mock.calls;
    expect(casCalls).toHaveLength(2);
    expect(casCalls[1][0]).toMatchObject({
      instanceNamespace: "vendorb",
      tokenCiphertext: "enc(minted-token-1)",
    });

    // The landed write cleared the stash.
    expect(clearPendingProvisionedCredentials).toHaveBeenCalledTimes(1);
    expect(pendingState.record).toBeNull();
  });

  it("clears the stash when the first attempt lands", async () => {
    vi.mocked(applyInstanceIdentityProvisioningWrite).mockReturnValue("swapped");

    const url = await captureRedirect(() =>
      renameInstanceNamespaceAction(buildFormData({ instanceNamespace: "vendorb" })),
    );

    expect(url).toContain("saved=1");
    expect(createNpmUser).toHaveBeenCalledTimes(1);
    // Stash write happened before the CAS attempt; the landed write cleared it.
    expect(writePendingProvisionedCredentials).toHaveBeenCalledTimes(1);
    expect(clearPendingProvisionedCredentials).toHaveBeenCalledTimes(1);
    expect(pendingState.record).toBeNull();
  });

  it("does NOT reuse a stash minted for a different namespace — the retry with a new name mints fresh", async () => {
    vi.mocked(applyInstanceIdentityProvisioningWrite)
      .mockReturnValueOnce("exhausted")
      .mockReturnValueOnce("swapped");

    await captureRedirect(() =>
      renameInstanceNamespaceAction(buildFormData({ instanceNamespace: "vendorb" })),
    );
    const retryUrl = await captureRedirect(() =>
      renameInstanceNamespaceAction(buildFormData({ instanceNamespace: "vendorc" })),
    );
    expect(retryUrl).toContain("saved=1");

    // A second mint ran for the NEW namespace; the stale vendorb stash was
    // not reused.
    expect(createNpmUser).toHaveBeenCalledTimes(2);
    const casCalls = vi.mocked(applyInstanceIdentityProvisioningWrite).mock.calls;
    expect(casCalls[1][0]).toMatchObject({
      instanceNamespace: "vendorc",
      tokenCiphertext: "enc(minted-token-2)",
    });
    expect(pendingState.record).toBeNull();
  });
});
