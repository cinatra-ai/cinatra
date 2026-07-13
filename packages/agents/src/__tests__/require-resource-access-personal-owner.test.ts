// Personal-skill access via the shared picker (cinatra#1416).
//
// Durable-owner authorization for user-authored (personal/custom) skills:
// ownership is a persisted `ownerUserId`, INDEPENDENT of the mutable
// `(level, scope)` tuple and of the canonical policy union. Broadening a
// personal skill to `[team:t1]` rewrites the projected tuple's scope to the
// granted locus and strips the redundant `owner` token, so without the durable
// short-circuit the owner would be locked out of their own skill.
//
//   AC1 — broadening never changes who owns/manages the skill.
//   AC2 — one authorization model: scope grants convey read/use, NOT manage.
//   AC5 — owner + platform admin manage; granted-scope members read/use only.
//
// Package-shipped skills carry NO `ownerUserId`, so every legacy union branch
// (read AND manage on any matching token) is unchanged for them.

import { describe, it, expect } from "vitest";
import type { ActorContext } from "@/lib/authz";
import { requireResourceAccess, buildSkillResourceRef } from "../auth-policy";
import type { AgentAuthPolicy } from "../auth-policy";

function actor(over: Partial<ActorContext>): ActorContext {
  return {
    platformRole: "member",
    principalId: "user-1",
    principalType: "HumanUser",
    ...over,
  } as unknown as ActorContext;
}

function policy(tokens: AgentAuthPolicy["runListVisibility"]): AgentAuthPolicy {
  return {
    runListVisibility: tokens,
    runDataVisibility: tokens,
    runExecuteVisibility: tokens,
    allowRunSharing: false,
  };
}

const OWNER = "owner-user-id";
const T1 = "team:11111111-1111-1111-1111-111111111111" as const;
const T1_ID = "11111111-1111-1111-1111-111111111111";

