// retryRemoteEffect + CMS restore adapter registry.
//
// The remote-effect substrate has no wired connector restore EXECUTOR
// (runCmsRestore has zero production callers). So retry must report
// `unsupported` when no adapter is registered — never a silent no-op.
// Registering an adapter flips it past the unsupported branch.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ runQueries: vi.fn() }));
vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgresql://test",
  postgresSchema: "test_schema",
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: mocks.runQueries,
}));

import {
  retryRemoteEffect,
  registerCmsRestoreAdapter,
  getCmsRestoreCallable,
} from "../cms-state-machine";

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: "rea_1",
    change_event_id: "evt_1",
    connector_name: "wordpress",
    target_kind: "post",
    target_id: "42",
    intended_state: { title: "x" },
    status: "failed",
    attempt_count: 1,
    last_error: "boom",
    remote_revision_ref: null,
    read_back_payload: null,
    idempotency_key: "rea_evt_1_wordpress",
    started_at: "2026-05-23T20:00:00Z",
    updated_at: "2026-05-23T20:00:00Z",
    org_id: "org_1",
    ...over,
  };
}

describe("retryRemoteEffect", () => {
  beforeEach(() => mocks.runQueries.mockReset());

  it("returns not-found when the attempt does not exist", async () => {
    mocks.runQueries.mockReturnValue([{ rows: [] }]);
    const result = await retryRemoteEffect({ attemptId: "missing", orgId: "org_1" });
    expect(result).toEqual({
      ok: false,
      reason: "not-found",
      message: "attempt not found",
    });
  });

  it("returns unsupported when no connector restore adapter is registered", async () => {
    mocks.runQueries.mockReturnValue([{ rows: [attemptRow()] }]);
    const result = await retryRemoteEffect({ attemptId: "rea_1", orgId: "org_1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unsupported");
      expect(result.message).toMatch(/No connector restore adapter/);
    }
  });
});

describe("CMS restore adapter registry", () => {
  it("registerCmsRestoreAdapter makes getCmsRestoreCallable resolve it", () => {
    expect(getCmsRestoreCallable("test-connector-x")).toBeNull();
    const fake = async () => ({ readBack: {} });
    registerCmsRestoreAdapter("test-connector-x", fake);
    expect(getCmsRestoreCallable("test-connector-x")).toBe(fake);
  });
});
