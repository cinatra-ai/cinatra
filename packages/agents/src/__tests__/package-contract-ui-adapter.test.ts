import { describe, expect, it } from "vitest";
import { cinatraAgentPackageMetadataSchema } from "../verdaccio/package-contract";

const validBase = {
  packageType: "agent" as const,
  manifestVersion: 1 as const,
  sourceTemplateId: "tpl-1",
  sourceVersionId: "ver-1",
  sourceVersionNumber: 1,
  
  type: "leaf" as const,
  riskLevel: "low" as const,
  hasApprovalGates: false,
  toolAccess: [],
  ownerOrgId: null,
};

describe("cinatraAgentPackageMetadataSchema — uiAdapter field (P80-04)", () => {
  it("accepts uiAdapter: 'ag-ui'", () => {
    expect(() => cinatraAgentPackageMetadataSchema.parse({ ...validBase, uiAdapter: "ag-ui" })).not.toThrow();
  });
  it("accepts missing uiAdapter (optional)", () => {
    expect(() => cinatraAgentPackageMetadataSchema.parse(validBase)).not.toThrow();
  });
  it("rejects uiAdapter: 'other'", () => {
    expect(() => cinatraAgentPackageMetadataSchema.parse({ ...validBase, uiAdapter: "other" })).toThrow();
  });
});
