// cinatra#3092 (Road P) — the agent passthrough's run write, through the REAL
// chain: the bridge binding (bindBridgeRunId), the run-authority mint and its
// verifier (mintRunWriteAuthorityForMcp → verifyRunAuthority), the dashboards
// create handler, the permission resolver, the org-write seam with the kernel
// guard, and the twin seam, and the ceiling containment check (the model
// bridge's deriveOboCeilingChain / oboCeilingContains). Only the database is
// replaced: the agent-run reads (by context id, the template read, and the
// verifier's row read) and the dashboards db, with the sanctioned kernel fakes,
// as twin-producer-run.test.ts does.
//
//   pnpm -C packages/dashboards exec vitest run src/__tests__/passthrough-run-write-3092.test.ts
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  insertError: null as Error | null,
  kernelAnswers: {
    organization: { archivedAt: null } as { archivedAt: string | null } | null,
  },
  /** The run the context id resolves to (bindBridgeRunId's read). */
  contextRun: null as Record<string, unknown> | null,
  /** The run row the verifier reads (readAgentRunRowForOrgWriteAuthority). */
  authorityRow: null as Record<string, unknown> | null,
  /** The run's template (readAgentTemplateById): its locked owner anchor. */
  template: null as Record<string, unknown> | null,
}));

// The agent-run database reads, and nothing else of the agents store.
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunByContextId: vi.fn(async () => state.contextRun),
  readAgentTemplateById: vi.fn(async () => state.template),
  readAgentRunRowForOrgWriteAuthority: vi.fn(async () => state.authorityRow),
}));

// The session membership read authority.ts imports for SESSION authorities; a
// run authority never calls it.
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: vi.fn(async () => {
    throw new Error("a run authority reads no session membership");
  }),
}));

