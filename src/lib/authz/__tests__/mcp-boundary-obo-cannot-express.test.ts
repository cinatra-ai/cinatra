/**
 * W4 (#1053) — cannot-express surfaces under agent-run OBO tokens.
 *
 * The shared MCP boundary denies (fail-closed, named) the surfaces that resolve
 * no target ownership (connectors, triggers, permissions, metrics, notifications,
 * dashboard cubes, and the P5.5 assistant surface — org-scoped store only)
 * when an AGENT-RUN OBO token carries a NON-ORG scope ceiling —
 * BEFORE the carve-out / unenforced-skip / platform-admin short-circuits, so a
 * platform-admin invoker can never nullify the ceiling for a delegated run.
 * Non-agent-run callers (no `oboCeiling` on the frame) and sibling-wave
 * primitives that share a resourceType (agent_run_trigger_*, dashboards_* proper)
 * are unaffected.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "../audit";
import {
  enforceMcpBoundary,
  cannotExpressSurface,
  oboCeilingNonOrgTiers,
  type CannotExpressSurface,
} from "../mcp-boundary";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

const nonOrgCeiling = (): OboCeilingChain => [
  { tier: "user", id: "u1" },
  { tier: "organization", id: "org-1" },
];
const orgOnlyCeiling = (): OboCeilingChain => [{ tier: "organization", id: "org-1" }];

// Agent-run OBO ctx: a member invoker with a non-org ceiling on the frame.
const oboMemberCtx = (oboCeiling: OboCeilingChain) => ({
  orgId: "org-1",
  userId: "user-1",
  platformRole: undefined as never,
  oboCeiling,
});
// Agent-run OBO ctx: a PLATFORM-ADMIN invoker (the ceiling must still win).
const oboAdminCtx = (oboCeiling: OboCeilingChain) => ({
  orgId: "org-1",
  userId: "admin-1",
  platformRole: "platform_admin" as const,
  oboCeiling,
});

describe("enforceMcpBoundary — W4 cannot-express OBO gate", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
  });
  afterEach(() => {
    auditSpy.mockRestore();
  });

  // Each cannot-express surface: a NON-ORG-ceiling agent-run OBO token is denied
  // with the surface-labelled reason and a structured audit row.
  const surfaceCases: Array<[string, string]> = [
    ["crm_contact_search", "connector"],
    ["apollo_status", "connector"],
    ["trigger_config_set", "trigger"],
    ["trigger_config_get", "trigger"],
    ["permissions_members_invite", "permissions"],
    ["role_grant_grant", "permissions"],
    ["metric_cost_summary", "metrics"],
    ["metric_usage_summary", "metrics"],
    ["chat_mentions_poll", "notifications"],
    ["dashboards_cube_load", "dashboard_cube"],
    ["dashboards_cube_discover", "dashboard_cube"],
    ["assistant_send", "assistant"],
    ["assistant_thread_list", "assistant"],
    ["assistant_thread_get", "assistant"],
  ];

  it.each(surfaceCases)(
    "denies %s under a non-org ceiling (surface=%s)",
    async (primitiveName, surface) => {
      const d = await enforceMcpBoundary({
        primitiveName,
        ctx: oboMemberCtx(nonOrgCeiling()),
        delegatedRestricted: false,
      });
      expect(d.allowed).toBe(false);
      expect(d).toMatchObject({
        reason: `agent_run_obo_scope_unsupported:${surface}`,
        shouldBlock: true,
      });
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "denied",
          metadata: expect.objectContaining({
            reason: "agent_run_obo_scope_unsupported",
            oboSurface: surface,
            unhonoredCeilingTiers: ["user"],
          }),
        }),
      );
    },
  );

  it("denies EVEN a platform-admin invoker (ceiling checked before the admin bypass)", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "crm_contact_search",
      ctx: oboAdminCtx(nonOrgCeiling()),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(false);
    expect(d).toMatchObject({
      reason: "agent_run_obo_scope_unsupported:connector",
      shouldBlock: true,
    });
    // The platform_admin "via" allow-audit must NOT have fired.
    expect(auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ via: "platform_admin" }) }),
    );
  });

  it("surfaces BOTH incomparable bounds in the audit for a team+project ceiling", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "wordpress_post_get",
      ctx: oboMemberCtx([
        { tier: "team", id: "t1" },
        { tier: "organization", id: "org-1" },
        { tier: "project", id: "p1" },
      ]),
      delegatedRestricted: false,
    });
    expect(d).toMatchObject({ reason: "agent_run_obo_scope_unsupported:connector", shouldBlock: true });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ unhonoredCeilingTiers: ["team", "project"] }),
      }),
    );
  });

  it("does NOT fire on an ORG-ONLY ceiling (allowed through to the admin bypass)", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "crm_contact_search",
      ctx: oboAdminCtx(orgOnlyCeiling()),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(true);
  });

  it("DENIES the assistant surface on an ORG-ONLY ceiling too (it can honor neither the sub-org bound nor the org floor)", async () => {
    for (const primitiveName of ["assistant_send", "assistant_thread_list", "assistant_thread_get"]) {
      const d = await enforceMcpBoundary({
        primitiveName,
        ctx: oboAdminCtx(orgOnlyCeiling()),
        delegatedRestricted: false,
      });
      expect(d).toMatchObject({
        allowed: false,
        reason: "agent_run_obo_scope_unsupported:assistant",
        shouldBlock: true,
      });
    }
    // The platform_admin "via" allow-audit must NOT have fired.
    expect(auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ via: "platform_admin" }) }),
    );
  });

  it("does NOT capture agent_run_trigger_* (W2 run-resolvable, same resourceType)", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "agent_run_trigger_set",
      ctx: oboAdminCtx(nonOrgCeiling()),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(true);
  });

  it("does NOT capture dashboards_* proper (W3, same resourceType)", async () => {
    const d = await enforceMcpBoundary({
      primitiveName: "dashboards_list",
      ctx: oboAdminCtx(nonOrgCeiling()),
      delegatedRestricted: false,
    });
    expect(d.allowed).toBe(true);
  });

  it("is a NO-OP for non-agent-run callers (no oboCeiling on the frame)", async () => {
    // A plain member session (no oboCeiling) on the same connector primitive is
    // never denied with the W4 reason — the gate keys on the ceiling's presence,
    // which the transport stamps ONLY for delegation === "agent_run".
    const d = await enforceMcpBoundary({
      primitiveName: "crm_contact_search",
      ctx: { orgId: "org-1", userId: "user-1", platformRole: undefined as never },
      delegatedRestricted: false,
    });
    if (!d.allowed) {
      expect(d.reason.startsWith("agent_run_obo_scope_unsupported")).toBe(false);
    }
    // And a platform-admin session (still no oboCeiling) is allowed as before.
    const d2 = await enforceMcpBoundary({
      primitiveName: "crm_contact_search",
      ctx: { orgId: "org-1", userId: "admin-1", platformRole: "platform_admin" as const },
      delegatedRestricted: false,
    });
    expect(d2.allowed).toBe(true);
  });
});

// Pure classifier + ceiling helpers (inlined into mcp-boundary.ts; exported here
// for unit coverage).
describe("cannotExpressSurface", () => {
  it("maps the exclusive-resourceType cannot-express surfaces", () => {
    const cases: Array<[string, string, CannotExpressSurface]> = [
      ["crm_contact_search", "connector_instance", "connector"],
      ["apollo_status", "connector_instance", "connector"],
      ["wordpress_post_get", "connector_instance", "connector"],
      ["email_send", "connector_instance", "connector"],
      ["permissions_members_invite", "administration", "permissions"],
      ["role_grant_grant", "administration", "permissions"],
      ["metric_cost_summary", "metric_cost", "metrics"],
      ["metric_usage_summary", "metric_usage", "metrics"],
      ["chat_mentions_poll", "notification", "notifications"],
    ];
    for (const [primitiveName, resourceType, surface] of cases) {
      expect(cannotExpressSurface({ primitiveName, resourceType })).toBe(surface);
    }
  });

  it("maps the standalone trigger_config_* primitives (by name)", () => {
    for (const primitiveName of ["trigger_config_get", "trigger_config_set", "trigger_config_delete"]) {
      expect(cannotExpressSurface({ primitiveName, resourceType: "trigger" })).toBe("trigger");
    }
  });

  it("does NOT capture agent_run_trigger_* (same resourceType, W2 run-resolvable)", () => {
    for (const primitiveName of ["agent_run_trigger_get", "agent_run_trigger_set", "agent_run_trigger_delete"]) {
      expect(cannotExpressSurface({ primitiveName, resourceType: "trigger" })).toBeNull();
    }
  });

  it("maps dashboards_cube_* (by name prefix)", () => {
    for (const primitiveName of [
      "dashboards_cube_discover",
      "dashboards_cube_validate",
      "dashboards_cube_load",
      "dashboards_cube_chart",
    ]) {
      expect(cannotExpressSurface({ primitiveName, resourceType: "dashboard" })).toBe("dashboard_cube");
    }
  });

  it("maps the assistant MCP surface (by name; resourceType 'object' is shared with objects_*)", () => {
    for (const primitiveName of ["assistant_send", "assistant_thread_list", "assistant_thread_get"]) {
      expect(cannotExpressSurface({ primitiveName, resourceType: "object" })).toBe("assistant");
    }
  });

  it("does NOT capture dashboards_* proper (same resourceType, W3 ad-hoc)", () => {
    for (const primitiveName of [
      "dashboards_get",
      "dashboards_list",
      "dashboards_create",
      "dashboards_update",
      "dashboards_publish",
      "dashboards_archive",
    ]) {
      expect(cannotExpressSurface({ primitiveName, resourceType: "dashboard" })).toBeNull();
    }
  });

  it("returns null for W2/W3 kernel / ad-hoc surfaces", () => {
    const nonW4: Array<[string, string]> = [
      ["objects_get", "object"],
      ["agent_get", "agent"],
      ["agent_run_get", "agent_run"],
      ["projects_get", "project"],
      ["artifacts_get", "artifact"],
      ["workflow_status_get", "workflow"],
      ["skills_personal_get", "skill"],
    ];
    for (const [primitiveName, resourceType] of nonW4) {
      expect(cannotExpressSurface({ primitiveName, resourceType })).toBeNull();
    }
  });
});

describe("oboCeilingNonOrgTiers", () => {
  const chain = (...c: OboCeilingChain): OboCeilingChain => c;

  it("org-only chain (just the mandatory floor) → no non-org tiers", () => {
    expect(oboCeilingNonOrgTiers(chain({ tier: "organization", id: "org-1" }))).toEqual([]);
  });

  it("user / team / workspace / project anchors surface their tier", () => {
    expect(oboCeilingNonOrgTiers(chain({ tier: "user", id: "u1" }, { tier: "organization", id: "org-1" }))).toEqual(["user"]);
    expect(oboCeilingNonOrgTiers(chain({ tier: "team", id: "t1" }, { tier: "organization", id: "org-1" }))).toEqual(["team"]);
    expect(oboCeilingNonOrgTiers(chain({ tier: "workspace", id: "w1" }, { tier: "organization", id: "org-1" }))).toEqual(["workspace"]);
    expect(oboCeilingNonOrgTiers(chain({ tier: "organization", id: "org-1" }, { tier: "project", id: "p1" }))).toEqual(["project"]);
  });

  it("a multi-axis chain (team + project) surfaces BOTH incomparable bounds", () => {
    expect(
      oboCeilingNonOrgTiers(
        chain({ tier: "team", id: "t1" }, { tier: "organization", id: "org-1" }, { tier: "project", id: "p1" }),
      ),
    ).toEqual(["team", "project"]);
  });

  it("dedups repeated non-org tiers", () => {
    expect(
      oboCeilingNonOrgTiers(chain({ tier: "user", id: "u1" }, { tier: "user", id: "u2" }, { tier: "organization", id: "org-1" })),
    ).toEqual(["user"]);
  });

  it("null / undefined / empty chain → no non-org tiers", () => {
    expect(oboCeilingNonOrgTiers(null)).toEqual([]);
    expect(oboCeilingNonOrgTiers(undefined)).toEqual([]);
    expect(oboCeilingNonOrgTiers([])).toEqual([]);
  });
});
