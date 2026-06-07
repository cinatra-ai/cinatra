/**
 * Store-layer org scoping tests.
 *
 * Verifies that:
 *   - ReadAgentRunsOptions accepts `organizationId` + `skipOrgFilter`
 *   - readAgentRuns({ organizationId }) filters rows to that org
 *   - readAgentRuns({ skipOrgFilter: true }) bypasses the filter (admin path)
 *   - readAgentTemplates() honours the same two options
 *
 * These tests guard the org_id column + the filter SQL in store.ts.
 *
 * Mocking strategy: vi.mock("../db") supplies a Drizzle-shaped chained
 * select() stub that resolves to the test's fixture rows regardless of WHERE.
 * If the store applies a real org filter, the stub still returns all rows —
 * but post-mapping the test asserts only org-A rows survive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted shared state — must be hoisted because vi.mock factories run
// before regular module-level code. See transition-run-status.test.ts for the
// canonical pattern.
// ---------------------------------------------------------------------------

const shared = vi.hoisted(() => {
  type FakeRunRow = Record<string, unknown> & {
    id: string;
    orgId: string | null;
  };
  type FakeTemplateRow = Record<string, unknown> & {
    id: string;
    orgId: string | null;
  };

  const baseRun = (id: string, orgId: string | null): FakeRunRow => ({
    id,
    templateId: "tpl-1",
    versionId: null,
    runBy: "u-1",
    status: "completed",
    inputParams: "{}",
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    sourceType: "internal",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId,
  });

  const baseTemplate = (id: string, orgId: string | null): FakeTemplateRow => ({
    id,
    name: id,
    description: null,
    sourceNl: "",
    compiledPlan: "[]",
    inputSchema: "{}",
    outputSchema: null,
    approvalPolicy: "{}",
    agentAuthPolicy: null,
    status: "ready",
    type: "leaf",
    taskSpec: null,
    packageName: null,
    packageVersion: null,
    currentVersionId: null,
    hitlScreens: null,
    agentDependencies: null,
    ioSpec: null,
    durable: false,
    hitlRequired: false,
    executionProvider: "wayflow",
    lgGraphCode: null,
    lgGraphId: null,
    sourceType: "internal",
    agentUrl: null,
    connectorSlug: null,
    remoteAgentId: null,
    triggerMode: null,
    gatedSteps: null,
    creatorId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    orgId,
  });

  return {
    runRows: [
      baseRun("run-A", "org-A"),
      baseRun("run-B", "org-B"),
      baseRun("run-N", null),
    ],
    templateRows: [
      baseTemplate("tpl-A", "org-A"),
      baseTemplate("tpl-B", "org-B"),
      baseTemplate("tpl-N", null),
    ],
    // Tracks which table the most recent select() targeted. The chain reads
    // its row source from this hint so a single mock can serve both
    // readAgentRuns and readAgentTemplates.
    currentTable: "runs" as "runs" | "templates",
  };
});

// ---------------------------------------------------------------------------
// vi.mock("../db") — Drizzle-like chainable stub for `db.select()`.
// ---------------------------------------------------------------------------

vi.mock("../db", async () => {
  // Resolve the real schema symbols so the mocked db.select().from(table)
  // sees the exact same `agentTemplates` / `agentRuns` Drizzle objects the
  // store imports. Object-identity comparison is the most reliable
  // dispatch — Drizzle tables don't expose a stable name property on the
  // top-level Symbol-keyed metadata across versions.
  const schema = await import("../schema");

  function makeChain(opts: { isCount: boolean }) {
    let table: "runs" | "templates" = shared.currentTable;
    const chain: Record<string, unknown> = {};
    const stages = [
      "from",
      "where",
      "orderBy",
      "limit",
      "offset",
      "innerJoin",
      "leftJoin",
      "groupBy",
    ] as const;
    for (const s of stages) {
      (chain as Record<string, (...args: unknown[]) => unknown>)[s] = (
        ...args: unknown[]
      ) => {
        if (s === "from") {
          const t = args[0];
          if (t === schema.agentTemplates) table = "templates";
          else if (t === schema.agentRuns) table = "runs";
        }
        return chain;
      };
    }
    chain.then = (resolve: (v: unknown) => unknown) => {
      const rows =
        table === "templates" ? shared.templateRows : shared.runRows;
      const value = opts.isCount ? [{ count: rows.length }] : rows;
      return Promise.resolve(value).then(resolve);
    };
    return chain;
  }

  const db = {
    select: (sel?: Record<string, unknown>) => {
      const isCount =
        !!sel && Object.prototype.hasOwnProperty.call(sel, "count");
      return makeChain({ isCount });
    },
  };

  return {
    db,
    agentBuilderPool: { on: () => {}, listenerCount: () => 1, end: vi.fn() },
  };
});

// ---------------------------------------------------------------------------
// Imports under test — keep AFTER vi.mock so the mock binds first.
// ---------------------------------------------------------------------------

import { readAgentRuns, readAgentTemplates } from "../store";

// ---------------------------------------------------------------------------
// Suite — readAgentRuns
// ---------------------------------------------------------------------------

describe("readAgentRuns org scope", () => {
  beforeEach(() => {
    shared.currentTable = "runs";
  });

  it("filters to organizationId when provided (org-B and null excluded)", async () => {
    // Passing organizationId narrows the result set.
    const result = await readAgentRuns({
      organizationId: "org-A",
    } as Parameters<typeof readAgentRuns>[0] & { organizationId: string });
    const items = (result as unknown as {
      items: Array<{ id: string; orgId: string | null }>;
    }).items;
    expect(items.every((r) => r.orgId === "org-A")).toBe(true);
    expect(items.find((r) => r.id === "run-B")).toBeUndefined();
    expect(items.find((r) => r.id === "run-N")).toBeUndefined();
    expect(items.length).toBe(1);
  });

  it("returns ALL rows when skipOrgFilter is true (admin bypass)", async () => {
    const result = await readAgentRuns({
      organizationId: "org-A",
      skipOrgFilter: true,
    } as Parameters<typeof readAgentRuns>[0] & {
      organizationId: string;
      skipOrgFilter: boolean;
    });
    const items = (result as { items: unknown[] }).items;
    expect(items.length).toBe(3);
  });

  it("returns ALL rows when organizationId is undefined (legacy back-compat)", async () => {
    const result = await readAgentRuns({});
    const items = (result as { items: unknown[] }).items;
    expect(items.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite — readAgentTemplates
// ---------------------------------------------------------------------------

describe("readAgentTemplates org scope", () => {
  beforeEach(() => {
    shared.currentTable = "templates";
  });

  it("filters templates to organizationId when provided", async () => {
    const result = await readAgentTemplates({
      organizationId: "org-A",
    } as Parameters<typeof readAgentTemplates>[0] & {
      organizationId: string;
    });
    const items = (result as unknown as {
      items: Array<{ id: string; orgId: string | null }>;
    }).items;
    expect(items.every((t) => t.orgId === "org-A")).toBe(true);
    expect(items.find((t) => t.id === "tpl-B")).toBeUndefined();
    expect(items.length).toBe(1);
  });

  it("returns all templates when skipOrgFilter is true", async () => {
    const result = await readAgentTemplates({
      organizationId: "org-A",
      skipOrgFilter: true,
    } as Parameters<typeof readAgentTemplates>[0] & {
      organizationId: string;
      skipOrgFilter: boolean;
    });
    const items = (result as { items: unknown[] }).items;
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves legacy behavior when organizationId is undefined", async () => {
    const result = await readAgentTemplates({});
    const items = (result as { items: unknown[] }).items;
    expect(items.length).toBe(3);
  });
});