vi.mock("../store/db", async () => {
  // The same small fake twin-producer-run.test.ts uses: the sanctioned kernel
  // test fakes answer the guard's own queries; inserts are recorded.
  const { wrapTxWithOrgWriteKernel } = await import("@cinatra-ai/org-write-kernel/testing");
  const insert = () => ({
    values: (v: Record<string, unknown>) => {
      if (state.insertError) {
        const p = Promise.reject(state.insertError);
        p.catch(() => undefined);
        return Object.assign(p, { returning: () => Promise.reject(state.insertError) });
      }
      state.inserted.push(v);
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

import { readAgentRunRowForOrgWriteAuthority } from "@cinatra-ai/agents";
import { bindBridgeRunId } from "@/lib/authz/bridge-run-binding";
import { runDashboardCreate } from "@/app/api/agents/passthrough/run-dashboard-create";
import * as mcpEntry from "../mcp/index";
import {
  resetDashboardArtifactTwinWriter,
  setDashboardArtifactTwinWriter,
  type DashboardTwinContext,
} from "../twin-writer-seam";

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER = "user-1";
const RUN = "run-1";
const TEAM = "team-1";
// The chain deriveOboCeilingChain gives an organization-anchored template.
const CEILING = [{ tier: "organization", id: ORG_A }];
const ORG_TEMPLATE = { id: "tpl-1", ownerLevel: "organization", ownerId: ORG_A };

const DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

/** The run row of a run of org A, inside a live attempt. */
function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN,
    orgId: ORG_A,
    templateId: "tpl-1",
    projectId: null,
    runBy: USER,
    status: "running",
    executionAttemptId: "att-1",
    executionDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    humanWaitAttemptId: null,
    oboCeiling: CEILING,
    ...overrides,
  };
}

function callback(): Request {
  return new Request("http://localhost/api/agents/passthrough", {
    method: "POST",
    headers: { "x-cinatra-a2a-context-id": "ctx-1" },
  });
}

/** The passthrough's road: bind the callback, then write as the bound run. */
async function writeAsRun(
  input: Record<string, unknown>,
  run: Record<string, unknown> = runRow(),
) {
  const binding = await bindBridgeRunId(callback(), RUN);
  if (!binding.ok) throw new Error(`binding refused: ${binding.error}`);
  return runDashboardCreate({
    binding,
    run: run as Parameters<typeof runDashboardCreate>[0]["run"],
    input,
  });
}

const personal = { name: "Run board", config: DC, ownerLevel: "user", ownerId: "me" };

let recorded: DashboardTwinContext[] = [];
const recordingTwin = async (_tx: unknown, ctx: DashboardTwinContext): Promise<void> => {
  recorded.push(ctx);
};

beforeEach(() => {
  state.inserted = [];
  state.insertError = null;
  state.kernelAnswers.organization = { archivedAt: null };
  state.contextRun = runRow();
  state.authorityRow = runRow();
  state.template = ORG_TEMPLATE;
  vi.mocked(readAgentRunRowForOrgWriteAuthority).mockClear();
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

describe("the passthrough run write through the real seams (cinatra#3092)", () => {
  it("the dashboards MCP entry exports the create write only", () => {
    expect(Object.keys(mcpEntry).sort()).toEqual(["createDashboardForRun"]);
  });

  it("writes a personal dashboard of the run's owner, and the twin gets the bound run", async () => {
    const outcome = await writeAsRun(personal);
    expect(outcome.ok).toBe(true);
    const dashboards = state.inserted.filter((row) => row.ownerLevel !== undefined);
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0]).toMatchObject({
      organizationId: ORG_A,
      ownerLevel: "user",
      ownerId: USER,
      createdBy: USER,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].producerRunId).toBe(RUN);
    if (outcome.ok) expect(recorded[0].dashboardId).toBe(outcome.result.dashboardId);
  });

  it("a run of org A cannot create a dashboard owned by org B", async () => {
    const outcome = await writeAsRun({
      ...personal,
      ownerLevel: "organization",
      ownerId: ORG_B,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(422);
      expect((outcome.error as { code?: string }).code).toBe("forbidden");
    }
    expect(state.inserted).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("a run of org A cannot create its own organization's dashboard either (member, no org role)", async () => {
    const outcome = await writeAsRun({ ...personal, ownerLevel: "organization", ownerId: ORG_A });
    expect(outcome.ok).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });

  it("the verifier mints no authority for a run row of another organization", async () => {
    // The row the verifier reads belongs to org B: the claimed org A is refused.
    state.authorityRow = runRow({ orgId: ORG_B });
    const outcome = await writeAsRun(personal);
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(state.inserted).toHaveLength(0);
  });

  it("refuses a stale attempt: the run moved on after the binding read it", async () => {
    // Bound under att-1; the run row the passthrough read is already on att-2.
    const outcome = await writeAsRun(personal, runRow({ executionAttemptId: "att-2" }));
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(state.inserted).toHaveLength(0);
  });

  it("refuses a stale attempt: the verifier's row read finds another attempt", async () => {
    // Binding and passthrough read att-1; when the verifier reads, it is att-2.
    state.authorityRow = runRow({ executionAttemptId: "att-2" });
    const outcome = await writeAsRun(personal);
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(state.inserted).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("refuses a run that is not inside a live attempt (deadline passed)", async () => {
    state.authorityRow = runRow({ executionDeadlineAt: new Date(Date.now() - 1_000).toISOString() });
    const outcome = await writeAsRun(personal);
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(state.inserted).toHaveLength(0);
  });

  it("refuses a run with no OBO ceiling", async () => {
    const outcome = await writeAsRun(personal, runRow({ oboCeiling: null }));
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(state.inserted).toHaveLength(0);
  });

  it("refuses a team-anchored run whose stored ceiling holds only the organization", async () => {
    // A stale or corrupt chain: the template is anchored to team-1, the stored
    // chain carries only org-a. The re-derived team-1 element is missing, so
    // the write stops before the mint, as the model bridge stops before minting.
    state.template = { id: "tpl-1", ownerLevel: "team", ownerId: TEAM };
    const outcome = await writeAsRun(personal);
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(readAgentRunRowForOrgWriteAuthority).not.toHaveBeenCalled();
    expect(state.inserted).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("passes a team-anchored run whose stored ceiling contains the re-derived chain to the mint", async () => {
    state.template = { id: "tpl-1", ownerLevel: "team", ownerId: TEAM };
    const ceiling = [
      { tier: "team", id: TEAM },
      { tier: "organization", id: ORG_A },
    ];
    const outcome = await writeAsRun(personal, runRow({ oboCeiling: ceiling }));
    // The containment check passes and the authority is minted; the resolver
    // then decides the write: a team ceiling holds no personal dashboard, so
    // it is the tool's own forbidden refusal, not the 403 before the mint.
    expect(readAgentRunRowForOrgWriteAuthority).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, status: 422 });
    if (!outcome.ok) expect((outcome.error as { code?: string }).code).toBe("forbidden");
  });

  it("writes for a user-anchored run whose stored ceiling contains the re-derived chain", async () => {
    state.template = { id: "tpl-1", ownerLevel: "user", ownerId: USER };
    const ceiling = [
      { tier: "user", id: USER },
      { tier: "organization", id: ORG_A },
    ];
    const outcome = await writeAsRun(personal, runRow({ oboCeiling: ceiling }));
    expect(outcome.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].producerRunId).toBe(RUN);
  });

  it("answers a database error with the fixed sentence, never its text", async () => {
    state.insertError = new Error('duplicate key value violates unique constraint "dashboards_pkey"');
    const outcome = await writeAsRun({ ...personal, dashboardId: "00000000-0000-4000-8000-000000000001" });
    expect(outcome).toEqual({
      ok: false,
      status: 500,
      error: { code: "internal_error", message: "dashboards_create failed" },
    });
  });
});
