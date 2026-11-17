/**
 * The WordPress site write tool on an agent run's frame (cinatra#3745).
 *
 * The WordPress connector splits its site tool proxy: `wordpress_site_tool_call`
 * forwards reads only, and `wordpress_site_tool_write` forwards every other
 * ability. The write tool's registration declares `outward`, so the stop comes
 * from that declaration, never from the name set.
 *
 * These cases drive the real `enforceMcpBoundary` and the real predicate. Only
 * the audit writer and the extension-registry reader are test doubles; every
 * double is restored after each case. The shared cases for the other outward
 * tools stay in src/lib/authz/__tests__/send-tools-carry-recorded-decision.test.ts.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "../authz/audit";
import * as augmentModule from "../authz/inventory-augment";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import * as boundary from "../authz/mcp-boundary";

const { enforceMcpBoundary } = boundary;

const REASON = "outward_effect_requires_recorded_decision";
const WRITE = "wordpress_site_tool_write";

const runMemberCtx = () => ({ orgId: "org-1", userId: "user-1", runId: "run-1" });
const runAdminCtx = () => ({
  orgId: "org-1",
  userId: "admin-1",
  platformRole: "platform_admin" as const,
  runId: "run-1",
});
const personMemberCtx = () => ({ orgId: "org-1", userId: "user-1" });

describe("wordpress_site_tool_write is held by its outward declaration", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let extensionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    extensionSpy = vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    extensionSpy.mockRestore();
    vi.restoreAllMocks();
  });

  const frames = [
    ["an organisation member's run", runMemberCtx],
    ["a platform administrator's run", runAdminCtx],
  ] as const;

  it("is a classified primitive, not a member of the name set", () => {
    expect(augmentModule.lookupPrimitiveClassification(WRITE)).toEqual({
      resourceType: "connector_instance",
      action: "execute",
      status: "enforced",
    });
    expect(boundary.OUTWARD_EFFECT_TOOL_NAMES.has(WRITE)).toBe(false);
    expect(boundary.needsRecordedDecision(WRITE, runMemberCtx())).toBe(false);
    expect(boundary.needsRecordedDecision(WRITE, runMemberCtx(), true)).toBe(true);
  });

  it.each(frames)("answers it with the named reason on %s when the registration declares outward", async (_label, ctx) => {
    const d = await enforceMcpBoundary({
      primitiveName: WRITE,
      ctx: ctx(),
      delegatedRestricted: false,
      declaresOutward: true,
    });
    expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: WRITE,
        decision: "denied",
        runId: "run-1",
        metadata: expect.objectContaining({ reason: REASON }),
      }),
    );
  });

  it("keeps the decision of wordpress_site_tool_call on a run's frame when nothing is declared", async () => {
    const d = await enforceMcpBoundary({ primitiveName: WRITE, ctx: runMemberCtx(), delegatedRestricted: false });
    expect(d).toEqual({ allowed: true });
  });

  it("keeps today's decision on a person's own frame without a run, declared or not", async () => {
    for (const declaresOutward of [true, false]) {
      const d = await enforceMcpBoundary({
        primitiveName: WRITE,
        ctx: personMemberCtx(),
        delegatedRestricted: false,
        declaresOutward,
      });
      expect(d).toEqual({ allowed: true });
    }
  });
});
