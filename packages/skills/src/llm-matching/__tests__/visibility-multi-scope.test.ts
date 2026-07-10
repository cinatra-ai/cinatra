/**
 * Multi-scope access W4 (#1073): filterMatchRowsByVisibility evaluates the
 * canonical accessPolicy union ANY-MATCH when a row carries `accessPolicy`.
 * An OR-policy like [team:t1, project:p2] admits an actor matching EITHER
 * scope — the projection the (level, scope) tuple cannot represent — and a
 * single-token policy stays behaviour-identical to the legacy per-level gate.
 */

import { describe, it, expect } from "vitest";
import {
  filterMatchRowsByVisibility,
  type VisibilityActor,
  type VisibilitySkillMeta,
} from "../visibility";
import type { SkillMatchRow } from "../types";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

const NOW = new Date("2026-07-10T15:00:00Z");

function row(skillId: string): SkillMatchRow {
  return {
    agentId: "@cinatra/email-agent",
    skillId,
    source: "llm",
    matched: true,
    score: 0.9,
    rationale: "test",
    evaluatorVersion: "llm-matcher-v1",
    agentInputHash: "a".repeat(64),
    skillInputHash: "b".repeat(64),
    status: "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: NOW,
    jobStartedAt: NOW,
  };
}

function policy(tokens: AgentAuthPolicy["runListVisibility"]): AgentAuthPolicy {
  return {
    runListVisibility: tokens,
    runDataVisibility: tokens,
    runExecuteVisibility: tokens,
    allowRunSharing: false,
  };
}

const T1 = "team:11111111-1111-1111-1111-111111111111" as const;
const P2 = "project:22222222-2222-2222-2222-222222222222" as const;

function member(over: Partial<VisibilityActor>): VisibilityActor {
  return { teamIds: [], projectIds: [], platformRole: "member", ...over };
}

describe("filterMatchRowsByVisibility — canonical multi-scope policy (W4)", () => {
  const rows = [row("s-or")];
  const skills = (meta: VisibilitySkillMeta) =>
    new Map<string, VisibilitySkillMeta>([["s-or", meta]]);
  const orMeta: VisibilitySkillMeta = {
    // The stored tuple level is a single dimension (team); the policy union
    // carries the real OR — the whole point of W4.
    level: "team",
    scope: "11111111-1111-1111-1111-111111111111",
    accessPolicy: policy([T1, P2]),
  };

  it("admits a member of team t1 (first token)", () => {
    const actor = member({ userId: "u", teamIds: ["11111111-1111-1111-1111-111111111111"] });
    expect(filterMatchRowsByVisibility(rows, skills(orMeta), actor)).toHaveLength(1);
  });

  it("admits a member of project p2 (second token) — tuple team-branch would hide it", () => {
    const actor = member({ userId: "u", projectIds: ["22222222-2222-2222-2222-222222222222"] });
    expect(filterMatchRowsByVisibility(rows, skills(orMeta), actor)).toHaveLength(1);
  });

  it("hides the row from an actor in neither scope", () => {
    const actor = member({ userId: "u", teamIds: ["x"], projectIds: ["y"] });
    expect(filterMatchRowsByVisibility(rows, skills(orMeta), actor)).toHaveLength(0);
  });

  it("platform_admin still sees everything (short-circuit)", () => {
    const actor = member({ userId: "u", platformRole: "platform_admin" });
    expect(filterMatchRowsByVisibility(rows, skills(orMeta), actor)).toHaveLength(1);
  });

  it("no policy present → legacy (level, scope) tuple still governs", () => {
    const legacy: VisibilitySkillMeta = {
      level: "team",
      scope: "11111111-1111-1111-1111-111111111111",
    };
    const inTeam = member({ userId: "u", teamIds: ["11111111-1111-1111-1111-111111111111"] });
    const outTeam = member({ userId: "u", teamIds: ["other"] });
    expect(filterMatchRowsByVisibility(rows, skills(legacy), inTeam)).toHaveLength(1);
    expect(filterMatchRowsByVisibility(rows, skills(legacy), outTeam)).toHaveLength(0);
  });
});
