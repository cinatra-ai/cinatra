/**
 * Security regression: `saveNangoConnectionAction` MUST gate on
 * `requireExtensionAction("@cinatra-ai/nango-connector", "manage")` as the FIRST
 * executable statement, since it writes the workspace-wide Nango gateway secret.
 * The action lives in the connector and gates on the SDK manage gate
 * (org_owner/org_admin/platform_admin, fail-closed; for an infra connector with
 * no catalog descriptor the host guard maps `manage` to org-admin). The connector
 * action is THE security boundary.
 *
 * This test lives under src/ (a root-vitest-covered, CI-pinned path) — NOT
 * co-located in the extension (the root vitest `include` does not cover
 * extensions/**) — so the security invariant is actually ENFORCED in CI. It
 * asserts against the connector source text by repo-relative path. Mirrors the
 * linkedin/apollo/gmail/wordpress connector-action gate tests, including the
 * stronger `firstExecutableStatement` check (not merely "first await").
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

/**
 * Strip leading whitespace + line/block comments so the remainder begins at the
 * first EXECUTABLE statement. Asserting against THIS (not merely the first
 * `await`) closes the hole where a synchronous statement (e.g. a config read or
 * a credential write) is slipped in before the gate.
 */
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
  join(process.cwd(), "extensions/cinatra-ai/nango-connector/src/actions.ts"),
  "utf-8",
);
const GATE = `requireExtensionAction("@cinatra-ai/nango-connector", "manage")`;

describe("nango connection action — extension manage gate", () => {
  it("saveNangoConnectionAction: the FIRST executable statement is the requireExtensionAction manage gate", () => {
    const body = extractFunctionBody(SOURCE, "saveNangoConnectionAction");
    expect(firstExecutableStatement(body).startsWith(`await ${GATE};`)).toBe(true);
  });
});
