/**
 * Security regression: the anthropic-connector's credential WRITE actions
 * (`saveConnection` / `clearConnection`, registered via ctx.ui.registerAction in
 * src/register.ts) MUST gate on the host action-guard service's
 * `guard.require(PACKAGE_NAME, "manage")` as the FIRST executable statement of
 * each handler, and the guard resolution MUST fail closed when the host service
 * is absent. The actions write/clear the Anthropic API connection (Nango
 * import) + the default Claude model, so an unprivileged caller must not be
 * able to overwrite them.
 *
 * At 0.1.4 the connector converted its settings UI to the schema-config DSL and
 * retired src/actions.ts: the manage boundary now lives in register.ts as a
 * lazily resolved host action-guard (the same value the SDK
 * `requireExtensionAction` slot binds — SDK VALUE imports are rejected in a
 * runtime serverEntry graph). This test pins that boundary the same way the
 * openai gate test pins its register.ts guard layer:
 *   1. requireManage resolves "@cinatra-ai/host:extension-action-guard" and
 *      THROWS when the service is missing (fail-closed, never a silent skip);
 *   2. requireManage delegates to `guard.require(PACKAGE_NAME, "manage")`;
 *   3. every credential WRITE handler's FIRST executable statement is
 *      `await requireManage();`;
 *   4. PACKAGE_NAME resolves to the anthropic-connector package id.
 *
 * This test lives under src/ (a root-vitest-covered, CI-pinned path) — NOT
 * co-located in the extension (the root vitest `include` does not cover
 * extensions/**) — so the security invariant is actually ENFORCED in CI. It
 * asserts against the connector source text by repo-relative path, using the
 * stronger firstExecutableStatement check (mirrors openai/github/linkedin).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Brace-matched block body starting at the first `{` at/after `from`. */
function extractBraceBlock(source: string, from: number): string {
  let i = source.indexOf("{", from);
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

/** Body of the `const requireManage = async ... => { ... }` arrow. */
function extractRequireManageBody(source: string): string {
  const at = source.indexOf("const requireManage = async");
  if (at === -1) throw new Error("requireManage not found");
  return extractBraceBlock(source, source.indexOf("=>", at));
}

/** Body of the `handler: async ...` immediately following `id: "<actionId>"`. */
function extractActionHandlerBody(source: string, actionId: string): string {
  const idAt = source.indexOf(`id: "${actionId}"`);
  if (idAt === -1) throw new Error(`action ${actionId} not found`);
  const handlerAt = source.indexOf("handler: async", idAt);
  if (handlerAt === -1) throw new Error(`handler for ${actionId} not found`);
  return extractBraceBlock(source, source.indexOf("=>", handlerAt));
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
  join(process.cwd(), "extensions/cinatra-ai/anthropic-connector/src/register.ts"),
  "utf-8",
);

describe("anthropic connection actions — register.ts manage gate", () => {
  it("requireManage resolves the host action-guard and FAILS CLOSED when it is absent", () => {
    const body = extractRequireManageBody(SOURCE);
    expect(body).toContain('"@cinatra-ai/host:extension-action-guard"');

    // Pin the fail-closed BRANCH structurally, not by substring: the
    // missing-guard check's block must open with a `throw` (a logged
    // early-return would pass a substring check while silently allowing the
    // ungated write to proceed).
    const checkAt = body.indexOf("if (!guard || typeof guard.require !== \"function\")");
    expect(checkAt, "missing-guard check present").toBeGreaterThanOrEqual(0);
    const branch = extractBraceBlock(body, checkAt);
    expect(
      firstExecutableStatement(branch).startsWith("throw new Error("),
      "missing-guard branch throws (fail-closed, never a logged skip)",
    ).toBe(true);

    // ...and the delegation to the guard happens AFTER the fail-closed check.
    const delegateAt = body.indexOf('await guard.require(PACKAGE_NAME, "manage");');
    expect(delegateAt, "manage delegation present").toBeGreaterThan(checkAt);
  });

  for (const actionId of ["saveConnection", "clearConnection"]) {
    it(`${actionId}: the FIRST executable statement is the requireManage gate`, () => {
      const body = extractActionHandlerBody(SOURCE, actionId);
      expect(firstExecutableStatement(body).startsWith("await requireManage();")).toBe(true);
    });
  }

  it("the gate targets the anthropic-connector package id", () => {
    expect(SOURCE).toContain('const PACKAGE_NAME = "@cinatra-ai/anthropic-connector";');
  });
});
