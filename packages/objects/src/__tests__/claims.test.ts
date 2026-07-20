import { describe, expect, it } from "vitest";

import {
  ARTIFACT_MUTABILITY_CLASSES,
  claimPrecedenceRank,
  claimWinnerProjectionDisposition,
  effectiveMutableBy,
  isValidClaimScope,
  isWinnerEligible,
  orgClaimScope,
  parseClaimDispositions,
  resolveClaimWinner,
  validateMutabilityNarrowsBaseline,
  type ArbitrableClaim,
  type ArtifactMutability,
  type ObjectMutator,
} from "../claims";
import type { ArtifactObjectTypeClaim } from "../types";

// Type-mirror parity (cinatra#1449): the type-only
// `ArtifactObjectTypeClaim.dispositions.mutability` in ../types is a structural
// twin of `ArtifactMutability` in ../claims. These two assignments are legal
// ONLY while the unions are identical — if either side gains or drops a member,
// `tsgo --noEmit` (CI typecheck, which includes this file) fails here.
type MirroredMutability = NonNullable<ArtifactObjectTypeClaim["dispositions"]>["mutability"];
const _mutabilityFwd: MirroredMutability = undefined as ArtifactMutability | undefined;
const _mutabilityRev: ArtifactMutability | undefined = undefined as MirroredMutability;
void _mutabilityFwd;
void _mutabilityRev;

function claim(partial: Partial<ArbitrableClaim> & Pick<ArbitrableClaim, "id" | "scope" | "claimKind">): ArbitrableClaim {
  return {
    objectTypeId: "@vendor/pkg:thing",
    status: "active",
    extensionPackage: "@vendor/pkg-artifact",
    extensionVersion: "1.0.0",
    generation: 1,
    ...partial,
  };
}

describe("claim scopes", () => {
  it("accepts platform and org:<id>, rejects everything else", () => {
    expect(isValidClaimScope("platform")).toBe(true);
    expect(isValidClaimScope(orgClaimScope("org-1"))).toBe(true);
    expect(isValidClaimScope("org:")).toBe(false); // empty org id
    expect(isValidClaimScope("workspace")).toBe(false);
    expect(isValidClaimScope("user:u1")).toBe(false);
  });
});

describe("kind-over-scope precedence", () => {
  it("ranks dedicated-org > dedicated-platform > default-org > default-platform", () => {
    const orgId = "org-1";
    expect(claimPrecedenceRank({ claimKind: "dedicated", scope: "org:org-1" }, orgId)).toBe(0);
    expect(claimPrecedenceRank({ claimKind: "dedicated", scope: "platform" }, orgId)).toBe(1);
    expect(claimPrecedenceRank({ claimKind: "default", scope: "org:org-1" }, orgId)).toBe(2);
    expect(claimPrecedenceRank({ claimKind: "default", scope: "platform" }, orgId)).toBe(3);
  });

  it("never ranks another org's claim", () => {
    expect(claimPrecedenceRank({ claimKind: "dedicated", scope: "org:other" }, "org-1")).toBeNull();
  });
});

