import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
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

const { upsertSkillMock, headState } = vi.hoisted(() => ({
  upsertSkillMock: vi.fn(),
  // cinatra#2274 added a registration POST-CONDITION that re-reads the skill's
  // bundle head. There is no DB here, so ONLY that reader is stubbed; the real
  // bundle walker + digest stay real (see the mock below).
  headState: { value: null as unknown },
}));

vi.mock("./skills-store", () => ({
  upsertSkill: upsertSkillMock,
  readSkillsStorageConfig: vi.fn(() => ({ dataPath: "data/skills" })),
  syncInstalledSkillsToDatabase: vi.fn(async () => ({ skillPackages: [], skills: [] })),
}));

vi.mock("@/lib/skill-bundle-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skill-bundle-store")>();
  return { ...actual, readAuthorityBundleHeadState: () => headState.value };
});

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
import { bundleDigestForFiles } from "@/lib/skill-bundle-store";
import { resolveUpsertBundleFiles } from "./skill-source";

/** Emulate the real store: write the canonical SKILL.md from `content` and
 * publish the head its lifecycle write would have installed. */
async function storeLike(storeDir: string) {
  return async (input: { content: string; bundleFiles?: unknown }) => {
    await mkdir(storeDir, { recursive: true });
    await writeFile(path.join(storeDir, "SKILL.md"), input.content, "utf8");
    headState.value = {
      headRevisionId: "rev-1",
      headBundleDigest: bundleDigestForFiles(
        resolveUpsertBundleFiles(input.content, input.bundleFiles as never),
      ),
      activeRevisionId: "rev-1",
      isAuthorityOwned: true,
    };
    return { id: "@cinatra-ai/chat:chat-assistant", sourcePath: path.join(storeDir, "SKILL.md") };
  };
}

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
    // A REAL canonical dir: the cinatra#2274 post-condition walks it back.
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "pss-store1-"));
    upsertSkillMock.mockImplementation(await storeLike(storeDir));

    const out = await registerExtensionSkill({
      skillId: "@cinatra-ai/chat:chat-assistant",
      packageName: "@cinatra-ai/chat",
      skillMdPath,
    });

    expect(out.id).toBe("@cinatra-ai/chat:chat-assistant");
    expect(out.sourcePath).toBe(path.join(storeDir, "SKILL.md"));
    const call = upsertSkillMock.mock.calls[0][0];
    expect(call.type).toBe("workspace");
    expect(call.packageName).toBe("@cinatra-ai/chat");
    expect(call.skillId).toBe("@cinatra-ai/chat:chat-assistant");
    expect(call.name).toBe("chat-assistant");
    expect(call.description).toContain("Cinatra chat assistant");
    expect(call.content).toContain("You are the Cinatra AI assistant.");
    // cinatra#2398: the write declares itself an EXTENSION registration, which
    // is what keeps the resulting row out of the user-authored `isCustom` class
    // (the class the shared assignability predicate refuses) while still giving
    // the catalog rebuild a reason to preserve it.
    expect(call.extensionRegistered).toBe(true);

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

// DELIVERED-SURFACE COMPLETENESS (cinatra#2090 S3 fold) moved off the
// copy-the-source mirror in cinatra#2274.
//
// `mirrorSkillBundleAssets` is GONE. Registration now materializes the canonical
// directory from the CONTENT AUTHORITY it just recorded
// (`materializeRevisionBundleToDirectory`): staged into a sibling temp dir and
// renamed into place, replacing whatever stood there. That removes the whole
// class the deleted suite covered — a stale reference cannot survive a
// wholesale replacement, and a planted symlink in the storage dir is removed by
// the `rm -r` (which lstats and unlinks a link) instead of being written
// through, so there is no "refuse to write through a symlink" path left to test.
// The `references/**` delivery, the stale-file case, and the symlink case are
// proven END TO END against a real database + real filesystem in
// src/lib/__tests__/integration/skill-extension-writer-authority.integration.test.ts;
// the delivery DECISION (materialize only on drift) is unit-pinned in
// src/__tests__/extension-skill-bundle-authority.test.ts.
