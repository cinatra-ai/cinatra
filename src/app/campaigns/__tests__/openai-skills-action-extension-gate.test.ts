/**
 * Security regression: the OpenAI connector server actions MUST gate on
 * requireExtensionAction("@cinatra-ai/openai-connector", "manage") as the FIRST
 * executable statement. These actions write workspace-wide OpenAI credentials +
 * shell/skills runtime settings, so an unprivileged caller must not be able to
 * overwrite them.
 *
 * saveOpenAISkillsSettingsAction lives in the connector and gates on the SDK
 * manage gate. The connector actions saveOpenAIConnectionAction +
 * clearOpenAIConnectionAction carry the same gate. The connector actions are
 * THE security boundary (openai IS a catalog connector).
 *
 * This test lives under src/ (root-vitest-covered, CI-pinned) and asserts against
 * the connector source text by repo-relative path, using the stronger
 * firstExecutableStatement check (mirrors linkedin/apollo/nango/github).
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

function firstExecutableStatement(body: string): string {
  let s = body;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    if (s.startsWith("//")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2);
    }
    if (s === before) break;
  }
  return s;
}

const SOURCE = readFileSync(
  join(process.cwd(), "extensions/cinatra-ai/openai-connector/src/actions.ts"),
  "utf-8",
);
// The connector references its package id via an OPENAI_PACKAGE_ID constant
// (apollo precedent). Assert both the gate-call shape AND that the constant
// resolves to the correct package id, so the gate can't be silently weakened by
// pointing the const at a different (or unknown) package.
const GATE = `requireExtensionAction(OPENAI_PACKAGE_ID, "manage")`;

describe("openai connector actions — extension manage gate", () => {
  it("OPENAI_PACKAGE_ID resolves to the openai-connector package id", () => {
    expect(SOURCE).toContain(`const OPENAI_PACKAGE_ID = "@cinatra-ai/openai-connector"`);
  });

  for (const fnName of [
    "saveOpenAISkillsSettingsAction",
    "saveOpenAIConnectionAction",
    "clearOpenAIConnectionAction",
  ]) {
    it(`${fnName}: the FIRST executable statement is the requireExtensionAction manage gate`, () => {
      const body = extractFunctionBody(SOURCE, fnName);
      expect(firstExecutableStatement(body).startsWith(`await ${GATE};`)).toBe(true);
    });
  }
});
