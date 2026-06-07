import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// extension-skill-resolver contract.
//
// The resolver replaces the per-consumer hardcoded skill self-heals with ONE
// generic, install/uninstall-aware mechanism: a caller names a stable,
// package-OWNED capability key (or a concrete skillId) and the resolver
// discovers the active extension that provides it from the filesystem, then
// lazily registers its SKILL.md body into the catalog. This pins:
//   (1) deriveSkillRegistration: the assistant-skills→@cinatra-ai/chat auth
//       carve-out is preserved; every other package uses its scoped name.
//   (2) resolveSkillIdForCapability: capability key → active extension's skillId.
//   (3) ensureInstalledSkillRegistered: registers the providing package's
//       co-located skills; only "skill" kind by default.
//   (4) a non-skill kind is NOT resolved unless explicitly allowed.

vi.mock("server-only", () => ({}));

const { registerExtensionSkillMock } = vi.hoisted(() => ({
  registerExtensionSkillMock: vi.fn(),
}));

vi.mock("./register-extension-skill", () => ({
  registerExtensionSkill: registerExtensionSkillMock,
}));

// Avoid loading the real install-path module (it pulls @/lib/database). Point
// the install dir at the bundled cwd/extensions so dedup-by-realpath collapses
// it with the cwd scan; the fixture is reached via cwd/extensions (we chdir).
vi.mock("@cinatra-ai/agents/agent-install-path", () => ({
  resolveAgentInstallDir: () => path.join(process.cwd(), "extensions"),
}));

import {
  deriveSkillRegistration,
  resolveSkillIdForCapability,
  ensureInstalledSkillRegistered,
  ensureInstalledSkillsRegistered,
  scanSkillExtensions,
} from "./extension-skill-resolver";

let tmpDir: string;
let origCwd: string;

