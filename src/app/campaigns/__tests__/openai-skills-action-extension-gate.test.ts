/**
 * Security regression: the OpenAI connector server actions MUST gate on the
 * manage permission as the FIRST executable statement. These actions write
 * workspace-wide OpenAI credentials, so an unprivileged caller must not be able
 * to overwrite them.
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
 *   2. every SURVIVING actions-core body gates FIRST on `await requireManage();`
 *      — the surviving gated surface is exactly saveConnection + clearConnection;
 *   3. register.ts's injected guard calls `guard.require(PACKAGE_NAME,
 *      "manage")` and THROWS when the host service is absent (fail-closed).
 *
 * REMOVAL PIN (openai-connector 0.1.9, cinatra#1715): the connector retired its
 * `saveSkillsSettings` action (skills administration is moving connector-side —
 * delivery rides the #1967 registration channel; setup-page ownership is the
 * #1104/#1926 track) and the host `saveOpenAISkillsSettingsAction` wrapper that
 * reached it was removed with it. An ungated skills mutation re-appearing is a
 * privilege-escalation regression, so this gate now also asserts the ABSENCE of
 * that action on BOTH sides — the connector body AND the host wrapper — turning
 * the removal into a pinned regression rather than a coincidence.
 *
 * This test lives under src/ (root-vitest-covered, CI-pinned) and asserts against
 * the connector + host source text by repo-relative path, using the stronger
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
// Host-side wrapper module: the removal pin below asserts the retired
// `saveOpenAISkillsSettingsAction` wrapper is gone from here (no ungated
// host reach-around to the connector's removed skills mutation).
const HOST_ACTIONS_SOURCE = readFileSync(
  join(process.cwd(), "src/app/campaigns/actions.ts"),
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

  // The surviving gated surface is exactly these two — saveSkillsSettings was
  // retired (see the REMOVAL PIN below).
  for (const fnName of ["saveConnection", "clearConnection"]) {
    it(`actions-core ${fnName}: the FIRST executable statement is the injected manage gate`, () => {
      const body = extractCoreFunctionBody(CORE_SOURCE, fnName);
      expect(firstExecutableStatement(body).startsWith("await requireManage();")).toBe(true);
    });
  }

  // REMOVAL PIN (openai-connector 0.1.9, cinatra#1715): the connector's
  // `saveSkillsSettings` action AND the host `saveOpenAISkillsSettingsAction`
  // wrapper that reached it were removed together (skills administration moved
  // connector-side). Re-introducing either — especially an ungated one — is a
  // privilege-escalation regression, so pin the ABSENCE on both sides.
  it("the connector actions-core no longer defines a saveSkillsSettings action", () => {
    expect(CORE_SOURCE).not.toContain("saveSkillsSettings");
  });

  it("the host campaigns actions no longer export or wire a skills-settings action", () => {
    // No exported host wrapper of that name...
    expect(HOST_ACTIONS_SOURCE).not.toContain(
      "export async function saveOpenAISkillsSettingsAction",
    );
    // ...and no host reach-around to the connector surface's removed action.
    expect(HOST_ACTIONS_SOURCE).not.toMatch(/actions\?\.saveSkillsSettings/);
  });

  it("the serverEntry build site's guard requires manage on the right package and fails closed when absent", () => {
    expect(REGISTER_SOURCE).toContain('await guard.require(PACKAGE_NAME, "manage");');
    expect(REGISTER_SOURCE).toContain('const PACKAGE_NAME = "@cinatra-ai/openai-connector"');
    // Fail-closed branch: a missing host guard service throws BEFORE any body runs.
    expect(REGISTER_SOURCE).toMatch(
      /if \(!guard \|\| typeof guard\.require !== "function"\) \{[\s\S]{0,40}?throw new Error\(/,
    );
  });
});
