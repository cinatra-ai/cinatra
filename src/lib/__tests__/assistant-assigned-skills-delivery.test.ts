/**
 * THE ASSISTANT DELIVERY SEAM, host half (cinatra#2815 S3, epic #2812).
 *
 * The resolver's half of this acceptance item is pinned in
 * `packages/skills/src/injection/__tests__/assistant-assigned-delivery.test.ts`.
 * This suite pins the host half: that the assistant's scope comes from the
 * THREAD's immutable snapshot, that it is handed to the SAME assigned-skill
 * tier the agent path uses (chain, effective-5 cap and revalidation included),
 * and that every unprovable arm yields the empty set while the turn proceeds.
 *
 * The runtime CALL SITE is asserted against the module source, the way
 * `assistant-runtime/__tests__/chat-catalog-seeds-from-plan.test.ts` already
 * does for that module: a behavioural test of `runAssistantTurn` needs the
 * whole provider/MCP graph and a database, so it would be a test of a mock —
 * while the property that matters here is that the seam is WIRED at all.
 */
import { readFileSync } from "node:fs";

import { describe, it, expect, beforeEach, vi } from "vitest";

import { resolveAssistantAssignedSkillIds } from "../assistant-assigned-skills-delivery";
import { buildAssignmentScopeSnapshot } from "../../../packages/agents/src/assignment-scope-snapshot";

const AGENT = "@cinatra-ai/chat";
const THREAD = "thread_abc";
const ORG = "org_1";

const SNAPSHOT = buildAssignmentScopeSnapshot({
  orgId: ORG,
  projectId: "proj_1",
  teamIds: ["team_a"],
  originatingHumanUserId: "user_1",
});

/** A tier double that records what scope it was asked with. */
function tierSpy(skillIds: string[] = []) {
  const seen: Array<{ agentId: string; runScope: unknown }> = [];
  const resolveTier = (async (agentId: string, _population: unknown, deps: any) => {
    seen.push({ agentId, runScope: deps?.runScope });
    return {
      skillIds,
      agentPackageName: agentId,
      withheld: [],
      degraded: null,
      scopeUsedFallback: false,
      droppedOverEffectiveCap: [],
    };
  }) as never;
  return { seen, resolveTier };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the assistant's scope comes from the THREAD's immutable snapshot", () => {
  it("hands the thread's frozen payload and its organization to the shared tier", async () => {
    const { seen, resolveTier } = tierSpy(["assigned-1"]);
    const out = await resolveAssistantAssignedSkillIds(
      { agentId: AGENT, sessionId: THREAD },
      {
        readThreadScope: () => ({ snapshot: SNAPSHOT, orgId: ORG }),
        resolveTier,
      },
    );
    expect(out).toEqual(["assigned-1"]);
    expect(seen).toEqual([
      { agentId: AGENT, runScope: { snapshot: SNAPSHOT, durableOrgId: ORG } },
    ]);
  });

  it("reads the scope for the SESSION the surface vetted, and nothing else", async () => {
    const asked: string[] = [];
    const { resolveTier } = tierSpy();
    await resolveAssistantAssignedSkillIds(
      { agentId: AGENT, sessionId: THREAD },
      {
        readThreadScope: (threadId) => {
          asked.push(threadId);
          return null;
        },
        resolveTier,
      },
    );
    expect(asked).toEqual([THREAD]);
  });

  it("a session that names no thread (a per-turn binding) carries NO scope", async () => {
    const { seen, resolveTier } = tierSpy();
    await resolveAssistantAssignedSkillIds(
      { agentId: AGENT, sessionId: "assistant-turn:1234" },
      { readThreadScope: () => null, resolveTier },
    );
    expect(seen[0].runScope).toEqual({ snapshot: undefined, durableOrgId: null });
  });

  it("a thread row with no snapshot still floors on the thread's own organization", async () => {
    const { seen, resolveTier } = tierSpy();
    await resolveAssistantAssignedSkillIds(
      { agentId: AGENT, sessionId: THREAD },
      { readThreadScope: () => ({ snapshot: null, orgId: ORG }), resolveTier },
    );
    expect(seen[0].runScope).toEqual({ snapshot: undefined, durableOrgId: ORG });
  });
});

describe("fail-closed, never fatal", () => {
  it("an empty agent or session resolves to nothing without reading a thread", async () => {
    const read = vi.fn(() => null);
    const { resolveTier } = tierSpy(["x"]);
    expect(
      await resolveAssistantAssignedSkillIds(
        { agentId: "", sessionId: THREAD },
        { readThreadScope: read, resolveTier },
      ),
    ).toEqual([]);
    expect(
      await resolveAssistantAssignedSkillIds(
        { agentId: AGENT, sessionId: "  " },
        { readThreadScope: read, resolveTier },
      ),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("the tier's own degraded arm surfaces as the empty set, not as a throw", async () => {
    const out = await resolveAssistantAssignedSkillIds(
      { agentId: AGENT, sessionId: THREAD },
      {
        readThreadScope: () => ({ snapshot: SNAPSHOT, orgId: ORG }),
        resolveTier: (async () => ({
          skillIds: [],
          agentPackageName: AGENT,
          withheld: [],
          degraded: "assignment-read-failed",
          scopeUsedFallback: false,
          droppedOverEffectiveCap: [],
        })) as never,
      },
    );
    expect(out).toEqual([]);
  });
});

describe("the seam is WIRED into the assistant runtime", () => {
  const runtimeSource = readFileSync(
    new URL("../assistant-runtime/runtime.ts", import.meta.url),
    "utf8",
  );

  it("the ports factory exposes the assistant assignment port", () => {
    expect(runtimeSource).toContain("async resolveAssistantAssignedSkills(intent)");
  });

  it("the turn supplies the port from THIS module, keyed on the session", () => {
    expect(runtimeSource).toContain("resolveAssignedSkillIdsForSession");
    expect(runtimeSource).toContain("@/lib/assistant-assigned-skills-delivery");
  });

  it("the port refuses a session the surface did not vet", () => {
    expect(runtimeSource).toContain(
      "if (!intent.sessionId || intent.sessionId !== input.sessionId) return [];",
    );
  });
});
