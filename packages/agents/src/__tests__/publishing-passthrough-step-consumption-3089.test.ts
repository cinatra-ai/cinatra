// cinatra#3089: the REAL single-use consumption of the person's decision (consumeRunActionDecision, cinatra#3745) admits
// the call of a direct passthrough publishing step: the run's bound source is this pull request's publishing-step fixture
// (a top-level `/api/agents/passthrough` ApiNode with `publishes: true` whose request names
// `email_outreach_send_initial_start`), read by the host's real step-tool reader. The guarded transaction is a stand-in
// that keeps the rows of each table in memory; the consumption table behaves as its primary key does.
// red-first-expect: action_decision_step_undeclared
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { agentRunOutwardActionPolicies, agentRunPublishDecisions, agentRuns, artifactReviewActionConsumptions } from "../schema";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({ tables: new Map<unknown, Record<string, unknown>[]>() }));

vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({ db: { transaction: () => { throw Error("must use the guarded seam"); } } }));
vi.mock("../org-write-run-seam", () => ({
  guardedRunWrite: async (authority: unknown, opts: { orgId: string }, body: (tx: object) => Promise<unknown>) => {
    if (!authority || (authority as { orgId?: unknown }).orgId !== opts.orgId) throw Error("org write refused");
    const rowsOf = (table: unknown) => h.tables.get(table) ?? [];
    const tx = {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const chain = {
            where: () => chain, orderBy: () => chain, limit: () => chain, for: () => chain,
            then: (resolve: (v: unknown) => unknown) => {
              const rows = rowsOf(table).map((r) => ({ ...r }));
              return resolve(columns ? rows.map((r) => ({ gateId: r.gateId })) : rows);
            },
          };
          return chain;
        },
      }),
      insert: (table: unknown) => ({
        values: (value: Row) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const rows = h.tables.get(table) ?? [];
              h.tables.set(table, rows);
              if (rows.some((r) => r.gateId === value.gateId)) return [];
              rows.push({ ...value });
              return [{ gateId: value.gateId }];
            },
          }),
        }),
      }),
    };
    return body(tx);
  },
}));

import { consumeRunActionDecision } from "../run-action-decision-consumption";

const STEP = "send_campaign";
const SEND = "email_outreach_send_initial_start";
const source = readFileSync(
  new URL("../../../../scripts/ci/__tests__/__fixtures__/pin-advance-host-tools/publishing-step-declared-tool.oas.json", import.meta.url),
  "utf8",
);
const sha = createHash("sha256").update(source).digest("hex");
const policy = { version: 1, contextId: "ctx", sourceSha256: sha, executedSourceSha256: sha, declarationSourceSha256: sha, source };
const proof = { contextId: "ctx", stepId: STEP, executionAttemptId: "attempt-1", sourceSha256: sha,
  executedSourceSha256: sha, declarationSourceSha256: sha };
const hostBuiltin = { toolName: SEND, packageName: "@cinatra-ai/host", version: "2817.1.0", installId: "host-builtin",
  digest: "host-builtin" };
const input = (over: Record<string, unknown> = {}) =>
  ({ orgId: "org-1", runId: "run-1", authority: { orgId: "org-1" }, proof, action: hostBuiltin, ...over }) as Parameters<
    typeof consumeRunActionDecision
  >[0];

beforeEach(() => {
  h.tables = new Map<unknown, Row[]>([
    [agentRuns, [{ id: "run-1", orgId: "org-1", status: "running", executionAttemptId: "attempt-1", a2aContextId: "ctx", resetGeneration: 0 }]],
    [agentRunOutwardActionPolicies, [{ runId: "run-1", orgId: "org-1", executionAttemptId: "attempt-1", policy }]],
    [agentRunPublishDecisions, [{ id: "decision-1", orgId: "org-1", runId: "run-1", nodeId: STEP, gateTaskId: "gate-task-1",
      status: "released", decidedBy: "user-7", decidedAt: new Date("2026-11-24T10:00:00Z"),
      createdAt: new Date("2026-11-24T09:00:00Z"), runGeneration: 0, surfacedValues: "{}", declaredRows: null,
      a2aContextId: "ctx", decisionNote: null, expiresAt: new Date("2026-11-25T09:00:00Z") }]],
    [artifactReviewActionConsumptions, []],
  ]);
});

describe("the decision of a direct passthrough publishing step, used once by the real consumption", () => {
  it("uses the released decision for the tool the step's request names, under publish_decision:<id>", async () => {
    let refusal: unknown = null;
    const result = await consumeRunActionDecision(input()).catch((err: unknown) => { refusal = err; return null; });
    expect((refusal as { code?: string } | null)?.code ?? null).toBeNull();
    expect(result).toMatchObject({ consumptionKey: "publish_decision:decision-1", decisionId: "decision-1", stepId: STEP });
    expect(h.tables.get(artifactReviewActionConsumptions)).toEqual([
      expect.objectContaining({ gateId: "publish_decision:decision-1", stepId: STEP, toolIdentity: hostBuiltin }),
    ]);
  });

  it("refuses a second use of the same decision", async () => {
    let first: unknown = null;
    await consumeRunActionDecision(input()).catch((err: unknown) => { first = err; });
    expect((first as { code?: string } | null)?.code ?? null).toBeNull();
    await expect(consumeRunActionDecision(input())).rejects.toMatchObject({ code: "action_person_decision_already_consumed" });
  });

  it("refuses a tool the step's request does not name", async () => {
    await expect(consumeRunActionDecision(input({ action: { ...hostBuiltin, toolName: "email_outreach_send_test_start" } })))
      .rejects.toMatchObject({ code: "step_tool_not_declared" });
    expect(h.tables.get(artifactReviewActionConsumptions)).toEqual([]);
  });
});
