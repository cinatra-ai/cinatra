// retryRemoteEffectAction platform_admin gate.
// A POSITIVE admin test (admin passes the gate + reaches the retry logic)
// alongside the non-admin denial — so we never ship an admin-only button
// that always fails the gate.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  isPlatformAdmin: vi.fn(),
  retryRemoteEffect: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: mocks.requireAuthSession,
  isPlatformAdmin: mocks.isPlatformAdmin,
}));
vi.mock("@/lib/object-history", () => ({
  retryRemoteEffect: mocks.retryRemoteEffect,
}));

import { retryRemoteEffectAction } from "../remote-effect-actions";

const SESSION = { user: { id: "u1" }, session: { activeOrganizationId: "org_1" } };

describe("retryRemoteEffectAction", () => {
  beforeEach(() => {
    mocks.requireAuthSession.mockReset();
    mocks.isPlatformAdmin.mockReset();
    mocks.retryRemoteEffect.mockReset();
    mocks.requireAuthSession.mockResolvedValue(SESSION);
  });

  it("rejects an orgless session", async () => {
    mocks.requireAuthSession.mockResolvedValue({ user: { id: "u1" }, session: {} });
    const r = await retryRemoteEffectAction({ attemptId: "rea_1" });
    expect(r).toEqual({ ok: false, error: "no active organization on session" });
    expect(mocks.retryRemoteEffect).not.toHaveBeenCalled();
  });

  it("DENIES a non-platform-admin (does not reach the retry logic)", async () => {
    mocks.isPlatformAdmin.mockReturnValue(false);
    const r = await retryRemoteEffectAction({ attemptId: "rea_1" });
    expect(r).toEqual({ ok: false, error: "platform_admin required to retry" });
    expect(mocks.retryRemoteEffect).not.toHaveBeenCalled();
  });

  it("ALLOWS a platform_admin past the gate to the retry logic (positive)", async () => {
    mocks.isPlatformAdmin.mockReturnValue(true);
    mocks.retryRemoteEffect.mockResolvedValue({
      ok: false,
      reason: "unsupported",
      message: "No connector restore adapter is registered for \"wordpress\".",
    });
    const r = await retryRemoteEffectAction({ attemptId: "rea_1" });
    // Admin reached retryRemoteEffect — the error is the retry result, NOT the
    // gate rejection. Proves the admin path isn't broken.
    expect(mocks.retryRemoteEffect).toHaveBeenCalledWith({
      attemptId: "rea_1",
      orgId: "org_1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toMatch(/platform_admin required/);
      expect(r.error).toMatch(/No connector restore adapter/);
    }
  });

  it("returns MutationResult ok with status when retry succeeds (adapter present)", async () => {
    mocks.isPlatformAdmin.mockReturnValue(true);
    mocks.retryRemoteEffect.mockResolvedValue({
      ok: true,
      attempt: { status: "succeeded" },
    });
    const r = await retryRemoteEffectAction({ attemptId: "rea_1" });
    expect(r).toEqual({ ok: true, data: { status: "succeeded" } });
  });
});
