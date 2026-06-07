/**
 * Security regression: saveLinkedInConnectionAction + deleteLinkedInAccountAction
 * MUST gate on requireExtensionAction("@cinatra-ai/linkedin-connector", "manage")
 * as the FIRST awaited statement. These actions write/mutate the LinkedIn
 * connector credentials + account list, so an unprivileged caller must not be
 * able to overwrite them.
 *
 * These actions live in the connector and gate on the SDK's
 * requireExtensionAction(..., "manage") gate (org_owner/org_admin/platform_admin,
 * fail-closed). The connector action is THE security boundary.
 *
 * This test lives under src/ (a root-vitest-covered path) — NOT co-located in
 * the extension — so the security invariant is actually ENFORCED in CI (the root
 * vitest `include` does not cover extensions/**). It asserts against the
 * connector source text by repo-relative path.
 *
 * Strategy: extract each action's function body from the source text and assert
 * the first awaited call is the requireExtensionAction manage gate. A positional
 * check (not mere presence) is apt because the security property is precisely
 * "the gate runs before anything else".
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
  // strip the wrapping braces → just the statements between them
  return source.slice(bodyStart + 1, i);
}

/**
 * Return the body with leading whitespace + line/block comments stripped, so the
 * remainder begins at the first EXECUTABLE statement. Asserting against THIS
 * (not merely the first `await`) closes the hole where a synchronous statement
 * (e.g. a getLinkedInDeps() read or a credential write) is slipped in before the
 * gate — which would still pass a first-`await` check.
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
  join(process.cwd(), "extensions/cinatra-ai/linkedin-connector/src/actions.ts"),
  "utf-8",
);
const GATE = `requireExtensionAction("@cinatra-ai/linkedin-connector", "manage")`;

describe("linkedin connection actions — extension manage gate", () => {
  for (const fnName of ["saveLinkedInConnectionAction", "deleteLinkedInAccountAction"]) {
    it(`${fnName}: the FIRST executable statement is the requireExtensionAction manage gate`, () => {
      const body = extractFunctionBody(SOURCE, fnName);
      // The very first executable statement (after any comments) must be exactly
      // the awaited manage gate — nothing may run before it.
      expect(firstExecutableStatement(body).startsWith(`await ${GATE};`)).toBe(true);
    });
  }
});
