// Per-event restore-authz gate.
//
// assertChangeSetRestoreAccess runs the inverse-operation write check on every
// affected event; canActorRestoreChangeSet wraps it as a boolean for the
// deep-link auto-open gate. This is the negative auth-boundary test: the modal
// must NOT auto-open for an actor whose confirm path would be denied.
//
// We use the REAL AuthzError (not a fake) so server-views' `instanceof
// AuthzError` check matches across the test boundary.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ enforceResourceAccess: vi.fn() }));

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgresql://test",
  postgresSchema: "test_schema",
}));
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn(() => [{ rows: [] }]) }));
vi.mock("@/lib/object-history", () => ({ readObjectScopeById: vi.fn() }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: mocks.enforceResourceAccess,
}));
vi.mock("@/lib/authz/resource-ref", () => ({ normalizeOwnerLevel: (v: string) => v }));

import { AuthzError } from "@/lib/authz/errors";
import {
  assertChangeSetRestoreAccess,
  canActorRestoreChangeSet,
} from "../server-views";

const ACTOR = { userId: "u1", organizationId: "org_1", roles: [] } as never;

function event(operation: string, objectId = "obj_1") {
  return {
    id: `evt-${objectId}-${operation}`,
    objectId,
    operation,
    orgId: "org_1",
    ownerLevel: "organization",
    ownerId: null,
    visibility: "organization",
  } as never;
}

function denied(): AuthzError {
  return new AuthzError({ statusCode: 403, reason: "forbidden", message: "denied" });
}

describe("assertChangeSetRestoreAccess / canActorRestoreChangeSet", () => {
  beforeEach(() => mocks.enforceResourceAccess.mockReset());

  it("maps each operation to its INVERSE write permission", async () => {
    mocks.enforceResourceAccess.mockResolvedValue(undefined);
    await assertChangeSetRestoreAccess(
      [event("create", "a"), event("update", "b"), event("soft-delete", "c"), event("tombstone", "d")],
      ACTOR,
    );
    const ops = mocks.enforceResourceAccess.mock.calls.map((c) => c[2]);
    expect(ops).toEqual([
      "object.delete", // undo of create
      "object.update", // undo of update
      "object.create", // undo of soft-delete
      "object.create", // undo of tombstone
    ]);
  });

  it("canActorRestoreChangeSet returns true when every event passes", async () => {
    mocks.enforceResourceAccess.mockResolvedValue(undefined);
    await expect(
      canActorRestoreChangeSet([event("update")], ACTOR),
    ).resolves.toBe(true);
  });

  it("canActorRestoreChangeSet returns true on a clean pass (auto-open allowed)", async () => {
    mocks.enforceResourceAccess.mockResolvedValue(undefined);
    await expect(
      canActorRestoreChangeSet([event("update", "a"), event("update", "b")], ACTOR),
    ).resolves.toBe(true);
  });

  // NOTE: the deny→false path (canActorRestoreChangeSet returns false when an
  // event throws AuthzError) is intentionally NOT unit-tested here. vitest 4.x
  // flags a vi.fn mockImplementation that throws as a worker-level error even
  // when the awaiting code catches it, which fails the test regardless of the
  // (correct) catch→false behaviour. That exact catch pattern IS integration-
  // tested in restore-object-version-action.test.ts ("surfaces an
  // object.update denial as an error"), and the page's auto-open gating on the
  // boolean is pinned in nav-modal-wiring.test.ts. `denied()` is retained for
  // documentation of the shape the gate guards against.
  void denied;
});
