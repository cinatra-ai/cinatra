/**
 * Agent-creation progress — general `dedupeKey` invariants (issue #50).
 *
 * The flyout showed the same milestone notification twice because every
 * emit deliberately uses a fresh `randomUUID()` for `source_job_id`
 * (so DIFFERENT milestones of one run never collapse under the legacy
 * `(user_id, source_job_id, kind)` index) — which also meant a RE-EMIT of
 * the SAME milestone was never deduped. Live double-writers:
 *   - "writing_files": both agent_source_write AND agent_source_write_files
 *     emit it in one creation flow (packages/agents/src/mcp/handlers.ts).
 *   - the review milestones: re-emitted by every agent_creation_review
 *     re-invocation (packages/agents/src/agent-creation-review.ts).
 *   - "syncing_skills": chat dispatch + review preflight both emit it
 *     (dormant while isAgentCreationPinActive() is false).
 *
 * The fix pins idempotency on the general dedupe key instead:
 *   dedupeKey = `agent-creation-progress:<runId>:<milestone>`
 * — ONE row per (run, milestone); re-emits collapse via
 * ON CONFLICT (user_id, dedupe_key) DO NOTHING.
 *
 * Uses the `setNotificationsHostAdapters` injection harness (same shape as
 * service.test.ts) — the SUT lives in packages/notifications/src/service.ts
 * and reaches Postgres only through the injected adapter.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  emitAgentCreationProgress,
  setNotificationsHostAdapters,
} from "@cinatra-ai/notifications/server";
import type { NotificationsHostAdapters } from "@cinatra-ai/notifications/server";

const runQueriesMock =
  vi.fn<NotificationsHostAdapters["runPostgresQueriesSync"]>();

beforeEach(() => {
  runQueriesMock.mockReset();
  // Every INSERT resolves with a stub row; these tests assert the SQL/values
  // contract, not row mapping.
  runQueriesMock.mockReturnValue([{ rows: [] }]);
  setNotificationsHostAdapters({
    getPostgresConnectionString: () => "postgres://stub",
    ensurePostgresSchema: vi.fn(),
    postgresSchema: "cinatra_test",
    runPostgresQueriesSync: runQueriesMock,
    getAuthSession: async () => null,
    buildActorContext: async () => {
      throw new Error("not used in this test");
    },
  });
});

function insertCalls(): Array<{ text: string; values: unknown[] }> {
  return runQueriesMock.mock.calls
    .map((call) => call[0].queries[0]!)
    .filter((q) => q.text.includes("INSERT INTO"))
    .map((q) => ({ text: q.text, values: q.values ?? [] }));
}

// VALUES order: id, user_id, recipient_kind, recipient_id, topic, kind,
// title, body, href, metadata, source_job_id, source_job_name, dedupe_key.
const SOURCE_JOB_ID_IDX = 10;
const DEDUPE_KEY_IDX = 12;

async function emit(milestone: "writing_files" | "validating"): Promise<void> {
  await emitAgentCreationProgress({
    recipient: { kind: "user", userId: "u-1" },
    runId: "r-1",
    packageName: "@cinatra-ai/planner-agent",
    milestone,
  });
}

describe("emitAgentCreationProgress — dedupeKey (issue #50)", () => {
  it("binds the stable per-(run, milestone) dedupe key and arbitrates on (user_id, dedupe_key)", async () => {
    await emit("writing_files");
    const [insert] = insertCalls();
    expect(insert).toBeDefined();
    expect(insert!.values[DEDUPE_KEY_IDX]).toBe(
      "agent-creation-progress:r-1:writing_files",
    );
    expect(insert!.text).toContain("ON CONFLICT (user_id, dedupe_key)");
    expect(insert!.text).toContain("DO NOTHING");
  });

  it("re-emitting the SAME milestone for the same run reuses the SAME dedupe key (collapse, not a second flyout row)", async () => {
    await emit("writing_files");
    await emit("writing_files");
    const calls = insertCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.values[DEDUPE_KEY_IDX]).toBe(
      calls[1]!.values[DEDUPE_KEY_IDX],
    );
    // The legacy invariant is preserved: source_job_id stays a FRESH UUID
    // per emit (never the runId) — collapse moved to dedupe_key.
    expect(calls[0]!.values[SOURCE_JOB_ID_IDX]).not.toBe(
      calls[1]!.values[SOURCE_JOB_ID_IDX],
    );
    expect(calls[0]!.values[SOURCE_JOB_ID_IDX]).not.toBe("r-1");
  });

  it("DIFFERENT milestones of one run carry DIFFERENT dedupe keys (timeline keeps one row per milestone)", async () => {
    await emit("writing_files");
    await emit("validating");
    const calls = insertCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.values[DEDUPE_KEY_IDX]).toBe(
      "agent-creation-progress:r-1:writing_files",
    );
    expect(calls[1]!.values[DEDUPE_KEY_IDX]).toBe(
      "agent-creation-progress:r-1:validating",
    );
  });
});
