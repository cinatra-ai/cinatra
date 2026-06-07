import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// registerExtensionSkill contract.
//
// The skills-layer invariant: a package-bundled system skill (the chat
// assistant) MUST register through `upsertSkill` and come back with a
// real `sourcePath`. Without `sourcePath`, `buildSkillTools` falls back
// to the disallowed `read_skill` function tool instead of the shell
// tool. This pins: (1) happy path returns {id, sourcePath};
// (2) missing SKILL.md throws; (3) an upsert that yields NO sourcePath
// throws (the invariant violation must fail loud, never silently
// degrade to read_skill).

vi.mock("server-only", () => ({}));

const { upsertSkillMock } = vi.hoisted(() => ({
  upsertSkillMock: vi.fn(),
}));

vi.mock("./skills-store", () => ({
  upsertSkill: upsertSkillMock,
  readSkillsStorageConfig: vi.fn(() => ({ dataPath: "data/skills" })),
  syncInstalledSkillsToDatabase: vi.fn(async () => ({ skillPackages: [], skills: [] })),
}));

vi.mock("./skills-registry", () => ({
  parseFrontmatter: (content: string) => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) return { attributes: {} as Record<string, string>, body: content };
    const attributes: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      attributes[line.slice(0, idx).trim()] = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
    return { attributes, body: content.slice(match[0].length) };
  },
}));

import { registerExtensionSkill } from "./register-extension-skill";

const SKILL_MD = `---
name: chat-assistant
description: Core system prompt for the Cinatra chat assistant.
---

You are the Cinatra AI assistant.
`;

describe("registerExtensionSkill — skills-layer invariant", () => {
  let dir: string;
  let skillMdPath: string;

  beforeEach(async () => {
    upsertSkillMock.mockReset();
    dir = await mkdtemp(path.join(os.tmpdir(), "pss-"));
    skillMdPath = path.join(dir, "SKILL.md");
    await writeFile(skillMdPath, SKILL_MD, "utf8");
  });

  it("registers via upsertSkill (type:workspace) and returns {id, sourcePath}", async () => {
    upsertSkillMock.mockResolvedValue({
      id: "@cinatra-ai/chat:chat-assistant",
      sourcePath: "/data/skills/system/chat/chat-assistant/SKILL.md",
    });

    const out = await registerExtensionSkill({
      skillId: "@cinatra-ai/chat:chat-assistant",
      packageName: "@cinatra-ai/chat",
      skillMdPath,
    });

    expect(out.id).toBe("@cinatra-ai/chat:chat-assistant");
    expect(out.sourcePath).toBe("/data/skills/system/chat/chat-assistant/SKILL.md");
    const call = upsertSkillMock.mock.calls[0][0];
    expect(call.type).toBe("workspace");
    expect(call.packageName).toBe("@cinatra-ai/chat");
    expect(call.skillId).toBe("@cinatra-ai/chat:chat-assistant");
    expect(call.name).toBe("chat-assistant");
    expect(call.description).toContain("Cinatra chat assistant");
    expect(call.content).toContain("You are the Cinatra AI assistant.");

    await rm(dir, { recursive: true, force: true });
  });

  it("throws when the SKILL.md file does not exist", async () => {
    await expect(
      registerExtensionSkill({
        skillId: "@cinatra-ai/chat:chat-assistant",
        packageName: "@cinatra-ai/chat",
        skillMdPath: path.join(dir, "does-not-exist.md"),
      }),
    ).rejects.toThrow(/SKILL\.md not found/);
    expect(upsertSkillMock).not.toHaveBeenCalled();
  });

  it("throws (fails loud) when upsertSkill returns no sourcePath — invariant violation", async () => {
    upsertSkillMock.mockResolvedValue({ id: "@cinatra-ai/chat:chat-assistant" });

    await expect(
      registerExtensionSkill({
        skillId: "@cinatra-ai/chat:chat-assistant",
        packageName: "@cinatra-ai/chat",
        skillMdPath,
      }),
    ).rejects.toThrow(/without a sourcePath/);

    await rm(dir, { recursive: true, force: true });
  });
});
