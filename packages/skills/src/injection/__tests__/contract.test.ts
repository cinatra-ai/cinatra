/**
 * `resolveInjectedSkillSet` — intents, authorization, attribution
 * (cinatra#2091, epic #2086 S4).
 *
 * These are the acceptance properties the epic names:
 *   - a closed intent union with per-intent server-side authorization;
 *   - the reviewer-lane purpose delivering THAT LANE's methodology;
 *   - the auditor purpose reproducing the recorded run set;
 *   - authorization failures being VISIBLE (thrown, never a silent empty set);
 *   - unattributed skill content being REFUSED.
 */
import { describe, it, expect } from "vitest";
import {
  resolveInjectedSkillSet,
  injectedCatalogSkillIds,
  injectedPersonalDelta,
  injectedSkillDrops,
  injectedSkillMembers,
  describeInjectedSelection,
  assertAttributedInjectedSkillSet,
  MissingInjectionPortError,
  SkillInjectionAuthorizationError,
  UnattributedSkillContentError,
  UnknownInjectionIntentError,
  type InjectionIntent,
} from "..";
import type { InjectionResolverPorts } from "../ports";

const OK = async () => ({ ok: true as const, runOwnerUserId: "owner-1" });

describe("agent-run intent", () => {
  const ports: InjectionResolverPorts = {
    authorizeAgentRun: OK,
    resolveDeclaredDependencySkills: async () => [{ skillId: "dep-1" }],
    resolveRunRecommendedSkills: async () => [
      { skillId: "rec-1", revisionId: "rev-9" },
    ],
    resolvePersonalDelta: async () => ({
      skillId: "personal-1",
      content: "MY DELTA",
      revisionId: "prev-3",
    }),
  };

  it("derives declared dependencies, recommendations and the delta — in delivery order", async () => {
    const set = await resolveInjectedSkillSet(
      { kind: "agent-run", agentId: "a", runId: "r", userId: "owner-1" },
      ports,
    );
    expect(injectedSkillMembers(set).map((m) => m.skillId)).toEqual([
      "personal-1",
      "dep-1",
      "rec-1",
    ]);
    // The delta is inline and never part of the catalog delivery set.
    expect(injectedCatalogSkillIds(set)).toEqual(["dep-1", "rec-1"]);
    expect(injectedPersonalDelta(set)?.content).toBe("MY DELTA");
    expect(injectedPersonalDelta(set)?.revisionId).toBe("prev-3");
    // A pinned revision from the selected set rides all the way to the member.
    expect(
      injectedSkillMembers(set).find((m) => m.skillId === "rec-1")?.revisionId,
    ).toBe("rev-9");
  });

  it("withholds the personal delta when the authorization resolved NO verified owner", async () => {
    let deltaAsked = false;
    const set = await resolveInjectedSkillSet(
      { kind: "agent-run", agentId: "a" },
      {
        ...ports,
        authorizeAgentRun: async () => ({ ok: true, runOwnerUserId: null }),
        resolvePersonalDelta: async () => {
          deltaAsked = true;
          return { skillId: "personal-1", content: "MY DELTA" };
        },
      },
    );
    expect(deltaAsked).toBe(false);
    expect(injectedPersonalDelta(set)).toBeNull();
  });

  it("an authorization refusal THROWS — it is never a silent empty set", async () => {
    await expect(
      resolveInjectedSkillSet(
        { kind: "agent-run", agentId: "a", runId: "r" },
        {
          ...ports,
          authorizeAgentRun: async () => ({
            ok: false,
            reason: "the intent claims a run this request did not prove ownership of",
          }),
        },
      ),
    ).rejects.toBeInstanceOf(SkillInjectionAuthorizationError);
  });

  it("a missing port names itself instead of resolving an empty set", async () => {
    await expect(
      resolveInjectedSkillSet({ kind: "agent-run", agentId: "a" }, {}),
    ).rejects.toBeInstanceOf(MissingInjectionPortError);
  });
});

