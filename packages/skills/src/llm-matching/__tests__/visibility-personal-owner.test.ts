/**
 * Durable-owner delivery for user-authored skills (cinatra#1416, AC7).
 *
 * Sharing a personal skill must never lock its owner out of DELIVERY: when the
 * skill carries `ownerUserId`, the read-time visibility filter admits the owner
 * regardless of the policy union (which the projection strips of the redundant
 * `owner` token once broadened). Mirrors requireResourceAccess's durable-owner
 * short-circuit. Package-shipped rows (no ownerUserId) keep the legacy union.
 */

import { describe, it, expect } from "vitest";
import {
  filterMatchRowsByVisibility,
  type VisibilityActor,
  type VisibilitySkillMeta,
} from "../visibility";
import type { SkillMatchRow } from "../types";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

const NOW = new Date("2026-07-13T09:00:00Z");
const OWNER = "owner-user-id";
const T1 = "team:11111111-1111-1111-1111-111111111111" as const;
const T1_ID = "11111111-1111-1111-1111-111111111111";

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

function member(over: Partial<VisibilityActor>): VisibilityActor {
  return { teamIds: [], projectIds: [], platformRole: "member", ...over };
}

describe("filterMatchRowsByVisibility — durable owner of a shared personal skill (cinatra#1416)", () => {
  const rows = [row("s-shared")];
  // Personal skill BROADENED to team t1: the projected tuple names the granted
  // locus and the union no longer carries `owner`. Only `ownerUserId` keeps the
  // owner in delivery.
  const sharedMeta: VisibilitySkillMeta = {
    level: "team",
    scope: T1_ID,
    ownerUserId: OWNER,
    accessPolicy: policy([T1]),
  };
  const skills = new Map<string, VisibilitySkillMeta>([["s-shared", sharedMeta]]);

  it("AC7: the owner still receives the skill even though the policy union excludes them", () => {
    const owner = member({ userId: OWNER, teamIds: [], projectIds: [] });
    expect(filterMatchRowsByVisibility(rows, skills, owner)).toHaveLength(1);
  });

  it("a granted-scope member receives the skill (union any-match)", () => {
    const teamMember = member({ userId: "member-x", teamIds: [T1_ID] });
    expect(filterMatchRowsByVisibility(rows, skills, teamMember)).toHaveLength(1);
  });

  it("an outsider (not owner, not in a granted scope) does NOT receive the skill", () => {
    const outsider = member({ userId: "stranger", teamIds: ["other"] });
    expect(filterMatchRowsByVisibility(rows, skills, outsider)).toHaveLength(0);
  });
});

describe("actorMatchesSkillPolicy owner-token — durable identity over the projected scope", () => {
  const rows = [row("s-owner")];
  // Legacy-ish shape: `owner` in the union but the tuple `scope` lags behind the
  // real owner. ownerUserId must win.
  const ownerMeta: VisibilitySkillMeta = {
    level: "personal",
    scope: "stale-scope-value",
    ownerUserId: OWNER,
    accessPolicy: policy(["owner"]),
  };
  const skills = new Map<string, VisibilitySkillMeta>([["s-owner", ownerMeta]]);

  it("admits the durable owner, not the stale scope value", () => {
    expect(filterMatchRowsByVisibility(rows, skills, member({ userId: OWNER }))).toHaveLength(1);
    expect(
      filterMatchRowsByVisibility(rows, skills, member({ userId: "stale-scope-value" })),
    ).toHaveLength(0);
  });
});
