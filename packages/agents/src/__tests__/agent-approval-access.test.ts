import { describe, it, expect } from "vitest";

import {
  agentApprovalAccessPolicy,
  AgentApprovalAccessTargetSchema,
} from "../auth-policy-types";

// cinatra#1327 — pure mapper from the reviewer's org/team/project selection to
// the agent_template access policy persisted at approval. The organization case
// is the load-bearing one: it must NOT fall back to the agent_template
// owner-only kind default (that is what "who has access" is choosing away from).

describe("agentApprovalAccessPolicy", () => {
  it("organization → workspace visibility (every same-org member), sharing off", () => {
    expect(agentApprovalAccessPolicy({ level: "organization", id: "org-1" })).toEqual({
      runListVisibility: ["workspace"],
      runDataVisibility: ["workspace"],
      runExecuteVisibility: ["workspace"],
      allowRunSharing: false,
    });
  });

  it("team → team:<id> visibility on all three fields, sharing off", () => {
    expect(agentApprovalAccessPolicy({ level: "team", id: "team-abc" })).toEqual({
      runListVisibility: ["team:team-abc"],
      runDataVisibility: ["team:team-abc"],
      runExecuteVisibility: ["team:team-abc"],
      allowRunSharing: false,
    });
  });

  it("project → project:<id> visibility on all three fields, sharing off", () => {
    expect(agentApprovalAccessPolicy({ level: "project", id: "proj-9" })).toEqual({
      runListVisibility: ["project:proj-9"],
      runDataVisibility: ["project:proj-9"],
      runExecuteVisibility: ["project:proj-9"],
      allowRunSharing: false,
    });
  });

  it("NEVER returns undefined / an owner-only policy for any level (fail-closed)", () => {
    for (const level of ["organization", "team", "project"] as const) {
      const policy = agentApprovalAccessPolicy({ level, id: "x" });
      expect(policy).toBeDefined();
      expect(policy.runExecuteVisibility).not.toContain("owner");
      expect(policy.runExecuteVisibility.length).toBe(1);
    }
  });
});

describe("AgentApprovalAccessTargetSchema", () => {
  it("accepts the three selectable levels with a non-empty id", () => {
    for (const level of ["organization", "team", "project"] as const) {
      expect(AgentApprovalAccessTargetSchema.safeParse({ level, id: "abc" }).success).toBe(true);
    }
  });

  it("rejects user / workspace levels and an empty id", () => {
    expect(AgentApprovalAccessTargetSchema.safeParse({ level: "user", id: "abc" }).success).toBe(false);
    expect(AgentApprovalAccessTargetSchema.safeParse({ level: "workspace", id: "abc" }).success).toBe(false);
    expect(AgentApprovalAccessTargetSchema.safeParse({ level: "organization", id: "" }).success).toBe(false);
  });
});