describe("resolveClaimWinner", () => {
  it("org claim overrides platform claim (AC-2)", () => {
    const winner = resolveClaimWinner(
      [
        claim({ id: "p", scope: "platform", claimKind: "dedicated" }),
        claim({ id: "o", scope: "org:org-1", claimKind: "dedicated" }),
      ],
      { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" },
    );
    expect(winner?.id).toBe("o");
  });

  it("kind dominates scope: a platform DEDICATED claim beats an org DEFAULT claim", () => {
    const winner = resolveClaimWinner(
      [
        claim({ id: "d", scope: "platform", claimKind: "dedicated" }),
        claim({ id: "f", scope: "org:org-1", claimKind: "default" }),
      ],
      { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" },
    );
    expect(winner?.id).toBe("d");
  });

  it("ignores dormant / reserved / retired claims and other orgs' claims", () => {
    const winner = resolveClaimWinner(
      [
        claim({ id: "dormant", scope: "org:org-1", claimKind: "default", status: "dormant" }),
        claim({ id: "reserved", scope: "org:org-1", claimKind: "dedicated", status: "reserved" }),
        claim({ id: "retired", scope: "org:org-1", claimKind: "dedicated", status: "retired" }),
        claim({ id: "foreign", scope: "org:other", claimKind: "dedicated" }),
        claim({ id: "live", scope: "platform", claimKind: "default" }),
      ],
      { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" },
    );
    expect(winner?.id).toBe("live");
  });

  it("a RETIRING claim remains the winner until retired (transition safety)", () => {
    expect(isWinnerEligible("retiring")).toBe(true);
    const winner = resolveClaimWinner(
      [claim({ id: "r", scope: "platform", claimKind: "dedicated", status: "retiring" })],
      { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" },
    );
    expect(winner?.id).toBe("r");
  });

  it("returns null when nothing claims the type", () => {
    expect(
      resolveClaimWinner([], { orgId: "org-1", objectTypeId: "@vendor/pkg:thing" }),
    ).toBeNull();
  });
});

describe("claim dispositions union", () => {
  it("parses a full artifact-safe payload", () => {
    const parsed = parseClaimDispositions({
      projection: "artifact-safe",
      snapshotPolicy: "content",
      redactionPolicyVersion: "v1",
      pinnable: true,
      sensitivity: "sensitive",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.dispositions.projection).toBe("artifact-safe");
      expect(parsed.dispositions.pinnable).toBe(true);
    }
  });

  it("applies defaults (snapshotPolicy none, sensitivity normal, pinnable false)", () => {
    const parsed = parseClaimDispositions({ projection: "raw" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.dispositions).toMatchObject({
        projection: "raw",
        snapshotPolicy: "none",
        sensitivity: "normal",
        pinnable: false,
      });
    }
  });

  it("rejects pinnable on a never-projected claim (projection none)", () => {
    const parsed = parseClaimDispositions({ projection: "none", pinnable: true });
    expect(parsed.ok).toBe(false);
  });

  it("rejects unknown keys and unknown projections (fail-closed strict union)", () => {
    expect(parseClaimDispositions({ projection: "raw", surprise: 1 }).ok).toBe(false);
    expect(parseClaimDispositions({ projection: "full" }).ok).toBe(false);
    expect(parseClaimDispositions("raw").ok).toBe(false);
  });

  it("mutability is optional — an absent class parses to undefined", () => {
    const parsed = parseClaimDispositions({ projection: "raw" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.dispositions.mutability).toBeUndefined();
  });

  it("accepts each mutability class (cinatra#1449)", () => {
    for (const mutability of ARTIFACT_MUTABILITY_CLASSES) {
      // external must be pinnable:false; draftable/record are unconstrained here.
      const parsed = parseClaimDispositions({
        projection: "artifact-safe",
        pinnable: false,
        mutability,
      });
      expect(parsed.ok, mutability).toBe(true);
      if (parsed.ok) expect(parsed.dispositions.mutability).toBe(mutability);
    }
  });

  it("the mutability vocabulary is exactly draftable|record|external", () => {
    expect([...ARTIFACT_MUTABILITY_CLASSES]).toEqual(["draftable", "record", "external"]);
  });

  it("rejects an unknown mutability class (fail-closed strict union)", () => {
    expect(parseClaimDispositions({ projection: "raw", mutability: "frozen" }).ok).toBe(false);
  });

  it("rejects a pinnable external claim — pin the snapshot record, not the pointer", () => {
    expect(
      parseClaimDispositions({ projection: "artifact-safe", mutability: "external", pinnable: true })
        .ok,
    ).toBe(false);
    // The same class is fine when the pointer is not pinnable.
    expect(
      parseClaimDispositions({ projection: "artifact-safe", mutability: "external", pinnable: false })
        .ok,
    ).toBe(true);
    // A never-projected external claim is fine (projection:"none" forces pinnable:false).
    expect(parseClaimDispositions({ projection: "none", mutability: "external" }).ok).toBe(true);
  });
});

// The pure baseline-narrowing rule (cinatra#1449) the object write path consumes:
// a mutability class may only NARROW the registering type's mutableBy, never widen.
describe("mutability baseline-narrowing rule", () => {
  const allBaselines: readonly ObjectMutator[][] = [[], ["agent"], ["user"], ["agent", "user"]];

  it("effectiveMutableBy: record/external narrow to [] for every baseline", () => {
    for (const baseline of allBaselines) {
      expect(effectiveMutableBy("record", baseline)).toEqual([]);
      expect(effectiveMutableBy("external", baseline)).toEqual([]);
    }
  });

  it("effectiveMutableBy: draftable and an absent class preserve the baseline (as a copy)", () => {
    const baseline: ObjectMutator[] = ["agent", "user"];
    expect(effectiveMutableBy("draftable", baseline)).toEqual(["agent", "user"]);
    expect(effectiveMutableBy(undefined, baseline)).toEqual(["agent", "user"]);
    // never widens: the result is always a subset of the baseline
    for (const mutability of [...ARTIFACT_MUTABILITY_CLASSES, undefined] as const) {
      for (const b of allBaselines) {
        expect(effectiveMutableBy(mutability, b).every((p) => b.includes(p))).toBe(true);
      }
    }
    // returns a fresh array — mutating it never aliases the baseline
    const copy = effectiveMutableBy("draftable", baseline);
    copy.pop();
    expect(baseline).toEqual(["agent", "user"]);
  });

  it("validateMutabilityNarrowsBaseline: record/external narrow ANY baseline (incl. immutable)", () => {
    for (const baseline of allBaselines) {
      expect(validateMutabilityNarrowsBaseline("record", baseline)).toBeNull();
      expect(validateMutabilityNarrowsBaseline("external", baseline)).toBeNull();
    }
  });

  it("validateMutabilityNarrowsBaseline: draftable is legal on any MUTABLE baseline", () => {
    expect(validateMutabilityNarrowsBaseline("draftable", ["agent"])).toBeNull();
    expect(validateMutabilityNarrowsBaseline("draftable", ["user"])).toBeNull();
    expect(validateMutabilityNarrowsBaseline("draftable", ["agent", "user"])).toBeNull();
  });

  it("validateMutabilityNarrowsBaseline: draftable over an immutable type widens (rejected)", () => {
    const violation = validateMutabilityNarrowsBaseline("draftable", []);
    expect(violation).not.toBeNull();
    expect(violation).toMatch(/widens an immutable type/);
  });
});

// The single fail-closed winner->disposition rule shared by the projector's
// per-row write path, the rebuild driver, and the recall handler (cinatra#1436).
describe("claimWinnerProjectionDisposition (the shared fail-closed rule)", () => {
  it("absent dispositions default to artifact-safe", () => {
    expect(claimWinnerProjectionDisposition({ dispositions: null })).toBe("artifact-safe");
    expect(claimWinnerProjectionDisposition({ dispositions: undefined })).toBe("artifact-safe");
  });

  it("valid dispositions pass through the parsed projection", () => {
    expect(claimWinnerProjectionDisposition({ dispositions: { projection: "raw" } })).toBe("raw");
    expect(claimWinnerProjectionDisposition({ dispositions: { projection: "none" } })).toBe("none");
    expect(claimWinnerProjectionDisposition({ dispositions: { projection: "artifact-safe" } })).toBe(
      "artifact-safe",
    );
  });

  it("INVALID dispositions fail closed DOWN to artifact-safe, never up to raw", () => {
    expect(claimWinnerProjectionDisposition({ dispositions: { projection: "totally-invalid" } })).toBe(
      "artifact-safe",
    );
    expect(claimWinnerProjectionDisposition({ dispositions: { projection: "raw", surprise: 1 } })).toBe(
      "artifact-safe",
    );
    expect(claimWinnerProjectionDisposition({ dispositions: "raw" })).toBe("artifact-safe");
  });
});

