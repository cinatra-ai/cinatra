/**
 * Tools whose registration declares that they act outward, on an agent run's
 * frame (cinatra#3745).
 *
 * A tool whose registration declares that it acts outward on a person's behalf
 * reaches the boundary with `declaresOutward: true`. On an agent run's frame (a
 * frame that carries a run id) the boundary holds such a tool exactly as it
 * holds a tool of its name list: it answers with the named reason
 * `outward_effect_requires_recorded_decision`. A call without the declaration,
 * and a call on a frame without a run id, keep the decision of the boundary's
 * other rules, and every tool of the name list stays held whatever the
 * declaration says, so the set of held tools can only grow.
 *
 * These cases drive the real `enforceMcpBoundary` and the real predicate. Only
 * the audit writer, the classification reader and the extension-registry reader
 * are test doubles; every double is restored after each case.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "../audit";
import * as augmentModule from "../inventory-augment";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import * as boundary from "../mcp-boundary";

const { enforceMcpBoundary, needsRecordedDecision } = boundary;

const REASON = "outward_effect_requires_recorded_decision";

// An invented tool name outside the rule's name list.
const DECLARED_TOOL = "example_outward_tool";

// The 21 names of the rule's list, as its census test names them.
const LISTED_NAMES = [
  "email_outreach_send_test_start",
  "email_outreach_send_initial_start",
  "email_outreach_send_initial_cancel",
  "email_outreach_system_jobs_initial_send_run",
  "email_outreach_system_process_due_follow_ups",
  "email_send",
  "gmail_email_send",
  "email_test_delivery_run_send",
  "permissions_members_invite",
  "social_media_publish",
  "linkedin_post_publish",
  "blog_post_publish_linkedin_publish",
  "agent_registry_publish",
  "agent_source_publish",
  "artifact_source_publish",
  "skill_source_publish",
  "agent_creation_request_propose",
  "agent_creation_request_decide",
  "agent_creation_request_retry_publish",
  "agent_run_resume",
  "approvals_decide",
] as const;

// A classification for the names the host inventory does not list, so every
// name of these cases reaches the rule under test.
const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;

const runMemberCtx = () => ({ orgId: "org-1", userId: "user-1", runId: "run-1" });
const runAdminCtx = () => ({
  orgId: "org-1",
  userId: "admin-1",
  platformRole: "platform_admin" as const,
  runId: "run-1",
});
const personMemberCtx = () => ({ orgId: "org-1", userId: "user-1" });

describe("a tool whose registration declares that it acts outward, on an agent run's frame", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let classificationSpy: ReturnType<typeof vi.spyOn>;
  let extensionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const realLookup = augmentModule.lookupPrimitiveClassification;
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    classificationSpy = vi
      .spyOn(augmentModule, "lookupPrimitiveClassification")
      .mockImplementation((name: string) => realLookup(name) ?? { ...FIXTURE_CLASSIFICATION });
    extensionSpy = vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    classificationSpy.mockRestore();
    extensionSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("is held exactly as a tool of the name list", () => {
    it("answers a declared tool with the named reason for an organisation member's run", async () => {
      const d = await enforceMcpBoundary({
        primitiveName: DECLARED_TOOL,
        ctx: runMemberCtx(),
        delegatedRestricted: false,
        declaresOutward: true,
      });
      expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: DECLARED_TOOL,
          decision: "denied",
          runId: "run-1",
          metadata: expect.objectContaining({ reason: REASON }),
        }),
      );
    });

    it("answers a declared tool with the named reason for a platform administrator's run", async () => {
      const d = await enforceMcpBoundary({
        primitiveName: DECLARED_TOOL,
        ctx: runAdminCtx(),
        delegatedRestricted: false,
        declaresOutward: true,
      });
      expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
      expect(auditSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ via: "platform_admin" }) }),
      );
    });

    it("holds a declared tool outside the name list on a run's frame in the predicate", () => {
      expect(needsRecordedDecision(DECLARED_TOOL, runMemberCtx(), true)).toBe(true);
    });
  });

  describe("keeps the decision of the boundary's other rules without the declaration or without a run", () => {
    it.each([
      ["without the field", {}],
      ["with the field false", { declaresOutward: false }],
    ] as const)("decides a tool %s on a run's frame by the other rules", async (_label, flag) => {
      const d = await enforceMcpBoundary({
        primitiveName: DECLARED_TOOL,
        ctx: runMemberCtx(),
        delegatedRestricted: false,
        ...flag,
      });
      expect(d).toEqual({ allowed: true });
      expect(auditSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ reason: REASON }) }),
      );
    });

    it.each([
      ["a person's own frame without a run", false],
      ["the delegated-chat perimeter without a run", true],
    ] as const)("decides a declared tool on %s as it decides the tool without the declaration", async (_label, delegatedRestricted) => {
      const without = await enforceMcpBoundary({
        primitiveName: DECLARED_TOOL,
        ctx: personMemberCtx(),
        delegatedRestricted,
      });
      const declared = await enforceMcpBoundary({
        primitiveName: DECLARED_TOOL,
        ctx: personMemberCtx(),
        delegatedRestricted,
        declaresOutward: true,
      });
      expect(declared).toEqual(without);
    });

    it("answers the predicate's two-argument call as it answers it without a declaration", () => {
      expect(needsRecordedDecision(DECLARED_TOOL, runMemberCtx())).toBe(false);
      expect(needsRecordedDecision(DECLARED_TOOL, personMemberCtx())).toBe(false);
      expect(needsRecordedDecision(DECLARED_TOOL, undefined)).toBe(false);
      expect(needsRecordedDecision(DECLARED_TOOL, personMemberCtx(), true)).toBe(false);
      expect(needsRecordedDecision(DECLARED_TOOL, undefined, true)).toBe(false);
    });
  });

  describe("holds every tool of the name list whatever the declaration says", () => {
    it("keeps exactly the 21 names of the list", () => {
      expect([...boundary.OUTWARD_EFFECT_TOOL_NAMES].sort()).toEqual([...LISTED_NAMES].sort());
    });

    it.each(LISTED_NAMES)("answers %s with the named reason on a run's frame with the declaration absent, false or true", async (primitiveName) => {
      for (const flag of [{}, { declaresOutward: false }, { declaresOutward: true }]) {
        const d = await enforceMcpBoundary({
          primitiveName,
          ctx: runMemberCtx(),
          delegatedRestricted: false,
          ...flag,
        });
        expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
      }
      expect(needsRecordedDecision(primitiveName, runMemberCtx())).toBe(true);
      expect(needsRecordedDecision(primitiveName, personMemberCtx())).toBe(false);
      expect(needsRecordedDecision(primitiveName, undefined)).toBe(false);
    });
  });
});
