// cinatra#3092 — the one twin-context constructor carries the dashboard's
// configuration, so every pairing path writes a revision WITH its record.
//
// (b1) drives the REAL writers (`createDashboard`, `deleteEntityDashboard`)
// against a fake dashboards transaction with a RECORDING twin registered in
// the fail-closed seam, and reads the context each one hands the twin.
// (b2) is the per-kind census: an AST scan of `mutation-service.ts`, in the
// shape of `pair-twin-required.test.ts`, proving every twin context is built by
// the one constructor `twinCtx`, so no pairing path can write a revision
// without the record.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const state = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  lockedRow: null as Record<string, unknown> | null,
  kernelAnswers: {
    organization: { archivedAt: null } as { archivedAt: string | null } | null,
  },
}));

vi.mock("../store/db", async () => {
  // The sanctioned kernel test fakes answer the guard's own queries; every
  // other statement reaches the small fake below (the shape
  // create-dashboard-anchor-1738.test.ts uses, plus a chainable select).
  const { wrapTxWithOrgWriteKernel } = await import("@cinatra-ai/org-write-kernel/testing");
  const insert = () => ({
    values: (v: Record<string, unknown>) => {
      state.inserted.push(v);
      const p = Promise.resolve([v]);
      return Object.assign(p, { returning: async () => [v] });
    },
  });
  // `select()` (the row lock) answers the locked row; `select({ organizationId })`
  // (the tenancy pre-read) answers its org; any other projection (the workspace
  // grant links) answers no rows.
  const select = (fields?: Record<string, unknown>) => {
    const rows =
      fields === undefined
        ? state.lockedRow
          ? [state.lockedRow]
          : []
        : Object.keys(fields).length === 1 && "organizationId" in fields
          ? state.lockedRow
            ? [{ organizationId: state.lockedRow.organizationId }]
            : []
          : [];
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "for", "limit"]) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return chain;
  };
  const del = () => ({ where: async () => undefined });
  const tx = wrapTxWithOrgWriteKernel(
    { insert, select, delete: del, execute: async () => ({ rows: [] }) },
    state.kernelAnswers,
  );
  return {
    auditEvents: {},
    dashboardEntityLinks: {},
    dashboardRevisions: {},
    dashboards: {},
    getDashboardsDb: () => ({
      select,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    }),
  };
});

import { createDashboard, deleteEntityDashboard } from "../mutation-service";
import type { DashboardActor } from "../permissions";
import {
  resetDashboardArtifactTwinWriter,
  setDashboardArtifactTwinWriter,
  type DashboardTwinContext,
} from "../twin-writer-seam";

const ORG = "org-1";
const TEAM = "team-1";

const actor: DashboardActor = {
  userId: "user-1",
  organizationId: ORG,
  teamIds: [TEAM],
  orgRole: "admin",
  teamRoles: { [TEAM]: "admin" },
  authority: { orgId: ORG, can: (c) => c === "content.write" },
};

// A bare drizzle-cube body (the shape agents emit; the writer wraps it into the
// apiVersion 1.2 envelope before the row is written).
const DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

const STORED_CONFIGURATION = {
  apiVersion: "1.2",
  scopeLevel: "team",
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

let recorded: DashboardTwinContext[] = [];
const recordingTwin = async (_tx: unknown, ctx: DashboardTwinContext): Promise<void> => {
  recorded.push(ctx);
};

beforeEach(() => {
  state.inserted = [];
  state.lockedRow = null;
  state.kernelAnswers.organization = { archivedAt: null };
  recorded = [];
  // The suite setup registered the NOOP twin; swap in the recorder (the setup's
  // afterEach resets the seam again).
  resetDashboardArtifactTwinWriter();
  setDashboardArtifactTwinWriter(recordingTwin);
});

afterAll(() => {
  resetDashboardArtifactTwinWriter();
  vi.doUnmock("../store/db");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("(b1) the twin context carries the just-written row's configuration (cinatra#3092)", () => {
  it("an upsert (create) hands the twin the written row's configJson as its configuration", async () => {
    const row = await createDashboard(
      { name: "Ops board", config: DC, ownerLevel: "team", ownerId: TEAM },
      actor,
    );
    const written = state.inserted.find((r) => "ownerLevel" in r);
    expect(written?.configJson).toBeDefined();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].operation).toBe("upsert");
    expect(recorded[0].dashboardId).toBe(row.id);
    expect(recorded[0].configuration).toEqual(written!.configJson);
  });

  it("a delete hands the twin no configuration", async () => {
    state.lockedRow = {
      id: "dash-del-1",
      name: "Ops board",
      description: null,
      configJson: STORED_CONFIGURATION,
      configVersion: "1.2",
      dashboardVersion: 1,
      publishedRevisionNumber: null,
      ownerLevel: "team",
      ownerId: TEAM,
      organizationId: ORG,
      status: "draft",
      createdBy: "user-1",
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      publishedAt: null,
      archivedAt: null,
      projectId: null,
      extensionId: null,
      isTemplate: false,
      templateScope: null,
      entityType: "team",
      entityId: TEAM,
      isDefault: false,
      contributionId: null,
      appliedContributionVersion: null,
      appliedDefaultJson: null,
      appliedDefaultHash: null,
      archiveReason: null,
    };
    await deleteEntityDashboard("dash-del-1", actor);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].operation).toBe("delete");
    expect(recorded[0].dashboardId).toBe("dash-del-1");
    expect(recorded[0].configuration).toBeUndefined();
    expect("configuration" in recorded[0]).toBe(false);
  });
});

