/**
 * cinatra#2047 (defect D-3 + row 9) — the AUTHORIZATION gate on the lifecycle
 * policy write path and the gate-volume read.
 *
 * The authz KERNEL is REAL here: `canDo` / `can` / `resolveRoles` / the
 * `DIRECT_GRANTS` policy table all run unmocked, so these cases assert the
 * platform's actual grant model, not a restatement of it. Only the MEMBERSHIP
 * lookup is stubbed (`buildCanDoOptsFromSession`, a `betterAuthDb` read) —
 * because that is exactly the axis under test: what happens when a caller's org
 * role RESOLVES versus when it does not.
 *
 * The trap this file exists to close (#1625 D3, `filterByAuthz` continuing
 * silently on a role-less `System` actor): an UNRESOLVED role must not degrade
 * into an implicit pass. The kernel synthesizes a `member` floor when membership
 * does not resolve, and `member` DOES hold `settings.read` — so relying on the
 * kernel alone would let a session still naming an org it was removed from read
 * that org's backlog. The gate therefore REQUIRES a resolved membership on BOTH
 * paths (platform admins exempted explicitly), and every refusal is an explicit
 * `{ ok: false, reason }` a caller must branch on — never an empty read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildCanDoOptsFromSession = vi.fn();
const getAuthSession = vi.fn();

// Only the SESSION/MEMBERSHIP resolvers are stubbed — the authz kernel stays real.
// `isPlatformAdmin` has to be restated here because it is exported from the SAME
// module being stubbed (importing the original would drag the whole auth runtime
// in). It is a 5-line comma-split predicate; that the PRODUCTION module imports the
// real one (never its own copy) is asserted in
// src/components/artifacts/console/__tests__/review-policy-surface.test.ts.
vi.mock("@/lib/auth-session", () => ({
  buildCanDoOptsFromSession: (...args: unknown[]) => buildCanDoOptsFromSession(...args),
  getAuthSession: (...args: unknown[]) => getAuthSession(...args),
  isPlatformAdmin: (s: { user?: { role?: string | null } | null } | null | undefined) =>
    String(s?.user?.role ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .includes("admin"),
}));

const {
  lifecycleAccessMessage,
  resolveGateVolumeReadAccess,
  resolvePolicyBoundWriteAccess,
} = await import("../lifecycle-policy-access");

const ORG = "org-2047";

/** A Better Auth session shape as the app's own helpers produce it. */
function session(over: {
  userId?: string | null;
  orgId?: string | null;
  platformRole?: string | null;
} = {}) {
  const userId = over.userId === undefined ? "user-1" : over.userId;
  if (!userId) return null;
  return {
    user: { id: userId, role: over.platformRole ?? "user" },
    session: { activeOrganizationId: over.orgId === undefined ? ORG : over.orgId },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the membership lookup resolves NOTHING (the role-less shape).
  buildCanDoOptsFromSession.mockResolvedValue({});
});

describe("write path (settings.update) — who may set an org bound", () => {
  it("an org_admin MAY write", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "org_admin" });
    const access = await resolvePolicyBoundWriteAccess(session());
    expect(access).toEqual({ ok: true, orgId: ORG, userId: "user-1" });
  });

  it("an org_owner MAY write (inherits org_admin)", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "org_owner" });
    const access = await resolvePolicyBoundWriteAccess(session());
    expect(access.ok).toBe(true);
  });

  it("a platform admin MAY write", async () => {
    const access = await resolvePolicyBoundWriteAccess(
      session({ platformRole: "user,admin" }),
    );
    expect(access.ok).toBe(true);
  });

  it("a plain member MAY NOT write — a bound is org administration, not resource CRUD", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "member" });
    const access = await resolvePolicyBoundWriteAccess(session());
    expect(access).toEqual({ ok: false, reason: "forbidden" });
  });

  it("THE TRAP: an UNRESOLVED org role fails CLOSED — it never continues as an implicit pass", async () => {
    // `buildCanDoOptsFromSession` resolved `{}` (no membership row / a role-less
    // principal). The answer must be an explicit refusal — not a silently-empty
    // success like the #1625 D3 filterByAuthz drop.
    const access = await resolvePolicyBoundWriteAccess(session());
    expect(access.ok).toBe(false);
    expect(access.ok === false && access.reason).toBe("forbidden");
  });
});

