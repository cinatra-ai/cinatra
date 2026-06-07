/**
 * agent_run_skills_used foundation regression gate.
 *
 * Verifies the foundation pieces of the Skills tab + per-run skill ledger:
 *   1. drizzle-store migration declares the table
 *   2. Skills tab route exists at the canonical path
 *   3. Helpers module exists at src/lib/agent-run-skills-used.ts with the
 *      three documented exports.
 *
 * Live database tests for snapshotSkillsAtRunStart + incrementSkillInvocation
 * + listSkillsUsedForRun are deferred to live integration UAT once the
 * /api/llm-bridge route + skills_installed_resolve_for_agent are wired,
 * because they need instrumentation hooks, not just the route.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");

describe("agent_run_skills_used foundation", () => {
  it("drizzle-store migration declares agent_run_skills_used table", () => {
    const drizzlePath = path.join(repoRoot, "src/lib/drizzle-store.ts");
    const content = fs.readFileSync(drizzlePath, "utf8");
    expect(content).toContain('CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll(\'"\', \'""\')}"."agent_run_skills_used"');
    // The skill_kind allow-list intentionally excludes external third-party kinds.
    expect(content).toContain("skill_kind text NOT NULL CHECK (skill_kind IN ('custom','installed','builtin'))");
    expect(content).toContain("agent_run_skills_used_run_skill_idx");
    expect(content).toContain("invocation_count integer NOT NULL DEFAULT 0");
  });

  it("helpers module exists at src/lib/agent-run-skills-used.ts", () => {
    const helperPath = path.join(repoRoot, "src/lib/agent-run-skills-used.ts");
    expect(fs.existsSync(helperPath)).toBe(true);
    const content = fs.readFileSync(helperPath, "utf8");
    expect(content).toContain("export function snapshotSkillsAtRunStart");
    expect(content).toContain("export function incrementSkillInvocation");
    expect(content).toContain("export function listSkillsUsedForRun");
    expect(content).toContain("export type SkillKind");
  });

  it("Skills tab route exists at /agents/[vendor]/[packageName]/[instanceId]/skills", () => {
    const routePath = path.join(
      repoRoot,
      "src/app/agents/[vendor]/[packageName]/[instanceId]/skills/page.tsx",
    );
    expect(fs.existsSync(routePath)).toBe(true);
    const content = fs.readFileSync(routePath, "utf8");
    expect(content).toContain("AgentPackageInstanceSkillsPage");
    expect(content).toContain("listSkillsUsedForRun");
  });

  it("incrementSkillInvocation uses upsert with invocation_count + 1", () => {
    const helperPath = path.join(repoRoot, "src/lib/agent-run-skills-used.ts");
    const content = fs.readFileSync(helperPath, "utf8");
    expect(content).toContain("ON CONFLICT (run_id, skill_id)");
    expect(content).toContain("invocation_count + 1");
  });

  it("snapshotSkillsAtRunStart is idempotent (ON CONFLICT DO NOTHING)", () => {
    const helperPath = path.join(repoRoot, "src/lib/agent-run-skills-used.ts");
    const content = fs.readFileSync(helperPath, "utf8");
    expect(content).toContain("ON CONFLICT (run_id, skill_id) DO NOTHING");
  });
});
