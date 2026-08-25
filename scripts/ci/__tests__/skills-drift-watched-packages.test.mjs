// Skill-linked pin-set derivation (cinatra#2986 gap 2).
//
// The pure halves only: the gate-caller pin parse, the `cinatra-watches`
// frontmatter grammar this mirrors from the pinned engine, and the restriction
// of the bump's changed pins to the watched set. No git, no network.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseGateSkillsRepos,
  parseWatches,
  collectWatchedPackages,
  skillLinkedPins,
  SkillsWatchError,
  GATE_CALLER,
} from "../skills-drift-watched-packages.mjs";

// FIXTURE NAMING: every `@cinatra-ai/example-*` package and `example_*`
// primitive below is FICTIONAL, deliberately. The skills gate intersects
// declared watch surfaces against the raw diff TEXT, so naming a really-watched
// package in a fixture would flag this very PR and ask a person for a judgment
// about a string in a test file. Keep these names unreal.
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const GATE_YAML = `
jobs:
  the-gate-caller-job:
    with:
      skills_repos: |
        # a comment line inside the block scalar
        cinatra-ai/blog-content-skill@163f73c05b441b61799a2db203f8ce873ec8aae7
        cinatra-ai/company-research-skill@639fdc073b7d600a8436900843bfd3ac42778743
      mode: enforce
`;

const SKILL_METADATA = `---
name: blog-content
description: d
metadata:
  cinatra-watches:
    primitives:
      - example_watched_primitive
    packages:
      - "@cinatra-ai/example-watched-agent"
      - "@cinatra-ai/example-watched-workflow"
---
body`;

const SKILL_LEGACY_FLOW = `---
name: legacy
cinatra-watches:
  packages: ["@cinatra-ai/example-second-watched-agent"]
---
body`;

const SKILL_UNDECLARED = `---
name: plain
description: no watches at all
---
body`;

describe("parseGateSkillsRepos", () => {
  it("reads the caller's own pinned owner/name@sha entries, skipping comments", () => {
    expect(parseGateSkillsRepos(GATE_YAML)).toEqual([
      { owner: "cinatra-ai", name: "blog-content-skill", sha: "163f73c05b441b61799a2db203f8ce873ec8aae7" },
      { owner: "cinatra-ai", name: "company-research-skill", sha: "639fdc073b7d600a8436900843bfd3ac42778743" },
    ]);
  });

  it("REFUSES a branch pin (the gate reads a pinned snapshot, never a moving ref)", () => {
    expect(() => parseGateSkillsRepos(GATE_YAML.replace(/@163f[0-9a-f]+/, "@main"))).toThrow(SkillsWatchError);
  });

  it("REFUSES an absent or empty skills_repos block rather than reporting no watches", () => {
    expect(() => parseGateSkillsRepos("jobs:\n  x:\n    with:\n      mode: enforce\n")).toThrow(SkillsWatchError);
    expect(() => parseGateSkillsRepos("      skills_repos: |\n      mode: enforce\n")).toThrow(SkillsWatchError);
  });

  it("parses the REAL gate caller in this repo", () => {
    const yaml = readFileSync(resolve(REPO_ROOT, GATE_CALLER), "utf8");
    const entries = parseGateSkillsRepos(yaml);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("parseWatches", () => {
  it("reads the preferred metadata.cinatra-watches block sequence", () => {
    expect(parseWatches(SKILL_METADATA).packages).toEqual([
      "@cinatra-ai/example-watched-agent",
      "@cinatra-ai/example-watched-workflow",
    ]);
  });

  it("falls back to the legacy top-level key and reads a flow array", () => {
    expect(parseWatches(SKILL_LEGACY_FLOW).packages).toEqual(["@cinatra-ai/example-second-watched-agent"]);
  });

  it("returns null for a skill that declares no watches", () => {
    expect(parseWatches(SKILL_UNDECLARED)).toBeNull();
    expect(parseWatches("no frontmatter at all")).toBeNull();
  });

  it("FAILS LOUD on a malformed block instead of silently reporting no watches", () => {
    expect(() => parseWatches(SKILL_METADATA.replace("packages:", "packagez:"))).toThrow(SkillsWatchError);
    expect(() => parseWatches("---\nmetadata:\n  cinatra-watches:\n    packages:\n---\nb")).toThrow(SkillsWatchError);
    expect(() => parseWatches("---\ncinatra-watches: inline\n---\nb")).toThrow(SkillsWatchError);
  });
});

describe("collectWatchedPackages", () => {
  it("unions the packages class and records which skill watches each", () => {
    const res = collectWatchedPackages([
      { label: "a/SKILL.md", text: SKILL_METADATA },
      { label: "b/SKILL.md", text: SKILL_LEGACY_FLOW },
      { label: "c/SKILL.md", text: SKILL_UNDECLARED },
    ]);
    expect(res.watchedPackages).toEqual([
      "@cinatra-ai/example-second-watched-agent",
      "@cinatra-ai/example-watched-agent",
      "@cinatra-ai/example-watched-workflow",
    ]);
    expect(res.byPackage["@cinatra-ai/example-second-watched-agent"]).toEqual(["b/SKILL.md"]);
    // Every class, not just packages: the surface list is the fingerprint half
    // that pins WHICH universe a judgment was made against.
    expect(res.surfaces).toEqual([
      "packages:@cinatra-ai/example-second-watched-agent@b/SKILL.md",
      "packages:@cinatra-ai/example-watched-agent@a/SKILL.md",
      "packages:@cinatra-ai/example-watched-workflow@a/SKILL.md",
      "primitives:example_watched_primitive@a/SKILL.md",
    ]);
    expect(res.scanned).toBe(3);
    expect(res.declared).toBe(2);
  });
});

describe("skillLinkedPins", () => {
  const changed = [
    { packageName: "@cinatra-ai/example-unwatched-connector", resolvedSha: "a".repeat(40) },
    { packageName: "@cinatra-ai/example-watched-agent", resolvedSha: "b".repeat(40) },
    { packageName: "@cinatra-ai/example-second-watched-agent", resolvedSha: "c".repeat(40) },
  ];

  it("keeps only the changed pins a skill declares, sorted", () => {
    expect(skillLinkedPins(changed, ["@cinatra-ai/example-second-watched-agent", "@cinatra-ai/example-watched-agent"])).toEqual([
      { packageName: "@cinatra-ai/example-second-watched-agent", resolvedSha: "c".repeat(40) },
      { packageName: "@cinatra-ai/example-watched-agent", resolvedSha: "b".repeat(40) },
    ]);
  });

  it("a DE-LISTED watched package is in the set, carrying the `(removed)` sentinel", () => {
    const withRemoval = [...changed, { packageName: "@cinatra-ai/example-watched-agent2", resolvedSha: "(removed)" }];
    expect(skillLinkedPins(withRemoval, ["@cinatra-ai/example-watched-agent2"])).toEqual([
      { packageName: "@cinatra-ai/example-watched-agent2", resolvedSha: "(removed)" },
    ]);
  });

  it("a watched package the bump does NOT re-pin is not in the set", () => {
    expect(skillLinkedPins(changed, ["@cinatra-ai/example-unrelated-watched-agent"])).toEqual([]);
  });

  it("no watched packages -> empty set", () => {
    expect(skillLinkedPins(changed, [])).toEqual([]);
  });
});