describe("assistant intent", () => {
  const ports: InjectionResolverPorts = {
    authorizeAssistantSession: async ({ userId }) =>
      userId === "u1"
        ? { ok: true }
        : { ok: false, reason: "the intent names a user this session is not authenticated as" },
    resolveAssistantRequiredSkills: async () => [
      { skillId: "s1" },
      { skillId: "s2" },
    ],
  };

  it("derives the assistant's own required set at declared-dependency rank", async () => {
    const set = await resolveInjectedSkillSet(
      { kind: "assistant", agentId: "@cinatra-ai/chat", userId: "u1", sessionId: "sess" },
      ports,
    );
    expect(injectedCatalogSkillIds(set)).toEqual(["s1", "s2"]);
    expect(injectedSkillMembers(set).every((m) => m.rank === "declared_dependency")).toBe(true);
  });

  it("refuses a session bound to a different user", async () => {
    await expect(
      resolveInjectedSkillSet(
        { kind: "assistant", agentId: "@cinatra-ai/chat", userId: "someone-else", sessionId: "sess" },
        ports,
      ),
    ).rejects.toBeInstanceOf(SkillInjectionAuthorizationError);
  });

  it("a consolidated 5-skill bundle plus the personal delta fits the cap — nothing drops", async () => {
    // The post-consolidation Cinatra assistant shape (cinatra#2090 S3): exactly
    // five router bundles, so 5 + delta = 6 ≤ the hard cap of 8 and the
    // resolver never truncates an assistant skill. The app-side SIZE CONTRACT
    // (cinatra-assistant-config.test.ts pins the bundle at 5 slugs, at most 7)
    // is what keeps this arithmetic true in production.
    const bundle = [
      "chat-assistant-core",
      "chat-extension-authoring",
      "chat-automation-authoring",
      "company-research",
      "blog-content",
    ];
    const set = await resolveInjectedSkillSet(
      { kind: "assistant", agentId: "@cinatra-ai/chat", userId: "u1", sessionId: "sess" },
      {
        ...ports,
        resolveAssistantRequiredSkills: async () =>
          bundle.map((skillId) => ({ skillId })),
        resolvePersonalDelta: async () => ({
          skillId: "personal-1",
          content: "MY DELTA",
        }),
      },
    );
    // The bundle's own order is load-bearing (bundle[0] is the system skill)
    // and survives resolution untouched; the delta is inline, never catalog.
    expect(injectedCatalogSkillIds(set)).toEqual(bundle);
    expect(injectedSkillMembers(set)).toHaveLength(6);
    expect(injectedPersonalDelta(set)?.skillId).toBe("personal-1");
    expect(injectedSkillDrops(set)).toEqual([]);
    expect(describeInjectedSelection(set)).toBeNull();
  });

  it("caps an over-cap required bundle and records every drop", async () => {
    // NOT the Cinatra assistant (whose bundle is contract-pinned at 5 and can
    // never reach this branch) — an extension-declared assistant's
    // `skillBundle` is schema-unbounded, so the intent-level cap + drop
    // recording must hold for an arbitrary over-cap required set.
    const set = await resolveInjectedSkillSet(
      { kind: "assistant", agentId: "@vendor/kiosk", userId: "u1", sessionId: "sess" },
      {
        ...ports,
        resolveAssistantRequiredSkills: async () =>
          Array.from({ length: 11 }, (_, i) => ({ skillId: `kiosk-${i}` })),
      },
    );
    expect(injectedCatalogSkillIds(set)).toHaveLength(8);
    expect(injectedSkillDrops(set)).toHaveLength(3);
    // The bundle's own order is load-bearing: the FIRST eight survive.
    expect(injectedCatalogSkillIds(set)[0]).toBe("kiosk-0");
    expect(injectedSkillDrops(set)[0]!.skillId).toBe("kiosk-8");
    const summary = describeInjectedSelection(set);
    expect(summary?.droppedSkillIds).toHaveLength(3);
    expect(summary?.selectionReason).toContain("over_cap_required_dependencies");
  });
});

