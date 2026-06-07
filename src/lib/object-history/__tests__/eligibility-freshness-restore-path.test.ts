// Restore-path freshness contract regression tests.
//
// The contract tests in freshness-contract.test.ts cover
// freshnessAllowsRestore directly, but the restore engine consumes
// summarizeChangeSetEligibility. This file exercises THAT path so a future
// eligibility refactor cannot silently drift from the contract.

import { describe, expect, it } from "vitest";

import {
  summarizeChangeSetEligibility,
  type LoadedChangeSet,
} from "../eligibility";
import type { ObjectChangeEvent, HistoryEffect } from "../types";

function makeEvent(
  overrides: Partial<ObjectChangeEvent> = {},
): ObjectChangeEvent {
  return {
    id: "che_1",
    changeSetId: "cs_1",
    sequence: 1,
    objectId: "obj_1",
    objectType: "blog.post",
    operation: "update",
    historyEffect: "reversible-internal" as HistoryEffect,
    beforeSnapshot: { payload: { data: { title: "old" } } },
    afterSnapshot: { payload: { data: { title: "new" } } },
    baseVersion: 1,
    resultVersion: 2,
    objectSchemaVersion: "v1",
    restoreEligible: true,
    restoreIneligibleReason: null,
    compensatingTemplateId: null,
    remoteRevisionRef: null,
    actorId: null,
    actorKind: null,
    runId: null,
    auditEventId: null,
    orgId: null,
    projectId: null,
    ownerLevel: null,
    ownerId: null,
    visibility: null,
    idempotencyKey: "che_1",
    eventChecksum: "checksum",
    createdAt: "2026-05-23T10:00:00Z",
    tombstonedAt: null,
    ...overrides,
  };
}

function makeLoaded(events: ObjectChangeEvent[]): LoadedChangeSet {
  return {
    changeSet: {
      id: "cs_1",
      restorable: true,
      restorableReason: null,
      effectRollup: "reversible-internal",
      orgId: null,
      openedAt: "2026-05-23T10:00:00Z",
      closedAt: "2026-05-23T10:00:01Z",
      closureReason: "single-mutation-close",
    },
    events,
  };
}

describe("summarizeChangeSetEligibility — freshness contract integration", () => {
  it("blocks restore when any event's freshness is 'changed' (CMS-tagged)", () => {
    const loaded = makeLoaded([
      makeEvent({
        objectId: "obj_1",
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      }),
    ]);
    const verdict = summarizeChangeSetEligibility(loaded, {
      externalFreshness: new Map([
        [
          "obj_1",
          {
            state: "changed",
            baseRevision: "rev_2",
            changedFields: ["title"],
          },
        ],
      ]),
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("external-source-changed");
  });

  it("blocks restore when any event's freshness is 'missing'", () => {
    const loaded = makeLoaded([
      makeEvent({
        objectId: "obj_1",
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      }),
    ]);
    const verdict = summarizeChangeSetEligibility(loaded, {
      externalFreshness: new Map([["obj_1", { state: "missing" }]]),
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("external-source-missing");
  });

  it("blocks restore when any event's freshness is 'unknown' (non-silent)", () => {
    const loaded = makeLoaded([
      makeEvent({
        objectId: "obj_1",
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      }),
    ]);
    const verdict = summarizeChangeSetEligibility(loaded, {
      externalFreshness: new Map([
        ["obj_1", { state: "unknown", reason: "network down" }],
      ]),
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("external-source-unknown");
  });

  it("blocks restore when CMS-tagged event has 'unsupported' freshness", () => {
    const loaded = makeLoaded([
      makeEvent({
        objectId: "obj_1",
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      }),
    ]);
    const verdict = summarizeChangeSetEligibility(loaded, {
      externalFreshness: new Map([["obj_1", { state: "unsupported" }]]),
    });
    expect(verdict.eligible).toBe(false);
  });

  it("allows restore when local-only event has 'unsupported' freshness in the map", () => {
    const loaded = makeLoaded([
      makeEvent({ objectId: "obj_1", remoteRevisionRef: null }),
    ]);
    // In practice resolveExternalFreshness never writes 'unsupported'
    // for local-only events (it skips them entirely), but we test the
    // contract: when an event is non-CMS, unsupported allows.
    const verdict = summarizeChangeSetEligibility(loaded, {
      externalFreshness: new Map([["obj_1", { state: "unsupported" }]]),
    });
    expect(verdict.eligible).toBe(true);
  });

  it("allows restore when freshness reports 'fresh'", () => {
    const loaded = makeLoaded([
      makeEvent({
        objectId: "obj_1",
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      }),
    ]);
    const verdict = summarizeChangeSetEligibility(loaded, {
      externalFreshness: new Map([
        ["obj_1", { state: "fresh", baseRevision: "rev_1" }],
      ]),
    });
    expect(verdict.eligible).toBe(true);
  });

  it("aggregates: one bad event blocks the whole change_set", () => {
    const loaded = makeLoaded([
      makeEvent({
        objectId: "obj_1",
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      }),
      makeEvent({
        objectId: "obj_2",
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "43",
        },
      }),
    ]);
    const verdict = summarizeChangeSetEligibility(loaded, {
      externalFreshness: new Map([
        ["obj_1", { state: "fresh", baseRevision: "ok" }],
        ["obj_2", { state: "missing" }],
      ]),
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toContain("external-source-missing");
  });
});
