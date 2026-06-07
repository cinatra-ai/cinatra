/**
 * withPlatformAdminBypass helper unit tests.
 *
 * The helper is the single auditable code path through which platform_admin
 * write powers on user-owned resources flow. Every successful call writes a
 * durable audit row BEFORE returning. Audit-write failure aborts the
 * caller's mutation (logAuditEventStrict propagates).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the audit module so we can both observe calls and force rejections.
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: vi.fn(),
  logAuditEventStrict: vi.fn(),
}));

import { logAuditEventStrict } from "@/lib/authz/audit";
import { withPlatformAdminBypass } from "@/lib/authz/admin-bypass";
import { AuthzError } from "@/lib/authz/errors";
import { FIXT_ADMIN, FIXT_MEMBER_A } from "./fixtures";
import type { ResourceRef } from "@/lib/authz";

const RES: ResourceRef & { ownerId: string } = {
  resourceType: "project",
  resourceId: "p-1",
  organizationId: "org-A",
  ownerType: "user",
  ownerId: "u-original",
  visibility: "private",
};

const strictMock = vi.mocked(logAuditEventStrict);

describe("withPlatformAdminBypass", () => {
  beforeEach(() => {
    strictMock.mockReset();
    strictMock.mockResolvedValue({ id: "audit-evt-123" });
  });

  it("Test 1 — non-admin actor → AuthzError(403, forbidden); audit NOT called", async () => {
    await expect(
      withPlatformAdminBypass(FIXT_MEMBER_A, "project.delete", RES, "moderation"),
    ).rejects.toMatchObject({
      name: "AuthzError",
      statusCode: 403,
      reason: "forbidden",
    });
    expect(strictMock).not.toHaveBeenCalled();
  });

  it("Test 2 — admin happy path: audit row shape (decision, principalType, metadata)", async () => {
    await withPlatformAdminBypass(FIXT_ADMIN, "project.delete", RES, "moderation");
    expect(strictMock).toHaveBeenCalledTimes(1);
    const arg = strictMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      decision: "allowed",
      actorPrincipalType: "human",
      actorPrincipalId: FIXT_ADMIN.principalId,
      operation: "project.delete",
      resourceType: "project",
      resourceId: "p-1",
    });
    expect(arg.metadata).toEqual({
      bypass: true,
      reason: "moderation",
      originalOwnerId: "u-original",
    });
  });

  it("Test 3 — returns { auditEventId } from logAuditEventStrict's id", async () => {
    strictMock.mockResolvedValue({ id: "audit-evt-123" });
    const out = await withPlatformAdminBypass(
      FIXT_ADMIN,
      "project.delete",
      RES,
      "moderation",
    );
    expect(out).toEqual({ auditEventId: "audit-evt-123" });
  });

  it("Test 4 — audit write failure propagates (no swallow, mutation aborts)", async () => {
    const auditErr = new Error("audit-down");
    strictMock.mockRejectedValue(auditErr);
    await expect(
      withPlatformAdminBypass(FIXT_ADMIN, "project.delete", RES, "moderation"),
    ).rejects.toBe(auditErr);
  });

  it("Test 5 — actor without platformRole === 'platform_admin' is forbidden", async () => {
    const noRole = { ...FIXT_MEMBER_A, platformRole: undefined };
    await expect(
      withPlatformAdminBypass(noRole, "project.delete", RES, "moderation"),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(strictMock).not.toHaveBeenCalled();
  });

  it("Test 6 — H3 lock: extraMetadata merged into audit metadata", async () => {
    await withPlatformAdminBypass(
      FIXT_ADMIN,
      "project.delete",
      RES,
      "gdpr_request",
      { ticketRef: "TICKET-42" },
    );
    const arg = strictMock.mock.calls[0][0];
    expect(arg.metadata).toEqual({
      ticketRef: "TICKET-42",
      bypass: true,
      reason: "gdpr_request",
      originalOwnerId: "u-original",
    });
  });

  it("Test 7 — extraMetadata cannot override canonical keys", async () => {
    await withPlatformAdminBypass(
      FIXT_ADMIN,
      "project.delete",
      RES,
      "gdpr_request",
      // Caller attempts to suppress / spoof canonical fields.
      { bypass: false, reason: "fake", originalOwnerId: "spoof" },
    );
    const arg = strictMock.mock.calls[0][0];
    expect(arg.metadata).toEqual({
      bypass: true,
      reason: "gdpr_request",
      originalOwnerId: "u-original",
    });
  });
});
