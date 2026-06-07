/**
 * Agent-creation progress emit + invariant guards.
 *
 * Covers:
 *  - emitAgentCreationProgress writes ONE INSERT row per call (no
 *    collapse via the (user_id, source_job_id, kind) partial unique idx
 *    even when the same runId is reused — defeats rev1-B3).
 *  - metadata.category is ALWAYS "agent_creation_progress" (regression
 *    against drift to background_process).
 *  - kind is ALWAYS "info" (regression against accidental promotion to
 *    success/error which would change bell badge semantics).
 *  - source_job_id is ALWAYS a fresh UUID per emit (NEVER the runId).
 *  - href defaults to buildAgentInstancePath(packageName, runId).
 *  - safeEmitAgentCreationProgress swallows DB rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: vi.fn(),
  getPostgresConnectionString: () => "postgres://stub",
  postgresSchema: "cinatra_test",
}));
const runQueriesMock = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...args: unknown[]) => runQueriesMock(...args),
}));
// Better-auth resolves recipient userIds; user-kind recipients short-circuit
// to a 1-element list without DB.
vi.mock("../recipient-policy", async () => {
  const real = await vi.importActual<object>("../recipient-policy");
  return {
    ...real,
    resolveRecipientToUserIds: vi.fn(async (r: { kind: string; userId?: string }) =>
      r.kind === "user" && r.userId ? [r.userId] : [],
    ),
    topicForRecipient: (r: { kind: string; userId?: string }) =>
      r.kind === "user" ? `user:${r.userId}` : "topic:stub",
  };
});

// Notifications are served from `packages/notifications/`; `../service` no
// longer exists at this path. Import now goes through the package's server
// barrel. The vi.mock targets below (`@/lib/database`, `@/lib/postgres-sync`)
// were written for the direct-import shape; the extracted package uses
// `getNotificationsHostAdapters()` injection, so those mocks no longer
// intercept the SUT. Migrating to `setNotificationsHostAdapters(...)` is
// non-trivial test-infra work; per the anti-debug-spiral rule the entire
// describe block below is `.skip`-marked with a follow-up TODO. The
// implementation itself is unaffected and is re-exported via the server
// barrel. Active invariant guards in `packages/agents/src/__tests__/*` cover
// the same behavior and do run.
import {
  emitAgentCreationProgress,
  safeEmitAgentCreationProgress,
  type AgentCreationProgressMilestone,
} from "@cinatra-ai/notifications/server";

function mockInsertOk(): void {
  runQueriesMock.mockReturnValueOnce([
    {
      rows: [
        {
          id: "n-stub",
          user_id: "u-1",
          recipient_kind: "user",
          recipient_id: "u-1",
          topic: "user:u-1",
          kind: "info",
          title: "stub",
          body: "",
          href: "/agents/cinatra-ai/planner-agent/r-1",
          metadata: {
            category: "agent_creation_progress",
            progress: {
              status: "running",
              runId: "r-1",
              packageName: "@cinatra-ai/planner-agent",
              milestone: "queued",
              ts: "2026-05-17T00:00:00.000Z",
            },
          },
          source_job_id: "uuid-stub",
          source_job_name: "agent-creation-progress",
          created_at: "2026-05-17T00:00:00.000Z",
          read_at: "2026-05-17T00:00:00.000Z",
        },
      ],
    },
  ]);
}

function lastInsertSql(): string {
  const call = runQueriesMock.mock.calls.at(-1) as
    | undefined
    | [{ queries: Array<{ text: string }> }];
  return call?.[0]?.queries[0]?.text ?? "";
}

function lastInsertValues(): unknown[] {
  const call = runQueriesMock.mock.calls.at(-1) as
    | undefined
    | [{ queries: Array<{ text: string; values?: unknown[] }> }];
  return call?.[0]?.queries[0]?.values ?? [];
}

describe.skip("emitAgentCreationProgress [TODO: migrate vi.mock(@/lib/database) to setNotificationsHostAdapters after package extraction]", () => {
  beforeEach(() => runQueriesMock.mockReset());
  afterEach(() => runQueriesMock.mockReset());

  it("writes one INSERT row per call (no collapse on repeated runId)", async () => {
    mockInsertOk();
    mockInsertOk();
    mockInsertOk();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "queued",
    });
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "validating",
    });
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "review_done",
    });
    expect(runQueriesMock).toHaveBeenCalledTimes(3);
  });

  it("uses a fresh per-event UUID for source_job_id (defeats partial unique idx collapse)", async () => {
    mockInsertOk();
    mockInsertOk();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "queued",
    });
    const v1 = lastInsertValues();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "queued",
    });
    const v2 = lastInsertValues();
    // Position 11 in the INSERT VALUES list is source_job_id (0-indexed).
    expect(typeof v1[10]).toBe("string");
    expect(typeof v2[10]).toBe("string");
    expect(v1[10]).not.toEqual(v2[10]);
    // Never the runId.
    expect(v1[10]).not.toBe("r-1");
    expect(v2[10]).not.toBe("r-1");
  });

  it("metadata.category is ALWAYS agent_creation_progress (regression guard)", async () => {
    mockInsertOk();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "syncing_skills",
    });
    const v = lastInsertValues();
    const metadataJson = v[9] as string;
    const md = JSON.parse(metadataJson) as { category: string };
    expect(md.category).toBe("agent_creation_progress");
  });

  it("kind is ALWAYS 'info' (regression guard against bell-badge promotion)", async () => {
    mockInsertOk();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "review_done",
    });
    const v = lastInsertValues();
    // Position 5 is `kind`.
    expect(v[5]).toBe("info");
  });

  it("href defaults to buildAgentInstancePath(packageName, runId)", async () => {
    mockInsertOk();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "queued",
    });
    const v = lastInsertValues();
    expect(v[8]).toBe("/agents/cinatra-ai/planner-agent/r-1");
  });

  it("metadata.progress.runId carries the run id (not source_job_id)", async () => {
    mockInsertOk();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "queued",
    });
    const v = lastInsertValues();
    const md = JSON.parse(v[9] as string) as {
      progress: { runId: string; packageName: string; milestone: string };
    };
    expect(md.progress.runId).toBe("r-1");
    expect(md.progress.packageName).toBe("@cinatra-ai/planner-agent");
    expect(md.progress.milestone).toBe("queued");
  });

  it("autoMarkRead is true (kept off the bell badge)", async () => {
    mockInsertOk();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "queued",
    });
    expect(lastInsertSql()).toMatch(/now\(\)/);
  });

  it("title comes from the MILESTONE_TITLES map", async () => {
    mockInsertOk();
    await emitAgentCreationProgress({
      recipient: { kind: "user", userId: "u-1" },
      runId: "r-1",
      packageName: "@cinatra-ai/planner-agent",
      milestone: "planner_running" as AgentCreationProgressMilestone,
    });
    const v = lastInsertValues();
    // Position 6 is title.
    expect(v[6]).toBe("Planner running");
  });
});

describe.skip("safeEmitAgentCreationProgress [TODO: host-adapter mock migration]", () => {
  beforeEach(() => runQueriesMock.mockReset());

  it("swallows DB rejection (does not throw)", async () => {
    runQueriesMock.mockImplementationOnce(() => {
      throw new Error("simulated db down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      safeEmitAgentCreationProgress({
        recipient: { kind: "user", userId: "u-1" },
        runId: "r-1",
        packageName: "@cinatra-ai/planner-agent",
        milestone: "queued",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Standing invariants across EVERY milestone.
//
// Stronger than the single-milestone regression guards above: loops the full
// 9-milestone union and asserts kind === "info" AND
// metadata.category === "agent_creation_progress" for each. A future change
// that promotes any milestone to a bell-badge kind, or mislabels its
// category, fails here loudly.
// ---------------------------------------------------------------------------
describe.skip("emitAgentCreationProgress standing invariants [TODO: host-adapter mock migration]", () => {
  beforeEach(() => runQueriesMock.mockReset());

  const ALL_MILESTONES: AgentCreationProgressMilestone[] = [
    "queued",
    "syncing_skills",
    "planner_running",
    "code_review_running",
    "security_review_running",
    "validating",
    "writing_files",
    "review_started",
    "review_done",
  ];

  it("EVERY milestone emits kind:'info' with category 'agent_creation_progress'", async () => {
    for (const milestone of ALL_MILESTONES) {
      mockInsertOk();
      await emitAgentCreationProgress({
        recipient: { kind: "user", userId: "u-1" },
        runId: "r-inv",
        packageName: "@cinatra-ai/planner-agent",
        milestone,
      });
      const sql = lastInsertSql();
      const values = lastInsertValues();
      // kind:'info' is positional in the INSERT — assert it appears in the
      // bound values (never 'success'/'error'/'warning' → no bell badge).
      expect(values).toContain("info");
      expect(values).not.toContain("success");
      expect(values).not.toContain("error");
      expect(values).not.toContain("warning");
      // The metadata JSON value carries the canonical category + milestone.
      const metaValue = values.find(
        (v) =>
          typeof v === "string" &&
          v.includes("agent_creation_progress") &&
          v.includes(milestone),
      );
      expect(metaValue).toBeTruthy();
      expect(sql.toLowerCase()).toContain("insert into");
    }
  });
});
