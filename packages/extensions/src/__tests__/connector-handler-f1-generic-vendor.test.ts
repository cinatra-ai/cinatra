import { describe, it, expect } from "vitest";
import {
  createConnectorExtensionHandler,
  GENERIC_VENDOR_CONNECTOR_NAME_RE,
  defaultConnectorVisibility,
  checkConnectorRealpathMatch,
} from "../connector-handler";

// Generic-vendor connector policy boundary tests.
//
// Extension management must accept ANY `@<vendor>/<slug>-connector`
// package, not only packages from a single vendor scope. The widening must be
// stricter than a permissive wildcard. These tests pin all four guard surfaces:
//   1. generic-vendor regex (accepts @example-vendor, @cinatra-ai, @acme...)
//   2. kind:"connector" semantic gate rejects -agent/-skill/-artifact
//   3. package-name↔realpath match + symlink-escape rejection
//   4. default visibility = "admin" unless explicitly set

const baseHandler = createConnectorExtensionHandler();
if (!baseHandler.validate) {
  throw new Error("connector handler must expose validate()");
}
const validate = baseHandler.validate.bind(baseHandler);

describe("generic-vendor connector name regex", () => {
  it("accepts @<vendor>/<slug>-connector for arbitrary vendors", () => {
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@example-vendor/blog-connector")).toBe(true);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@cinatra-ai/social-media-connector")).toBe(true);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@acme/widget-connector")).toBe(true);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@a/b-connector")).toBe(true);
  });

  it("rejects names not ending in -connector", () => {
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@example-vendor/blog-agent")).toBe(false);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@cinatra-ai/some-skill")).toBe(false);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@cinatra-ai/x-artifact")).toBe(false);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@cinatra-ai/connector")).toBe(false);
  });

  it("rejects unscoped / malformed names (no permissive wildcard)", () => {
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("blog-connector")).toBe(false);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@/blog-connector")).toBe(false);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@-bad/blog-connector")).toBe(false);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@Examplenamespace/Blog-Connector")).toBe(false);
    expect(GENERIC_VENDOR_CONNECTOR_NAME_RE.test("@vendor/slug/extra-connector")).toBe(false);
  });
});

describe("validate() kind gate rejects non-connector packages", () => {
  it("accepts a well-formed generic-vendor connector", async () => {
    const result = await validate({
      name: "@example-vendor/blog-connector",
      cinatra: { kind: "connector" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a name-shaped-like-connector package whose kind is agent/skill/artifact", async () => {
    for (const kind of ["agent", "skill", "artifact"]) {
      const result = await validate({
        // The regex would reject these anyway, but the kind gate is the
        // semantic backstop the connector policy relies on.
        name: "@example-vendor/blog-connector",
        cinatra: { kind },
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes("cinatra.kind"))).toBe(true);
    }
  });

  it("rejects -agent / -skill / -artifact named packages even with kind:connector", async () => {
    for (const name of [
      "@example-vendor/blog-agent",
      "@example-vendor/blog-skill",
      "@example-vendor/blog-artifact",
    ]) {
      const result = await validate({
        name,
        cinatra: { kind: "connector" },
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes("kind-at-end convention"))).toBe(true);
    }
  });

  it("rejects an unknown cinatra.visibility value", async () => {
    const result = await validate({
      name: "@example-vendor/blog-connector",
      cinatra: { kind: "connector", visibility: "public" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.includes("cinatra.visibility"))).toBe(true);
  });

  it("accepts an explicit admin/workspace visibility", async () => {
    for (const visibility of ["admin", "workspace"]) {
      const result = await validate({
        name: "@example-vendor/blog-connector",
        cinatra: { kind: "connector", visibility },
      });
      expect(result.valid).toBe(true);
    }
  });
});

describe("defaultConnectorVisibility", () => {
  it("defaults to admin when visibility is unset", () => {
    expect(defaultConnectorVisibility({})).toBe("admin");
    expect(defaultConnectorVisibility({ cinatra: {} })).toBe("admin");
  });
  it("honors an explicit workspace visibility", () => {
    expect(defaultConnectorVisibility({ cinatra: { visibility: "workspace" } })).toBe("workspace");
  });
  it("falls back to admin for any non-workspace value", () => {
    expect(defaultConnectorVisibility({ cinatra: { visibility: "garbage" } })).toBe("admin");
  });
});

describe("checkConnectorRealpathMatch (package-name↔realpath + symlink escape)", () => {
  const root = "/repo/extensions";

  it("accepts a package whose realpath is <root>/<vendor>/<slug>-connector", () => {
    const r = checkConnectorRealpathMatch({
      packageName: "@example-vendor/blog-connector",
      packageRealpath: "/repo/extensions/example-vendor/blog-connector",
      extensionsRootRealpath: root,
    });
    expect(r.valid).toBe(true);
  });

  it("rejects a package whose realpath points outside the extensions root (symlink escape)", () => {
    const r = checkConnectorRealpathMatch({
      packageName: "@example-vendor/blog-connector",
      packageRealpath: "/tmp/evil/blog-connector",
      extensionsRootRealpath: root,
    });
    expect(r.valid).toBe(false);
  });

  it("rejects a vendor/slug path mismatch (name says example-namespace, path says acme)", () => {
    const r = checkConnectorRealpathMatch({
      packageName: "@example-vendor/blog-connector",
      packageRealpath: "/repo/extensions/acme/blog-connector",
      extensionsRootRealpath: root,
    });
    expect(r.valid).toBe(false);
  });

  it("rejects a slug mismatch (name says blog-connector, path says other-connector)", () => {
    const r = checkConnectorRealpathMatch({
      packageName: "@example-vendor/blog-connector",
      packageRealpath: "/repo/extensions/example-vendor/other-connector",
      extensionsRootRealpath: root,
    });
    expect(r.valid).toBe(false);
  });

  it("rejects a non-connector-shaped name outright", () => {
    const r = checkConnectorRealpathMatch({
      packageName: "@example-vendor/blog-agent",
      packageRealpath: "/repo/extensions/example-vendor/blog-agent",
      extensionsRootRealpath: root,
    });
    expect(r.valid).toBe(false);
  });
});
