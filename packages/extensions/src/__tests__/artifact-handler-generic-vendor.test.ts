import { describe, it, expect, vi } from "vitest";

// The handler imports the objects registry for its listActive facet; validate()
// never touches it. Mock the barrel so this UNIT test stays leaf-light (the
// artifact-handler-list-active precedent).
vi.mock("@cinatra-ai/objects", () => ({
  objectTypeRegistry: { listArtifacts: () => [] },
}));

import {
  createArtifactExtensionHandler,
  GENERIC_VENDOR_ARTIFACT_NAME_RE,
} from "../artifact-handler";

// Generic-vendor ARTIFACT policy boundary (cinatra#1425 multi-vendor fix —
// the connector-handler precedent applied to kind:"artifact"). Extension
// management must accept ANY `@<vendor>/<slug>-artifact` package, not only
// first-party ones; the widening stays stricter than a permissive wildcard
// and the kind-at-end + metadata-only gates are unchanged.

const handler = createArtifactExtensionHandler();
if (!handler.validate) {
  throw new Error("artifact handler must expose validate()");
}
const validate = handler.validate.bind(handler);

describe("generic-vendor artifact name regex", () => {
  it("accepts @<vendor>/<slug>-artifact for arbitrary vendors", () => {
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@acme-vendor/competitor-teardown-artifact")).toBe(true);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@cinatra-ai/marketing-icp-artifact")).toBe(true);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@a/b-artifact")).toBe(true);
  });

  it("rejects names not ending in -artifact and malformed scopes (no permissive wildcard)", () => {
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@acme/widget-connector")).toBe(false);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@cinatra-ai/artifact")).toBe(false);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("thing-artifact")).toBe(false);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@/thing-artifact")).toBe(false);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@-bad/thing-artifact")).toBe(false);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@Vendor/Thing-Artifact")).toBe(false);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@vendor/a/b-artifact")).toBe(false);
  });
});

describe("validate() accepts third-vendor artifact packages (AC-5, handler half)", () => {
  it("accepts a well-formed THIRD-VENDOR artifact manifest", async () => {
    const result = await validate({
      name: "@acme-vendor/competitor-teardown-artifact",
      cinatra: {
        kind: "artifact",
        artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      },
    });
    expect(result.valid, result.errors?.join("; ")).toBe(true);
  });

  it("still rejects a wrong-kind or agent-payload-carrying package", async () => {
    const wrongKind = await validate({
      name: "@acme-vendor/competitor-teardown-artifact",
      cinatra: { kind: "agent" },
    });
    expect(wrongKind.valid).toBe(false);

    const agentPayload = await validate({
      name: "@acme-vendor/competitor-teardown-artifact",
      cinatra: {
        kind: "artifact",
        oas: {},
        artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      },
    });
    expect(agentPayload.valid).toBe(false);
  });

  it("still rejects the kind-at-end violation with the vendor-agnostic message", async () => {
    const result = await validate({
      name: "@acme-vendor/competitor-teardown",
      cinatra: {
        kind: "artifact",
        artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.includes("@<vendor>/<slug>-artifact"))).toBe(true);
  });
});
