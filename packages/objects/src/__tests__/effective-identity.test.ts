// The settled effective-identity truth table (cinatra#1426, epic #1424) —
// every row of the matrix, plus the transition-safety cases (stale binding
// after a winner change; claim retired with an installed classic) and the
// install axis (an extension with no install row is INACTIVE for identity).
// AC-1 (matrix), AC-3 (catalog identity browse-only, excluded from
// selectable-identity queries) and AC-4 (uninstalled ⇒ INACTIVE) live here;
// AC-2 (the one-active-binding unique index) is the DB integration test.
import { describe, expect, it } from "vitest";

import {
  ASSERTION_BASES,
  GENERIC_ARTIFACT_OBJECT_TYPE,
  resolveEffectiveIdentity,
  selectableAssertionId,
  type EffectiveIdentityInput,
  type IdentityAssertion,
} from "../effective-identity";
import { DEFAULT_ARTIFACT_EXTENSION } from "../generated/artifact-floor";

const EMAIL_TYPE = "@cinatra-ai/email:draft";
const EMAIL_EXT = "@cinatra-ai/email-artifact";
const ICP_EXT = "@cinatra-ai/marketing-icp-artifact";
const OTHER_EXT = "@cinatra-ai/other-artifact";
const GENERIC_OBJECT_TYPE = "@cinatra-ai/objects:object";

let seq = 0;
function assertion(over: Partial<IdentityAssertion> & { extension: string }): IdentityAssertion {
  seq += 1;
  return {
    id: `sa-${seq}`,
    assertedBy: "user",
    eligibility: "eligible",
    assertionBasis: "classic",
    bindingClaimId: null,
    bindingGeneration: null,
    assertedAt: `2026-07-0${(seq % 9) + 1}T00:00:00Z`,
    ...over,
  };
}

function binding(
  extension: string,
  generation: number,
  id = "sa-binding",
  claimId = "claim-1",
): IdentityAssertion {
  return {
    id,
    extension,
    assertedBy: "agent",
    eligibility: "eligible",
    assertionBasis: "binding",
    bindingClaimId: claimId,
    bindingGeneration: generation,
    assertedAt: "2026-07-01T00:00:00Z",
  };
}

const floorRow = (id = "sa-floor"): IdentityAssertion =>
  assertion({ id, extension: DEFAULT_ARTIFACT_EXTENSION, assertedBy: "agent" });

const allInstalled = () => true;
const noneInstalled = () => false;

function resolve(over: Partial<EffectiveIdentityInput>): ReturnType<typeof resolveEffectiveIdentity> {
  return resolveEffectiveIdentity({
    baseType: GENERIC_ARTIFACT_OBJECT_TYPE,
    claimWinner: null,
    claimWinnerInstalled: false,
    assertions: [],
    isExtensionInstalled: allInstalled,
    ...over,
  });
}

