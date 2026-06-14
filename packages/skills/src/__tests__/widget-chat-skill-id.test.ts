/**
 * `isWidgetChatSkillId` is the AUTHORITATIVE predicate that lets the
 * unauthenticated in-CMS widget SSE stream's roleless internal-model actor read
 * the widget-chat SKILL.md (the WordPress/Drupal content-editor system prompt).
 * Its truth is the extension manifest's `cinatra.capabilities` keyed
 * `widget-chat.*` — NEVER a slug/id naming convention.
 *
 * These tests scan a REAL on-disk fixture extensions tree (so the actual
 * package.json parse + capability map + `deriveSkillRegistration` id derivation
 * are exercised), with the lifecycle-status read controllable per test. Because
 * the predicate feeds an AUTHORIZATION carve-out it is FAIL-CLOSED: a degraded
 * status store denies, a tombstoned extension denies, and a manifest pointer
 * without a bundled SKILL.md denies. This pins the exact security boundary the
 * widget-chat auth carve-out depends on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// `isWidgetChatSkillId` only uses the scan + capability map + id derivation; it
// never registers a skill. Stub the registration module so its transitive
// `skills-store` → mcp-server import chain is not pulled into this unit test.
vi.mock("../register-extension-skill", () => ({
  registerExtensionSkill: vi.fn(),
  deriveStoragePackagePathFromSkillMd: vi.fn(),
}));

// Controllable lifecycle-status read. Default: throw (status store degraded) so
// the FAIL-CLOSED posture is the test default — individual tests opt into a
// healthy store (empty Map = no lifecycle rows = image-shipped floor) or an
// archived/tombstoned row.
const { lifecycleStatusMock } = vi.hoisted(() => ({ lifecycleStatusMock: vi.fn() }));
vi.mock("@cinatra-ai/extensions", () => ({
  readEffectiveStatusByPackageNames: (names: string[]) => lifecycleStatusMock(names),
}));

// Pin the dynamically-installed extension root to the same fixture so the scan
// has a single deterministic root (deduped by realpath against cwd/extensions).
let fixtureRoot: string;
vi.mock("@cinatra-ai/agents/agent-install-path", () => ({
  resolveAgentInstallDir: () => path.join(fixtureRoot, "extensions"),
}));

import { isWidgetChatSkillId } from "../extension-skill-resolver";

function writeExtension(
  root: string,
  vendor: string,
  pkgDir: string,
  pkgJson: Record<string, unknown>,
  slugs: string[],
): void {
  const dir = path.join(root, "extensions", vendor, pkgDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
  for (const slug of slugs) {
    const skillDir = path.join(dir, "skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `# ${slug}\n`);
  }
}

let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "widget-chat-skill-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fixtureRoot);

  // A connector that declares a widget-chat capability (WordPress shape).
  writeExtension(
    fixtureRoot,
    "cinatra-ai",
    "wordpress-mcp-connector",
    {
      name: "@cinatra-ai/wordpress-mcp-connector",
      cinatra: {
        kind: "connector",
        capabilities: { "widget-chat.wordpress-content-editor": "wordpress-widget-chat" },
      },
    },
    ["wordpress-widget-chat"],
  );

  // A skill package that declares a widget-chat capability (Drupal shape).
  writeExtension(
    fixtureRoot,
    "cinatra-ai",
    "drupal-skills",
    {
      name: "@cinatra-ai/drupal-skills",
      cinatra: {
        kind: "skill",
        capabilities: { "widget-chat.drupal-content-editor": "drupal-widget-chat" },
      },
    },
    ["drupal-widget-chat"],
  );

  // A NON-widget skill package whose slug merely RESEMBLES a widget id — it is
  // NOT declared under a widget-chat capability, so it must NOT be recognised.
  writeExtension(
    fixtureRoot,
    "some-other",
    "look-alike",
    {
      name: "@some-other/look-alike",
      cinatra: {
        kind: "skill",
        // declared under a DIFFERENT capability namespace
        capabilities: { "blog.generate": "evil-widget-chat" },
      },
    },
    ["evil-widget-chat"],
  );

  // A widget-chat extension whose manifest POINTS at a slug that ships NO
  // bundled SKILL.md (no skills/<slug>/SKILL.md on disk) — the manifest pointer
  // alone must NOT make the id resolvable (invariant: package-bundled prompt).
  writeExtension(
    fixtureRoot,
    "some-other",
    "no-skillmd",
    {
      name: "@some-other/no-skillmd",
      cinatra: {
        kind: "skill",
        capabilities: { "widget-chat.no-skillmd-editor": "no-skillmd-widget-chat" },
      },
    },
    [], // capability declared, but the slug dir / SKILL.md is absent
  );

  // A widget-chat extension that IS declared + bundled but is TOMBSTONED in the
  // lifecycle store (archived) — must be denied.
  writeExtension(
    fixtureRoot,
    "some-other",
    "retired-widget",
    {
      name: "@some-other/retired-widget",
      cinatra: {
        kind: "connector",
        capabilities: { "widget-chat.retired-editor": "retired-widget-chat" },
      },
    },
    ["retired-widget-chat"],
  );
});

afterAll(() => {
  cwdSpy.mockRestore();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Default: HEALTHY status store with NO lifecycle rows (image-shipped floor →
  // live by being on disk). Tests that need archived/degraded override this.
  lifecycleStatusMock.mockReset();
  lifecycleStatusMock.mockResolvedValue(new Map());
});

describe("isWidgetChatSkillId", () => {
  it("recognises a connector-co-located widget-chat skill", async () => {
    await expect(
      isWidgetChatSkillId("@cinatra-ai/wordpress-mcp-connector:wordpress-widget-chat"),
    ).resolves.toBe(true);
  });

  it("recognises a sibling skill-package widget-chat skill", async () => {
    await expect(
      isWidgetChatSkillId("@cinatra-ai/drupal-skills:drupal-widget-chat"),
    ).resolves.toBe(true);
  });

  it("recognises a widget skill whose owning package is affirmatively active", async () => {
    lifecycleStatusMock.mockResolvedValue(
      new Map([["@cinatra-ai/wordpress-mcp-connector", "active"]]),
    );
    await expect(
      isWidgetChatSkillId("@cinatra-ai/wordpress-mcp-connector:wordpress-widget-chat"),
    ).resolves.toBe(true);
  });

  it("does NOT recognise a look-alike slug not declared under a widget-chat.* capability", async () => {
    await expect(
      isWidgetChatSkillId("@some-other/look-alike:evil-widget-chat"),
    ).resolves.toBe(false);
  });

  it("does NOT recognise an unknown / uninstalled skill id", async () => {
    await expect(isWidgetChatSkillId("@nobody/nothing:not-installed")).resolves.toBe(false);
    await expect(isWidgetChatSkillId("@cinatra-ai/chat:chat-assistant-core")).resolves.toBe(false);
  });

  it("does NOT recognise a widget capability whose slug has no bundled SKILL.md", async () => {
    await expect(
      isWidgetChatSkillId("@some-other/no-skillmd:no-skillmd-widget-chat"),
    ).resolves.toBe(false);
  });

  it("FAIL-CLOSED: denies a widget skill when the lifecycle-status read fails", async () => {
    lifecycleStatusMock.mockRejectedValue(new Error("status store down"));
    await expect(
      isWidgetChatSkillId("@cinatra-ai/wordpress-mcp-connector:wordpress-widget-chat"),
    ).resolves.toBe(false);
  });

  it("denies a TOMBSTONED (archived) widget extension", async () => {
    lifecycleStatusMock.mockResolvedValue(
      new Map([["@some-other/retired-widget", "archived"]]),
    );
    await expect(
      isWidgetChatSkillId("@some-other/retired-widget:retired-widget-chat"),
    ).resolves.toBe(false);
  });
});
