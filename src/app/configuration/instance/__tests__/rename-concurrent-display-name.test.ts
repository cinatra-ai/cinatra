// Regression test for a lost-update race (cinatra#2418 review, MAJOR): a
// frozen display-name save (editVendorAction) used to be silently overwritten
// when it completed WHILE renameInstanceNamespaceAction's provisionAndPersist
// was still awaiting registry work (assertNamespaceRenameAllowed /
// createNpmUser). provisionAndPersist built its final write payload by
// spreading the `current` snapshot captured BEFORE those awaits — so a
// same-submit display-name change that landed in the gap was discarded the
// moment the rename's write finally happened.
//
// This test drives that exact interleaving deterministically: it pauses
// createNpmUser mid-flight, simulates the concurrent display-name save by
// changing what readInstanceIdentity() returns, then lets provisioning
// resume — and asserts the final write carries BOTH the new namespace AND
// the concurrently-saved display name.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
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
// consumer/vendor token available at all is a safe-rename no-op, so
// provisionAndPersist proceeds straight to registry provisioning without any
// network call here.
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

// The pausable registry-provisioning gate. createNpmUser resolves only when
// the test explicitly releases it, giving a deterministic window in which to
// simulate the concurrent display-name save.
const { npmUserGate } = vi.hoisted(() => {
  let release: ((value: { token: string }) => void) | null = null;
  const promise = new Promise<{ token: string }>((resolve) => {
    release = resolve;
  });
  return {
    npmUserGate: {
      promise,
      release: (value: { token: string }) => release?.(value),
    },
  };
});
vi.mock("@cinatra-ai/registries", () => ({
  createNpmUser: vi.fn(() => npmUserGate.promise),
  VerdaccioUserAlreadyRegisteredError: class extends Error {},
  VerdaccioRegistrationDisabledError: class extends Error {},
  VerdaccioUnexpectedResponseError: class extends Error {},
  listAgentPackages: vi.fn(async () => []),
}));

import { renameInstanceNamespaceAction } from "@/app/configuration/instance/actions";
import { readInstanceIdentity, writeInstanceIdentity } from "@/lib/instance-identity-store";
import type { InstanceIdentity } from "@/lib/instance-identity-store";

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renameInstanceNamespaceAction — concurrent display-name save (cinatra#2418 review)", () => {
  it("keeps a display-name save that lands while registry provisioning is still in flight", async () => {
    // Initial read, at the very start of the action: the frozen identity
    // BEFORE the concurrent display-name save.
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(FROZEN_IDENTITY);

    const actionPromise = captureRedirect(() =>
      renameInstanceNamespaceAction(buildFormData({ instanceNamespace: "vendorb" })),
    );

    // Let the microtask queue drain up to the createNpmUser await point.
    await vi.waitFor(() => {
      expect(vi.mocked(readInstanceIdentity)).toHaveBeenCalledTimes(1);
    });

    // Simulate the concurrent frozen display-name save (editVendorAction)
    // completing here, mid-flight: every SUBSEQUENT readInstanceIdentity()
    // call now sees the updated display name.
    const CONCURRENTLY_UPDATED: InstanceIdentity = {
      ...FROZEN_IDENTITY,
      instanceDisplayName: "Vendor A — Updated Concurrently",
    };
    vi.mocked(readInstanceIdentity).mockReturnValue(CONCURRENTLY_UPDATED);

    // Now let registry provisioning (createNpmUser) resolve, unblocking the
    // rest of provisionAndPersist.
    npmUserGate.release({ token: "new-registry-token" });

    const url = await actionPromise;
    expect(url).toContain("saved=1");

    expect(writeInstanceIdentity).toHaveBeenCalledTimes(1);
    const [writtenIdentity] = vi.mocked(writeInstanceIdentity).mock.calls[0];
    // Both changes survive: the rename AND the concurrent display-name save.
    expect(writtenIdentity).toMatchObject({
      instanceNamespace: "vendorb",
      instanceDisplayName: "Vendor A — Updated Concurrently",
    });
    expect((writtenIdentity as InstanceIdentity).oldInstanceNamespaces).toEqual([
      expect.objectContaining({ name: "vendora" }),
    ]);
  });
});
