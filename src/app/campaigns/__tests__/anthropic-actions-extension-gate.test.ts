/**
 * Security regression: saveAnthropicSettingsAction MUST gate on
 * requireExtensionAction("@cinatra-ai/anthropic-connector", "manage") as the FIRST
 * executable statement. The action writes the Anthropic API connection (Nango
 * import) + the default Claude model, so an unprivileged caller must not be able to
 * overwrite them.
 *
 * This action lives in the connector and carries the SDK's requireExtensionAction
 * gate (org_owner/org_admin/platform_admin, fail-closed). The connector action is
 * THE security boundary.
 *
 * This test lives under src/ (a root-vitest-covered, CI-pinned path) — NOT
 * co-located in the extension (the root vitest `include` does not cover
 * extensions/**) — so the security invariant is actually ENFORCED in CI. It asserts
 * against the connector source text by repo-relative path, using the stronger
 * firstExecutableStatement check (mirrors github/linkedin/apollo/nango).
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
  join(process.cwd(), "extensions/cinatra-ai/anthropic-connector/src/actions.ts"),
  "utf-8",
);
const GATE = `requireExtensionAction(ANTHROPIC_PACKAGE_ID, "manage")`;

describe("anthropic settings action — extension manage gate", () => {
  it("saveAnthropicSettingsAction: the FIRST executable statement is the requireExtensionAction manage gate", () => {
    const body = extractFunctionBody(SOURCE, "saveAnthropicSettingsAction");
    expect(firstExecutableStatement(body).startsWith(`await ${GATE};`)).toBe(true);
  });

  it("the gate targets the anthropic-connector package id", () => {
    expect(SOURCE).toContain('const ANTHROPIC_PACKAGE_ID = "@cinatra-ai/anthropic-connector";');
  });
});
