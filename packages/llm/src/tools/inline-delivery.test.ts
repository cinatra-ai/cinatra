/**
 * Cross-provider router-skill equivalence + the inline short-circuit
 * (cinatra#2091, epic #2086 S4, AC-4).
 *
 * A router SKILL.md with `references/` must behave EQUIVALENTLY on every
 * provider: readable through the mounted shell tool on a tool-mount provider,
 * and — because an inline provider gets neither a tool nor a container — read
 * by CORE and merged into the system context there. An over-budget fixture must
 * drop WHOLE skills.
 *
 * Real files on a real temp dir: the expansion's containment rules (no `..`, no
 * symlink escape, regular files only) are exactly what a mock would erase.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const { installedGetMock } = vi.hoisted(() => ({ installedGetMock: vi.fn() }));

// The skills BARREL pulls the host-app artifact/objects boot graph, which is
// unresolvable in this sandbox. `tools/skills.ts` uses exactly one symbol from
// it. The `@cinatra-ai/skills/injection` LEAF (the contract itself) is a
// different specifier and stays REAL — this test exercises the real resolver.
vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: async () => "",
}));

vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { get: installedGetMock },
  }),
}));

import { deliverInjectedSkillsInline } from "./skills";
import {
  resolveInjectedSkillSet,
  type ResolvedInjectedSkillSet,
} from "@cinatra-ai/skills/injection";

let root: string;
let routerDir: string;
let bigDir: string;
let symlinkedParentDir: string;
let parentSymlinkAvailable = false;

const ROUTER_BODY = [
  "# Router",
  "Read [the guide](references/guide.md) before answering.",
  "Deep dive: `references/deep.md`.",
  "Escape attempt: [nope](../outside.md)",
  "Link out: [docs](https://example.test/x.md)",
].join("\n");

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "s4-inline-"));
  writeFileSync(path.join(root, "outside.md"), "OUTSIDE SECRET", "utf8");

  routerDir = path.join(root, "router-skill");
  mkdirSync(path.join(routerDir, "references"), { recursive: true });
  writeFileSync(path.join(routerDir, "SKILL.md"), ROUTER_BODY, "utf8");
  writeFileSync(path.join(routerDir, "references", "guide.md"), "GUIDE BODY", "utf8");
  writeFileSync(path.join(routerDir, "references", "deep.md"), "DEEP BODY", "utf8");
  // A symlink pointing OUT of the bundle must never be followed.
  try {
    symlinkSync(
      path.join(root, "outside.md"),
      path.join(routerDir, "references", "escape.md"),
    );
  } catch {
    // Symlink creation can be unavailable; the `..` case still covers escape.
  }

  // A skill whose ENTIRE `references` directory is a symlink out of the bundle.
  // A lexical containment check plus a final-component lstat both pass here —
  // only a full realpath comparison catches it.
  symlinkedParentDir = path.join(root, "symlink-parent-skill");
  mkdirSync(symlinkedParentDir, { recursive: true });
  writeFileSync(
    path.join(symlinkedParentDir, "SKILL.md"),
    "# Parent escape\nRead `references/leak.md`.",
    "utf8",
  );
  const outsideRefs = path.join(root, "outside-refs");
  mkdirSync(outsideRefs, { recursive: true });
  writeFileSync(path.join(outsideRefs, "leak.md"), "PARENT SYMLINK SECRET", "utf8");
  try {
    symlinkSync(outsideRefs, path.join(symlinkedParentDir, "references"), "dir");
    parentSymlinkAvailable = true;
  } catch {
    parentSymlinkAvailable = false;
  }

  bigDir = path.join(root, "big-skill");
  mkdirSync(path.join(bigDir, "references"), { recursive: true });
  writeFileSync(
    path.join(bigDir, "SKILL.md"),
    "# Big\nSee `references/huge.md`.",
    "utf8",
  );
  writeFileSync(
    path.join(bigDir, "references", "huge.md"),
    "H".repeat(500),
    "utf8",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function catalogRow(id: string, dir: string, body: string) {
  return {
    id,
    name: id,
    slug: path.basename(dir),
    description: "",
    body,
    content: body,
    sourcePath: path.join(dir, "SKILL.md"),
  };
}

function set(skillIds: string[]): Promise<ResolvedInjectedSkillSet> {
  return resolveInjectedSkillSet(
    { kind: "agent-run", agentId: "a", runId: "r" },
    {
      authorizeAgentRun: async () => ({ ok: true, runOwnerUserId: null }),
      resolveDeclaredDependencySkills: async () =>
        skillIds.map((skillId) => ({ skillId })),
      resolveRunRecommendedSkills: async () => [],
    },
  );
}

describe("core-owned inline delivery", () => {
  it("expands the router AND its one-hop references into the system context", async () => {
    installedGetMock.mockImplementation(async (id: string) =>
      id === "router" ? catalogRow("router", routerDir, ROUTER_BODY) : null,
    );
    const result = await deliverInjectedSkillsInline({ set: await set(["router"]) });
    expect(result.systemContext).toContain("Skill instructions:");
    expect(result.systemContext).toContain("# Router");
    expect(result.systemContext).toContain("GUIDE BODY");
    expect(result.systemContext).toContain("DEEP BODY");
    expect(result.exposure).toEqual([
      { skillId: "router", deliveryMode: "gemini_inline", invocationAttributable: false },
    ]);
    expect(result.dropped).toEqual([]);
  });

  it("NEVER reads outside the bundle — `..` and symlink escapes are refused", async () => {
    installedGetMock.mockImplementation(async (id: string) =>
      id === "router" ? catalogRow("router", routerDir, ROUTER_BODY) : null,
    );
    const result = await deliverInjectedSkillsInline({ set: await set(["router"]) });
    // The router's own prose is inlined VERBATIM (it is the instructions), so
    // the assertion is about what was FETCHED: no reference section was emitted
    // for the escape targets, and the out-of-bundle bytes never appear.
    expect(result.systemContext).not.toContain("OUTSIDE SECRET");
    expect(result.systemContext).not.toContain("router :: ../outside.md");
    expect(result.systemContext).not.toContain("router :: references/escape.md");
    expect(result.systemContext).not.toMatch(/### router :: https?:/);
    // Exactly the two in-bundle references were expanded.
    expect(result.systemContext.match(/### router :: /g)).toHaveLength(2);
  });

  it("a SYMLINKED PARENT directory cannot smuggle an out-of-bundle file in", async () => {
    expect(parentSymlinkAvailable).toBe(true);
    const body = "# Parent escape\nRead `references/leak.md`.";
    installedGetMock.mockImplementation(async (id: string) =>
      id === "escaper" ? catalogRow("escaper", symlinkedParentDir, body) : null,
    );
    const result = await deliverInjectedSkillsInline({ set: await set(["escaper"]) });
    // The router itself still ships; the escaping reference does NOT.
    expect(result.systemContext).toContain("# Parent escape");
    expect(result.systemContext).not.toContain("PARENT SYMLINK SECRET");
    expect(result.systemContext).not.toContain("escaper :: references/leak.md");
  });

  it("drops the WHOLE skill when its expansion exceeds the per-request budget", async () => {
    installedGetMock.mockImplementation(async (id: string) => {
      if (id === "router") return catalogRow("router", routerDir, ROUTER_BODY);
      if (id === "big") {
        return catalogRow("big", bigDir, "# Big\nSee `references/huge.md`.");
      }
      return null;
    });
    const result = await deliverInjectedSkillsInline({
      set: await set(["router", "big"]),
      budgetBytes: 600,
    });
    expect(result.exposure.map((e) => e.skillId)).toEqual(["router"]);
    expect(result.systemContext).not.toContain("# Big");
    expect(result.systemContext).not.toContain("HHHH");
    expect(result.dropped).toEqual([
      {
        skillId: "big",
        rank: "declared_dependency",
        reason: "inline_budget_exhausted",
      },
    ]);
  });

  it("records an unresolvable skill rather than emitting an empty one", async () => {
    installedGetMock.mockImplementation(async () => null);
    const result = await deliverInjectedSkillsInline({ set: await set(["ghost"]) });
    expect(result.systemContext).toBe("");
    expect(result.exposure).toEqual([]);
    expect(result.dropped).toEqual([
      {
        skillId: "ghost",
        rank: "declared_dependency",
        reason: "inline_body_unresolvable",
      },
    ]);
  });

  it("an empty set short-circuits without touching the catalog", async () => {
    installedGetMock.mockReset();
    const result = await deliverInjectedSkillsInline({ set: await set([]) });
    expect(result).toEqual({ systemContext: "", exposure: [], dropped: [] });
    expect(installedGetMock).not.toHaveBeenCalled();
  });
});