describe("explicit-purpose intents", () => {
  it("agent-creation-review delivers THAT LANE's methodology, not the candidate's", async () => {
    const asked: string[] = [];
    const set = await resolveInjectedSkillSet(
      {
        kind: "explicit-purpose",
        purpose: "agent-creation-review",
        subject: { candidateAgentRef: "candidate-agent", reviewerLane: "security-reviewer" },
      },
      {
        authorizeCreationReview: async () => ({ ok: true }),
        resolveLaneMethodologySkills: async ({ reviewerLane }) => {
          asked.push(reviewerLane);
          return [{ skillId: `${reviewerLane}:methodology` }];
        },
      },
    );
    expect(asked).toEqual(["security-reviewer"]);
    expect(injectedCatalogSkillIds(set)).toEqual(["security-reviewer:methodology"]);
  });

  it("agent-creation-review refuses a lane outside the closed enum", async () => {
    await expect(
      resolveInjectedSkillSet(
        {
          kind: "explicit-purpose",
          purpose: "agent-creation-review",
          subject: {
            candidateAgentRef: "candidate",
            // Deliberately outside the enum — a payload-shaped lane must refuse.
            reviewerLane: "attacker-lane",
          },
        } as unknown as InjectionIntent,
        {
          authorizeCreationReview: async () => ({ ok: true }),
          resolveLaneMethodologySkills: async () => [{ skillId: "nope" }],
        },
      ),
    ).rejects.toBeInstanceOf(SkillInjectionAuthorizationError);
  });

  it("auditor-run-skills reproduces the RECORDED run set", async () => {
    const set = await resolveInjectedSkillSet(
      {
        kind: "explicit-purpose",
        purpose: "auditor-run-skills",
        subject: { runId: "run-77" },
      },
      {
        authorizeAuditAuthority: async ({ runId }) =>
          runId === "run-77"
            ? { ok: true }
            : { ok: false, reason: "unverified run" },
        resolveRecordedRunSkills: async () => [
          { skillId: "recorded-a", revisionId: "rev-a" },
          { skillId: "recorded-b" },
        ],
      },
    );
    expect(injectedCatalogSkillIds(set)).toEqual(["recorded-a", "recorded-b"]);
  });

  it("agent-authoring derives the authoring surface's own set", async () => {
    const set = await resolveInjectedSkillSet(
      {
        kind: "explicit-purpose",
        purpose: "agent-authoring",
        subject: { agentSpecRef: "@cinatra-ai/author-agent" },
      },
      {
        authorizeAuthoringSurface: async () => ({ ok: true }),
        resolveAuthoringSkills: async () => [{ skillId: "authoring-skill" }],
      },
    );
    expect(injectedCatalogSkillIds(set)).toEqual(["authoring-skill"]);
  });
});

describe("attribution", () => {
  it("REFUSES personal-delta content that carries no skill id", async () => {
    await expect(
      resolveInjectedSkillSet(
        { kind: "agent-run", agentId: "a", runId: "r" },
        {
          authorizeAgentRun: OK,
          resolveRunRecommendedSkills: async () => [],
          resolvePersonalDelta: async () =>
            ({ skillId: "", content: "UNATTRIBUTED" }) as never,
        },
      ),
    ).rejects.toBeInstanceOf(UnattributedSkillContentError);
  });

  it("drops a catalog ref with a blank id rather than delivering it unnamed", async () => {
    const set = await resolveInjectedSkillSet(
      { kind: "agent-run", agentId: "a", runId: "r" },
      {
        authorizeAgentRun: OK,
        resolveRunRecommendedSkills: async () => [
          { skillId: "" },
          { skillId: "   " },
          { skillId: "real" },
        ],
      },
    );
    expect(injectedCatalogSkillIds(set)).toEqual(["real"]);
  });

  it("the runtime assertion rejects a member with an unknown delivery mode", () => {
    const forged = {
      intentKind: "agent-run",
      intentLabel: "agent-run",
      members: [{ skillId: "x", rank: "recommendation", deliveryMode: "smuggled", revisionId: null }],
      dropped: [],
    } as never;
    expect(() => assertAttributedInjectedSkillSet(forged)).toThrow(
      UnattributedSkillContentError,
    );
  });

  it("the runtime assertion rejects literal content on a non-inline member", () => {
    const forged = {
      intentKind: "agent-run",
      intentLabel: "agent-run",
      members: [
        {
          skillId: "x",
          rank: "recommendation",
          deliveryMode: "catalog",
          revisionId: null,
          content: "SMUGGLED BODY",
        },
      ],
      dropped: [],
    } as never;
    expect(() => assertAttributedInjectedSkillSet(forged)).toThrow(
      UnattributedSkillContentError,
    );
  });

  it("rejects an intent outside the closed union", async () => {
    await expect(
      resolveInjectedSkillSet({ kind: "whatever" } as unknown as InjectionIntent, {}),
    ).rejects.toBeInstanceOf(UnknownInjectionIntentError);
  });
});
