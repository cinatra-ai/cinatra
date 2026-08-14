// Unit tests for editVendorAction's post-freeze namespace-change refusal
// (cinatra#2387).
//
// Before this change, a namespace value reaching editVendorAction on a
// frozen instance (firstPublishedAt !== null) was SILENTLY dropped — only
// the display-name edit persisted, with no signal that the namespace change
// was ignored. This suite proves the fix: an attempted namespace change on a
// frozen instance is explicitly refused (redirects with
// `frozen-namespace-use-rename`) and writeInstanceIdentity is never called
// with the changed namespace, while a same-namespace submission (the real
// UI's disabled-field case, and a legitimate display-name-only edit) still
// succeeds exactly as before.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
  // cinatra#2539 — the module now also owns the READ side of the identity
  // cache. Stubbed as a permanent MISS so every `readInstanceIdentity()` in
  // this suite still reaches the mocked database, exactly as before the cache
  // existed; the cache's own behaviour is covered in
  // src/lib/__tests__/instance-identity-cache.test.ts.
  readInstanceIdentityCacheEntry: vi.fn(() => null),
  storeInstanceIdentityCacheEntry: vi.fn(),
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

import { editVendorAction } from "@/app/configuration/instance/actions";
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
  vi.mocked(readInstanceIdentity).mockReturnValue(FROZEN_IDENTITY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editVendorAction — post-freeze namespace-change refusal", () => {
  it("EXPLICITLY refuses an attempted namespace change on a frozen instance (never silently drops it)", async () => {
    const url = await captureRedirect(() =>
      editVendorAction(
        buildFormData({
          instanceDisplayName: "Vendor A",
          instanceNamespace: "attempted-new-name",
        }),
      ),
    );
    expect(url).toContain("error=frozen-namespace-use-rename");
    // The whole point of the fix: writeInstanceIdentity must NEVER be called
    // with a changed namespace when frozen — not even the display-name-only
    // partial write the old silent-ignore behavior produced.
    expect(writeInstanceIdentity).not.toHaveBeenCalled();
  });

  it("still allows a display-name-only edit on a frozen instance (same namespace)", async () => {
    const url = await captureRedirect(() =>
      editVendorAction(
        buildFormData({
          instanceDisplayName: "Vendor A Renamed Display",
          instanceNamespace: "vendora",
        }),
      ),
    );
    expect(url).toContain("saved=1");
    expect(writeInstanceIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceNamespace: "vendora",
        instanceDisplayName: "Vendor A Renamed Display",
      }),
    );
  });

  it("still allows a display-name-only edit on a frozen instance when instanceNamespace is omitted (the real disabled-input case)", async () => {
    // The UI's namespace field is `disabled` when frozen, so a real submit
    // never includes `instanceNamespace` in formData at all — the action
    // falls back to `current.instanceNamespace`. Prove that fallback still
    // takes the same-namespace path, not the refusal path.
    const url = await captureRedirect(() =>
      editVendorAction(buildFormData({ instanceDisplayName: "Vendor A" })),
    );
    expect(url).toContain("saved=1");
    expect(url).not.toContain("error=");
    expect(writeInstanceIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ instanceNamespace: "vendora" }),
    );
  });
});
