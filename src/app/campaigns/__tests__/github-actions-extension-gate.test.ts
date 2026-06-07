/**
 * Security regression: saveGitHubConnectionAction + saveGitHubRepositorySelectionAction
 * MUST gate on requireExtensionAction("@cinatra-ai/github-connector", "manage")
 * as the FIRST executable statement. These actions write the GitHub OAuth app
 * credentials + the selected repository, so an unprivileged caller must not be
 * able to overwrite them.
 *
 * These actions live in the connector and gate on the SDK's
 * requireExtensionAction(..., "manage") gate (org_owner/org_admin/platform_admin,
 * fail-closed; github IS a catalog connector). The connector action is THE
 * security boundary. There are no host forwarders in campaigns/actions.ts.
 *
 * This test lives under src/ (a root-vitest-covered, CI-pinned path) — NOT
 * co-located in the extension (the root vitest `include` does not cover
 * extensions/**) — so the security invariant is actually ENFORCED in CI. It
 * asserts against the connector source text by repo-relative path, using the
 * stronger firstExecutableStatement check (mirrors linkedin/apollo/nango).
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
  join(process.cwd(), "extensions/cinatra-ai/github-connector/src/actions.ts"),
  "utf-8",
);
const GATE = `requireExtensionAction("@cinatra-ai/github-connector", "manage")`;

describe("github connection actions — extension manage gate", () => {
  for (const fnName of ["saveGitHubConnectionAction", "saveGitHubRepositorySelectionAction"]) {
    it(`${fnName}: the FIRST executable statement is the requireExtensionAction manage gate`, () => {
      const body = extractFunctionBody(SOURCE, fnName);
      expect(firstExecutableStatement(body).startsWith(`await ${GATE};`)).toBe(true);
    });
  }
});
