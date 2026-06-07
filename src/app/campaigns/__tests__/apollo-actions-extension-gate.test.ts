/**
 * Security regression: saveApolloConnectionAction + clearApolloConnectionAction
 * MUST gate on requireExtensionAction("@cinatra-ai/apollo-connector", "manage")
 * as the FIRST executable statement. These actions write/clear the Apollo API
 * connection credentials, so an unprivileged caller must not be able to
 * overwrite or wipe them.
 *
 * These actions live in the connector and gate on the SDK's
 * requireExtensionAction(..., "manage") gate
 * (org_owner/org_admin/platform_admin, fail-closed). The connector action is
 * THE security boundary.
 *
 * This test lives under src/ (a root-vitest-covered path) — NOT co-located in
 * the extension — so the security invariant is actually ENFORCED in CI (the root
 * vitest `include` does not cover extensions/**). It asserts against the
 * connector source text by repo-relative path.
 *
 * The connector references the package id via an APOLLO_PACKAGE_ID constant
 * rather than an inline string literal, so the gate assertion matches that form.
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
 * Return the body with leading whitespace + line/block comments stripped, so the
 * remainder begins at the first EXECUTABLE statement. Asserting against THIS
 * (not merely the first `await`) closes the hole where a synchronous statement
 * is slipped in before the gate — which would still pass a first-`await` check.
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
  join(process.cwd(), "extensions/cinatra-ai/apollo-connector/src/actions.ts"),
  "utf-8",
);
const GATE = `requireExtensionAction(APOLLO_PACKAGE_ID, "manage")`;

describe("apollo connection actions — extension manage gate", () => {
  for (const fnName of ["saveApolloConnectionAction", "clearApolloConnectionAction"]) {
    it(`${fnName}: the FIRST executable statement is the requireExtensionAction manage gate`, () => {
      const body = extractFunctionBody(SOURCE, fnName);
      expect(firstExecutableStatement(body).startsWith(`await ${GATE};`)).toBe(true);
    });
  }
});
