// isEventRestoreEligible coverage.
//
// The per-version restore button only renders when this verdict says the
// event is restore-eligible. Pins: an update event with an after-snapshot is
// eligible; a hard-delete (no recoverable state) is not; ANY event missing
// its after-snapshot is not (the engine has nothing to re-apply).

import { describe, expect, it } from "vitest";

import { isEventRestoreEligible } from "../eligibility";
import type { ObjectChangeEvent } from "../types";

function makeEvent(
  overrides: Partial<ObjectChangeEvent> = {},
): ObjectChangeEvent {
  return {
    id: "evt_1",
    changeSetId: "cs_1",
    sequence: 1,
    objectId: "obj_1",
    objectType: "note",
    operation: "update",
    historyEffect: "reversible-internal",
    beforeSnapshot: { payload: { data: { name: "old" } } },
    afterSnapshot: { payload: { data: { name: "new" } } },
    baseVersion: 1,
    resultVersion: 2,
    objectSchemaVersion: "v1",
    restoreEligible: true,
    restoreIneligibleReason: null,
    compensatingTemplateId: null,
    remoteRevisionRef: null,
    actorId: "user_1",
    actorKind: "user",
    runId: null,
    auditEventId: null,
    orgId: "org_1",
    projectId: null,
    ownerLevel: "organization",
    ownerId: null,
    visibility: "organization",
    createdAt: "2026-05-23T20:00:00.000Z",
    ...overrides,
  } as ObjectChangeEvent;
}

describe("isEventRestoreEligible", () => {
  it("a reversible update with an after-snapshot is eligible", () => {
    const verdict = isEventRestoreEligible(makeEvent());
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBe("ok");
  });

  it("a hard-delete event is not eligible", () => {
    const verdict = isEventRestoreEligible(
      makeEvent({ operation: "hard-delete", afterSnapshot: null }),
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe("hard-deleted");
  });

  it("any event missing its after-snapshot is not eligible (nothing to re-apply)", () => {
    const verdict = isEventRestoreEligible(
      makeEvent({ operation: "update", afterSnapshot: null }),
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe("hard-deleted");
    expect(verdict.details).toMatch(/no after-snapshot/);
  });

  it("a soft-delete with its tombstone after-snapshot IS eligible (re-applies the deleted state)", () => {
    const verdict = isEventRestoreEligible(
      makeEvent({
        operation: "soft-delete",
        afterSnapshot: { payload: { data: {}, deleted_at: "2026-05-23T20:00:00Z" } },
      }),
    );
    expect(verdict.eligible).toBe(true);
  });

  it("an unsupported schema version is not eligible", () => {
    const verdict = isEventRestoreEligible(
      makeEvent({ objectSchemaVersion: "v999" }),
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe("schema-version-mismatch");
  });
});