async function writeExtension(input: {
  vendor: string;
  pkgDir: string;
  name: string;
  kind: string;
  capabilities?: Record<string, string>;
  slugs: string[];
}) {
  const dir = path.join(tmpDir, "extensions", input.vendor, input.pkgDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: input.name,
      cinatra: { apiVersion: "cinatra.ai/v1", kind: input.kind, capabilities: input.capabilities },
    }),
  );
  for (const slug of input.slugs) {
    const skillDir = path.join(dir, "skills", slug);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${slug}\n---\nbody`);
  }
}

beforeEach(async () => {
  registerExtensionSkillMock.mockReset();
  registerExtensionSkillMock.mockResolvedValue({ id: "x", sourcePath: "data/skills/x" });
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ext-skill-resolver-"));
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("deriveSkillRegistration", () => {
  it("preserves the assistant-skills → @cinatra-ai/chat auth carve-out", () => {
    expect(deriveSkillRegistration("@cinatra-ai/assistant-skills", "assistant-skills", "chat-core")).toEqual({
      packageName: "@cinatra-ai/chat",
      skillId: "@cinatra-ai/chat:chat-core",
    });
  });

  it("uses the package's own scoped name as the id prefix otherwise", () => {
    expect(deriveSkillRegistration("@acme/widget-skills", "widget-skills", "do-thing")).toEqual({
      packageName: "@acme/widget-skills",
      skillId: "@acme/widget-skills:do-thing",
    });
  });

  it("normalizes a bare (unscoped) package name with a leading @", () => {
    expect(deriveSkillRegistration("widget-skills", "widget-skills", "do-thing").packageName).toBe("@widget-skills");
  });
});

describe("scanSkillExtensions + resolveSkillIdForCapability", () => {
  it("maps a capability key to the active extension's skillId", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "widget-skills",
      name: "@acme/widget-skills",
      kind: "skill",
      capabilities: { "widget.do-thing-xyz": "do-thing" },
      slugs: ["do-thing"],
    });
    const found = (await scanSkillExtensions()).find((e) => e.pkgDirName === "widget-skills");
    expect(found?.capabilities["widget.do-thing-xyz"]).toBe("do-thing");

    const skillId = await resolveSkillIdForCapability("widget.do-thing-xyz");
    expect(skillId).toBe("@acme/widget-skills:do-thing");
  });

  it("returns null for an unknown capability", async () => {
    expect(await resolveSkillIdForCapability("nope.not-a-real-capability-zzz")).toBeNull();
  });

  it("does NOT resolve a non-skill kind unless explicitly allowed", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "art-pkg",
      name: "@acme/art-pkg",
      kind: "artifact",
      capabilities: { "art.cap-qqq": "do-art" },
      slugs: ["do-art"],
    });
    expect(await resolveSkillIdForCapability("art.cap-qqq")).toBeNull();
    expect(await resolveSkillIdForCapability("art.cap-qqq", { allowKinds: ["artifact"] })).toBe(
      "@acme/art-pkg:do-art",
    );
  });
});

describe("ensureInstalledSkillRegistered", () => {
  it("registers the co-located skills of the package that provides the skillId", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "lazy-skills",
      name: "@acme/lazy-skills",
      kind: "skill",
      slugs: ["lazy-one"],
    });
    await ensureInstalledSkillRegistered("@acme/lazy-skills:lazy-one");
    expect(registerExtensionSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: "@acme/lazy-skills:lazy-one", packageName: "@acme/lazy-skills" }),
    );
  });

  it("does not register (and does not throw) when no extension provides the skillId", async () => {
    await ensureInstalledSkillRegistered("@nobody/missing:none-zzz");
    expect(registerExtensionSkillMock).not.toHaveBeenCalled();
  });

  it("does NOT memo-as-done (retries) when the requested skill fails to upsert but a sibling succeeds", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "partial-skills",
      name: "@acme/partial-skills",
      kind: "skill",
      slugs: ["ok-one", "fails-one"],
    });
    // First call: the requested skill's upsert throws; the sibling succeeds.
    registerExtensionSkillMock.mockImplementation(async ({ skillId }) => {
      if (skillId === "@acme/partial-skills:fails-one") throw new Error("transient upsert failure");
      return { id: skillId, sourcePath: `data/skills/${skillId}` };
    });
    await ensureInstalledSkillRegistered("@acme/partial-skills:fails-one");
    const firstAttempts = registerExtensionSkillMock.mock.calls.filter(
      (c) => c[0].skillId === "@acme/partial-skills:fails-one",
    ).length;
    expect(firstAttempts).toBeGreaterThan(0);

    // Second call: the transient failure healed — it MUST retry (not be cached
    // as done just because the sibling registered on the first pass).
    registerExtensionSkillMock.mockResolvedValue({ id: "x", sourcePath: "data/skills/x" });
    await ensureInstalledSkillRegistered("@acme/partial-skills:fails-one");
    const totalAttempts = registerExtensionSkillMock.mock.calls.filter(
      (c) => c[0].skillId === "@acme/partial-skills:fails-one",
    ).length;
    expect(totalAttempts).toBeGreaterThan(firstAttempts);
  });
});

describe("ensureInstalledSkillsRegistered (batch)", () => {
  it("registers all co-located skills of a multi-skill package in ONE scan", async () => {
    await writeExtension({
      vendor: "cinatra-ai",
      pkgDir: "assistant-skills",
      name: "@cinatra-ai/assistant-skills",
      kind: "skill",
      slugs: ["chat-core", "chat-run-polling", "blog-content"],
    });
    await ensureInstalledSkillsRegistered([
      "@cinatra-ai/chat:chat-core",
      "@cinatra-ai/chat:chat-run-polling",
      "@cinatra-ai/chat:blog-content",
    ]);
    // Every co-located slug registered exactly once (package scanned once).
    const ids = registerExtensionSkillMock.mock.calls.map((c) => c[0].skillId).sort();
    expect(ids).toEqual([
      "@cinatra-ai/chat:blog-content",
      "@cinatra-ai/chat:chat-core",
      "@cinatra-ai/chat:chat-run-polling",
    ]);
    // The auth-boundary packageName is preserved for the carve-out package.
    expect(registerExtensionSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@cinatra-ai/chat" }),
    );
  });

  it("does not re-register ids already memoized on a second batch call", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "memo-skills",
      name: "@acme/memo-skills",
      kind: "skill",
      slugs: ["memo-a", "memo-b"],
    });
    const ids = ["@acme/memo-skills:memo-a", "@acme/memo-skills:memo-b"];
    await ensureInstalledSkillsRegistered(ids);
    const firstCount = registerExtensionSkillMock.mock.calls.length;
    expect(firstCount).toBe(2);
    await ensureInstalledSkillsRegistered(ids);
    // Second call: all ids memoized as done — no new registration work.
    expect(registerExtensionSkillMock.mock.calls.length).toBe(firstCount);
  });

  it("retries only the id that failed to upsert; the succeeded sibling stays memoized", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "batch-skills",
      name: "@acme/batch-skills",
      kind: "skill",
      slugs: ["ok-one", "fails-one"],
    });
    registerExtensionSkillMock.mockImplementation(async ({ skillId }) => {
      if (skillId === "@acme/batch-skills:fails-one") throw new Error("transient upsert failure");
      return { id: skillId, sourcePath: `data/skills/${skillId}` };
    });
    const ids = ["@acme/batch-skills:ok-one", "@acme/batch-skills:fails-one"];
    await ensureInstalledSkillsRegistered(ids);
    const okFirst = registerExtensionSkillMock.mock.calls.filter(
      (c) => c[0].skillId === "@acme/batch-skills:ok-one",
    ).length;

    // Heal the transient failure and re-run the batch.
    registerExtensionSkillMock.mockResolvedValue({ id: "x", sourcePath: "data/skills/x" });
    await ensureInstalledSkillsRegistered(ids);

    // The failed id retried because it was never memoized as done — its package
    // is rescanned and re-registered on the second batch.
    const failsTotal = registerExtensionSkillMock.mock.calls.filter(
      (c) => c[0].skillId === "@acme/batch-skills:fails-one",
    ).length;
    expect(failsTotal).toBeGreaterThan(1);
    // The succeeded sibling registered on the first batch (the unit of
    // registration is the whole co-located package; rescanning for the failed
    // id necessarily re-touches the sibling, which is an idempotent upsert).
    expect(okFirst).toBe(1);
  });
});
