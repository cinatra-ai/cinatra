// cinatra#3092 (finding A2) — a dashboard an agent RUN writes names that run as
// its producer, so the review gate binds to a real run and the run page finds it.
//
// (a) the MCP actor carries the frame's run: `narrowRunId` keeps a non-empty
//     string only, and the dashboards MCP `dashboards_create` hands the twin
//     the run the request envelope carries;
// (b) the content writers (create, update, publish) hand the twin
//     `producerRunId` from the actor; a person's write (no run) hands none;
// (c) census: ONLY those three writers pass a producing run, so no lifecycle
//     write (archive, restore, rename, adopt, upgrade, backfill) is announced
//     as a run's product; and the registry forwards the frame's run id.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const state = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  kernelAnswers: {
    organization: { archivedAt: null } as { archivedAt: string | null } | null,
  },
}));

vi.mock("../store/db", async () => {
  // The same small fake twin-pinned-configuration.test.ts uses: the sanctioned
  // kernel test fakes answer the guard's own queries; inserts are recorded.
  const { wrapTxWithOrgWriteKernel } = await import("@cinatra-ai/org-write-kernel/testing");
  const insert = () => ({
    values: (v: Record<string, unknown>) => {
      state.inserted.push(v);
      // RETURNING carries the columns' database defaults: created_at and
      // updated_at are `defaultNow()` in store/schema.ts, so the returned row
      // has them although the insert names neither. The MCP handler's toDto
      // reads both (mcp/handlers.ts toDto).
      const now = new Date();
      const row = { createdAt: now, updatedAt: now, ...v };
      const p = Promise.resolve([row]);
      return Object.assign(p, { returning: async () => [row] });
    },
  });
  const select = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "for", "limit"]) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve([]).then(res, rej);
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

import { createDashboard } from "../mutation-service";
import { createDashboardPrimitiveHandlers, narrowRunId } from "../mcp/handlers";
import type { DashboardActor } from "../permissions";
import {
  resetDashboardArtifactTwinWriter,
  setDashboardArtifactTwinWriter,
  type DashboardTwinContext,
} from "../twin-writer-seam";

const ORG = "org-1";
const TEAM = "team-1";
const RUN = "run-9";

const authority = { orgId: ORG, can: (c: string) => c === "content.write" };

const personActor: DashboardActor = {
  userId: "user-1",
  organizationId: ORG,
  teamIds: [TEAM],
  orgRole: "admin",
  teamRoles: { [TEAM]: "admin" },
  authority: authority as DashboardActor["authority"],
};
const runActor: DashboardActor = { ...personActor, runId: RUN };

const DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

let recorded: DashboardTwinContext[] = [];
const recordingTwin = async (_tx: unknown, ctx: DashboardTwinContext): Promise<void> => {
  recorded.push(ctx);
};

beforeEach(() => {
  state.inserted = [];
  state.kernelAnswers.organization = { archivedAt: null };
  recorded = [];
  resetDashboardArtifactTwinWriter();
  setDashboardArtifactTwinWriter(recordingTwin);
});

afterAll(() => {
  resetDashboardArtifactTwinWriter();
  vi.doUnmock("../store/db");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("(a) the MCP actor carries the frame's run (cinatra#3092)", () => {
  it("narrowRunId keeps a non-empty string only", () => {
    expect(narrowRunId("run-1")).toBe("run-1");
    expect(narrowRunId("")).toBeUndefined();
    expect(narrowRunId(undefined)).toBeUndefined();
    expect(narrowRunId(null)).toBeUndefined();
    expect(narrowRunId(42)).toBeUndefined();
    expect(narrowRunId({ id: "run-1" })).toBeUndefined();
  });

  it("dashboards_create hands the twin the run the request envelope carries", async () => {
    const handlers = createDashboardPrimitiveHandlers();
    const result = (await handlers.dashboards_create({
      primitiveName: "dashboards_create",
      input: { name: "Run board", config: DC, ownerLevel: "team", ownerId: TEAM },
      actor: {
        actorType: "model",
        source: "agent",
        userId: "user-1",
        orgId: ORG,
        orgRole: "org_admin",
        teamIds: [TEAM],
        teamRoles: { [TEAM]: "admin" },
        orgWriteAuthority: authority,
        runId: RUN,
      },
      mode: "agentic",
    } as never)) as { dashboard?: { id: string }; error?: unknown };
    expect(result.error).toBeUndefined();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].producerRunId).toBe(RUN);
  });
});

describe("(b) the content writers hand the twin the producing run (cinatra#3092)", () => {
  it("createDashboard by a run's actor names the run", async () => {
    const row = await createDashboard(
      { name: "Run board", config: DC, ownerLevel: "team", ownerId: TEAM },
      runActor,
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0].dashboardId).toBe(row.id);
    expect(recorded[0].operation).toBe("upsert");
    expect(recorded[0].producerRunId).toBe(RUN);
  });

  it("createDashboard by a person names no run", async () => {
    await createDashboard(
      { name: "Person board", config: DC, ownerLevel: "team", ownerId: TEAM },
      personActor,
    );
    expect(recorded).toHaveLength(1);
    expect("producerRunId" in recorded[0]).toBe(false);
  });
});

describe("(c) census: only the content writers pass a producing run (cinatra#3092)", () => {
  const MUTATION_SERVICE = path.resolve(__dirname, "../mutation-service.ts");
  const source = fs.readFileSync(MUTATION_SERVICE, "utf-8");
  const sf = ts.createSourceFile(MUTATION_SERVICE, source, ts.ScriptTarget.ES2022, true);

  function enclosingFunctionName(node: ts.Node): string {
    let n: ts.Node | undefined = node.parent;
    let name = "<top>";
    while (n) {
      if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
      n = n.parent;
    }
    return name;
  }

  it("producerRunId is passed by createDashboard, updateDashboard and publishDashboard only", () => {
    const writers = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "twinCtx" ||
          node.expression.text === "pairTwinUnlessWorkspaceRow")
      ) {
        const passes = node.arguments.some(
          (a) =>
            ts.isObjectLiteralExpression(a) &&
            a.properties.some(
              (p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "producerRunId",
            ),
        );
        if (passes) writers.add(enclosingFunctionName(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect([...writers].sort()).toEqual(["createDashboard", "publishDashboard", "updateDashboard"]);
  });

  it("every producerRunId a writer passes is the actor's own run", () => {
    const matches = source.match(/producerRunId: [A-Za-z.]+/g) ?? [];
    const passed = matches.filter((m) => !m.startsWith("producerRunId: opts"));
    expect(passed.length).toBe(3);
    for (const m of passed) expect(m).toBe("producerRunId: actor.runId");
  });

  it("the dashboards MCP registry forwards the frame's run id onto the actor", () => {
    const registry = fs.readFileSync(path.resolve(__dirname, "../mcp/registry.ts"), "utf-8");
    expect(registry).toContain("if (requestCtx?.runId) actorBase.runId = requestCtx.runId;");
  });

  it("the dashboards MCP registry takes the request frame from its own subpath, not the package barrel", () => {
    // The barrel (src/index.tsx) also holds the MCP screens; the frame store is
    // the same object, exported by the request-context subpath.
    const registry = fs.readFileSync(path.resolve(__dirname, "../mcp/registry.ts"), "utf-8");
    expect(registry).toContain('import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server/request-context";');
    expect(registry).not.toMatch(/^import \{[^}]*\} from "@cinatra-ai\/mcp-server";$/m);
  });
});
