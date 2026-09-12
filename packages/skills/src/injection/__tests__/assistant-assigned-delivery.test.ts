/**
 * THE ASSISTANT DELIVERY SEAM (cinatra#2815 S3, epic #2812).
 *
 * Acceptance item: "Assistant runs deliver assigned skills (fixture); the S1
 * assistant-target-admission suite remains green."
 *
 * What this suite pins, at the injection contract itself: an assistant turn
 * delivers its SCOPED assigned skills through the same resolver, at the same
 * rank the agent-run path's assignments ride, under the SAME unchanged ceiling
 * of 8 — and that the seam introduces no context-artifact path, because
 * assistants take no context artifacts.
 */
import { describe, it, expect, vi } from "vitest";

import {
  INJECTED_SKILL_CAP,
  injectedCatalogSkillIds,
  injectedSkillMembers,
  injectedSkillDrops,
  resolveInjectedSkillSet,
} from "../index";
import type { InjectionResolverPorts } from "../ports";

const AGENT = "@cinatra-ai/chat";
const SESSION = "thread_abc";

const INTENT = {
  kind: "assistant",
  agentId: AGENT,
  userId: "u1",
  sessionId: SESSION,
} as const;

const basePorts: InjectionResolverPorts = {
  authorizeAssistantSession: async ({ userId }) =>
    userId === "u1" ? { ok: true } : { ok: false, reason: "not this session's user" },
  resolveAssistantRequiredSkills: async () => [{ skillId: "required-1" }],
};

describe("an assistant turn delivers its assigned skills", () => {
  it("delivers the assigned set, at recommendation rank, after the required bundle", async () => {
    const set = await resolveInjectedSkillSet(INTENT, {
      ...basePorts,
      resolveAssistantAssignedSkills: async () => [
        { skillId: "assigned-1" },
        { skillId: "assigned-2" },
      ],
    });
    expect(injectedCatalogSkillIds(set)).toEqual([
      "required-1",
      "assigned-1",
      "assigned-2",
    ]);
    const byId = new Map(injectedSkillMembers(set).map((m) => [m.skillId, m.rank]));
    expect(byId.get("required-1")).toBe("declared_dependency");
    expect(byId.get("assigned-1")).toBe("recommendation");
    expect(byId.get("assigned-2")).toBe("recommendation");
  });

  it("is handed the SESSION the surface vetted — never a mutable column", async () => {
    const seen: Array<{ agentId: string; sessionId: string }> = [];
    await resolveInjectedSkillSet(INTENT, {
      ...basePorts,
      resolveAssistantAssignedSkills: async (input) => {
        seen.push({ agentId: input.agentId, sessionId: input.sessionId });
        return [];
      },
    });
    expect(seen).toEqual([{ agentId: AGENT, sessionId: SESSION }]);
  });

  it("a surface that supplies no assignment port delivers none — never a wider set", async () => {
    const set = await resolveInjectedSkillSet(INTENT, basePorts);
    expect(injectedCatalogSkillIds(set)).toEqual(["required-1"]);
  });

  it("an assignment that is ALSO the required bundle is delivered ONCE, at the higher rank", async () => {
    const set = await resolveInjectedSkillSet(INTENT, {
      ...basePorts,
      resolveAssistantAssignedSkills: async () => [{ skillId: "required-1" }],
    });
    expect(injectedCatalogSkillIds(set)).toEqual(["required-1"]);
    expect(injectedSkillMembers(set)[0].rank).toBe("declared_dependency");
  });
});

describe("the injection ceiling is UNCHANGED by the seam", () => {
  it("stays 8", () => {
    expect(INJECTED_SKILL_CAP).toBe(8);
  });

  it("assignments never displace the assistant's required bundle at the cap", async () => {
    const required = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ skillId: `required-${n}` }));
    const set = await resolveInjectedSkillSet(INTENT, {
      ...basePorts,
      resolveAssistantRequiredSkills: async () => required,
      resolveAssistantAssignedSkills: async () => [{ skillId: "assigned-1" }],
    });
    expect(injectedCatalogSkillIds(set)).toEqual(required.map((r) => r.skillId));
    expect(injectedSkillDrops(set).map((d) => d.skillId)).toEqual(["assigned-1"]);
  });

  it("the seam cannot deliver more than the ceiling, whatever the port returns", async () => {
    const set = await resolveInjectedSkillSet(INTENT, {
      ...basePorts,
      resolveAssistantRequiredSkills: async () => [],
      resolveAssistantAssignedSkills: async () =>
        Array.from({ length: 12 }, (_, i) => ({ skillId: `assigned-${i}` })),
    });
    expect(injectedCatalogSkillIds(set)).toHaveLength(INJECTED_SKILL_CAP);
  });
});

describe("assistants take no context artifacts", () => {
  it("the assistant branch consults exactly its own ports — no context path is exercised", async () => {
    const calls: string[] = [];
    const track = <T,>(name: string, value: T) =>
      vi.fn(async () => {
        calls.push(name);
        return value;
      });
    const ports = {
      authorizeAssistantSession: track("authorizeAssistantSession", {
        ok: true,
      } as const),
      resolveAssistantRequiredSkills: track("resolveAssistantRequiredSkills", [
        { skillId: "required-1" },
      ]),
      resolveAssistantAssignedSkills: track("resolveAssistantAssignedSkills", [
        { skillId: "assigned-1" },
      ]),
      resolveDeclaredDependencySkills: track("resolveDeclaredDependencySkills", []),
      resolvePersonalDelta: track("resolvePersonalDelta", null),
      // Agent-run-only ports. An assistant turn must never reach them.
      authorizeAgentRun: track("authorizeAgentRun", { ok: true } as const),
      resolveRunRecommendedSkills: track("resolveRunRecommendedSkills", []),
      resolveRecordedRunSkills: track("resolveRecordedRunSkills", []),
    } as unknown as InjectionResolverPorts;

    await resolveInjectedSkillSet(INTENT, ports);

    expect(calls.sort()).toEqual([
      "authorizeAssistantSession",
      "resolveAssistantAssignedSkills",
      "resolveAssistantRequiredSkills",
      "resolveDeclaredDependencySkills",
      "resolvePersonalDelta",
    ]);
    // The contract carries NO context port at all — there is no seam for a
    // context artifact to reach an assistant through, by construction.
    expect(Object.keys(ports).some((k) => /context|artifact/i.test(k))).toBe(false);
  });

  it("a refused session delivers nothing and never reaches the assignment port", async () => {
    const assigned = vi.fn(async () => [{ skillId: "assigned-1" }]);
    await expect(
      resolveInjectedSkillSet(
        { ...INTENT, userId: "someone-else" },
        { ...basePorts, resolveAssistantAssignedSkills: assigned },
      ),
    ).rejects.toThrow();
    expect(assigned).not.toHaveBeenCalled();
  });
});
