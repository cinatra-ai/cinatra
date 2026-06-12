/**
 * Standing-invariant regression coverage for Anthropic container skill delivery.
 *
 * The Anthropic function-tool / shell / read_skill skill path must NEVER be
 * reachable for skill delivery. This suite proves:
 *
 *  1. AnthropicContainerSkillDelivery emits exactly ONE container_skills tool
 *     and ZERO function/shell/read_skill/bash tools when skills are synced.
 *  2. An unsynced catalog skill makes deliver() reject with
 *     AnthropicSkillNotSyncedError — a configuration error, never a silent
 *     function-tool fallback.
 *  3. > 8 mapped refs reject with AnthropicSkillCapError.
 *  4. translateTools over a container_skills tool emits ONLY the
 *     code_execution_20250825 entry — no input_schema function tool.
 *  5. The provider boundary guard rejects a skill-bearing shell tool and a
 *     read_skill/bash function tool with AnthropicFunctionToolSkillError
 *     (covers callers that build tools outside the seam).
 *
 * The skills client is mocked so resolveSkillSummaries works for the cue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { installedGetMock } = vi.hoisted(() => ({
  installedGetMock: vi.fn(),
}));

vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { get: installedGetMock },
  }),
}));

vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: async () => "",
}));

// The openai `llm-provider-surface` GATED shellTools member (cinatra#151
// Stage 2): the settings reader + docker executor resolve via the capability.
const { openaiShellSurface } = vi.hoisted(() => ({
  openaiShellSurface: {
    providerId: "openai",
    shellTools: {
      readSettings: () => null,
      runCommandInDocker: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    },
  },
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn((providerId: string) =>
    providerId === "openai" ? openaiShellSurface : null,
  ),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    if (providerId === "openai") return openaiShellSurface;
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => [openaiShellSurface]),
}));

import { AnthropicContainerSkillDelivery } from "../tools/skill-delivery";
import {
  setAnthropicSkillSyncMap,
  resetAnthropicSkillSyncMap,
  type AnthropicSyncedSkillRef,
} from "../tools/anthropic-skill-sync-map";
import {
  AnthropicSkillNotSyncedError,
  AnthropicSkillCapError,
} from "../errors";
import type { LlmContainerSkillsTool, LlmShellTool, LlmFunctionTool } from "../types";

beforeEach(() => {
  installedGetMock.mockReset();
  installedGetMock.mockImplementation((id: string) =>
    Promise.resolve({ id, name: id, slug: id, description: `desc ${id}` }),
  );
});

afterEach(() => {
  resetAnthropicSkillSyncMap();
});

function syncMapReturning(refs: Record<string, AnthropicSyncedSkillRef | null>) {
  setAnthropicSkillSyncMap({
    resolve: async (catalogSkillId: string) => refs[catalogSkillId] ?? null,
  });
}

describe("AnthropicContainerSkillDelivery — container.skills only", () => {
  it("emits exactly one container_skills tool, zero function/shell tools", async () => {
    syncMapReturning({
      "@a:one": { skillId: "skill_111", version: "v1", catalogSkillId: "@a:one" },
      "@b:two": { skillId: "skill_222", version: "v2", catalogSkillId: "@b:two" },
    });

    const result = await new AnthropicContainerSkillDelivery().deliver({
      skillIds: ["@a:one", "@b:two"],
    });

    expect(result.tools).toHaveLength(1);
    const tool = result.tools[0] as LlmContainerSkillsTool;
    expect(tool.type).toBe("container_skills");
    expect(tool.skills).toEqual([
      { skillId: "skill_111", version: "v1", catalogSkillId: "@a:one" },
      { skillId: "skill_222", version: "v2", catalogSkillId: "@b:two" },
    ]);

    // ZERO function / shell / read_skill / bash tools.
    for (const t of result.tools) {
      const type = "type" in t ? t.type : "function";
      expect(type).not.toBe("shell");
      expect(type).not.toBe("function");
      expect((t as { name?: string }).name).not.toBe("read_skill");
      expect((t as { name?: string }).name).not.toBe("bash");
    }

    // The cue must NOT tell the model to use the read_skill tool.
    expect(result.systemContext).not.toMatch(/read_skill/);
    expect(result.systemContext).toMatch(/@a:one/);
  });

  it("dedupes refs that map to the same Anthropic skill id", async () => {
    syncMapReturning({
      "@a:one": { skillId: "skill_dup", version: "v1", catalogSkillId: "@a:one" },
      "@b:two": { skillId: "skill_dup", version: "v1", catalogSkillId: "@b:two" },
    });
    const result = await new AnthropicContainerSkillDelivery().deliver({
      skillIds: ["@a:one", "@b:two"],
    });
    const tool = result.tools[0] as LlmContainerSkillsTool;
    expect(tool.skills).toHaveLength(1);
    expect(tool.skills[0].skillId).toBe("skill_dup");
  });

  it("empty skillIds → no tools, no context (no throw)", async () => {
    const result = await new AnthropicContainerSkillDelivery().deliver({ skillIds: [] });
    expect(result.tools).toEqual([]);
    expect(result.systemContext).toBe("");
  });
});

describe("AnthropicContainerSkillDelivery — fail-loud, never function-tool fallback", () => {
  it("rejects with AnthropicSkillNotSyncedError for an unsynced skill", async () => {
    syncMapReturning({
      "@a:ok": { skillId: "skill_ok", version: "v1", catalogSkillId: "@a:ok" },
      "@b:missing": null,
    });
    await expect(
      new AnthropicContainerSkillDelivery().deliver({
        skillIds: ["@a:ok", "@b:missing"],
      }),
    ).rejects.toBeInstanceOf(AnthropicSkillNotSyncedError);
  });

  it("default (stub) sync map → every id unsynced → fail loud (no fallback)", async () => {
    // No setAnthropicSkillSyncMap → default UnsyncedAnthropicSkillMap.
    await expect(
      new AnthropicContainerSkillDelivery().deliver({ skillIds: ["@a:x"] }),
    ).rejects.toBeInstanceOf(AnthropicSkillNotSyncedError);
  });

  it("rejects with AnthropicSkillCapError when > 8 refs map", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `@s:${i}`);
    syncMapReturning(
      Object.fromEntries(
        ids.map((id, i) => [
          id,
          { skillId: `skill_${i}`, version: "v1", catalogSkillId: id },
        ]),
      ),
    );
    await expect(
      new AnthropicContainerSkillDelivery().deliver({ skillIds: ids }),
    ).rejects.toBeInstanceOf(AnthropicSkillCapError);
  });
});

describe("Anthropic provider boundary — structural enforcement", () => {
  it("translateTools(container_skills) emits only code_execution, no function tool", async () => {
    const {
      isContainerSkillsTool,
      buildContainerSkillsParam,
      CONTAINER_SKILLS_CODE_EXECUTION_ENTRY,
    } = await import("../providers/anthropic-skill-tools");
    const containerTool: LlmContainerSkillsTool = {
      type: "container_skills",
      skills: [{ skillId: "skill_1", version: "v1", catalogSkillId: "@a:1" }],
    };
    expect(isContainerSkillsTool(containerTool)).toBe(true);
    // The ONLY tools[] entry is code_execution — no input_schema function tool.
    expect(CONTAINER_SKILLS_CODE_EXECUTION_ENTRY.type).toBe("code_execution_20250825");
    expect(
      (CONTAINER_SKILLS_CODE_EXECUTION_ENTRY as { input_schema?: unknown }).input_schema,
    ).toBeUndefined();
    // Skill refs go in the top-level container param, NOT tools.
    const containerParam = buildContainerSkillsParam([containerTool]);
    expect(containerParam).toEqual({
      skills: [{ type: "custom", skill_id: "skill_1", version: "v1" }],
    });
  });

  it("buildContainerSkillsParam fails loud (cap) for a raw >8-skill tool from a direct caller", async () => {
    const { buildContainerSkillsParam } = await import(
      "../providers/anthropic-skill-tools"
    );
    const { AnthropicSkillCapError } = await import("../errors");
    const tool: LlmContainerSkillsTool = {
      type: "container_skills",
      skills: Array.from({ length: 9 }, (_, i) => ({
        skillId: `skill_${i}`,
        version: "v1",
        catalogSkillId: `@s:${i}`,
      })),
    };
    expect(() => buildContainerSkillsParam([tool])).toThrow(AnthropicSkillCapError);
  });

  it("assertNoFunctionToolSkillDelivery throws on a skill-bearing shell tool", async () => {
    const { assertNoFunctionToolSkillDelivery } = await import(
      "../providers/anthropic-skill-tools"
    );
    const shellTool: LlmShellTool = {
      type: "shell",
      skills: [{ name: "s", description: "d", path: "/skills/s" }],
      execute: async () => [],
    };
    expect(() => assertNoFunctionToolSkillDelivery([shellTool])).toThrow(
      /forbidden standing invariant/,
    );
  });

  it("assertNoFunctionToolSkillDelivery throws on read_skill / bash function tools", async () => {
    const { assertNoFunctionToolSkillDelivery } = await import(
      "../providers/anthropic-skill-tools"
    );
    const readSkill: LlmFunctionTool = {
      name: "read_skill",
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async () => ({}),
    };
    const bash: LlmFunctionTool = {
      name: "bash",
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async () => ({}),
    };
    expect(() => assertNoFunctionToolSkillDelivery([readSkill])).toThrow();
    expect(() => assertNoFunctionToolSkillDelivery([bash])).toThrow();
  });

  it("assertNoFunctionToolSkillDelivery allows non-skill tools through", async () => {
    const { assertNoFunctionToolSkillDelivery } = await import(
      "../providers/anthropic-skill-tools"
    );
    const normalFn: LlmFunctionTool = {
      name: "campaigns_list",
      description: "list campaigns",
      parameters: { type: "object", properties: {} },
      execute: async () => ({}),
    };
    const emptyShell: LlmShellTool = {
      type: "shell",
      skills: [],
      execute: async () => [],
    };
    expect(() =>
      assertNoFunctionToolSkillDelivery([normalFn, emptyShell]),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Deterministic rank-and-truncate-to-8 (general path).
//
// The general selectable Anthropic path may resolve >8 skills (the recommend
// agent is uncapped). Over-cap ⇒ DETERMINISTIC rank-and-truncate-to-8 with
// VISIBLE droppedSkillIds. The CREATION path (fixed pre-synced allowlist;
// selectionMode unset OR "creation") stays a HARD AnthropicSkillCapError —
// never silently truncated. Truncation can NEVER leak a skill into a
// function/shell tool (standing invariant).
// ---------------------------------------------------------------------------
describe("rank-and-truncate-to-8 (general selectable path)", () => {
  function nineSyncedRefs() {
    // Ten ids in a deliberately NON-sorted input order so a correct
    // implementation (rank by first-seen input position) differs from a naive
    // lexicographic sort — proves the tier ordering is honoured.
    const ids = [
      "@z:agent-self", // tier-1 (position 0)
      "@m:rec-1",
      "@a:rec-2",
      "@y:rec-3",
      "@b:rec-4",
      "@x:rec-5",
      "@c:rec-6",
      "@w:rec-7",
      "@d:sys-1", // position 8 — last kept (top-8)
      "@e:sys-2", // position 9 — DROPPED (over cap)
    ];
    syncMapReturning(
      Object.fromEntries(
        ids.map((id, i) => [
          id,
          { skillId: `skill_${i}`, version: "v1", catalogSkillId: id },
        ]),
      ),
    );
    return ids;
  }

  it("general mode + >8 ⇒ deterministic top-8 by input order + visible droppedSkillIds", async () => {
    const ids = nineSyncedRefs();
    const result = await new AnthropicContainerSkillDelivery().deliver({
      skillIds: ids,
      selectionMode: "general",
    });

    const tool = result.tools[0] as LlmContainerSkillsTool;
    expect(tool.type).toBe("container_skills");
    expect(tool.skills).toHaveLength(8);
    // Top-8 = the first 8 input positions (the resolved-order tier ranking),
    // NOT a lexicographic re-sort.
    expect(tool.skills.map((s) => s.catalogSkillId)).toEqual(ids.slice(0, 8));
    // The 9th + 10th input positions are dropped, in stable (input) order.
    expect(result.droppedSkillIds).toEqual(["@d:sys-1", "@e:sys-2"]);
    expect(result.selectionReason).toMatch(/at most 8/);
    expect(result.selectionReason).toMatch(/@e:sys-2/);
    // The cue lists ONLY the selected skills — never a dropped one.
    expect(result.systemContext).not.toMatch(/@e:sys-2/);
    // Standing invariant: zero function/shell tools even under truncation.
    for (const t of result.tools) {
      const type = "type" in t ? t.type : "function";
      expect(type).not.toBe("shell");
      expect(type).not.toBe("function");
    }
  });

  it("is deterministic — identical inputs ⇒ byte-identical selection (run twice)", async () => {
    const ids = nineSyncedRefs();
    const a = await new AnthropicContainerSkillDelivery().deliver({
      skillIds: ids,
      selectionMode: "general",
    });
    const b = await new AnthropicContainerSkillDelivery().deliver({
      skillIds: [...ids],
      selectionMode: "general",
    });
    expect(a.tools).toEqual(b.tools);
    expect(a.droppedSkillIds).toEqual(b.droppedSkillIds);
    expect(a.selectionReason).toEqual(b.selectionReason);
  });

  it("creation mode + >8 ⇒ HARD AnthropicSkillCapError (fixed allowlist never truncated)", async () => {
    const ids = nineSyncedRefs();
    await expect(
      new AnthropicContainerSkillDelivery().deliver({
        skillIds: ids,
        selectionMode: "creation",
      }),
    ).rejects.toBeInstanceOf(AnthropicSkillCapError);
  });

  it("UNSET mode + >8 ⇒ HARD AnthropicSkillCapError (default == creation)", async () => {
    const ids = nineSyncedRefs();
    await expect(
      new AnthropicContainerSkillDelivery().deliver({ skillIds: ids }),
    ).rejects.toBeInstanceOf(AnthropicSkillCapError);
  });

  it("general mode + ≤8 ⇒ all delivered, NO droppedSkillIds / selectionReason", async () => {
    syncMapReturning({
      "@a:1": { skillId: "skill_1", version: "v1", catalogSkillId: "@a:1" },
      "@b:2": { skillId: "skill_2", version: "v1", catalogSkillId: "@b:2" },
    });
    const result = await new AnthropicContainerSkillDelivery().deliver({
      skillIds: ["@a:1", "@b:2"],
      selectionMode: "general",
    });
    expect((result.tools[0] as LlmContainerSkillsTool).skills).toHaveLength(2);
    expect(result.droppedSkillIds).toBeUndefined();
    expect(result.selectionReason).toBeUndefined();
  });

  it("general mode + >8 with an UNSYNCED id ⇒ AnthropicSkillNotSyncedError (config error BEFORE truncation; never hidden by a drop)", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `@s:${i}`);
    syncMapReturning(
      Object.fromEntries(
        ids.map((id, i) =>
          i === 4
            ? [id, null] // one unsynced in the middle
            : [id, { skillId: `skill_${i}`, version: "v1", catalogSkillId: id }],
        ),
      ),
    );
    await expect(
      new AnthropicContainerSkillDelivery().deliver({
        skillIds: ids,
        selectionMode: "general",
      }),
    ).rejects.toBeInstanceOf(AnthropicSkillNotSyncedError);
  });
});