describe("requireResourceAccess — durable owner of a user-authored skill (cinatra#1416)", () => {
  // A personal skill BROADENED to team t1: the projection rewrote the tuple to
  // (team, t1) and dropped the `owner` token from the union. The owner is NOT a
  // member of t1 — only the durable `ownerUserId` keeps them in.
  const sharedRef = buildSkillResourceRef({
    id: "@custom/personal-skills/my-skill",
    level: "team",
    scope: T1_ID,
    ownerUserId: OWNER,
    accessPolicy: policy([T1]),
  });

  it("AC1: the owner is admitted for READ even though the policy union excludes them", () => {
    expect(() =>
      requireResourceAccess(actor({ principalId: OWNER, teamIds: [], projectIds: [] }), sharedRef),
    ).not.toThrow();
  });

  it("AC1/AC5: the owner is admitted for MANAGE even though the policy union excludes them", () => {
    expect(() =>
      requireResourceAccess(
        actor({ principalId: OWNER, teamIds: [], projectIds: [] }),
        sharedRef,
        "manage",
      ),
    ).not.toThrow();
  });

  it("AC5: a granted-scope member READS the shared skill (union any-match)", () => {
    expect(() =>
      requireResourceAccess(actor({ principalId: "member-x", teamIds: [T1_ID] }), sharedRef),
    ).not.toThrow();
  });

  it("AC2/AC5: a granted-scope member is DENIED manage — a scope grant conveys read/use only", () => {
    expect(() =>
      requireResourceAccess(
        actor({ principalId: "member-x", teamIds: [T1_ID] }),
        sharedRef,
        "manage",
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403, reason: "forbidden" }));
  });

  it("an outsider (not owner, not in a granted scope) is denied READ and MANAGE", () => {
    expect(() =>
      requireResourceAccess(actor({ principalId: "stranger", teamIds: ["other"] }), sharedRef),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() =>
      requireResourceAccess(
        actor({ principalId: "stranger", teamIds: ["other"] }),
        sharedRef,
        "manage",
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it("platform_admin still manages a durable-owner skill (structural bypass precedes the owner key)", () => {
    expect(() =>
      requireResourceAccess(
        actor({ principalId: "admin-u", platformRole: "platform_admin" }),
        sharedRef,
        "manage",
      ),
    ).not.toThrow();
  });

  it("the `owner` token resolves to the DURABLE ownerUserId, not the projected scope", () => {
    // A personal skill still narrowed to personal keeps `owner` in the union; the
    // tuple scope may lag behind (legacy row) but ownerUserId is authoritative.
    const ownerTokenRef = buildSkillResourceRef({
      id: "@custom/personal-skills/s2",
      level: "personal",
      scope: "stale-scope-value",
      ownerUserId: OWNER,
      accessPolicy: policy(["owner"]),
    });
    expect(() => requireResourceAccess(actor({ principalId: OWNER }), ownerTokenRef)).not.toThrow();
    expect(() =>
      requireResourceAccess(actor({ principalId: "stale-scope-value" }), ownerTokenRef),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it("AC1: narrowing back to personal restores the owner-only baseline (owner manages, others denied)", () => {
    const narrowedRef = buildSkillResourceRef({
      id: "@custom/personal-skills/s3",
      level: "personal",
      scope: OWNER,
      ownerUserId: OWNER,
      accessPolicy: policy(["owner"]),
    });
    expect(() =>
      requireResourceAccess(actor({ principalId: OWNER }), narrowedRef, "manage"),
    ).not.toThrow();
    expect(() =>
      requireResourceAccess(actor({ principalId: "member-x", teamIds: [T1_ID] }), narrowedRef),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

describe("requireResourceAccess — owned skill with NO canonical policy (tuple fallback, cinatra#1416, AC2)", () => {
  // A personal skill whose (level, scope) projected to (team, t1) but whose ref
  // carries NO accessPolicy (the legacy / tuple-only path). The owned-skill
  // MANAGE denial must fire BEFORE the tuple branch — otherwise a t1 member
  // would match the team tuple (which does not distinguish read from manage)
  // and wrongly receive manage on someone else's personal skill.
  const tupleRef = buildSkillResourceRef({
    id: "@custom/personal-skills/tuple-only",
    level: "team",
    scope: T1_ID,
    ownerUserId: OWNER,
    // no accessPolicy → falls through to the (level, scope) tuple branch
  });

  it("a granted-scope member READS the owned skill via the tuple", () => {
    expect(() =>
      requireResourceAccess(actor({ principalId: "member-x", teamIds: [T1_ID] }), tupleRef),
    ).not.toThrow();
  });

  it("a granted-scope member is DENIED manage even on the tuple-fallback path (security)", () => {
    expect(() =>
      requireResourceAccess(
        actor({ principalId: "member-x", teamIds: [T1_ID] }),
        tupleRef,
        "manage",
      ),
    ).toThrow();
  });

  it("the durable owner still MANAGES the tuple-only owned skill", () => {
    expect(() =>
      requireResourceAccess(actor({ principalId: OWNER, teamIds: [] }), tupleRef, "manage"),
    ).not.toThrow();
  });
});

describe("requireResourceAccess — package-shipped skills keep legacy union manage (no ownerUserId)", () => {
  // No ownerUserId → the AC2 manage restriction does NOT apply; the legacy
  // union admits any matching token for read AND manage, exactly as before.
  const pkgRef = buildSkillResourceRef({
    id: "@pkg/shipped-skill",
    level: "team",
    scope: T1_ID,
    accessPolicy: policy([T1]),
  });

  it("a team member MANAGES a package skill (legacy union semantics preserved)", () => {
    expect(pkgRef.ownerUserId).toBeUndefined();
    expect(() =>
      requireResourceAccess(actor({ principalId: "member-x", teamIds: [T1_ID] }), pkgRef, "manage"),
    ).not.toThrow();
  });
});
