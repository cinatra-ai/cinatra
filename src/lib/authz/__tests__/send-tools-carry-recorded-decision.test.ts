/**
 * Outward-effect tools on an agent run's frame (cinatra#3745).
 *
 * A tool call that sends a message, publishes a post or a package, or answers
 * a person's pending gate on that person's behalf is served, on an agent run's
 * frame, only together with the person's recorded decision for the run's
 * action; without one the boundary answers with the named reason
 * `outward_effect_requires_recorded_decision`, whatever the caller's role, the
 * tool's classification status or a carve-out.
 *
 * These cases drive the real `enforceMcpBoundary` and the real predicate. Only
 * the audit writer, the classification reader, the extension-registry reader
 * and (for one case) the carve-out reader are test doubles; every double is
 * restored after each case.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "../audit";
import * as augmentModule from "../inventory-augment";
import * as carveOutModule from "../carve-out";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import * as boundary from "../mcp-boundary";
import inventory from "@/lib/authz/__generated__/inventory.json";
import { triggerEmailSendPrimitiveMetadata } from "../../../../packages/trigger-email-send/src/mcp/metadata";

const { enforceMcpBoundary } = boundary;

const REASON = "outward_effect_requires_recorded_decision";

// The trigger-email-send tools whose metadata marks a state change.
const TRIGGER_EMAIL_SEND_MEMBERS = [
  "email_outreach_send_test_start",
  "email_outreach_send_initial_start",
  "email_outreach_send_initial_cancel",
  "email_outreach_system_jobs_initial_send_run",
  "email_outreach_system_process_due_follow_ups",
] as const;

// Every other member, each a primitive of the authorization inventory.
const INVENTORY_MEMBERS = [
  // Messages.
  "email_send",
  "gmail_email_send",
  "email_test_delivery_run_send",
  "permissions_members_invite",
  // Publishing.
  "social_media_publish",
  "linkedin_post_publish",
  "blog_post_publish_linkedin_publish",
  "agent_registry_publish",
  "agent_source_publish",
  "artifact_source_publish",
  "skill_source_publish",
  // Publishing: an agent package through a creation request.
  "agent_creation_request_propose",
  "agent_creation_request_decide",
  "agent_creation_request_retry_publish",
  // An answer to a person's pending gate in a run.
  "agent_run_resume",
  // A person's decision on an approval at its source.
  "approvals_decide",
] as const;

const EXPECTED_MEMBERS: readonly string[] = [...TRIGGER_EMAIL_SEND_MEMBERS, ...INVENTORY_MEMBERS];

// Names this set leaves to later decisions; each keeps its current decision.
const KEPT_OUTSIDE_THE_SET = [
  "drupal_node_publish",
  "wordpress_site_tool_call",
  "blog_post_publish_wordpress_start",
  "blog_post_publish_wordpress_delete",
  "dashboards_publish",
  "email_outreach_send_initial_status",
] as const;

// A classification for the members the host inventory does not list (the
// trigger-email-send tools), so every member reaches the rule under test.
const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;

const runMemberCtx = () => ({ orgId: "org-1", userId: "user-1", runId: "run-1" });
const runAdminCtx = () => ({
  orgId: "org-1",
  userId: "admin-1",
  platformRole: "platform_admin" as const,
  runId: "run-1",
});
const personMemberCtx = () => ({ orgId: "org-1", userId: "user-1" });

describe("outward-effect tools on an agent run's frame", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let classificationSpy: ReturnType<typeof vi.spyOn>;
  let extensionSpy: ReturnType<typeof vi.spyOn>;
  let classificationOverride: augmentModule.PrimitiveClassification | undefined;

  beforeEach(() => {
    classificationOverride = undefined;
    const realLookup = augmentModule.lookupPrimitiveClassification;
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    classificationSpy = vi
      .spyOn(augmentModule, "lookupPrimitiveClassification")
      .mockImplementation((name: string) => {
        if (classificationOverride) return classificationOverride;
        const real = realLookup(name);
        if (real) return real;
        return (TRIGGER_EMAIL_SEND_MEMBERS as readonly string[]).includes(name)
          ? { ...FIXTURE_CLASSIFICATION }
          : undefined;
      });
    extensionSpy = vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    classificationSpy.mockRestore();
    extensionSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("a tool that sends or publishes, called on an agent run's frame, is served together with a recorded decision", () => {
    it.each(EXPECTED_MEMBERS)("answers %s with the named reason for an organisation member's run", async (primitiveName) => {
      const d = await enforceMcpBoundary({ primitiveName, ctx: runMemberCtx(), delegatedRestricted: false });
      expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: primitiveName,
          decision: "denied",
          runId: "run-1",
          metadata: expect.objectContaining({ reason: REASON }),
        }),
      );
    });

    it.each(EXPECTED_MEMBERS)("answers %s with the named reason for a platform administrator's run", async (primitiveName) => {
      const d = await enforceMcpBoundary({ primitiveName, ctx: runAdminCtx(), delegatedRestricted: false });
      expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
      expect(auditSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ via: "platform_admin" }) }),
      );
    });

    it.each(EXPECTED_MEMBERS)("answers %s with the named reason when its classification status is unenforced", async (primitiveName) => {
      classificationOverride = { resourceType: "agent_run", action: "execute", status: "unenforced" };
      const d = await enforceMcpBoundary({ primitiveName, ctx: runMemberCtx(), delegatedRestricted: false });
      expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
    });

    it.each(EXPECTED_MEMBERS)("answers %s with the named reason when a carve-out is present for it", async (primitiveName) => {
      const carveSpy = vi.spyOn(carveOutModule, "findCarveOut").mockImplementation((ref) =>
        ref.primitiveName === primitiveName
          ? {
              primitiveName,
              resourceType: "agent_run",
              action: "execute",
              boundary: ref.boundary,
              reason: "test fixture",
              risk: "low",
              owningTeam: "test",
              reviewedAt: "2026-09-28",
              reviewerId: "test",
            }
          : undefined,
      );
      try {
        const d = await enforceMcpBoundary({ primitiveName, ctx: runMemberCtx(), delegatedRestricted: false });
        expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
        expect(auditSpy).not.toHaveBeenCalledWith(
          expect.objectContaining({ metadata: expect.objectContaining({ carveOut: true }) }),
        );
      } finally {
        carveSpy.mockRestore();
      }
    });

    it.each(EXPECTED_MEMBERS)("answers %s with the named reason when the run carries a scope ceiling", async (primitiveName) => {
      const d = await enforceMcpBoundary({
        primitiveName,
        ctx: { ...runMemberCtx(), oboCeiling: [{ tier: "user", id: "user-1" }, { tier: "organization", id: "org-1" }] },
        delegatedRestricted: false,
      });
      expect(d).toEqual({ allowed: false, reason: REASON, shouldBlock: true });
    });
  });

  describe("every tool of the outward-effect set is named in the boundary module", () => {
    const inventoryNames = new Set(
      (inventory as { primitives: Array<{ primitiveName: string }> }).primitives.map((p) => p.primitiveName),
    );

    it("holds exactly the listed members", () => {
      expect([...boundary.OUTWARD_EFFECT_TOOL_NAMES].sort()).toEqual([...EXPECTED_MEMBERS].sort());
    });

    it("holds every trigger-email-send tool whose metadata marks a state change", () => {
      const stateChanging = triggerEmailSendPrimitiveMetadata.filter((m) => m.mutatesState).map((m) => m.name);
      expect(stateChanging.length).toBeGreaterThan(0);
      for (const name of stateChanging) expect(boundary.OUTWARD_EFFECT_TOOL_NAMES.has(name)).toBe(true);
    });

    it.each(INVENTORY_MEMBERS)("holds %s, a primitive of the authorization inventory", (name) => {
      expect(boundary.OUTWARD_EFFECT_TOOL_NAMES.has(name)).toBe(true);
      expect(inventoryNames.has(name)).toBe(true);
    });

    it.each(KEPT_OUTSIDE_THE_SET)("leaves %s outside the set", (name) => {
      expect(boundary.OUTWARD_EFFECT_TOOL_NAMES.has(name)).toBe(false);
      expect(boundary.needsRecordedDecision(name, runMemberCtx())).toBe(false);
    });

    it("applies to a member on a frame with a run id, and to no call outside that", () => {
      expect(boundary.needsRecordedDecision("email_send", runMemberCtx())).toBe(true);
      expect(boundary.needsRecordedDecision("email_send", personMemberCtx())).toBe(false);
      expect(boundary.needsRecordedDecision("email_send", undefined)).toBe(false);
      expect(boundary.needsRecordedDecision("remote_server_send_message", runMemberCtx())).toBe(false);
    });
  });

  describe("a tool outside the set, and a call on a frame that carries no run, keep today's decision", () => {
    it.each(["accounts_get", "dashboards_list"])("keeps the decision for %s on an agent run's frame", async (primitiveName) => {
      const d = await enforceMcpBoundary({ primitiveName, ctx: runMemberCtx(), delegatedRestricted: false });
      expect(d).toEqual({ allowed: true });
    });

    it.each(EXPECTED_MEMBERS)("keeps the decision for %s on a person's own frame without a run", async (primitiveName) => {
      const d = await enforceMcpBoundary({ primitiveName, ctx: personMemberCtx(), delegatedRestricted: false });
      expect(d).toEqual({ allowed: true });
    });

    it.each(EXPECTED_MEMBERS)("keeps the decision for %s on the delegated-chat perimeter without a run", async (primitiveName) => {
      const d = await enforceMcpBoundary({ primitiveName, ctx: personMemberCtx(), delegatedRestricted: true });
      expect(d).toEqual({ allowed: true });
    });
  });

  describe("the tools this leg keeps outside the set keep today's decision on an agent run's frame", () => {
    const frames = [
      ["an organisation member's run", runMemberCtx],
      ["a platform administrator's run", runAdminCtx],
    ] as const;

    it.each(frames)(
      "drupal_node_publish keeps its decision on %s: the tool evaluates a person's review decision on the record it changes",
      async (_label, ctx) => {
        const d = await enforceMcpBoundary({ primitiveName: "drupal_node_publish", ctx: ctx(), delegatedRestricted: false });
        expect(d).toEqual({ allowed: true });
      },
    );

    it.each(frames)(
      "wordpress_site_tool_call keeps its decision on %s: the connector's own invoker decides by the ability it calls",
      async (_label, ctx) => {
        const d = await enforceMcpBoundary({ primitiveName: "wordpress_site_tool_call", ctx: ctx(), delegatedRestricted: false });
        expect(d).toEqual({ allowed: true });
      },
    );

    it.each(frames)(
      "blog_post_publish_wordpress_start and _delete keep their decision on %s: a draft on the connected site, decided with drafts",
      async (_label, ctx) => {
        for (const primitiveName of ["blog_post_publish_wordpress_start", "blog_post_publish_wordpress_delete"]) {
          const d = await enforceMcpBoundary({ primitiveName, ctx: ctx(), delegatedRestricted: false });
          expect(d).toEqual({ allowed: true });
        }
      },
    );

    it.each(frames)(
      "dashboards_publish keeps its decision on %s: a revision inside the organisation",
      async (_label, ctx) => {
        const d = await enforceMcpBoundary({ primitiveName: "dashboards_publish", ctx: ctx(), delegatedRestricted: false });
        expect(d).toEqual({ allowed: true });
      },
    );

    it("a tool name outside the set, such as an external tool server's tool, keeps its decision on an agent run's frame", async () => {
      const d = await enforceMcpBoundary({
        primitiveName: "remote_server_send_message",
        ctx: runMemberCtx(),
        delegatedRestricted: false,
      });
      expect(d).toEqual({ allowed: false, reason: "unclassified_primitive", shouldBlock: true });
    });
  });
});
