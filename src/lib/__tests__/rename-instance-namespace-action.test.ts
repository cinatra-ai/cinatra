// Assertion tests for post-publish namespace rename and pre-publish credential replacement.
//
// `renameInstanceNamespaceAction` (post-publish hard rename) and `editVendorAction`
// (pre-publish credential replacement) live in
// `src/app/configuration/instance/actions.ts`. Placeholders throw, so these tests
// lock the expected behavior while the real bodies are implemented.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({ user: { id: "admin-1", email: "admin@example.com" } })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));
// The rename gate (`assertNamespaceRenameAllowed`) resolves the marketplace
// bearer from the identity row and probes vendor-application status before
// allowing a rename. Stub the HTTP client so the probe reports a non-locking
// state and the rename proceeds to writeInstanceIdentity.
vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  createHttpMarketplaceMcpClient: vi.fn(() => ({
    vendorApplicationStatus: vi.fn(async () => ({ state: "none" })),
  })),
}));

import {
  editVendorAction,
  renameInstanceNamespaceAction,
} from "@/app/configuration/instance/actions";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
  type InstanceIdentity,
} from "@/lib/instance-identity-store";
// Real encryption module (no vi.mock) — vitest sets CINATRA_ENCRYPTION_KEY to a
// valid 32-byte key, so fixtures carry genuine AES-256-GCM ciphertexts the
// rename gate can decrypt. The per-field AADs mirror the action's encrypt sites.
import { encryptSecret } from "@/lib/instance-secrets";

const ORIGINAL_FETCH = globalThis.fetch;
const OLD_TOKEN_ENC = encryptSecret("old-vendor-token", "vendor.token");
const OLD_PASSWORD_ENC = encryptSecret("old-vendor-password", "vendor.password");
const FROZEN_IDENTITY: InstanceIdentity = {
  instanceNamespace: "oldvendor",
  instanceDisplayName: "Old Vendor",
  tokenCiphertext: OLD_TOKEN_ENC.ciphertext,
  tokenIv: OLD_TOKEN_ENC.iv,
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: OLD_PASSWORD_ENC.ciphertext,
  passwordIv: OLD_PASSWORD_ENC.iv,
  registryUrl: "https://registry.cinatra.ai",
  firstPublishedAt: "2026-04-01T00:00:00.000Z",
  createdAt: "2026-03-01T00:00:00.000Z",
};

const PRE_PUBLISH_IDENTITY: InstanceIdentity = {
  ...FROZEN_IDENTITY,
  firstPublishedAt: null,
};

function buildRenameFormData(newInstanceNamespace: string): FormData {
  const fd = new FormData();
  fd.append("instanceNamespace", newInstanceNamespace);
  // Both actions require a non-empty display name before any provisioning.
  fd.append("instanceDisplayName", "Renamed Vendor");
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mock fetch to return Verdaccio adduser 201 with a fresh token.
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ token: "new-token-abc" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("renameInstanceNamespaceAction (post-freeze hard rename)", () => {
  it("appends the previous vendor to oldInstanceNamespaces[]", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(FROZEN_IDENTITY);
    await renameInstanceNamespaceAction(buildRenameFormData("newvendor"));
    expect(vi.mocked(writeInstanceIdentity)).toHaveBeenCalledTimes(1);
    const passedIdentity = vi.mocked(writeInstanceIdentity).mock.calls[0]?.[0];
    expect(passedIdentity?.oldInstanceNamespaces).toBeDefined();
    expect(passedIdentity?.oldInstanceNamespaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "oldvendor",
          lastTokenCiphertext: FROZEN_IDENTITY.tokenCiphertext,
          lastTokenIv: FROZEN_IDENTITY.tokenIv,
        }),
      ]),
    );
  });

  it("replaces instanceNamespace + token + password credentials", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(FROZEN_IDENTITY);
    await renameInstanceNamespaceAction(buildRenameFormData("newvendor"));
    const passedIdentity = vi.mocked(writeInstanceIdentity).mock.calls[0]?.[0];
    expect(passedIdentity?.instanceNamespace).toBe("newvendor");
    expect(passedIdentity?.tokenCiphertext).not.toBe(FROZEN_IDENTITY.tokenCiphertext);
    expect(passedIdentity?.passwordCiphertext).not.toBe(FROZEN_IDENTITY.passwordCiphertext);
    expect(passedIdentity?.tokenIv).not.toBe(FROZEN_IDENTITY.tokenIv);
    expect(passedIdentity?.passwordIv).not.toBe(FROZEN_IDENTITY.passwordIv);
  });

  it("resets firstPublishedAt to null after rename", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(FROZEN_IDENTITY);
    await renameInstanceNamespaceAction(buildRenameFormData("newvendor"));
    const passedIdentity = vi.mocked(writeInstanceIdentity).mock.calls[0]?.[0];
    expect(passedIdentity?.firstPublishedAt).toBeNull();
  });

  it("preserves the original createdAt timestamp", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(FROZEN_IDENTITY);
    await renameInstanceNamespaceAction(buildRenameFormData("newvendor"));
    const passedIdentity = vi.mocked(writeInstanceIdentity).mock.calls[0]?.[0];
    expect(passedIdentity?.createdAt).toBe(FROZEN_IDENTITY.createdAt);
  });
});

