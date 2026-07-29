// cinatra#1939 wave 3 Stage D — kernel-refusal error-classification pin
// (adversarial-review round-1 follow-up, adopted).
//
// The guarded fixed-batch refuses a lifecycle-denied write by casting the
// refusal GUC message to int: Postgres raises SQLSTATE 22P02
// (invalid_text_representation) with a message embedding
// "org-write-kernel refused: ...". canonical-writer's isCasAssertError must
// stay marker-specific (SQLSTATE 22012 / "division by zero") so a kernel
// REFUSAL is RETHROWN VERBATIM — never laundered into a VersionConflictError,
// which callers treat as a retryable CAS race.

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runGuardedOrgWriteBatchSync: vi.fn((_batch: unknown): never => {
    // The exact error SHAPE the postgres-sync worker surfaces for the guard's
    // refusal cast: a plain Error carrying only the message (the worker
    // serializes {message, stack} — SQLSTATE codes do not survive).
    throw new Error(
      'invalid input syntax for type integer: "org-write-kernel refused: content.write not permitted for this organization\'s lifecycle state"',
    );
  }),
  // Pre-write reads (snapshot, event sequence) ride runPostgresQueriesSync
  // directly — return empty result sets (fresh create path).
  runPostgresQueriesSync: vi.fn(() => [
    { rows: [] as Array<Record<string, unknown>>, rowCount: 0 },
  ]),
}));

vi.mock("@/lib/org-write/batch-wrapper", () => ({
  runGuardedOrgWriteBatchSync: mocks.runGuardedOrgWriteBatchSync,
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: mocks.runPostgresQueriesSync,
}));

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgres://stub",
  postgresSchema: "cinatra_test",
}));

vi.mock("@/lib/mcp-request-context", () => ({
  mcpRequestContextStorage: { getStore: () => undefined },
}));

vi.mock("@/lib/project-writable", () => ({
  assertProjectWritableSync: () => {},
}));

vi.mock("@/lib/project-inheritance", () => ({
  resolveProjectInheritanceForType: () => null,
}));

vi.mock("../change-set", () => ({
  openChangeSet: () => ({ changeSetId: "cs_guard_refusal" }),
  closeChangeSet: () => {},
}));

import { historyAwareUpsert } from "../canonical-writer";
import { VersionConflictError } from "../errors";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

const authority: OrgWriteAuthority = { orgId: "org_1", can: () => true };

describe("canonical-writer × guarded-batch refusal classification (#1939 Stage D)", () => {
  it("rethrows a kernel refusal verbatim — NEVER converts it to VersionConflictError", () => {
    let caught: unknown;
    try {
      historyAwareUpsert(
        { id: "obj_1", type: "@test/pkg:doc", data: { title: "x" }, orgId: "org_1" },
        {
          expectedBaseVersion: null,
          historyEffect: "reversible-internal",
          actor: { actorId: "user_1", actorKind: "user", orgId: "org_1" },
          authority,
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(VersionConflictError);
    expect((caught as Error).message).toMatch(/org-write-kernel refused/);
    // The refusal came from the guarded batch, which was genuinely invoked.
    expect(mocks.runGuardedOrgWriteBatchSync).toHaveBeenCalledTimes(1);
  });
});
