import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
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

import { registerExtensionSkill, mirrorSkillBundleAssets } from "./register-extension-skill";

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

// Delivered-surface completeness (cinatra#2090 S3 fold): registration must
// mirror the bundle's references/** beside the stored SKILL.md, because the
// shell tool serves one-hop reference reads from the CANONICAL dir — a router
// registered without its references promises paths that do not resolve.
describe("registerExtensionSkill — bundle-asset mirroring (references/**)", () => {
  let srcDir: string;
  let storeDir: string;

  beforeEach(async () => {
    upsertSkillMock.mockReset();
    srcDir = await mkdtemp(path.join(os.tmpdir(), "pss-src-"));
    storeDir = await mkdtemp(path.join(os.tmpdir(), "pss-store-"));
    await writeFile(path.join(srcDir, "SKILL.md"), SKILL_MD, "utf8");
    await mkdir(path.join(srcDir, "references", "deep"), { recursive: true });
    await writeFile(path.join(srcDir, "references", "one.md"), "ref one\n", "utf8");
    await writeFile(path.join(srcDir, "references", "deep", "two.md"), "ref two\n", "utf8");
  });

  it("copies references/** (recursively) into the canonical dir; SKILL.md stays upsertSkill-owned", async () => {
    const storedSkillMd = path.join(storeDir, "SKILL.md");
    await writeFile(storedSkillMd, "CANONICAL BODY (written by upsertSkill)\n", "utf8");
    upsertSkillMock.mockResolvedValue({
      id: "@cinatra-ai/chat:chat-assistant",
      sourcePath: storedSkillMd,
    });

    await registerExtensionSkill({
      skillId: "@cinatra-ai/chat:chat-assistant",
      packageName: "@cinatra-ai/chat",
      skillMdPath: path.join(srcDir, "SKILL.md"),
    });

    expect(await readFile(path.join(storeDir, "references", "one.md"), "utf8")).toBe("ref one\n");
    expect(await readFile(path.join(storeDir, "references", "deep", "two.md"), "utf8")).toBe("ref two\n");
    // The canonical SKILL.md is upsertSkill's write — the mirror never overwrites it.
    expect(await readFile(storedSkillMd, "utf8")).toBe("CANONICAL BODY (written by upsertSkill)\n");

    await rm(srcDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  });

  it("mirrorSkillBundleAssets skips symlinks fail-closed (nothing outside the bundle is pulled in)", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "pss-outside-"));
    await writeFile(path.join(outside, "secret.md"), "outside\n", "utf8");
    await symlink(path.join(outside, "secret.md"), path.join(srcDir, "references", "link.md"));
    await symlink(outside, path.join(srcDir, "linked-dir"));

    await mirrorSkillBundleAssets(srcDir, storeDir);

    expect(existsSync(path.join(storeDir, "references", "one.md"))).toBe(true);
    expect(existsSync(path.join(storeDir, "references", "link.md"))).toBe(false);
    expect(existsSync(path.join(storeDir, "linked-dir"))).toBe(false);

    await rm(srcDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("mirrorSkillBundleAssets refuses to write through a pre-existing symlink leaf in the storage dir", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "pss-outside2-"));
    await mkdir(path.join(storeDir, "references"), { recursive: true });
    await symlink(path.join(outside, "target.md"), path.join(storeDir, "references", "one.md"));

    await expect(mirrorSkillBundleAssets(srcDir, storeDir)).rejects.toThrow(/symlink leaf/);
    expect(existsSync(path.join(outside, "target.md"))).toBe(false);

    await rm(srcDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("is a no-op when the source bundle dir has no extra assets (single SKILL.md bundles)", async () => {
    const bare = await mkdtemp(path.join(os.tmpdir(), "pss-bare-"));
    await writeFile(path.join(bare, "SKILL.md"), SKILL_MD, "utf8");
    await mirrorSkillBundleAssets(bare, storeDir);
    expect(existsSync(path.join(storeDir, "references"))).toBe(false);
    await rm(bare, { recursive: true, force: true });
    await rm(srcDir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  });
});

// Appended alongside the mirroring suite: a pre-existing SYMLINKED DIRECTORY
// in the storage tree must refuse the descent (a linked references/ would
// redirect every copied leaf outside the canonical dir).
describe("mirrorSkillBundleAssets — symlinked destination directory", () => {
  it("refuses to descend through a symlinked destination directory", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "pss-src2-"));
    const store = await mkdtemp(path.join(os.tmpdir(), "pss-store2-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "pss-outside3-"));
    await writeFile(path.join(src, "SKILL.md"), SKILL_MD, "utf8");
    await mkdir(path.join(src, "references"), { recursive: true });
    await writeFile(path.join(src, "references", "one.md"), "ref one\n", "utf8");
    await symlink(outside, path.join(store, "references"));

    await expect(mirrorSkillBundleAssets(src, store)).rejects.toThrow(/symlinked directory/);
    expect(existsSync(path.join(outside, "one.md"))).toBe(false);

    await rm(src, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
});
