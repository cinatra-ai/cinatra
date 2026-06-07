/**
 * Security regression: saveGoogleOAuthConnectionAction MUST gate on
 * requireExtensionAction("@cinatra-ai/google-oauth-connector", "manage") as the
 * FIRST executable statement. It writes the workspace-wide Google OAuth client
 * credentials, so an unprivileged caller must not be able to overwrite them.
 *
 * This action lives in the connector (the connector OWNS its setup-impl + save
 * action). The action resolves the OAuth facade via the connector's
 * globalThis-Symbol deps DI (host-bound) only AFTER the manage gate.
 *
 * This test lives under src/ (root-vitest-covered, CI-pinned) and asserts against
 * the connector source by repo-relative path, using firstExecutableStatement.
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
  join(process.cwd(), "extensions/cinatra-ai/google-oauth-connector/src/actions.ts"),
  "utf-8",
);
const GATE = `requireExtensionAction("@cinatra-ai/google-oauth-connector", "manage")`;

describe("google-oauth connection action — extension manage gate", () => {
  it("saveGoogleOAuthConnectionAction: the FIRST executable statement is the requireExtensionAction manage gate", () => {
    const body = extractFunctionBody(SOURCE, "saveGoogleOAuthConnectionAction");
    expect(firstExecutableStatement(body).startsWith(`await ${GATE};`)).toBe(true);
  });
});
