import { describe, it, expect } from "vitest";

import { organizationCreateErrorMessage } from "../error-messages";

describe("organizationCreateErrorMessage — fixed ?error= allowlist", () => {
  it("maps the known codes", () => {
    expect(organizationCreateErrorMessage("missing-name")).toBe(
      "Enter an organization name.",
    );
    expect(organizationCreateErrorMessage("slug-unavailable")).toMatch(
      /unique URL slug/,
    );
  });

  it("returns undefined (no banner) when there is no code", () => {
    expect(organizationCreateErrorMessage(undefined)).toBeUndefined();
    expect(organizationCreateErrorMessage("")).toBeUndefined();
  });

  it("falls back to the generic message for unknown codes", () => {
    expect(organizationCreateErrorMessage("nope")).toBe(
      "Could not create the organization.",
    );
  });

  it("does NOT let inherited object keys escape the allowlist", () => {
    // ?error= is caller-controlled; a bare RECORD[key] lookup would return
    // Object.prototype members (objects/functions — which React cannot
    // render as children) for these instead of the generic string.
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(organizationCreateErrorMessage(key)).toBe(
        "Could not create the organization.",
      );
    }
  });
});
