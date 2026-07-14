/**
 * Contract tests for the chat-shaped distillation entry (cinatra#1367):
 * createOrUpdateChatCaptureSkill.
 *
 * Unlike the run-autosave entry (createOrUpdateCustomSkillForAgent), this
 * entry must have NO installed-agent requirement and NO matched-skills
 * requirement — it targets ONE deterministic standalone personal skill per
 * user (the graceful-standalone design; the (user, agent)-scoped arm is
 * deferred to the #1037 assistant→agent target mapping).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  runResolvedDeterministicLlmTaskMock,
  resolveConfiguredLlmRuntimeMock,
  upsertSkillMock,
  listCustomSkillsMock,
} = vi.hoisted(() => {
  const defaultResponse = JSON.stringify({
    description: "Durable chat preferences",
    content: "---\ndisplay_name: Chat capture\n---\n## Preferences\n- Always answer in German.",
  });
  return {
    runResolvedDeterministicLlmTaskMock: vi.fn(async (_input?: unknown) => ({
      text: defaultResponse,
      rawBody: null,
    })),
    resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
      provider: "openai" as const,
      connection: { apiKey: "sk-test" },
    })),
    upsertSkillMock: vi.fn(async (input: { skillId?: string; name: string; content: string }) => ({
      id: input.skillId ?? "persisted-1",
      name: input.name,
      slug: "chat-capture",
      description: "d",
      content: input.content,
      packageId: "custom:personal-skills",
      packageName: "Custom Skills",
      packageSlug: "custom-skills",
      usedBy: [],
      isCustomSkill: true,
      level: "personal" as const,
    })),
    listCustomSkillsMock: vi.fn(async (_ownerUserId?: string) => [] as Array<Record<string, unknown>>),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedDeterministicLlmTask: runResolvedDeterministicLlmTaskMock,
  resolveConfiguredLlmRuntime: resolveConfiguredLlmRuntimeMock,
  parseStructuredJson: <T>(value: string) => JSON.parse(value) as T,
}));
vi.mock("@/lib/agents-store", () => ({
  readAgentsForSkillMatching: vi.fn(async () => []),
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));
vi.mock("./skills-registry", () => ({
  listInstalledSkills: vi.fn(async () => []),
  getInstalledSkillById: vi.fn(async () => null),
}));
vi.mock("./skills-store", () => ({
  upsertSkill: upsertSkillMock,
  listCustomSkills: listCustomSkillsMock,
  upsertCustomSkill: vi.fn(),
  getCustomSkillForAgent: vi.fn(async () => null),
  listCustomSkillsForAgent: vi.fn(async () => []),
  resolveCustomSkillOwner: vi.fn(),
  getAgentOwnership: vi.fn(),
}));
vi.mock("./constants", () => ({
  LOCAL_USER_ID: "local-test-user",
}));

import { buildChatCaptureSkillId, createOrUpdateChatCaptureSkill } from "./personal-skills";

const PROVENANCE = { threadId: "thread-1", turnId: "legacy:8:thread-1:m3" };

beforeEach(() => {
  vi.clearAllMocks();
  runResolvedDeterministicLlmTaskMock.mockResolvedValue({
    text: JSON.stringify({
      description: "Durable chat preferences",
      content: "---\ndisplay_name: Chat capture\n---\n## Preferences\n- Always answer in German.",
    }),
    rawBody: null,
  });
  resolveConfiguredLlmRuntimeMock.mockResolvedValue({
    provider: "openai" as const,
    connection: { apiKey: "sk-test" },
  });
  listCustomSkillsMock.mockResolvedValue([]);
});

describe("buildChatCaptureSkillId", () => {
  it("is deterministic per user and collision-safe across similar raw ids", () => {
    expect(buildChatCaptureSkillId("user-1")).toBe(buildChatCaptureSkillId("user-1"));
    // slugify-style collisions (case/punctuation) must NOT collide here.
    expect(buildChatCaptureSkillId("user_ABC")).not.toBe(buildChatCaptureSkillId("user-abc"));
    expect(buildChatCaptureSkillId("user-1")).toMatch(
      /^custom:personal-skills:chat-capture-[0-9a-f]{12}$/,
    );
  });
});

describe("createOrUpdateChatCaptureSkill", () => {
  it("creates the standalone skill with NO installed-agent and NO matched-skills requirement", async () => {
    const result = await createOrUpdateChatCaptureSkill({
      ownerUserId: "user-1",
      instruction: "Always answer in German.",
      provenance: PROVENANCE,
    });
    expect(result.id).toBe(buildChatCaptureSkillId("user-1"));
    expect(upsertSkillMock).toHaveBeenCalledTimes(1);
    const args = upsertSkillMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.type).toBe("personal");
    expect(args.ownerUserId).toBe("user-1");
    expect(args.skillId).toBe(buildChatCaptureSkillId("user-1"));
    expect(args.revisionSource).toBe("chat-capture");
    // No agent binding on the standalone slice.
    expect(args.agentId).toBeUndefined();
  });

  it("threads the instruction + provenance into the distiller prompt", async () => {
    await createOrUpdateChatCaptureSkill({
      ownerUserId: "user-1",
      instruction: "Never use emojis.",
      provenance: PROVENANCE,
    });
    const llmInput = runResolvedDeterministicLlmTaskMock.mock.calls[0][0] as {
      system: string;
      user: string;
    };
    expect(llmInput.user).toContain("Never use emojis.");
    expect(llmInput.user).toContain(PROVENANCE.threadId);
    expect(llmInput.user).toContain(PROVENANCE.turnId);
    expect(llmInput.system).toMatch(/\[REDACTED\] placeholders verbatim/);
    expect(llmInput.user).toContain("no existing skill yet");
  });

  it("amends in place: existing content is embedded and the same deterministic id is upserted", async () => {
    const skillId = buildChatCaptureSkillId("user-1");
    listCustomSkillsMock.mockResolvedValue([
      {
        id: skillId,
        ownerUserId: "user-1",
        name: "Chat capture — personal instructions",
        description: "existing",
        content: "## Preferences\n- Existing rule.",
      },
    ]);
    await createOrUpdateChatCaptureSkill({
      ownerUserId: "user-1",
      instruction: "Always answer in German.",
      provenance: PROVENANCE,
    });
    const llmInput = runResolvedDeterministicLlmTaskMock.mock.calls[0][0] as { user: string };
    expect(llmInput.user).toContain("Existing rule.");
    expect(llmInput.user).not.toContain("no existing skill yet");
    const args = upsertSkillMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.skillId).toBe(skillId);
  });

  it("refuses to amend a row owned by a different user (defense-in-depth)", async () => {
    const skillId = buildChatCaptureSkillId("user-1");
    listCustomSkillsMock.mockResolvedValue([
      { id: skillId, ownerUserId: "someone-else", name: "x", description: "d", content: "c" },
    ]);
    await expect(
      createOrUpdateChatCaptureSkill({
        ownerUserId: "user-1",
        instruction: "Always answer in German.",
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(/not owned by/);
    expect(upsertSkillMock).not.toHaveBeenCalled();
  });

  it("fails loudly when no LLM runtime is configured", async () => {
    resolveConfiguredLlmRuntimeMock.mockResolvedValue(null as never);
    await expect(
      createOrUpdateChatCaptureSkill({
        ownerUserId: "user-1",
        instruction: "Always answer in German.",
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(/No LLM provider configured/);
  });

  it("requires ownerUserId and instruction", async () => {
    await expect(
      createOrUpdateChatCaptureSkill({
        ownerUserId: "",
        instruction: "x",
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(/ownerUserId is required/);
    await expect(
      createOrUpdateChatCaptureSkill({
        ownerUserId: "user-1",
        instruction: "   ",
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow(/instruction is required/);
  });
});
