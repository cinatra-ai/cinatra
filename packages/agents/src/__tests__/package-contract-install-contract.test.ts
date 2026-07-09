// cinatra#1163 — install-time metadata-contract validation surfaces a
// STRUCTURED error (package + exact failing fields), not a raw ZodError that
// becomes an opaque HTTP 500. This exercises the pure validator directly:
// one missing field, several missing fields, an entirely-absent cinatra block
// (every required field enumerated), and a present-but-invalid value.
import { describe, expect, it } from "vitest";
import {
  AgentPackageContractViolationError,
  AGENT_PACKAGE_CONTRACT_VIOLATION_CODE,
  parseAgentPackageManifestForInstall,
} from "../verdaccio/package-contract";

// A fully-valid manifest that satisfies the fail-closed metadata contract.
function validManifest(): Record<string, unknown> {
  return {
    name: "@cinatra-ai/example-agent",
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

function cinatra(m: Record<string, unknown>): Record<string, unknown> {
  return m.cinatra as Record<string, unknown>;
}

function expectViolation(fn: () => unknown): AgentPackageContractViolationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AgentPackageContractViolationError);
    return e as AgentPackageContractViolationError;
  }
  throw new Error("expected an AgentPackageContractViolationError to be thrown");
}

describe("parseAgentPackageManifestForInstall (cinatra#1163)", () => {
  it("returns the parsed manifest for a valid package (unchanged success path)", () => {
    const parsed = parseAgentPackageManifestForInstall(
      validManifest(),
      "@cinatra-ai/example-agent",
    );
    expect(parsed.cinatra.riskLevel).toBe("low");
    expect(parsed.name).toBe("@cinatra-ai/example-agent");
  });

  it("throws a STRUCTURED 4xx error naming the package + the ONE missing field", () => {
    const m = validManifest();
    delete cinatra(m).riskLevel;
    const v = expectViolation(() =>
      parseAgentPackageManifestForInstall(m, "@cinatra-ai/example-agent"),
    );
    expect(v.code).toBe(AGENT_PACKAGE_CONTRACT_VIOLATION_CODE);
    expect(v.statusCode).toBe(422);
    expect(v.statusCode).toBeGreaterThanOrEqual(400);
    expect(v.statusCode).toBeLessThan(500);
    expect(v.packageName).toBe("@cinatra-ai/example-agent");
    expect(v.missingFields).toEqual(["cinatra.riskLevel"]);
    expect(v.message).toContain("@cinatra-ai/example-agent");
    expect(v.message).toContain("cinatra.riskLevel");
  });

  it("names SEVERAL missing fields, sorted (per-field detail)", () => {
    const m = validManifest();
    delete cinatra(m).riskLevel;
    delete cinatra(m).toolAccess;
    delete cinatra(m).hasApprovalGates;
    const v = expectViolation(() =>
      parseAgentPackageManifestForInstall(m, "@cinatra-ai/example-agent"),
    );
    expect(v.missingFields).toEqual([
      "cinatra.hasApprovalGates",
      "cinatra.riskLevel",
      "cinatra.toolAccess",
    ]);
  });

  it("enumerates EVERY required cinatra field when the whole cinatra block is absent", () => {
    const m = { name: "@cinatra-ai/example-agent", version: "1.0.0" };
    const v = expectViolation(() =>
      parseAgentPackageManifestForInstall(m, "@cinatra-ai/example-agent"),
    );
    expect(v.missingFields).toEqual(
      expect.arrayContaining([
        "cinatra.packageType",
        "cinatra.manifestVersion",
        "cinatra.sourceTemplateId",
        "cinatra.sourceVersionId",
        "cinatra.sourceVersionNumber",
        "cinatra.riskLevel",
        "cinatra.hasApprovalGates",
        "cinatra.toolAccess",
        "cinatra.ownerOrgId",
      ]),
    );
    // `type` carries a schema default → NOT required → NOT reported.
    expect(v.missingFields).not.toContain("cinatra.type");
  });

  it("reports a present-but-invalid value too (contract failure, not just absence)", () => {
    const m = validManifest();
    cinatra(m).riskLevel = "extreme"; // not in the riskLevel enum
    const v = expectViolation(() =>
      parseAgentPackageManifestForInstall(m, "@cinatra-ai/example-agent"),
    );
    expect(v.missingFields).toContain("cinatra.riskLevel");
  });
});
