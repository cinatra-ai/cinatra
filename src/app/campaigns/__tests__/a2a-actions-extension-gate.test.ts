/**
 * Security regression: addA2AConnectionAction + removeA2AConnectionAction MUST
 * gate on requireExtensionAction("@cinatra-ai/a2a-server-connector", "manage") as
 * the FIRST executable statement. They write/remove a Nango connection record +
 * an external-agent-template row, so an unprivileged caller must not reach them.
 *
 * The a2a-server-connector is decoupled: the actions do not import
 * @cinatra-ai/nango-connector or @cinatra-ai/agents by name — they resolve a
 * host-injected provider via the SDK's requireA2AConnectionProvider(), gated
 * behind requireExtensionAction (a2a-server IS a catalog connector). The provider
 * is resolved only AFTER the manage gate.
 *
 * This test lives under src/ (root-vitest-covered, CI-pinned) and asserts against
 * the connector source by repo-relative path, using firstExecutableStatement
 * (mirrors linkedin/apollo/nango/github/openai).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function extractFunctionBody(source: string, fnName: string): string {
  // These actions are non-exported inline form actions (`async function …`) co-located
  // with the render component, so match `async function` (covers `export` too).
  const marker = `async function ${fnName}`;
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
    } else if (s.startsWith('"use server"') || s.startsWith("'use server'")) {
      // These actions live in the same file as the render component, so each is
      // marked with an INLINE "use server" directive — not an executable statement.
      const semi = s.indexOf(";");
      s = semi === -1 ? "" : s.slice(semi + 1);
    }
    if (s === before) break;
  }
  return s;
}

const SOURCE = readFileSync(
  join(process.cwd(), "extensions/cinatra-ai/a2a-server-connector/src/a2a-server-setup-impl.tsx"),
  "utf-8",
);
const GATE = `requireExtensionAction("@cinatra-ai/a2a-server-connector", "manage")`;

describe("a2a-server connection actions — extension manage gate", () => {
  for (const fnName of ["addA2AConnectionAction", "removeA2AConnectionAction"]) {
    it(`${fnName}: the FIRST executable statement is the requireExtensionAction manage gate`, () => {
      const body = extractFunctionBody(SOURCE, fnName);
      expect(firstExecutableStatement(body).startsWith(`await ${GATE};`)).toBe(true);
    });
  }
});
