/**
 * ARCHITECTURE GATE — no production path delivers a skill outside the contract
 * (cinatra#2091, epic #2086 S4, AC-1).
 *
 * Scans the real source tree (this suite runs in CI as part of the skills unit
 * job) and pins three structural facts:
 *
 *   1. `buildSkillTools` — the raw shell-mount builder — is imported ONLY by the
 *      delivery seam and its own tests. The assistant runtime's direct call was
 *      the last production bypass and it is gone.
 *   2. No caller passes a `skillIds:` array into a skill-aware LLM entry point.
 *   3. The branded set has exactly ONE constructor: nothing outside
 *      `injection/contract.ts` casts to `ResolvedInjectedSkillSet`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

const SCAN_ROOTS = ["src", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  ".git",
  "coverage",
]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(abs);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield abs;
    }
  }
}

function sourceFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(path.join(REPO_ROOT, root))) {
      out.push({
        rel: path.relative(REPO_ROOT, abs).replaceAll("\\", "/"),
        text: readFileSync(abs, "utf8"),
      });
    }
  }
  return out;
}

const isTestFile = (rel: string) =>
  /\.test\.tsx?$/.test(rel) ||
  rel.includes("/__tests__/") ||
  rel.includes("/tests/");

const FILES = sourceFiles();

describe("skill-injection architecture gate", () => {
  it("finds a source tree to scan (the gate is not vacuously green)", () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it("buildSkillTools is not on the LLM package's public surface", () => {
    const index = FILES.find((f) => f.rel === "packages/llm/src/index.ts")!;
    const barrel = index.text.slice(0, index.text.indexOf("// ---"));
    expect(barrel).not.toMatch(/^\s*buildSkillTools,\s*$/m);
  });

  it("buildSkillTools is reachable ONLY from the delivery seam", () => {
    // Its own module, the provider delivery adapters, and the SDK contract that
    // types the core-owned delivery floor.
    const ALLOWED = new Set([
      "packages/llm/src/tools/skills.ts",
      "packages/llm/src/tools/skill-delivery.ts",
      "packages/llm/src/index.ts",
      "packages/sdk-extensions/src/llm-provider-adapter-contract.ts",
    ]);
    const offenders = FILES.filter(
      ({ rel, text }) =>
        !isTestFile(rel) &&
        !ALLOWED.has(rel) &&
        /\bbuildSkillTools\s*[({]/.test(text),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no production caller passes a raw skillIds array into a skill-aware entry point", () => {
    const ENTRY_POINTS =
      /(runSkillAwareDeterministicLlmTask|runResolvedSkillAwareDeterministicLlmTask)\s*\(\s*\{([\s\S]{0,2000}?)\n\s*\}\s*\)/g;
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      if (isTestFile(rel)) continue;
      for (const match of text.matchAll(ENTRY_POINTS)) {
        if (/^\s*skillIds\s*:/m.test(match[2] ?? "")) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the skill-aware entry input declares injectedSkills and NO skillIds channel", () => {
    const index = FILES.find((f) => f.rel === "packages/llm/src/index.ts");
    expect(index).toBeDefined();
    const block = index!.text.slice(
      index!.text.indexOf("export type SkillAwareDeterministicLlmExecutionInput"),
      index!.text.indexOf("export type ResolvedDeterministicLlmExecutionInput"),
    );
    expect(block).toContain("injectedSkills: ResolvedInjectedSkillSet");
    expect(block).not.toMatch(/^\s*skillIds\??\s*:/m);
    expect(block).not.toMatch(/^\s*customSkillContent\??\s*:/m);
    expect(block).not.toMatch(/^\s*customSkillId\??\s*:/m);
  });

  it("ResolvedInjectedSkillSet has exactly ONE constructor", () => {
    const offenders = FILES.filter(
      ({ rel, text }) =>
        rel !== "packages/skills/src/injection/index.ts" &&
        !isTestFile(rel) &&
        /as\s+unknown\s+as\s+ResolvedInjectedSkillSet/.test(text),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every skill-aware caller declares an intent through the resolver", () => {
    // The entry point's own module defines these functions; it is not a caller.
    const ENTRY_POINT_HOME = "packages/llm/src/index.ts";
    const callers = FILES.filter(
      ({ rel, text }) =>
        !isTestFile(rel) &&
        rel !== ENTRY_POINT_HOME &&
        /(runSkillAwareDeterministicLlmTask|runResolvedSkillAwareDeterministicLlmTask)\s*\(\s*\{/.test(
          text,
        ),
    ).map((f) => f.rel);
    // The exhaustive migrated caller set. A NEW skill-aware caller must be added
    // here deliberately — that is the point of the gate.
    expect(callers.sort()).toEqual(
      [
        "packages/agents/src/agent-creation-review.ts",
        "packages/agents/src/run-author-agent.ts",
        "src/app/api/auditor/run-skills/route.ts",
        "src/app/api/llm-bridge/route.ts",
      ].sort(),
    );
    for (const rel of callers) {
      const text = FILES.find((f) => f.rel === rel)!.text;
      expect(text, `${rel} must resolve an injected set`).toMatch(
        /resolveInjectedSkillSet\s*\(/,
      );
    }
  });
});