describe("truth-table row 1–2: the generic artifact base type (never claimed, never bound)", () => {
  it("row 1: installed eligible classic wins (highest precedence)", () => {
    const a = assertion({ id: "u1", extension: ICP_EXT, assertedBy: "user" });
    const identity = resolve({ assertions: [a, floorRow()] });
    expect(identity).toEqual({
      kind: "extension",
      extension: ICP_EXT,
      basis: "classic",
      selectable: true,
      assertionId: "u1",
    });
  });

  it("row 2: floor only ⇒ default artifact, selectable through the floor assertion id", () => {
    const identity = resolve({ assertions: [floorRow("f9")] });
    expect(identity).toEqual({ kind: "default-artifact", selectable: true, assertionId: "f9" });
  });

  it("classic precedence: user > authoring_skill > agent; ties break newest-first then lexicographic", () => {
    const agent = assertion({ id: "ag", extension: OTHER_EXT, assertedBy: "agent" });
    const skill = assertion({ id: "sk", extension: ICP_EXT, assertedBy: "authoring_skill" });
    expect(resolve({ assertions: [agent, skill] })).toMatchObject({ extension: ICP_EXT, assertionId: "sk" });
    // Same rank: newest assertedAt wins.
    const older = assertion({ id: "o", extension: ICP_EXT, assertedBy: "agent", assertedAt: "2026-07-01T00:00:00Z" });
    const newer = assertion({ id: "n", extension: OTHER_EXT, assertedBy: "agent", assertedAt: "2026-07-02T00:00:00Z" });
    expect(resolve({ assertions: [older, newer] })).toMatchObject({ extension: OTHER_EXT, assertionId: "n" });
  });

  it("matcher drafts never grant identity (draft ≠ eligible)", () => {
    const draft = assertion({ id: "d", extension: ICP_EXT, assertedBy: "matcher", eligibility: "draft" });
    expect(resolve({ assertions: [draft, floorRow("f")] })).toMatchObject({ kind: "default-artifact", assertionId: "f" });
  });

  it("AC-4: an UNINSTALLED extension's classic assertion is INACTIVE — identity falls to the floor", () => {
    const a = assertion({ id: "u1", extension: ICP_EXT, assertedBy: "user" });
    const identity = resolve({
      assertions: [a, floorRow("f1")],
      isExtensionInstalled: noneInstalled,
    });
    expect(identity).toEqual({ kind: "default-artifact", selectable: true, assertionId: "f1" });
  });

  it("the floor extension itself never needs an install check (system extension exemption is the CALLER's; a floor row resolves regardless of the predicate)", () => {
    // The pure leaf never consults the predicate for the floor row.
    const identity = resolve({ assertions: [floorRow("f2")], isExtensionInstalled: noneInstalled });
    expect(identity).toMatchObject({ kind: "default-artifact", assertionId: "f2" });
  });
});

describe("truth-table rows 3–4: claimed typed rows (dedicated winner)", () => {
  const winner = {
    claimId: "claim-1",
    extensionPackage: EMAIL_EXT,
    claimKind: "dedicated" as const,
    generation: 2,
  };

  it("row 3: a VALID binding (winner's extension at the winner's generation) is the identity; classics coexist without displacing it", () => {
    const identity = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: winner,
      claimWinnerInstalled: true,
      assertions: [binding(EMAIL_EXT, 2, "b1"), assertion({ id: "c1", extension: ICP_EXT, assertedBy: "user" })],
    });
    expect(identity).toEqual({
      kind: "extension",
      extension: EMAIL_EXT,
      basis: "binding",
      selectable: true,
      assertionId: "b1",
    });
    expect(selectableAssertionId(identity)).toBe("b1");
  });

  it("row 4 + AC-3: claim without a landed binding ⇒ BROWSE-ONLY catalog identity — never selectable, no assertion id", () => {
    const identity = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: winner,
      claimWinnerInstalled: true,
      assertions: [],
    });
    expect(identity).toEqual({
      kind: "extension",
      extension: EMAIL_EXT,
      basis: "catalog",
      selectable: false,
      assertionId: null,
    });
    expect(selectableAssertionId(identity)).toBeNull();
  });

  it("transition safety: a STALE binding (generation no longer the winner's) is IGNORED — activation barrier applies", () => {
    const identity = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: winner, // generation 2
      claimWinnerInstalled: true,
      assertions: [binding(EMAIL_EXT, 1, "stale")],
    });
    expect(identity).toMatchObject({ basis: "catalog", selectable: false, assertionId: null });
  });

  it("transition safety: a binding for a DIFFERENT extension than the current winner is stale too", () => {
    const identity = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: winner,
      claimWinnerInstalled: true,
      assertions: [binding(OTHER_EXT, 2, "foreign")],
    });
    expect(identity).toMatchObject({ basis: "catalog", extension: EMAIL_EXT });
  });

  it("transition safety: generations are PER-CLAIM counters — a retired claim's binding never revalidates against a NEW same-package claim that also sits at the same generation", () => {
    // Old claim (claim-old, gen 2) retired; a fresh claim row for the SAME
    // package activates and happens to reach generation 2 as well. The stale
    // binding still carries claim-old — it must NOT be selectable.
    const identity = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: { ...winner, claimId: "claim-new" },
      claimWinnerInstalled: true,
      assertions: [binding(EMAIL_EXT, 2, "stale-row", "claim-old")],
    });
    expect(identity).toMatchObject({ basis: "catalog", selectable: false, assertionId: null });
  });

  it("AC-4: an UNINSTALLED winner is INACTIVE — even a generation-matching binding is ignored and resolution falls through", () => {
    const identity = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: winner,
      claimWinnerInstalled: false,
      assertions: [binding(EMAIL_EXT, 2, "b1"), assertion({ id: "c1", extension: ICP_EXT, assertedBy: "user" })],
    });
    // Falls through to the installed classic (row 5), never the binding.
    expect(identity).toMatchObject({ basis: "classic", extension: ICP_EXT, assertionId: "c1" });
  });
});

