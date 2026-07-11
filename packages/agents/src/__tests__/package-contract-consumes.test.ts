// cinatra#1032 deliverable 3 — the `cinatra.consumes` declaration must SURVIVE
// publish and install without being silently normalized, dropped, or widened.
//
// Install side: the cinatra metadata schema is a CLOSED zod object (unknown
// keys are silently stripped), so before this field existed a published
// package's consumes block was erased by the parse — and the pm-work-store
// PM-seat binding claim with it. The zod shape is a SEMANTIC MIRROR of the
// authoritative SDK parser (sdk-extensions consumes.ts): non-blank primitive,
// duplicate refusal, extra entry keys tolerated-but-stripped.
//
// Publish side: `carryManifestConsumes` routes the source block through the
// SDK parser itself — ONE truth source, FAIL-LOUD (a malformed block aborts
// the publish; nothing is laundered into validity), explicit [] preserved.
import { describe, expect, it } from "vitest";
import {
  AgentPackageContractViolationError,
  parseAgentPackageManifestForInstall,
} from "../verdaccio/package-contract";
import { carryManifestConsumes } from "../verdaccio/client";

const PM_PKG = "@cinatra-ai/project-manager-agent";

function validManifest(): Record<string, unknown> {
  return {
    name: PM_PKG,
    version: "1.0.0",
    cinatra: {
      packageType: "agent",
      manifestVersion: 1,
      sourceTemplateId: "tpl-1",
      sourceVersionId: "ver-1",
      sourceVersionNumber: 1,
      riskLevel: "low",
      hasApprovalGates: false,
      toolAccess: [],
      ownerOrgId: null,
    },
  };
}

const withConsumes = (consumes: unknown): Record<string, unknown> => {
  const m = validManifest();
  (m.cinatra as Record<string, unknown>).consumes = consumes;
  return m;
};

describe("cinatra.consumes install-parse round-trip (SDK-parity zod mirror)", () => {
  it("preserves a well-formed consumes declaration VERBATIM through the parse", () => {
    const parsed = parseAgentPackageManifestForInstall(
      withConsumes([
        { primitive: "pm-work-store", requirement: "required" },
        { primitive: "artifact_representation_get", requirement: "optional" },
      ]),
      PM_PKG,
    );
    expect(parsed.cinatra.consumes).toEqual([
      { primitive: "pm-work-store", requirement: "required" },
      { primitive: "artifact_representation_get", requirement: "optional" },
    ]);
  });

  it("leaves an ABSENT consumes absent (back-compat: not declared ≠ empty)", () => {
    const parsed = parseAgentPackageManifestForInstall(validManifest(), PM_PKG);
    expect(parsed.cinatra.consumes).toBeUndefined();
  });

  it("preserves an EXPLICITLY empty array (declared-nothing, not erased)", () => {
    const parsed = parseAgentPackageManifestForInstall(withConsumes([]), PM_PKG);
    expect(parsed.cinatra.consumes).toEqual([]);
  });

  it("fails the contract structurally on a malformed entry (bad requirement)", () => {
    expect(() =>
      parseAgentPackageManifestForInstall(
        withConsumes([{ primitive: "pm-work-store", requirement: "sometimes" }]),
        PM_PKG,
      ),
    ).toThrow(AgentPackageContractViolationError);
  });

  it("fails on a WHITESPACE primitive (the SDK's non-blank rule, not zod min(1))", () => {
    expect(() =>
      parseAgentPackageManifestForInstall(
        withConsumes([{ primitive: "   ", requirement: "required" }]),
        PM_PKG,
      ),
    ).toThrow(AgentPackageContractViolationError);
  });

  it("fails on DUPLICATE primitives (the SDK's duplicate refusal)", () => {
    expect(() =>
      parseAgentPackageManifestForInstall(
        withConsumes([
          { primitive: "pm-work-store", requirement: "required" },
          { primitive: "pm-work-store", requirement: "optional" },
        ]),
        PM_PKG,
      ),
    ).toThrow(AgentPackageContractViolationError);
  });

  it("tolerates-but-strips an extra entry key (SDK shape-check parity — a claim, never trusted)", () => {
    const parsed = parseAgentPackageManifestForInstall(
      withConsumes([{ primitive: "pm-work-store", requirement: "required", ownerPackage: "@x/y" }]),
      PM_PKG,
    );
    expect(parsed.cinatra.consumes).toEqual([
      { primitive: "pm-work-store", requirement: "required" },
    ]);
  });
});

describe("carryManifestConsumes (publisher carry — SDK parser, fail-loud)", () => {
  it("returns undefined for an undeclared block (absence stays absent)", async () => {
    expect(await carryManifestConsumes({ name: PM_PKG, cinatra: {} }, PM_PKG)).toBeUndefined();
    expect(await carryManifestConsumes({ name: PM_PKG }, PM_PKG)).toBeUndefined();
  });

  it("preserves an explicitly empty array", async () => {
    expect(await carryManifestConsumes({ cinatra: { consumes: [] } }, PM_PKG)).toEqual([]);
  });

  it("projects well-formed entries to the exact contract shape (extra keys stripped)", async () => {
    expect(
      await carryManifestConsumes(
        {
          cinatra: {
            consumes: [{ primitive: "pm-work-store", requirement: "required", note: "x" }],
          },
        },
        PM_PKG,
      ),
    ).toEqual([{ primitive: "pm-work-store", requirement: "required" }]);
  });

  it("FAILS LOUD on a malformed block — explicit null, blank primitive, bad requirement, duplicates", async () => {
    for (const consumes of [
      null,
      [{ primitive: "  ", requirement: "required" }],
      [{ primitive: "pm-work-store", requirement: "sometimes" }],
      [
        { primitive: "pm-work-store", requirement: "required" },
        { primitive: "pm-work-store", requirement: "required" },
      ],
      "pm-work-store",
    ]) {
      await expect(carryManifestConsumes({ cinatra: { consumes } }, PM_PKG)).rejects.toThrow();
    }
  });
});
