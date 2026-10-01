// ---------------------------------------------------------------------------
// The four package-global agent↔skill assignment actions are RETIRED
// (cinatra#2702): the settings surface that was their only caller is gone, so
// the actions, their modules, and every route to them leave the tree with it.
//
//   searchAssignableSkillExtensions  packages/extensions/src/assignable-skills-actions.ts
//   listAssignedAgentSkills          packages/skills/src/agent-assigned-skills-actions.ts
//   assignAgentSkill                 packages/skills/src/agent-assigned-skills-actions.ts
//   removeAgentSkill                 packages/skills/src/agent-assigned-skills-actions.ts
//
// A retired server action is not merely unreferenced: while its module file,
// its package `exports` entry and its tsconfig path alias survive, any caller
// can reach it again in one import. So this gate reads the tree itself — the
// files, the two export maps, and every import statement in the workspace —
// rather than asking a module loader what a specifier resolves to.
//
// The lifecycle cascades (S1) and the runtime reader (S3) own the assigned-
// skills STORE and are deliberately untouched here; nothing below asserts
// anything about them.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "../..");

const RETIRED_MODULES = [
  "packages/extensions/src/assignable-skills-actions.ts",
  "packages/skills/src/agent-assigned-skills-actions.ts",
  // The section's own display-name resolver: UI-only, and the retired section
  // was its only caller.
  "packages/extensions/src/assigned-skills-display.ts",
  // The retired action's own private helpers — the search model and the
  // candidate sources it read. Nothing else ever imported either.
  "packages/extensions/src/assignable-skills-search-model.ts",
  "packages/extensions/src/assignable-skills-sources.ts",
  // The settings Skills section itself (server half + client editor).
  "src/components/skills/agent-skills-config-section.tsx",
  "src/components/skills/agent-skills-config-client.tsx",
];

const RETIRED_SPECIFIERS = [
  "@cinatra-ai/extensions/assignable-skills-actions",
  "@cinatra-ai/extensions/assigned-skills-display",
  "@cinatra-ai/skills/agent-assigned-skills-actions",
  "@/components/skills/agent-skills-config-section",
  "@/components/skills/agent-skills-config-client",
];

const RETIRED_ACTIONS = [
  "searchAssignableSkillExtensions",
  "listAssignedAgentSkills",
  "assignAgentSkill",
  "removeAgentSkill",
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const FILES = [
  ...sourceFiles(path.join(REPO, "src")),
  ...sourceFiles(path.join(REPO, "packages")),
].filter((f) => !f.includes("agent-skill-assignment-actions-retired"));

describe("cinatra#2702 — the four agent↔skill assignment actions are retired", () => {
  it("no module in the tree declares any of the four actions", () => {
    const declaring = FILES.filter((file) => {
      const text = readFileSync(file, "utf8");
      return RETIRED_ACTIONS.some((name) =>
        new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${name}\\b`).test(text),
      );
    }).map((f) => path.relative(REPO, f));

    expect(declaring).toEqual([]);
  });

  it("the retired modules are gone from the tree", () => {
    const surviving = RETIRED_MODULES.filter((rel) => existsSync(path.join(REPO, rel)));
    expect(surviving).toEqual([]);
  });

  it("nothing imports a retired module — no orphaned import anywhere in the workspace", () => {
    const importers: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      for (const spec of RETIRED_SPECIFIERS) {
        if (text.includes(`"${spec}"`)) importers.push(`${path.relative(REPO, file)} → ${spec}`);
      }
      // Relative imports of the same modules from inside their own packages.
      for (const rel of [
        "./assignable-skills-actions",
        "./assignable-skills-search-model",
        "./assignable-skills-sources",
        "./assigned-skills-display",
        "../assignable-skills-actions",
        "../assignable-skills-search-model",
        "../assignable-skills-sources",
        "../assigned-skills-display",
        "./agent-assigned-skills-actions",
      ]) {
        if (new RegExp(`from\\s+"${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(text)) {
          importers.push(`${path.relative(REPO, file)} → ${rel}`);
        }
      }
    }
    expect(importers).toEqual([]);
  });

  it("no package `exports` entry and no tsconfig path alias still routes to one", () => {
    const maps = [
      "packages/extensions/package.json",
      "packages/skills/package.json",
      "tsconfig.json",
      "config/build-config.manifest.json",
    ];
    const routes: string[] = [];
    for (const rel of maps) {
      const text = readFileSync(path.join(REPO, rel), "utf8");
      for (const name of [
        "assignable-skills-actions",
        "assignable-skills-search-model",
        "assigned-skills-display",
        "agent-assigned-skills-actions",
      ]) {
        if (text.includes(name)) routes.push(`${rel} → ${name}`);
      }
    }
    expect(routes).toEqual([]);
  });
});
