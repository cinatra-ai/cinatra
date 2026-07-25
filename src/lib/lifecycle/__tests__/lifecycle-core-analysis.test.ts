import { describe, expect, it } from "vitest";

import { buildCoreAnalysis, projectionDigest, CORE_ANALYSIS_LANE_ID } from "../lifecycle-core-analysis";

describe("buildCoreAnalysis — S4 core advisor lane provenance (cinatra#2042)", () => {
  const target = { artifactId: "art-1", representationRevisionId: "rev-1" };

  it("stamps FULL provenance: lane id, target revision, projection digest, field lists, authz decision", () => {
    const a = buildCoreAnalysis({
      target,
      projection: { includedFields: { subject: "Hi", body: "text" }, excludedFields: ["ssn"] },
      authzDecision: "partial",
    });
    expect(a.provenance.laneId).toBe(CORE_ANALYSIS_LANE_ID);
    expect(a.provenance.targetArtifactId).toBe("art-1");
    expect(a.provenance.targetRevisionId).toBe("rev-1");
    expect(a.provenance.includedFields).toEqual(["body", "subject"]);
    expect(a.provenance.excludedFields).toEqual(["ssn"]);
    expect(a.provenance.authzDecision).toBe("partial");
    expect(a.provenance.projectionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("analyzes ONLY disclosed fields and NAMES the withheld ones — no output implies broader inspection", () => {
    const a = buildCoreAnalysis({
      target,
      projection: { includedFields: { subject: "Hi" }, excludedFields: ["body", "ssn"] },
      authzDecision: "partial",
    });
    // The withheld fields are named as NOT disclosed, never analyzed.
    expect(a.body).toMatch(/2 field\(s\) were NOT disclosed to this lane: body, ssn/);
    // The disclosed field appears in the provenance field list.
    expect(a.provenance.includedFields).toEqual(["subject"]);
    // The excluded content values never appear in the output.
    expect(a.body).not.toContain("ssn=");
  });

  it("flags empty disclosed fields (content-aware, deterministic)", () => {
    const a = buildCoreAnalysis({
      target,
      projection: { includedFields: { subject: "Hi", body: "  " }, excludedFields: [] },
      authzDecision: "authorized",
    });
    expect(a.analysis.join(" ")).toMatch(/1 disclosed field\(s\) are empty: body/);
  });

  it("a denied disclosure reads nothing and says so", () => {
    const a = buildCoreAnalysis({
      target,
      projection: { includedFields: {}, excludedFields: ["subject", "body"] },
      authzDecision: "denied",
    });
    expect(a.summary).toMatch(/content disclosure denied — no fields were read/);
    expect(a.provenance.includedFields).toEqual([]);
  });

  it("the projection digest is stable + order-independent over the same disclosed content", () => {
    const d1 = projectionDigest({ a: "1", b: "2" });
    const d2 = projectionDigest({ b: "2", a: "1" });
    expect(d1).toBe(d2);
    const d3 = projectionDigest({ a: "1", b: "3" });
    expect(d3).not.toBe(d1);
  });
});
