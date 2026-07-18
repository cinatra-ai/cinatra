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
//
// Plural naming (cinatra#1453, epic cinatra#1448): the slug suffix also
// accepts the plural `-artifacts` form (a pack that holds — or is expected to
// grow to — more than one type); the singular `-artifact` stays valid for
// single-type packs. Both forms are exercised below, alongside the rejection
// cases proving the `s?` quantifier did NOT relax the boundary (it is
// zero-or-one, and only on the -artifact kind).

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

  it("accepts the plural @<vendor>/<slug>-artifacts form (cinatra#1453)", () => {
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@cinatra-ai/email-artifacts")).toBe(true);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@cinatra-ai/linkedin-artifacts")).toBe(true);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@acme-vendor/competitor-teardown-artifacts")).toBe(true);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@a/b-artifacts")).toBe(true);
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

  it("rejects plural malformations — `s?` is zero-or-one and only on -artifact (cinatra#1453)", () => {
    // Bare plural with no `<slug>-` prefix (mirrors the singular @<vendor>/artifact reject):
    // the suffix must still attach to a real slug segment.
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@cinatra-ai/artifacts")).toBe(false);
    // Trailing double-s: the quantifier is `s?` (zero-or-one), never `s*`/`s+`.
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@cinatra-ai/email-artifactss")).toBe(false);
    // A stray char after the suffix is still rejected (kind-at-end is exact).
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@cinatra-ai/email-artifacts-x")).toBe(false);
    // The plural applies ONLY to the -artifact kind — it is not a general pluralizer.
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@acme/widget-connectors")).toBe(false);
    // Uppercase and nested paths stay rejected for the plural form too.
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@Vendor/Thing-Artifacts")).toBe(false);
    expect(GENERIC_VENDOR_ARTIFACT_NAME_RE.test("@vendor/a/b-artifacts")).toBe(false);
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

  it("accepts a well-formed PLURAL-named artifact manifest (cinatra#1453)", async () => {
    const result = await validate({
      name: "@cinatra-ai/email-artifacts",
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
    // The message names BOTH accepted forms since cinatra#1453 (the plural is
    // not merely a substring of the singular — assert it verbatim).
    expect(result.errors?.some((e) => e.includes("@<vendor>/<slug>-artifacts"))).toBe(true);
  });
});