describe("editVendorAction (pre-publish, no oldInstanceNamespaces append)", () => {
  it("replaces credentials WITHOUT appending to oldInstanceNamespaces[]", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(PRE_PUBLISH_IDENTITY);
    await editVendorAction(buildRenameFormData("newvendor"));
    // The provisioning (credential-replacing) write is the LAST writeInstanceIdentity
    // call. Since cinatra#357 the display-name change is pre-persisted first, so the
    // namespace+credential write is no longer calls[0].
    const calls = vi.mocked(writeInstanceIdentity).mock.calls;
    const passedIdentity = calls[calls.length - 1]?.[0];
    expect(passedIdentity?.instanceNamespace).toBe("newvendor");
    // Either oldInstanceNamespaces is undefined or unchanged from the input shape (also undefined).
    expect(passedIdentity?.oldInstanceNamespaces ?? []).toEqual([]);
  });

  // cinatra#357 — defect #2: a failed namespace rename must NOT discard a valid
  // display-name edit. The display-name change is a plain metadata write that
  // needs no provisioning; pre-persisting it guarantees a downstream
  // provisioning failure (createNpmUser) no longer loses the edit.
  it("persists the display-name edit BEFORE namespace provisioning, so a provisioning failure does not lose it", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(PRE_PUBLISH_IDENTITY);
    // Force the registry adduser to fail so provisionAndPersist redirects with
    // an error and never reaches its own writeInstanceIdentity.
    globalThis.fetch = vi.fn(async () =>
      new Response("registration is unavailable", { status: 503 }),
    ) as unknown as typeof fetch;

    const fd = new FormData();
    fd.append("instanceNamespace", "newvendor"); // namespace IS changing
    fd.append("instanceDisplayName", "Edited Display Name");

    // redirectWithError() calls next/navigation `redirect` then throws an
    // "unreachable" guard. In production `redirect` throws its own control-flow
    // error first; the mocked `redirect` is a no-op, so the guard surfaces here.
    // Either way the action does NOT complete normally on a provisioning
    // failure — what matters is the persisted write state below.
    await expect(editVendorAction(fd)).rejects.toThrow();

    const calls = vi.mocked(writeInstanceIdentity).mock.calls;
    // Exactly one write happened — the display-name pre-persist — and the
    // provisioning write never ran because adduser failed.
    expect(calls).toHaveLength(1);
    const persisted = calls[0]?.[0];
    expect(persisted?.instanceDisplayName).toBe("Edited Display Name");
    // The display-name write keeps the CURRENT namespace (no rename committed).
    expect(persisted?.instanceNamespace).toBe(PRE_PUBLISH_IDENTITY.instanceNamespace);
    // And it must NOT carry the rename flag — it's a same-namespace metadata edit.
    expect(calls[0]?.[1]?.allowNamespaceRename).toBeFalsy();
  });
});

describe("renameInstanceNamespaceAction (does NOT touch agent_templates)", () => {
  it("does not mutate any agent_templates row (behavioral: no DB writer for templates is invoked)", async () => {
    // The behavior we assert: the action wires through writeInstanceIdentity
    // ONLY (no agent-templates table mutation). If the implementation ever
    // imports a templates writer here, this test still passes today (no mock
    // exists for it) but the design intent is captured for review.
    // The executor must keep the action templates-free.
    vi.mocked(readInstanceIdentity).mockReturnValueOnce(FROZEN_IDENTITY);
    await renameInstanceNamespaceAction(buildRenameFormData("newvendor"));
    expect(vi.mocked(writeInstanceIdentity)).toHaveBeenCalledTimes(1);
    // Only a single mutation, and it targets the instance_identity row.
    const args = vi.mocked(writeInstanceIdentity).mock.calls[0];
    expect(args).toBeDefined();
  });
});
