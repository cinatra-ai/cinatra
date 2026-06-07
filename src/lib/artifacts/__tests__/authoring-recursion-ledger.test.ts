/**
 * Authoring recursion ledger unit tests.
 *
 *   npx vitest run src/lib/artifacts/__tests__/authoring-recursion-ledger.test.ts
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { runPgMock } = vi.hoisted(() => ({
  runPgMock: vi.fn(),
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPgMock,
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));

import {
  recordAuthoringInvocation,
  markAuthoringInvocationCommitted,
  markAuthoringInvocationAborted,
  getAuthoringChain,
  getConfiguredMaxDepth,
} from "../authoring-recursion-ledger";

type Row = Record<string, unknown>;

function rowsForChain(rows: Row[]) {
  return [{ rows, rowCount: rows.length }];
}

const ORG = "org-a";

beforeEach(() => {
  runPgMock.mockReset();
});

afterEach(() => {
  delete process.env.CINATRA_AUTHORING_MAX_DEPTH;
});

describe("recordAuthoringInvocation — root step (no parent)", () => {
  it("inserts a root step at depth 0 when parentStepId is null", () => {
    // First call: loadParentChain returns no rows (parentStepId=null
    // short-circuits inside the service — no SQL is even issued).
    // Second call: INSERT.
    runPgMock.mockReturnValueOnce([{ rows: [], rowCount: 1 }]); // INSERT result
    const res = recordAuthoringInvocation({
      orgId: ORG,
      parentStepId: null,
      extension: "@cinatra-ai/marketing-icp-artifact",
      runId: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.depth).toBe(0);
    expect(res.stepId).toMatch(/^aut_/);
    // Only one mock call — the INSERT (no SELECT chain walk for null parent).
    expect(runPgMock).toHaveBeenCalledTimes(1);
    const insertCall = runPgMock.mock.calls[0][0];
    expect(insertCall.queries[0].text).toMatch(/INSERT INTO/);
    expect(insertCall.queries[0].values).toEqual([
      res.stepId,
      ORG,
      null,
      "@cinatra-ai/marketing-icp-artifact",
      0,
      null,
    ]);
  });
});

describe("recordAuthoringInvocation — chained step (with parent)", () => {
  it("computes depth from the parent chain length", () => {
    // Mock the CTE to return a 2-deep chain (root + immediate parent).
    runPgMock.mockReturnValueOnce(
      rowsForChain([
        {
          authoring_step_id: "aut_root",
          org_id: ORG,
          parent_step_id: null,
          extension: "@cinatra-ai/brand-voice-artifact",
          depth: 0,
          run_id: null,
          status: "open",
          started_at: "2026-05-19T09:00:00Z",
          completed_at: null,
        },
        {
          authoring_step_id: "aut_parent",
          org_id: ORG,
          parent_step_id: "aut_root",
          extension: "@cinatra-ai/competitive-analysis-artifact",
          depth: 1,
          run_id: null,
          status: "open",
          started_at: "2026-05-19T09:01:00Z",
          completed_at: null,
        },
      ]),
    );
    // INSERT.
    runPgMock.mockReturnValueOnce([{ rows: [], rowCount: 1 }]);

    const res = recordAuthoringInvocation({
      orgId: ORG,
      parentStepId: "aut_parent",
      extension: "@cinatra-ai/marketing-icp-artifact",
      runId: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.depth).toBe(2);
  });

  it("rejects with reason='cycle' when extension already on parent chain", () => {
    runPgMock.mockReturnValueOnce(
      rowsForChain([
        {
          authoring_step_id: "aut_root",
          org_id: ORG,
          parent_step_id: null,
          extension: "@cinatra-ai/marketing-icp-artifact",
          depth: 0,
          run_id: null,
          status: "open",
          started_at: "2026-05-19T09:00:00Z",
          completed_at: null,
        },
        {
          authoring_step_id: "aut_parent",
          org_id: ORG,
          parent_step_id: "aut_root",
          extension: "@cinatra-ai/brand-voice-artifact",
          depth: 1,
          run_id: null,
          status: "open",
          started_at: "2026-05-19T09:01:00Z",
          completed_at: null,
        },
      ]),
    );
    const res = recordAuthoringInvocation({
      orgId: ORG,
      parentStepId: "aut_parent",
      extension: "@cinatra-ai/marketing-icp-artifact", // same as root
      runId: null,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("cycle");
    expect(res.detail).toMatch(/marketing-icp-artifact/);
    // No INSERT issued.
    expect(runPgMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with reason='parent-not-found' when parentStepId is non-null but chain walk returns empty", () => {
    // CTE returns no rows — parent is dangling.
    runPgMock.mockReturnValueOnce([{ rows: [], rowCount: 0 }]);
    const res = recordAuthoringInvocation({
      orgId: ORG,
      parentStepId: "aut_DANGLING",
      extension: "@cinatra-ai/marketing-icp-artifact",
      runId: null,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("parent-not-found");
    expect(res.detail).toMatch(/aut_DANGLING/);
    // NO INSERT issued — only the CTE walk.
    expect(runPgMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with reason='depth-cap-exceeded' when chain length >= cap", () => {
    process.env.CINATRA_AUTHORING_MAX_DEPTH = "2";
    // Build a 3-deep chain (depth=0/1/2). Adding a 4th would be depth=3
    // which exceeds the cap=2.
    runPgMock.mockReturnValueOnce(
      rowsForChain(
        [0, 1, 2].map((d) => ({
          authoring_step_id: `aut_d${d}`,
          org_id: ORG,
          parent_step_id: d === 0 ? null : `aut_d${d - 1}`,
          extension: `@cinatra-ai/ext-${d}-artifact`,
          depth: d,
          run_id: null,
          status: "open",
          started_at: "2026-05-19T09:00:00Z",
          completed_at: null,
        })),
      ),
    );
    const res = recordAuthoringInvocation({
      orgId: ORG,
      parentStepId: "aut_d2",
      extension: "@cinatra-ai/ext-NEW-artifact",
      runId: null,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("depth-cap-exceeded");
    expect(res.detail).toMatch(/cap 2/);
    expect(runPgMock).toHaveBeenCalledTimes(1);
  });
});

describe("getConfiguredMaxDepth — env handling", () => {
  it("defaults to 8 when env unset", () => {
    delete process.env.CINATRA_AUTHORING_MAX_DEPTH;
    expect(getConfiguredMaxDepth()).toBe(8);
  });

  it("uses env value when in range [1, 32]", () => {
    process.env.CINATRA_AUTHORING_MAX_DEPTH = "15";
    expect(getConfiguredMaxDepth()).toBe(15);
  });

  it("clamps to 1 when env < 1", () => {
    process.env.CINATRA_AUTHORING_MAX_DEPTH = "0";
    expect(getConfiguredMaxDepth()).toBe(1);
  });

  it("clamps to 32 when env > 32", () => {
    process.env.CINATRA_AUTHORING_MAX_DEPTH = "99";
    expect(getConfiguredMaxDepth()).toBe(32);
  });

  it("ignores non-numeric env values (falls back to default)", () => {
    process.env.CINATRA_AUTHORING_MAX_DEPTH = "not-a-number";
    expect(getConfiguredMaxDepth()).toBe(8);
  });
});

describe("markAuthoringInvocationCommitted / Aborted", () => {
  it("issues an UPDATE setting status=committed", () => {
    runPgMock.mockReturnValueOnce([{ rows: [], rowCount: 1 }]);
    markAuthoringInvocationCommitted(ORG, "aut_step");
    const call = runPgMock.mock.calls[0][0];
    expect(call.queries[0].text).toMatch(/UPDATE /);
    expect(call.queries[0].text).toMatch(/status=\$3, completed_at=now\(\)/);
    expect(call.queries[0].values).toEqual([ORG, "aut_step", "committed"]);
  });

  it("issues an UPDATE setting status=aborted", () => {
    runPgMock.mockReturnValueOnce([{ rows: [], rowCount: 1 }]);
    markAuthoringInvocationAborted(ORG, "aut_step");
    const call = runPgMock.mock.calls[0][0];
    expect(call.queries[0].values[2]).toBe("aborted");
  });
});

describe("getAuthoringChain — chain debugging surface", () => {
  it("returns the chain rows shaped as AuthoringInvocationRecord[]", () => {
    runPgMock.mockReturnValueOnce(
      rowsForChain([
        {
          authoring_step_id: "aut_root",
          org_id: ORG,
          parent_step_id: null,
          extension: "@cinatra-ai/brand-voice-artifact",
          depth: 0,
          run_id: "run_x",
          status: "committed",
          started_at: "2026-05-19T09:00:00Z",
          completed_at: "2026-05-19T09:05:00Z",
        },
      ]),
    );
    const chain = getAuthoringChain(ORG, "aut_root");
    expect(chain).toHaveLength(1);
    expect(chain[0]).toEqual({
      authoringStepId: "aut_root",
      orgId: ORG,
      parentStepId: null,
      extension: "@cinatra-ai/brand-voice-artifact",
      depth: 0,
      runId: "run_x",
      status: "committed",
      startedAt: "2026-05-19T09:00:00Z",
      completedAt: "2026-05-19T09:05:00Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Schema gate — verify the DDL is in drizzle-store.ts (catches a removal).
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";

describe("authoring_invocation_ledger DDL is wired in drizzle-store.ts", () => {
  it("the table CREATE statement exists", () => {
    const filePath = path.join(__dirname, "../../drizzle-store.ts");
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toMatch(/authoring_invocation_ledger/);
    expect(content).toMatch(/ail_depth_chk.*CHECK \(depth >= 0/);
    expect(content).toMatch(/ail_status_chk.*CHECK \(status IN/);
  });

  it("operational table has no append-only trigger", () => {
    const filePath = path.join(__dirname, "../../drizzle-store.ts");
    const content = fs.readFileSync(filePath, "utf8");
    // Search for an append-only function on this table. There must NOT
    // be one (operational table = deletions allowed for TTL sweep).
    expect(content).not.toMatch(
      /fn_authoring_invocation_ledger_append_only/,
    );
  });
});
