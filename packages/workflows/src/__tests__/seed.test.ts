import { describe, it, expect } from "vitest";
import { MAJOR_PRODUCT_RELEASE_TEMPLATE } from "../seed/major-product-release";
import { validateTemplate, validateDraft } from "../spec";

describe("Major Product Release template", () => {
  it("is template-valid (relative schedules + placeholders, no concrete release)", () => {
    const r = validateTemplate(MAJOR_PRODUCT_RELEASE_TEMPLATE);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it("is NOT draft-valid until instantiated (unfilled placeholder + no release date)", () => {
    const r = validateDraft(MAJOR_PRODUCT_RELEASE_TEMPLATE);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "UNRESOLVED_PLACEHOLDER")).toBe(true);
  });
});