describe("(b2) every twin context is built by the one constructor (cinatra#3092 census)", () => {
  const MUTATION_SERVICE = path.resolve(__dirname, "../mutation-service.ts");
  const source = fs.readFileSync(MUTATION_SERVICE, "utf-8");
  const sf = ts.createSourceFile(MUTATION_SERVICE, source, ts.ScriptTarget.ES2022, true);
  const PAIRING = new Set(["pairTwin", "pairTwinBulk", "pairTwinUnlessWorkspaceRow"]);

  type Site = { callee: string; writer: string; line: number; node: ts.CallExpression };

  function enclosingFunctionName(node: ts.Node): string {
    let n: ts.Node | undefined = node.parent;
    let name = "<top>";
    while (n) {
      if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
      n = n.parent;
    }
    return name;
  }

  const sites: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      PAIRING.has(node.expression.text)
    ) {
      sites.push({
        callee: node.expression.text,
        writer: enclosingFunctionName(node),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        node,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  it("every pairTwin call receives its context straight from twinCtx(...)", () => {
    const pairTwinCalls = sites.filter((s) => s.callee === "pairTwin");
    expect(pairTwinCalls.length).toBeGreaterThan(0);
    const handBuilt = pairTwinCalls
      .filter((s) => {
        const ctxArg = s.node.arguments[1];
        return !(
          ctxArg &&
          ts.isCallExpression(ctxArg) &&
          ts.isIdentifier(ctxArg.expression) &&
          ctxArg.expression.text === "twinCtx"
        );
      })
      .map((s) => `  ${s.writer} (line ${s.line})`);
    expect(handBuilt, `pairTwin with a context not built by twinCtx:\n${handBuilt.join("\n")}`).toEqual([]);
  });

  it("pairTwinBulk and pairTwinUnlessWorkspaceRow build theirs the same way (they hand twinCtx a row)", () => {
    for (const helper of ["pairTwinBulk", "pairTwinUnlessWorkspaceRow"]) {
      const inner = sites.filter((s) => s.writer === helper);
      expect(inner.map((s) => s.callee), `${helper} pairs through pairTwin`).toEqual(["pairTwin"]);
      // Its callers pass a row (an identifier or row list), never a context literal.
      const callers = sites.filter((s) => s.callee === helper);
      expect(callers.length, `${helper} has callers`).toBeGreaterThan(0);
      for (const c of callers) {
        expect(ts.isObjectLiteralExpression(c.node.arguments[1]), `${c.writer} line ${c.line}`).toBe(false);
      }
    }
  });

  it("twinCtx is the only builder of a DashboardTwinContext in the mutation service", () => {
    const builders: string[] = [];
    const looksLikeContext = (node: ts.ObjectLiteralExpression): boolean => {
      const names = new Set(
        node.properties
          .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : null))
          .filter((n): n is string => n !== null),
      );
      return names.has("operation") && names.has("dashboardId");
    };
    const scan = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && looksLikeContext(node)) {
        builders.push(enclosingFunctionName(node));
      }
      ts.forEachChild(node, scan);
    };
    scan(sf);
    expect(builders).toEqual(["twinCtx"]);
    const ctxFns = sf.statements.filter(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.type?.getText(sf) === "DashboardTwinContext",
    );
    expect(ctxFns.map((f) => f.name?.text)).toEqual(["twinCtx"]);
  });

  it("the census enumerates a pairing on every upsert kind and the delete", () => {
    const outer = sites.filter(
      (s) => s.writer !== "pairTwinBulk" && s.writer !== "pairTwinUnlessWorkspaceRow",
    );
    const writers = new Set(outer.map((s) => s.writer));
    const census = outer.map((s) => `${s.writer}:${s.callee}@${s.line}`).join("\n");
    for (const kind of [
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
      "pairOneUntwinnedDashboardTwin",
    ]) {
      expect(writers.has(kind), `no twin pairing found in ${kind}; census:\n${census}`).toBe(true);
    }
  });
});
