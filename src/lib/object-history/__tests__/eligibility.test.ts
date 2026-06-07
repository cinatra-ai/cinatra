import { describe, expect, it } from "vitest";

import { checkEventEligibility } from "../eligibility";
import type { ObjectChangeEvent } from "../types";

function makeEvent(
  overrides: Partial<ObjectChangeEvent> = {},
): Pick<
  ObjectChangeEvent,
  | "objectId"
  | "objectType"
  | "operation"
  | "historyEffect"
  | "objectSchemaVersion"
  | "compensatingTemplateId"
  | "restoreEligible"
  | "restoreIneligibleReason"
> {
  return {
    objectId: "obj_1",
    objectType: "blog.post",
    operation: "update",
    historyEffect: "reversible-internal",
    objectSchemaVersion: "v1",
    compensatingTemplateId: null,
    restoreEligible: true,
    restoreIneligibleReason: null,
    ...overrides,
  };
}

describe("checkEventEligibility", () => {
  it("returns ok for a reversible-internal v1 event", () => {
    const v = checkEventEligibility(makeEvent());
    expect(v.eligible).toBe(true);
    expect(v.reason).toBe("ok");
  });

  it("blocks unknown schema version", () => {
    const v = checkEventEligibility(
      makeEvent({ objectSchemaVersion: "v999" }),
    );
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("schema-version-mismatch");
  });

  it("blocks irreversible-logged without compensating template", () => {
    const v = checkEventEligibility(
      makeEvent({ historyEffect: "irreversible-logged" }),
    );
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("irreversible-no-compensating");
  });

  it("blocks compensating-action without template id", () => {
    const v = checkEventEligibility(
      makeEvent({ historyEffect: "compensating-action" }),
    );
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("irreversible-no-compensating");
  });

  it("allows compensating-action when template id is present", () => {
    const v = checkEventEligibility(
      makeEvent({
        historyEffect: "compensating-action",
        compensatingTemplateId: "tmpl_retract_email_v1",
      }),
    );
    expect(v.eligible).toBe(true);
  });

  it("blocks hard-delete operation", () => {
    const v = checkEventEligibility(
      makeEvent({ operation: "hard-delete" }),
    );
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("hard-deleted");
  });

  it("blocks when referenced object is hard-deleted", () => {
    const v = checkEventEligibility(makeEvent(), {
      referencedObjectsReachable: new Map([["ref_1", "hard-deleted"]]),
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("referenced-object-hard-deleted");
  });

  it("blocks when external freshness reports missing", () => {
    const v = checkEventEligibility(makeEvent(), {
      externalFreshness: new Map([["obj_1", { state: "missing" }]]),
    });
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("external-source-missing");
  });

  it("blocks when external freshness reports changed (CMS-tagged)", () => {
    const v = checkEventEligibility(
      {
        ...makeEvent(),
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      },
      {
        externalFreshness: new Map([
          [
            "obj_1",
            {
              state: "changed",
              baseRevision: "wp_rev_99",
              changedFields: ["title", "content"],
            },
          ],
        ]),
      },
    );
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("external-source-changed");
    expect(v.details).toMatch(/changed|title/);
  });

  it("blocks when freshness unknown — non-silent", () => {
    const v = checkEventEligibility(
      {
        ...makeEvent(),
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      },
      {
        externalFreshness: new Map([["obj_1", { state: "unknown" }]]),
      },
    );
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe("external-source-unknown");
  });

  it("allows unsupported for non-CMS-tagged events (remoteRevisionRef: null)", () => {
    const v = checkEventEligibility(
      { ...makeEvent(), remoteRevisionRef: null },
      {
        externalFreshness: new Map([["obj_1", { state: "unsupported" }]]),
      },
    );
    expect(v.eligible).toBe(true);
  });

  it("blocks unsupported for CMS-tagged events", () => {
    const v = checkEventEligibility(
      {
        ...makeEvent(),
        remoteRevisionRef: {
          connector: "wordpress",
          kind: "wordpress-post",
          remoteId: "42",
        },
      },
      {
        externalFreshness: new Map([["obj_1", { state: "unsupported" }]]),
      },
    );
    expect(v.eligible).toBe(false);
  });

  it("passes when freshness is fresh", () => {
    const v = checkEventEligibility(makeEvent(), {
      externalFreshness: new Map([
        ["obj_1", { state: "fresh", baseRevision: "wp_rev_100" }],
      ]),
    });
    expect(v.eligible).toBe(true);
  });
});
