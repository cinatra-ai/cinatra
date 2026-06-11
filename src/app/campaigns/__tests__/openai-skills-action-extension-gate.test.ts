/**
 * Security regression: the OpenAI connector server actions MUST gate on the
 * manage permission as the FIRST executable statement. These actions write
 * workspace-wide OpenAI credentials + shell/skills runtime settings, so an
 * unprivileged caller must not be able to overwrite them.
 *
 * Post lazy/guarded host-access cutover the action BODIES live
 * in the connector's actions-core factory, parameterized by the manage guard;
 * the two build sites are (a) the "use server" actions.ts binding the SDK
 * `requireExtensionAction(OPENAI_PACKAGE_ID, "manage")` slot and (b) the
 * serverEntry register.ts binding the host's
 * `@cinatra-ai/host:extension-action-guard` service with the same fail-closed
 * semantics. This test pins ALL THREE layers against the source text:
 *   1. actions.ts binds the factory to the SDK manage gate (and the const
 *      resolves to the right package id);
 *   2. every actions-core body gates FIRST on `await requireManage();`;
 *   3. register.ts's injected guard calls `guard.require(PACKAGE_NAME,
 *      "manage")` and THROWS when the host service is absent (fail-closed).
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

const ACTIONS_SOURCE = readFileSync(
  join(process.cwd(), "extensions/cinatra-ai/openai-connector/src/actions.ts"),
  "utf-8",
);
const CORE_SOURCE = readFileSync(
  join(process.cwd(), "extensions/cinatra-ai/openai-connector/src/actions-core.ts"),
  "utf-8",
);
const REGISTER_SOURCE = readFileSync(
  join(process.cwd(), "extensions/cinatra-ai/openai-connector/src/register.ts"),
  "utf-8",
);

function extractCoreFunctionBody(source: string, fnName: string): string {
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

describe("openai connector actions — extension manage gate", () => {
  it("OPENAI_PACKAGE_ID resolves to the openai-connector package id", () => {
    expect(ACTIONS_SOURCE).toContain(`const OPENAI_PACKAGE_ID = "@cinatra-ai/openai-connector"`);
  });

  it('the "use server" build site binds the factory to the SDK manage gate', () => {
    expect(ACTIONS_SOURCE).toContain(
      `makeOpenAIConnectionActions(() =>
  requireExtensionAction(OPENAI_PACKAGE_ID, "manage"),
)`,
    );
  });

  for (const fnName of ["saveConnection", "clearConnection", "saveSkillsSettings"]) {
    it(`actions-core ${fnName}: the FIRST executable statement is the injected manage gate`, () => {
      const body = extractCoreFunctionBody(CORE_SOURCE, fnName);
      expect(firstExecutableStatement(body).startsWith("await requireManage();")).toBe(true);
    });
  }

  it("the serverEntry build site's guard requires manage on the right package and fails closed when absent", () => {
    expect(REGISTER_SOURCE).toContain('await guard.require(PACKAGE_NAME, "manage");');
    expect(REGISTER_SOURCE).toContain('const PACKAGE_NAME = "@cinatra-ai/openai-connector"');
    // Fail-closed branch: a missing host guard service throws BEFORE any body runs.
    expect(REGISTER_SOURCE).toMatch(
      /if \(!guard \|\| typeof guard\.require !== "function"\) \{[\s\S]{0,40}?throw new Error\(/,
    );
  });
});
