/**
 * AST-based regression gate — proves NO file outside
 * `mutation-service.ts` writes to the `dashboards` or `dashboard_revisions`
 * Drizzle tables directly.
 *
 * Walks every `.ts` / `.tsx` file under `packages/dashboards/src/` and
 * `src/app/` and flags `CallExpression` nodes that look like:
 *
 *   <anything>.insert(dashboards)
 *   <anything>.update(dashboards)
 *   <anything>.delete(dashboards)
 *   <anything>.insert(dashboardRevisions)
 *   ... etc
 *
 * The mutation service, the migrations file, fixtures, and test files
 * themselves are allowlisted.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
// Repo-wide scope — any new package added in a later phase is caught
// automatically. Excludes node_modules, .next, .git, .claude/worktrees.
const TARGET_DIRS = [
  path.join(REPO_ROOT, "packages"),
  path.join(REPO_ROOT, "src"),
];
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  ".cache",
  ".turbo",
]);
const ALLOWLIST_SUFFIXES = [
  "packages/dashboards/src/mutation-service.ts",
  "src/lib/drizzle-store.ts", // migrations (raw SQL strings, not the Drizzle write API)
];
const WRITE_TABLE_NAMES = new Set(["dashboards", "dashboardRevisions"]);
const WRITE_METHODS = new Set(["insert", "update", "delete"]);

function isAllowlisted(file: string): boolean {
  if (file.includes("/__tests__/") || file.endsWith(".test.ts") || file.endsWith(".fixture.ts")) {
    return true;
  }
  return ALLOWLIST_SUFFIXES.some((s) => file.endsWith(s) || file.includes(s));
}

function walkDir(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, acc);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

type Violation = { readonly file: string; readonly line: number; readonly snippet: string };

function findViolations(file: string): Violation[] {
  const source = fs.readFileSync(file, "utf-8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const out: Violation[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      if (WRITE_METHODS.has(methodName) && node.arguments.length >= 1) {
        const firstArg = node.arguments[0];
        if (ts.isIdentifier(firstArg) && WRITE_TABLE_NAMES.has(firstArg.text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.push({
            file,
            line: line + 1,
            snippet: source.split("\n")[line]?.trim() ?? "",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

describe("no direct writes to dashboards / dashboard_revisions outside the mutation service", () => {
  it("only the mutation service may call .insert/.update/.delete on these tables", () => {
    const allFiles = TARGET_DIRS.flatMap((d) => walkDir(d));
    const violations: Violation[] = [];
    for (const file of allFiles) {
      if (isAllowlisted(file)) continue;
      violations.push(...findViolations(file));
    }
    expect(
      violations,
      `Found ${violations.length} direct-write violation(s). Route all dashboard mutations through packages/dashboards/src/mutation-service.ts:\n${violations
        .map((v) => `  ${v.file}:${v.line}\n    ${v.snippet}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
