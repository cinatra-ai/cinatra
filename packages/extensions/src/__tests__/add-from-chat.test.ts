// add-from-chat detection + proposal tests.
import { describe, expect, it } from "vitest";

import {
  SourceDetectionError,
  buildProposal,
  detectSourceRef,
} from "../add-from-chat";

describe("source detection", () => {
  it("detects GitHub URLs with and without ref/path", () => {
    expect(detectSourceRef("github.com/cinatra-ai/foo-agent")).toMatchObject({
      type: "github",
      repo: "cinatra-ai/foo-agent",
    });
    expect(detectSourceRef("https://github.com/cinatra-ai/foo-agent@v1.2.3")).toMatchObject({
      type: "github",
      repo: "cinatra-ai/foo-agent",
      ref: "v1.2.3",
    });
    expect(detectSourceRef("https://github.com/o/r.git#packages/x")).toMatchObject({
      type: "github",
      repo: "o/r",
      path: "packages/x",
    });
  });

  it("detects private @cinatra-ai scope as verdaccio", () => {
    expect(detectSourceRef("@cinatra-ai/security-reviewer-agent")).toMatchObject({
      type: "verdaccio",
      packageName: "@cinatra-ai/security-reviewer-agent",
    });
    expect(detectSourceRef("@cinatra-ai/foo-agent@2.0.0")).toMatchObject({
      type: "verdaccio",
      packageName: "@cinatra-ai/foo-agent",
      version: "2.0.0",
    });
  });

  it("detects third-party scope/name as npm", () => {
    expect(detectSourceRef("lodash@4.17.21")).toMatchObject({
      type: "npm",
      packageName: "lodash",
      version: "4.17.21",
    });
    expect(detectSourceRef("@acme/widget")).toMatchObject({
      type: "npm",
      packageName: "@acme/widget",
    });
  });

  it("detects local paths (file:// + fs paths)", () => {
    expect(detectSourceRef("file:///opt/ext/foo")).toMatchObject({
      type: "local",
      path: "/opt/ext/foo",
    });
    expect(detectSourceRef("./local/ext")).toMatchObject({ type: "local", path: "./local/ext" });
  });

  it("throws structured error on empty + unrecognised", () => {
    expect(() => detectSourceRef("")).toThrow(SourceDetectionError);
    expect(() => detectSourceRef("!!! not a ref @@@")).toThrow(SourceDetectionError);
  });
});

describe("proposal building (thin propose-confirm)", () => {
  it("builds a github proposal requiring confirmation", () => {
    const detected = detectSourceRef("github.com/cinatra-ai/foo-agent@v1");
    const proposal = buildProposal(detected, { kind: "agent" });
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.source.type).toBe("github");
    expect(proposal.kind).toBe("agent");
    expect(proposal.summary).toContain("Confirm");
  });

  it("builds a verdaccio proposal for a private package", () => {
    const detected = detectSourceRef("@cinatra-ai/foo-agent@2.0.0");
    const proposal = buildProposal(detected, { kind: "agent", registryUrl: "http://localhost:4873" });
    expect(proposal.source.type).toBe("verdaccio");
    if (proposal.source.type === "verdaccio") {
      expect(proposal.source.version).toBe("2.0.0");
    }
  });

  it("kind defaults to unknown when not resolved", () => {
    const detected = detectSourceRef("file:///x/y");
    const proposal = buildProposal(detected);
    expect(proposal.kind).toBe("unknown");
    expect(proposal.summary).toContain("extension");
  });

  it("proposal provenance placeholders fail validation until resolved", async () => {
    const { validateExtensionSource } = await import("../canonical-types");
    // A github proposal carries resolvedSha:"pending-resolution" + ref fallback
    // "HEAD" - both are placeholders that MUST NOT pass provenance validation.
    const ghProposal = buildProposal(detectSourceRef("github.com/o/r"), { kind: "agent" });
    expect(validateExtensionSource(ghProposal.source).length).toBeGreaterThan(0);
    // A verdaccio proposal without a pinned version -> version "latest" +
    // integrity "pending-resolution" -> also invalid.
    const vProposal = buildProposal(detectSourceRef("@cinatra-ai/foo-agent"), { kind: "agent" });
    expect(validateExtensionSource(vProposal.source).length).toBeGreaterThan(0);
  });
});
