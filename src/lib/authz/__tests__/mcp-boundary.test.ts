/**
 * MCP boundary enforcement tests.
 *
 * Every primitive is expected to use `status:"enforced"` with coarse-boundary
 * semantics:
 *   - platform_admin -> always allowed.
 *   - unauthenticated / org-less -> blocked (deny-by-default).
 *   - requireRole mismatch -> blocked.
 *   - READ/LIST effect -> base permission hard-enforced via can().
 *   - WRITE/ADMIN/EXECUTE effect -> membership-gated; permission audited but
 *     not hard-blocked (per-handler authz owns ownership).
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "../audit";
import { enforceMcpBoundary } from "../mcp-boundary";
import { markEffectiveExtensionMcpTools, _resetExtensionMcpForTests } from "@/lib/extension-mcp-registry";

const memberCtx = () => ({ orgId: "org-1", userId: "user-1", platformRole: undefined as never });
const adminCtx = () => ({ orgId: "org-1", userId: "admin-1", platformRole: "platform_admin" as const });

describe("enforceMcpBoundary", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
  });
  afterEach(() => {
    auditSpy.mockRestore();
  });

  it("blocks unclassified primitives", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "no_such_primitive",
      ctx: memberCtx(),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({ shouldBlock: true, reason: "unclassified_primitive" });
  });

  it("blocks an unauthenticated / org-less caller (deny-by-default)", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "accounts_get",
      ctx: { orgId: null, userId: null, platformRole: undefined as never },
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({ reason: "not_org_member", shouldBlock: true });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", metadata: expect.objectContaining({ reason: "not_org_member" }) }),
    );
  });

  it("allows platform_admin unconditionally", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "accounts_delete",
      ctx: adminCtx(),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allowed", metadata: expect.objectContaining({ via: "platform_admin" }) }),
    );
  });

  it("allows an org member to read (effect:read, member has the grant)", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "accounts_get", // entity_account::read
      ctx: memberCtx(),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allowed", metadata: expect.objectContaining({ mode: "enforced", requiredPermission: "entity.read" }) }),
    );
  });

  it("allows an org member to write — membership-gated, deferred to handler", async () => {
    // accounts_delete is entity_account::delete (effect: admin). Member does
    // NOT hold entity.delete, but the boundary defers ownership to the
    // per-handler authz and lets the call through (audited).
    const d = await enforceMcpBoundary({
      primitiveName: "accounts_delete",
      ctx: memberCtx(),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allowed",
        metadata: expect.objectContaining({ mode: "enforced", deferredToHandler: true }),
      }),
    );
  });

  it("short-circuits via CarveOut at the delegated_chat_token perimeter", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "workflow_draft_create",
      ctx: memberCtx(),
      delegatedRestricted: true,
    });
    expect(d.allowed).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allowed", metadata: expect.objectContaining({ carveOut: true, boundary: "delegated_chat_token" }) }),
    );
  });

  it("blocks a read whose permission the member's role does not grant", async () => {
    // Override accounts_get to point at audit_log::read, which needs
    // audit.read — a permission the member role does NOT have.
    const augment = await import("../inventory-augment");
    const original = augment.PRIMITIVE_CLASSIFICATIONS.accounts_get;
    (augment.PRIMITIVE_CLASSIFICATIONS as Record<string, unknown>).accounts_get = {
      resourceType: "audit_log",
      action: "read",
      status: "enforced",
    };
    try {
      const d = await enforceMcpBoundary({
        primitiveName: "accounts_get",
        ctx: memberCtx(),
        delegatedRestricted: false,
      });
      expect(d.allowed).toBe(false);
      expect(d).toMatchObject({ shouldBlock: true });
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({ decision: "denied", metadata: expect.objectContaining({ requiredPermission: "audit.read" }) }),
      );
    } finally {
      (augment.PRIMITIVE_CLASSIFICATIONS as Record<string, unknown>).accounts_get = original;
    }
  });

  it("write/uninstall primitive is membership-gated (no DB hit, no throw)", async () => {
    // extensions_registry_unpublish -> extension_registry::uninstall (effect:
    // admin, no requireRole). A member passes the membership gate; the
    // boundary defers to the per-handler authz without resolving role grants.
    const d = await enforceMcpBoundary({
      primitiveName: "extensions_registry_unpublish",
      ctx: memberCtx(),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(true);
  });

  describe("extension-registered MCP tools (register(ctx) → ctx.mcp)", () => {
    afterEach(() => _resetExtensionMcpForTests());

    it("shadow-allows an EFFECTIVELY-registered extension tool + audits provenance", async () => {
      markEffectiveExtensionMcpTools([{ name: "x_ext_only_tool", packageName: "@cinatra-ai/x" }]);
      const d = await enforceMcpBoundary({ primitiveName: "x_ext_only_tool", ctx: memberCtx(), delegatedRestricted: false });
      expect(d.allowed).toBe(true);
      const call = auditSpy.mock.calls.find((c) => (c[0] as { operation?: string })?.operation === "x_ext_only_tool");
      expect((call?.[0] as { metadata?: Record<string, unknown> })?.metadata).toMatchObject({
        mode: "shadow",
        classificationSource: "extension_mcp_registry",
        packageName: "@cinatra-ai/x",
      });
    });

    it("still HARD-BLOCKS a truly-unknown primitive (not effective)", async () => {
      const d = await enforceMcpBoundary({ primitiveName: "definitely_not_registered", ctx: memberCtx(), delegatedRestricted: false });
      expect(d).toMatchObject({ allowed: false, reason: "unclassified_primitive" });
    });

    it("does NOT synthesize on the delegated-chat perimeter", async () => {
      markEffectiveExtensionMcpTools([{ name: "x_ext_only_tool", packageName: "@cinatra-ai/x" }]);
      const d = await enforceMcpBoundary({ primitiveName: "x_ext_only_tool", ctx: memberCtx(), delegatedRestricted: true });
      expect(d).toMatchObject({ allowed: false, reason: "unclassified_primitive" });
    });

    it("does NOT unlock a host-colliding name an extension registered but the replay SKIPPED (privilege-escalation guard)", async () => {
      // An extension registered `system_screen_lookup` (an unclassified host built-in),
      // but the replay skipped it as a reserved-name collision → it is NOT in the
      // effective set. The boundary must still treat it as unclassified → block.
      markEffectiveExtensionMcpTools([]); // skipped → not effective
      const d = await enforceMcpBoundary({ primitiveName: "system_screen_lookup", ctx: memberCtx(), delegatedRestricted: false });
      expect(d).toMatchObject({ allowed: false, reason: "unclassified_primitive" });
    });
  });

  // ---------------------------------------------------------------------------
  // Carried orgRole (issue #83): the boundary's synthetic actor uses the
  // transport-resolved ctx.orgRole instead of the coarse "member" default.
  // metric_cost_summary is metric_cost::read → metric.read, which the kernel
  // grants to org_admin (and above) but NOT to member.
  // ---------------------------------------------------------------------------
  describe("carried orgRole on the boundary synthetic actor", () => {
    it("denies an admin-tier read to the default member actor (regression baseline)", async () => {
      const d = await enforceMcpBoundary({
        primitiveName: "metric_cost_summary",
        ctx: memberCtx(),
        delegatedRestricted: false,
      });
      expect(d).toMatchObject({ allowed: false, reason: "denied:metric.read", shouldBlock: true });
    });

    it("allows an admin-tier read when ctx carries orgRole org_admin", async () => {
      const d = await enforceMcpBoundary({
        primitiveName: "metric_cost_summary",
        ctx: { ...memberCtx(), orgRole: "org_admin" as const },
        delegatedRestricted: false,
      });
      expect(d.allowed).toBe(true);
    });

    it("carried orgRole member behaves exactly like the default (no widening)", async () => {
      const d = await enforceMcpBoundary({
        primitiveName: "metric_cost_summary",
        ctx: { ...memberCtx(), orgRole: "member" as const },
        delegatedRestricted: false,
      });
      expect(d).toMatchObject({ allowed: false, reason: "denied:metric.read" });
    });

    it("member-tier read still allowed regardless of carried role (sanity)", async () => {
      const d = await enforceMcpBoundary({
        primitiveName: "accounts_get",
        ctx: { ...memberCtx(), orgRole: "member" as const },
        delegatedRestricted: false,
      });
      expect(d.allowed).toBe(true);
    });
  });
});