describe("read path (settings.read) — who may see the gate volume", () => {
  it("a plain member MAY read — the backlog question is a REVIEWER's question", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "member" });
    const access = await resolveGateVolumeReadAccess(session());
    expect(access).toEqual({ ok: true, orgId: ORG, userId: "user-1" });
  });

  it("THE TRAP, READ SIDE: an UNRESOLVED membership is REFUSED, not silently admitted", async () => {
    // The kernel would synthesize `member` here, and `member` holds
    // `settings.read` — so a session still naming an org it was removed from
    // would read that org's backlog. The gate requires a REAL membership.
    const access = await resolveGateVolumeReadAccess(session());
    expect(access).toEqual({ ok: false, reason: "forbidden" });
  });

  it("a PLATFORM admin reads without an org membership row (the one explicit exemption)", async () => {
    const access = await resolveGateVolumeReadAccess(session({ platformRole: "user,admin" }));
    expect(access.ok).toBe(true);
  });

  it("an org_admin MAY read", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "org_admin" });
    expect((await resolveGateVolumeReadAccess(session())).ok).toBe(true);
  });
});

describe("fail-closed scoping — the org is never a client input and never widens", () => {
  it("no session → refused, and no permission check is even attempted", async () => {
    const access = await resolvePolicyBoundWriteAccess(null);
    expect(access).toEqual({ ok: false, reason: "no-session" });
    expect(buildCanDoOptsFromSession).not.toHaveBeenCalled();
  });

  it("a session with NO active org → refused; it never degrades to a cross-org read", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "org_admin" });
    const write = await resolvePolicyBoundWriteAccess(session({ orgId: null }));
    const read = await resolveGateVolumeReadAccess(session({ orgId: null }));
    expect(write).toEqual({ ok: false, reason: "no-active-org" });
    expect(read).toEqual({ ok: false, reason: "no-active-org" });
    // Fail-closed BEFORE the kernel call — there is no "any org" code path.
    expect(buildCanDoOptsFromSession).not.toHaveBeenCalled();
  });

  it("the granted org id is the SESSION's active org, verbatim", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "org_admin" });
    const access = await resolvePolicyBoundWriteAccess(session({ orgId: "org-other" }));
    expect(access.ok && access.orgId).toBe("org-other");
    // The membership resolution is asked about THAT org — never a different one.
    expect(buildCanDoOptsFromSession).toHaveBeenCalledWith(
      expect.objectContaining({ session: { activeOrganizationId: "org-other" } }),
    );
  });

  it("falls back to the ambient session when the caller passes NOTHING", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "org_admin" });
    getAuthSession.mockResolvedValue(session());
    const access = await resolvePolicyBoundWriteAccess();
    expect(access.ok).toBe(true);
    expect(getAuthSession).toHaveBeenCalledTimes(1);
  });

  it("an EXPLICIT null stays a refusal — it never silently re-resolves the ambient session", async () => {
    buildCanDoOptsFromSession.mockResolvedValue({ orgRole: "org_admin" });
    getAuthSession.mockResolvedValue(session());
    const access = await resolvePolicyBoundWriteAccess(null);
    expect(access).toEqual({ ok: false, reason: "no-session" });
    expect(getAuthSession).not.toHaveBeenCalled();
  });
});

describe("refusal messages leak nothing", () => {
  it("names the remedy, never the org, the user or the permission", () => {
    for (const reason of ["no-session", "no-active-org", "forbidden"] as const) {
      const message = lifecycleAccessMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/org-|settings\.|user-/);
    }
  });
});
