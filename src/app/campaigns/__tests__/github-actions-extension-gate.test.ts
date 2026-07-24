/**
 * Security regression: saveGitHubOAuthSettingsForConnect + saveGitHubRepositorySelectionAction
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
 * asserts against the connector source by repo-relative path (mirrors
 * linkedin/apollo/nango).
 *
 * The connector's owner-reviewed rename (github-connector @ cb791b10) renamed
 * `saveGitHubConnectionAction` -> `saveGitHubOAuthSettingsForConnect` and
 * factored the package name into a module-level `const PACKAGE_NAME =
 * "@cinatra-ai/github-connector"`, so the gate now reads
 * `requireExtensionAction(PACKAGE_NAME, "manage")`. This test therefore
 * tolerates the gate's package argument being either the string literal OR an
 * identifier — and resolves an identifier through the TypeScript compiler's
 * TYPE CHECKER (real symbol/lexical-scope resolution, `getSymbolAtLocation`),
 * failing unless it resolves to exactly the github-connector package.
 *
 * Using the checker's symbol resolution (rather than any text/scope heuristic)
 * makes the assertion fail-closed and hard to spoof: a `const PACKAGE_NAME` in
 * a comment, in an unrelated nested function, or in a sibling block that does
 * not enclose the gate call is NOT the symbol the gate references; a parameter,
 * import, or non-string-literal binding does not resolve to a value. The
 * invariant is preserved, not loosened: the manage gate for THIS connector must
 * remain the verified first executable statement.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SOURCE_PATH = join(
  process.cwd(),
  "extensions/cinatra-ai/github-connector/src/actions.ts",
);
const FILE_NAME = "actions.ts";
const SOURCE_TEXT = readFileSync(SOURCE_PATH, "utf-8");

// A single-file Program with a minimal in-memory host. noLib/noResolve keep it
// fast and hermetic — identifier→declaration (binder/scope) resolution needs no
// lib.d.ts or module resolution.
const SF = ts.createSourceFile(
  FILE_NAME,
  SOURCE_TEXT,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TS,
);
const HOST: ts.CompilerHost = {
  getSourceFile: (name) => (name === FILE_NAME ? SF : undefined),
  getDefaultLibFileName: () => "lib.d.ts",
  writeFile: () => {},
  getCurrentDirectory: () => "",
  getCanonicalFileName: (f) => f,
  useCaseSensitiveFileNames: () => true,
  getNewLine: () => "\n",
  fileExists: (name) => name === FILE_NAME,
  readFile: (name) => (name === FILE_NAME ? SOURCE_TEXT : undefined),
};
const PROGRAM = ts.createProgram({
  rootNames: [FILE_NAME],
  options: { noResolve: true, noLib: true, types: [] },
  host: HOST,
});
const CHECKER = PROGRAM.getTypeChecker();
const EXPECTED_PACKAGE = "@cinatra-ai/github-connector";

function findTopLevelFunction(name: string): ts.FunctionDeclaration {
  const hit = SF.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  if (!hit) throw new Error(`fn ${name} not found as a top-level function declaration`);
  return hit;
}

/** Resolve an identifier at the gate call site to its bound string value (fail-closed). */
function resolveIdentifierValue(id: ts.Identifier): string | undefined {
  const symbol = CHECKER.getSymbolAtLocation(id);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isStringLiteralLike(decl.initializer)
  ) {
    return decl.initializer.text;
  }
  return undefined; // param / import / function / non-literal / unresolved ⇒ fail-closed
}

/**
 * The resolved package string IFF the function's FIRST statement is exactly
 * `await requireExtensionAction(<pkg>, "manage")` with <pkg> a string literal or
 * an identifier resolving (via the checker) to a string; otherwise undefined.
 */
function gatePackage(fn: ts.FunctionDeclaration): string | undefined {
  const stmt = fn.body?.statements[0];
  if (!stmt || !ts.isExpressionStatement(stmt)) return undefined;
  const expr = stmt.expression;
  if (!ts.isAwaitExpression(expr)) return undefined;
  const call = expr.expression;
  if (!ts.isCallExpression(call)) return undefined;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "requireExtensionAction") {
    return undefined;
  }
  const [pkgArg, actionArg] = call.arguments;
  if (!actionArg || !ts.isStringLiteralLike(actionArg) || actionArg.text !== "manage") {
    return undefined;
  }
  if (!pkgArg) return undefined;
  if (ts.isStringLiteralLike(pkgArg)) return pkgArg.text;
  if (ts.isIdentifier(pkgArg)) return resolveIdentifierValue(pkgArg);
  return undefined; // any other expression shape (member/call/etc.) ⇒ fail-closed
}

describe("github connection actions — extension manage gate", () => {
  for (const fnName of [
    "saveGitHubOAuthSettingsForConnect",
    "saveGitHubRepositorySelectionAction",
  ]) {
    it(`${fnName}: the FIRST executable statement is the requireExtensionAction manage gate for ${EXPECTED_PACKAGE}`, () => {
      const fn = findTopLevelFunction(fnName);
      expect(
        gatePackage(fn),
        `${fnName}: the first statement must be await requireExtensionAction(<pkg>, "manage") ` +
          `with <pkg> resolving (via the type checker) to ${EXPECTED_PACKAGE}`,
      ).toBe(EXPECTED_PACKAGE);
    });
  }
});
