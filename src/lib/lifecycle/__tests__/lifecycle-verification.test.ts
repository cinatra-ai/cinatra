import { describe, expect, it } from "vitest";

import {
  computeVerificationVerdict,
  scopeManifestFromFindings,
} from "../lifecycle-verification";

describe("computeVerificationVerdict — S4 post-change verification core (cinatra#2042)", () => {
  const findings = [
    { id: "f1", path: "subject" },
    { id: "f2", path: "body" },
  ];
  const scope = scopeManifestFromFindings(findings);

  it("verified: every accepted finding's field changed and no field changed out of scope", () => {
    const v = computeVerificationVerdict({
      acceptedFindings: findings,
      scopeManifest: scope,
      baseFields: { subject: "Hi", body: "old", cc: "a@x" },
      repairedFields: { subject: "Hello", body: "new", cc: "a@x" },
    });
    expect(v.outcome).toBe("verified");
    expect(v.unmetFindingIds).toEqual([]);
    expect(v.outOfScopePaths).toEqual([]);
    // The before/after diff carries exactly the two changed fields.
    expect(v.fieldDiff).toEqual([
      { field: "body", before: "old", after: "new" },
      { field: "subject", before: "Hi", after: "Hello" },
    ]);
  });

  it("unmet: an IN-SCOPE finding left unapplied is flagged (independent of the producer's claim)", () => {
    const v = computeVerificationVerdict({
      acceptedFindings: findings,
      scopeManifest: scope,
      // body unchanged ⇒ f2 unapplied, even if the producer claimed it applied.
      baseFields: { subject: "Hi", body: "same" },
      repairedFields: { subject: "Hello", body: "same" },
    });
    expect(v.outcome).toBe("unmet");
    expect(v.unmetFindingIds).toEqual(["f2"]);
    expect(v.outOfScopePaths).toEqual([]);
  });

  it("drifted: an OUT-OF-SCOPE change (a field no finding named) is flagged", () => {
    const v = computeVerificationVerdict({
      acceptedFindings: findings,
      scopeManifest: scope,
      baseFields: { subject: "Hi", body: "old", cc: "a@x" },
      // cc changed but no finding named it ⇒ out-of-scope drift.
      repairedFields: { subject: "Hello", body: "new", cc: "evil@x" },
    });
    expect(v.outcome).toBe("drifted");
    expect(v.outOfScopePaths).toEqual(["cc"]);
  });

  it("drift takes precedence over an unmet finding when both are present", () => {
    const v = computeVerificationVerdict({
      acceptedFindings: findings,
      scopeManifest: scope,
      baseFields: { subject: "Hi", body: "old", cc: "a@x" },
      repairedFields: { subject: "Hi", body: "new", cc: "evil@x" }, // f1 unmet + cc drift
      });
    expect(v.outcome).toBe("drifted");
    expect(v.unmetFindingIds).toEqual(["f1"]);
    expect(v.outOfScopePaths).toEqual(["cc"]);
  });

  it("validator failures force a non-verified verdict even with all findings applied and no drift", () => {
    const v = computeVerificationVerdict({
      acceptedFindings: findings,
      scopeManifest: scope,
      baseFields: { subject: "Hi", body: "old" },
      repairedFields: { subject: "Hello", body: "new" },
      validatorFailures: ["type: subject exceeds max length"],
    });
    expect(v.outcome).toBe("unmet");
    expect(v.validatorFailures).toEqual(["type: subject exceeds max length"]);
  });

  it("a mismatched rendered representation forces a non-verified verdict", () => {
    const v = computeVerificationVerdict({
      acceptedFindings: findings,
      scopeManifest: scope,
      baseFields: { subject: "Hi", body: "old" },
      repairedFields: { subject: "Hello", body: "new" },
      representationMatches: false,
    });
    expect(v.outcome).toBe("unmet");
    expect(v.representationMatches).toBe(false);
  });

  it("a finding whose field is ABSENT from the projection is advisory — verification only judges what it saw", () => {
    // The projector could not expose `body` (e.g. a type-agnostic representation
    // projection); f2 must NOT be asserted unapplied.
    const v = computeVerificationVerdict({
      acceptedFindings: findings,
      scopeManifest: scope,
      baseFields: { subject: "Hi" },
      repairedFields: { subject: "Hello" },
    });
    expect(v.outcome).toBe("verified");
    expect(v.unmetFindingIds).toEqual([]);
  });

  it("a path-less finding is advisory — it never forces an unmet verdict", () => {
    const v = computeVerificationVerdict({
      acceptedFindings: [{ id: "advice", path: null }],
      scopeManifest: { paths: [] },
      baseFields: { subject: "Hi" },
      repairedFields: { subject: "Hi" },
    });
    expect(v.outcome).toBe("verified");
    expect(v.unmetFindingIds).toEqual([]);
  });
});