describe("truth-table rows 5–6, 9: no effective claim on a typed row", () => {
  it("row 5: claim retired/uninstalled, binding archived, installed eligible classic exists ⇒ that classic extension", () => {
    const identity = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: null, // retired — no winner-eligible claim remains
      assertions: [assertion({ id: "c2", extension: ICP_EXT, assertedBy: "agent" })],
    });
    expect(identity).toMatchObject({ kind: "extension", basis: "classic", extension: ICP_EXT, assertionId: "c2" });
  });

  it("row 6: typed row with NO default coverage and no classic ⇒ plain object (a leftover floor assertion grants nothing)", () => {
    const identity = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: null,
      assertions: [floorRow()],
    });
    expect(identity).toEqual({ kind: "plain-object", selectable: false, assertionId: null });
  });

  it("row 9: proposed dynamic / unclaimed type with nothing at all ⇒ plain object", () => {
    const identity = resolve({ baseType: "@dynamic/proposed:thing", claimWinner: null, assertions: [] });
    expect(identity).toEqual({ kind: "plain-object", selectable: false, assertionId: null });
    expect(selectableAssertionId(identity)).toBeNull();
  });

  it("a stale ACTIVE binding with no remaining claim falls through the table (row 5/6), never errors", () => {
    const withClassic = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: null,
      assertions: [binding(EMAIL_EXT, 1), assertion({ id: "c3", extension: ICP_EXT })],
    });
    expect(withClassic).toMatchObject({ basis: "classic", extension: ICP_EXT });
    const withoutClassic = resolve({
      baseType: EMAIL_TYPE,
      claimWinner: null,
      assertions: [binding(EMAIL_EXT, 1)],
    });
    expect(withoutClassic).toMatchObject({ kind: "plain-object" });
  });
});

describe("truth-table rows 7–8: default-claim coverage (objects:object / approved dynamic)", () => {
  const defaultWinner = {
    claimId: "claim-def",
    extensionPackage: DEFAULT_ARTIFACT_EXTENSION,
    claimKind: "default" as const,
    generation: 3,
  };

  it("row 8: default claim is the winner ⇒ default artifact, selectable through the real floor assertion", () => {
    const identity = resolve({
      baseType: GENERIC_OBJECT_TYPE,
      claimWinner: defaultWinner,
      claimWinnerInstalled: true,
      assertions: [floorRow("f7")],
    });
    expect(identity).toEqual({ kind: "default-artifact", selectable: true, assertionId: "f7" });
  });

  it("row 7: dedicated retired, default reactivated (new generation) ⇒ coverage reactivates; an archived-era binding is gone and a stale one would be ignored", () => {
    const identity = resolve({
      baseType: GENERIC_OBJECT_TYPE,
      claimWinner: { ...defaultWinner, generation: 4 },
      claimWinnerInstalled: true,
      assertions: [floorRow("f8")],
    });
    expect(identity).toEqual({ kind: "default-artifact", selectable: true, assertionId: "f8" });
  });

  it("default coverage without a floor assertion row yet ⇒ default artifact, browse-only (no id to select)", () => {
    const identity = resolve({
      baseType: GENERIC_OBJECT_TYPE,
      claimWinner: defaultWinner,
      claimWinnerInstalled: true,
      assertions: [],
    });
    expect(identity).toEqual({ kind: "default-artifact", selectable: false, assertionId: null });
    expect(selectableAssertionId(identity)).toBeNull();
  });
});

describe("vocabulary + constants", () => {
  it("ASSERTION_BASES is exactly the DDL CHECK vocabulary", () => {
    expect(ASSERTION_BASES).toEqual(["binding", "classic"]);
  });
  it("the generic artifact base type literal matches the canonical constant's value", () => {
    expect(GENERIC_ARTIFACT_OBJECT_TYPE).toBe("@cinatra-ai/artifact:object");
  });
});
