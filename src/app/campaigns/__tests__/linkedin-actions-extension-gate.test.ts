/**
 * Security regression: the save road of @cinatra-ai/linkedin-oauth-connector
 * (the action that writes the LinkedIn app credentials into the shared
 * connector-config row) MUST run the extension "manage" gate as its FIRST
 * executable statement, before any read or write. An unprivileged caller must
 * not be able to overwrite the stored credentials.
 *
 * This test lives under src/ (a root-vitest-covered path), NOT co-located in
 * the extension, so the security invariant is actually ENFORCED in CI (the root
 * vitest `include` does not cover extensions/**). It asserts against the
 * connector source text by repo-relative path, in whichever connector tree the
 * dev lock pins. It knows two layouts of that tree:
 *
 * - register layout: src/register.ts is the connector's `register(ctx)` server
 *   entry. It registers the setup form's named actions with
 *   ctx.ui.registerAction, and the save road is the "saveConnection" handler.
 *   The host dispatches those actions at the "use" tier only, so the handler
 *   re-checks "manage" itself: its first statement must be
 *   `await requireManage();`. requireManage must take the action guard from the
 *   host's own provider, throw when that guard is missing (fail closed), and
 *   otherwise await guard.require(PACKAGE_NAME, "manage").
 * - actions layout: src/actions.ts exports the server action
 *   saveLinkedInOAuthConnectionAction. Its first statement must be
 *   `await requireExtensionAction(PACKAGE_NAME, "manage");` (the SDK gate:
 *   org_owner/org_admin/platform_admin, fail-closed).
 *
 * Each layout whose file carries its save handler is checked. The test FAILS
 * CLOSED: when neither file carries a save handler, or a file names the handler
 * in a shape this test does not recognise, it fails. It never skips and never
 * passes on an empty set.
 *
 * Strategy: extract the handler body from the source text and assert that its
 * first executable statement is the awaited manage gate. A positional check
 * (not mere presence) is apt because the security property is precisely "the
 * gate runs before anything else".
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE = "@cinatra-ai/linkedin-oauth-connector";
const CONNECTOR_SRC = "extensions/cinatra-ai/linkedin-oauth-connector/src";
const REGISTER_PATH = `${CONNECTOR_SRC}/register.ts`;
const ACTIONS_PATH = `${CONNECTOR_SRC}/actions.ts`;

/** The text between the brace at `open` and its matching closing brace. */
function bodyFrom(source: string, open: number, what: string): string {
  if (source[open] !== "{") throw new Error(`${what}: no opening brace`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${what}: the body never closes`);
}

/** The body of the one match of `header`, a pattern that ends at the body's
 *  opening brace. Zero or several matches fail. */
function onlyBody(source: string, header: RegExp, what: string): string {
  const matches = [...source.matchAll(new RegExp(header.source, "g"))];
  if (matches.length !== 1) throw new Error(`${what}: expected 1 match, found ${matches.length}`);
  const m = matches[0];
  return bodyFrom(source, (m.index ?? 0) + m[0].length - 1, what);
}

/**
 * Return the body with leading whitespace + line/block comments stripped, so the
 * remainder begins at the first EXECUTABLE statement. Asserting against THIS
 * (not merely the first `await`) closes the hole where a synchronous statement
 * (e.g. a row read or a credential write) is slipped in before the gate, which
 * would still pass a first-`await` check.
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

/** Both layouts gate on the inlined PACKAGE_NAME constant. */
function expectPackageName(source: string, path: string): void {
  expect(source.includes(`const PACKAGE_NAME = "${PACKAGE}";`), `${path} defines PACKAGE_NAME as ${PACKAGE}`).toBe(true);
}

type Layout = { name: string; path: string; check: (source: string) => void };

const REGISTER_LAYOUT: Layout = {
  name: 'register layout: the "saveConnection" handler of src/register.ts',
  path: REGISTER_PATH,
  check(source) {
    expectPackageName(source, REGISTER_PATH);
    const handler = onlyBody(
      source,
      /registerAction\(\s*\{\s*id:\s*"saveConnection"\s*,\s*handler:\s*async\s*\([^)]*\)\s*(?::[^=]*)?=>\s*\{/,
      "saveConnection handler",
    );
    expect(firstExecutableStatement(handler).startsWith("await requireManage();")).toBe(true);

    const guard = onlyBody(
      source,
      /const\s+requireManage\s*=\s*async\s*\(\s*\)\s*(?::[^=]*)?=>\s*\{/,
      "requireManage",
    );
    // The guard comes from the host's own provider of the action-guard capability.
    expect(guard).toMatch(/hostProvider\(\s*ctx\s*,\s*"@cinatra-ai\/host:extension-action-guard"\s*\)/);
    // Fail closed: a missing guard (or one without require) throws.
    const failClosed = guard.search(
      /if\s*\(\s*!guard\s*\|\|\s*typeof\s+guard\.require\s*!==\s*"function"\s*\)\s*\{\s*throw\b/,
    );
    expect(failClosed).toBeGreaterThanOrEqual(0);
    // Then the manage check itself, after the fail-closed branch.
    const manageCheck = guard.indexOf(`await guard.require(PACKAGE_NAME, "manage");`);
    expect(manageCheck).toBeGreaterThan(failClosed);
    // Nothing may return early from, or swallow a refusal of, the gate.
    expect(guard).not.toMatch(/\b(return|try|catch)\b/);
  },
};

const ACTIONS_LAYOUT: Layout = {
  name: "actions layout: saveLinkedInOAuthConnectionAction of src/actions.ts",
  path: ACTIONS_PATH,
  check(source) {
    expectPackageName(source, ACTIONS_PATH);
    const body = onlyBody(
      source,
      /export\s+async\s+function\s+saveLinkedInOAuthConnectionAction\s*\([^)]*\)\s*(?::[^{]*)?\{/,
      "saveLinkedInOAuthConnectionAction",
    );
    // The very first executable statement (after any comments) must be exactly
    // the awaited manage gate; nothing may run before it.
    expect(firstExecutableStatement(body).startsWith(`await requireExtensionAction(PACKAGE_NAME, "manage");`)).toBe(
      true,
    );
  },
};

/** A file carries a layout's save handler when it names that handler at all;
 *  a named handler in an unrecognised shape then fails its check. */
function carries(layout: Layout, source: string): boolean {
  return layout === REGISTER_LAYOUT
    ? /\bid:\s*"saveConnection"/.test(source)
    : source.includes("saveLinkedInOAuthConnectionAction");
}

function readIfPresent(path: string): string | null {
  const abs = join(process.cwd(), path);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
}

const FOUND = [REGISTER_LAYOUT, ACTIONS_LAYOUT].flatMap((layout) => {
  const source = readIfPresent(layout.path);
  return source !== null && carries(layout, source) ? [{ layout, source }] : [];
});

describe("linkedin oauth connector save road — extension manage gate", () => {
  it("the pinned connector tree carries a recognisable save handler (fail closed)", () => {
    expect(
      FOUND.map((f) => f.layout.path),
      `neither ${REGISTER_PATH} nor ${ACTIONS_PATH} carries the save handler`,
    ).not.toEqual([]);
  });

  for (const { layout, source } of FOUND) {
    it(`${layout.name}: the FIRST executable statement is the manage gate`, () => {
      layout.check(source);
    });
  }
});
