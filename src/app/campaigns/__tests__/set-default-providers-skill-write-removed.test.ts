/**
 * REMOVAL PIN (cinatra#1104): the Anthropic skill-upload opt-in was a
 * non-ZDR data-egress control that core USED to read, persist, and act on
 * inside `setDefaultProvidersAction` (parse `anthropicSkillSyncEnabled` →
 * `writeAnthropicSkillSyncEnabledToDatabase` → `orchestrateAnthropicSkillSync`).
 * That control is now owned solely by the anthropic-connector Skills tab, which
 * persists it through the `@cinatra-ai/host:anthropic-skill-config` write
 * capability (the same host orchestration, single-sourced).
 *
 * Re-introducing a second, core-side write path for that opt-in would strand
 * an instance with two divergent surfaces for a data-egress toggle, so pin the
 * ABSENCE against the action's source text. The check is scoped to the
 * `setDefaultProvidersAction` BODY (so the honest relocation notes elsewhere in
 * the file may still name the moved-away primitives in prose) plus a file-level
 * assertion that the eager-sync service is no longer imported.
 *
 * Mirrors the #1972 openai honest-retirement pin
 * (openai-skills-action-extension-gate.test.ts): source-text, repo-relative
 * path, root-vitest-covered / CI-pinned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function extractFunctionBody(source: string, fnName: string): string {
  const marker = `export async function ${fnName}`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`fn ${fnName} not found`);
  let i = source.indexOf("{", start);
  const bodyStart = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart + 1, i);
}

const ACTIONS_SOURCE = readFileSync(
  join(process.cwd(), "src/app/campaigns/actions.ts"),
  "utf-8",
);

describe("setDefaultProvidersAction — anthropic skill-write removed (#1104)", () => {
  // The action itself must still exist (extractFunctionBody throws otherwise) —
  // this pins the removal of the skill-write, not the deletion of the action.
  const body = extractFunctionBody(ACTIONS_SOURCE, "setDefaultProvidersAction");

  it("no longer reads the anthropicSkillSyncEnabled form field", () => {
    expect(body).not.toContain("anthropicSkillSyncEnabled");
  });

  it("no longer persists the opt-in via writeAnthropicSkillSyncEnabledToDatabase", () => {
    expect(body).not.toContain("writeAnthropicSkillSyncEnabledToDatabase");
  });

  it("no longer triggers orchestrateAnthropicSkillSync", () => {
    expect(body).not.toContain("orchestrateAnthropicSkillSync");
  });

  it("no longer imports the eager skill-sync orchestration service", () => {
    // Catches a re-wiring of the removed sync at the import site, independent of
    // the body scan above.
    expect(ACTIONS_SOURCE).not.toMatch(
      /import\s+[^;]*from\s+["']@\/lib\/anthropic-skill-config-service["']/,
    );
  });
});
