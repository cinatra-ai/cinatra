import { describe, expect, it } from "vitest";
import {
  FIRST_PARTY_PACKAGE_SCOPE,
  dependencyScopePrefixesFor,
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
