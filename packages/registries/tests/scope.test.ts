import { describe, expect, it } from "vitest";
import {
  FIRST_PARTY_PACKAGE_SCOPE,
  dependencyScopePrefixesFor,
  parsePackageId,
  vendorScopeOfPackage,
} from "@cinatra-ai/registries";

describe("vendorScopeOfPackage", () => {
  it("extracts the scope from a scoped package name", () => {
    expect(vendorScopeOfPackage("@cinatra-ai/contract-artifact")).toBe("@cinatra-ai");
    expect(vendorScopeOfPackage("@acme/widget")).toBe("@acme");
  });

  it("returns null for unscoped names", () => {
    expect(vendorScopeOfPackage("lodash")).toBeNull();
  });

  it("returns null for malformed inputs", () => {
    expect(vendorScopeOfPackage("@foo")).toBeNull(); // no slash
    expect(vendorScopeOfPackage("@/foo")).toBeNull(); // empty scope
    expect(vendorScopeOfPackage("")).toBeNull();
  });
});

describe("parsePackageId — canonical @vendor/name splitter (cinatra#537)", () => {
  it("splits a hyphenated SCOPE on the first '/' only — never on '-'", () => {
    // The exact #537 regression: the hyphen in the scope must NOT be treated
    // as a vendor/name boundary.
    expect(parsePackageId("@marcushorndt-local/page-summarizer-agent")).toEqual({
      vendor: "marcushorndt-local",
      name: "page-summarizer-agent",
    });
  });

  it("parses a first-party scoped name", () => {
    expect(parsePackageId("@cinatra-ai/foo")).toEqual({ vendor: "cinatra-ai", name: "foo" });
  });

  it("keeps every hyphen in a multi-hyphen scope inside the vendor", () => {
    expect(parsePackageId("@a-b-c-d/my-cool-agent")).toEqual({
      vendor: "a-b-c-d",
      name: "my-cool-agent",
    });
  });

  it("strips the leading '@' from the returned vendor (usable as a path segment)", () => {
    const parsed = parsePackageId("@acme/widget");
    expect(parsed?.vendor).toBe("acme"); // no leading "@"
    expect(parsed?.name).toBe("widget");
  });

  it("preserves additional '/' segments in the name part verbatim", () => {
    expect(parsePackageId("@acme/sub/deep")).toEqual({ vendor: "acme", name: "sub/deep" });
  });

  it("returns vendor=null for an unscoped name (caller decides its own fallback)", () => {
    // The repo convention: unscoped → no vendor, name is the whole input. We
    // deliberately do NOT guess a vendor by splitting on '-' (that was the bug).
    expect(parsePackageId("page-summarizer-agent")).toEqual({
      vendor: null,
      name: "page-summarizer-agent",
    });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parsePackageId("  @acme/widget  ")).toEqual({ vendor: "acme", name: "widget" });
  });

  it("returns null for malformed scoped inputs (mirrors vendorScopeOfPackage)", () => {
    expect(parsePackageId("@foo")).toBeNull(); // no slash
    expect(parsePackageId("@/foo")).toBeNull(); // empty scope
    expect(parsePackageId("@acme/")).toBeNull(); // empty name
    expect(parsePackageId("@")).toBeNull();
    expect(parsePackageId("")).toBeNull();
  });

  it("agrees with vendorScopeOfPackage on the vendor for every well-formed scoped name", () => {
    for (const name of ["@cinatra-ai/foo", "@marcushorndt-local/page-summarizer-agent", "@acme/widget"]) {
      const parsed = parsePackageId(name);
      const scope = vendorScopeOfPackage(name);
      expect(scope).toBe(`@${parsed?.vendor}`);
    }
  });
});

describe("dependencyScopePrefixesFor", () => {
  it("returns own scope + first-party for a third-party root", () => {
    expect(dependencyScopePrefixesFor("@acme/widget").sort()).toEqual(
      [`${FIRST_PARTY_PACKAGE_SCOPE}/`, "@acme/"].sort(),
    );
  });

  it("deduplicates for a first-party root", () => {
    expect(dependencyScopePrefixesFor("@cinatra-ai/blog-idea-generator-agent")).toEqual([
      `${FIRST_PARTY_PACKAGE_SCOPE}/`,
    ]);
  });

  it("yields only the first-party prefix for an unscoped root (which the resolver then rejects)", () => {
    expect(dependencyScopePrefixesFor("lodash")).toEqual([`${FIRST_PARTY_PACKAGE_SCOPE}/`]);
  });

  it("never derives the allowlist from anything but the root package name", () => {
    // Regression contract for issue #103: the instance namespace must not
    // appear here. The function signature only accepts the root name, so this
    // simply pins the first-party constant's value.
    expect(FIRST_PARTY_PACKAGE_SCOPE).toBe("@cinatra-ai");
  });
});
