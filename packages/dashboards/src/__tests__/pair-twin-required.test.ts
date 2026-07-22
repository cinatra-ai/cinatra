/**
 * AST function-scope gate (cinatra#1894 B1b, item 5) — proves EVERY writer in
 * `mutation-service.ts` that performs a `dashboards` / `dashboard_revisions`
 * write ALSO pairs the artifact-substrate twin.
 *
 * Complements `no-direct-writes.test.ts` (which proves the mutation service is
 * the ONLY writer). Here, for each TOP-LEVEL function in the mutation service,
 * if its subtree (including nested `db.transaction(...)` / `withDashboardsTx(...)`
 * closures) contains a dashboards write, that same subtree must contain a
 * `pairTwin(...)` / `pairTwinBulk(...)` call — OR delegate exclusively to another
 * paired writer (no double-pairing on nested composition). A writer that adds a
 * dashboards write but forgets to pair the twin fails CI here.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const MUTATION_SERVICE = path.resolve(__dirname, "../mutation-service.ts");

const WRITE_TABLE_NAMES = new Set(["dashboards", "dashboardRevisions"]);
const WRITE_METHODS = new Set(["insert", "update", "delete"]);
const PAIR_CALLEES = new Set(["pairTwin", "pairTwinBulk"]);

/** The exported mutation-service writer names — a call to one of these counts as
 *  delegation (the callee pairs its own twin). Kept in sync via the gate's own
 *  "every writer pairs" assertion below. */
const KNOWN_WRITERS = new Set([
  "createDashboard",
  "updateDashboard",
  "publishDashboard",
  "archiveDashboard",
  "upsertDashboardConfig",
  "ensureOverview",
  "createEntityDashboard",
  "renameDashboard",
  "deleteEntityDashboard",
  "materializeExtensionTemplate",
  "materializeExtensionInstanceForProject",
  "archiveExtensionDashboards",
  "restoreExtensionDashboards",
  "adoptExtensionDashboards",
  "upgradeExtensionDashboards",
]);

function subtreeHasDashboardsWrite(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const arg0 = node.arguments[0];
      if (
        WRITE_METHODS.has(method) &&
        arg0 &&
        ts.isIdentifier(arg0) &&
        WRITE_TABLE_NAMES.has(arg0.text)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function subtreeHasPairOrDelegation(root: ts.Node, selfName: string | undefined): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (PAIR_CALLEES.has(callee)) {
        found = true;
        return;
      }
      if (callee !== selfName && KNOWN_WRITERS.has(callee)) {
        // Delegates to another paired writer.
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function topLevelFunctions(sf: ts.SourceFile): ts.FunctionDeclaration[] {
  return sf.statements.filter(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && !!s.body,
  );
}

describe("mutation-service pairs the artifact-substrate twin on every write path", () => {
  const source = fs.readFileSync(MUTATION_SERVICE, "utf-8");
  const sf = ts.createSourceFile(MUTATION_SERVICE, source, ts.ScriptTarget.ES2022, true);
  const fns = topLevelFunctions(sf);

  it("every top-level function that writes dashboards also pairs the twin (or delegates)", () => {
    const violations: string[] = [];
    for (const fn of fns) {
      const name = fn.name?.text;
      if (!subtreeHasDashboardsWrite(fn)) continue;
      if (!subtreeHasPairOrDelegation(fn, name)) {
        const { line } = sf.getLineAndCharacterOfPosition(fn.getStart(sf));
        violations.push(`  ${name ?? "<anonymous>"} (line ${line + 1}) writes dashboards but never pairs the twin`);
      }
    }
    expect(
      violations,
      `Found ${violations.length} unpaired writer(s). Every dashboards write must pair the twin ` +
        `(pairTwin / pairTwinBulk) in the SAME transaction:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("every KNOWN_WRITERS name is a real top-level writer that both writes and pairs", () => {
    const byName = new Map(fns.filter((f) => f.name).map((f) => [f.name!.text, f]));
    const missing: string[] = [];
    for (const w of KNOWN_WRITERS) {
      const fn = byName.get(w);
      if (!fn) {
        missing.push(`${w}: not found as a top-level function`);
        continue;
      }
      if (!subtreeHasDashboardsWrite(fn)) missing.push(`${w}: no dashboards write`);
      if (!subtreeHasPairOrDelegation(fn, w)) missing.push(`${w}: no twin pairing`);
    }
    expect(missing, `KNOWN_WRITERS drift:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the twin is paired at least once (sanity: the gate is wired to a real symbol)", () => {
    expect(source.includes("pairTwin(")).toBe(true);
    expect(source.includes("pairTwinBulk(")).toBe(true);
  });
});
