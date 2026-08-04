// Wiring test for provisionAndPersist's CAS-based commit (cinatra#2418
// review, round 2): renameInstanceNamespaceAction's final identity write now
// routes through applyInstanceIdentityProvisioningWrite — row-level CAS with
// bounded retry — instead of a single synchronous re-read-then-write. That
// switch was made because a plain re-read only serialises against an
// in-process writer with no intervening `await` of its own (e.g.
// editVendorAction's frozen display-name-only save); it does NOT protect
// against a SECOND CONCURRENT provisionAndPersist call, where the last plain
// write would silently discard the other's namespace change.
//
// The actual concurrency properties (a concurrent display-name save is
// preserved; a concurrent second rename's archived oldInstanceNamespaces
// entry reflects the fresh row, not a stale pre-await snapshot; sustained
// contention exhausts rather than clobbers) are proven deterministically,
// with a byte-equal fake CAS store and no wall-clock/promise-timing tricks,
// in src/lib/__tests__/instance-identity-cas.test.ts
// ("applyInstanceIdentityProvisioningWrite" describe block).
//
// This file proves ONLY the action-level wiring on top of that: a "swapped"
// outcome redirects success, and any other CAS outcome (a genuine conflict
// under sustained contention) redirects with the new
// `identity-write-conflict` code rather than silently succeeding or leaking
// an unhandled exception to the operator.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
  applyInstanceIdentityProvisioningWrite: vi.fn(),
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

vi.mock("@cinatra-ai/registries", () => ({
  createNpmUser: vi.fn(async () => ({ token: "new-registry-token" })),
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
  vi.mocked(readInstanceIdentity).mockReturnValue(FROZEN_IDENTITY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renameInstanceNamespaceAction — CAS-commit wiring (cinatra#2418 review, round 2)", () => {
  it("redirects success and appends the previous namespace when the CAS swap lands", async () => {
    vi.mocked(applyInstanceIdentityProvisioningWrite).mockReturnValue("swapped");

    const url = await captureRedirect(() =>
      renameInstanceNamespaceAction(buildFormData({ instanceNamespace: "vendorb" })),
    );

    expect(url).toContain("saved=1");
    expect(applyInstanceIdentityProvisioningWrite).toHaveBeenCalledTimes(1);
    const [write, opts] = vi.mocked(applyInstanceIdentityProvisioningWrite).mock.calls[0];
    expect(write).toMatchObject({ instanceNamespace: "vendorb" });
    // renameInstanceNamespaceAction is the append-to-oldInstanceNamespaces
    // path — see editVendorAction's own pre-publish call for append: false.
    expect(opts).toEqual({ appendPreviousNamespace: true });
  });

  it.each(["no-identity", "unparseable", "aborted", "exhausted"] as const)(
    "redirects identity-write-conflict (never a silent success) on CAS outcome %s",
    async (outcome) => {
      vi.mocked(applyInstanceIdentityProvisioningWrite).mockReturnValue(outcome);

      const url = await captureRedirect(() =>
        renameInstanceNamespaceAction(buildFormData({ instanceNamespace: "vendorb" })),
      );

      expect(url).toContain("error=identity-write-conflict");
      expect(url).not.toContain("saved=1");
    },
  );
});
