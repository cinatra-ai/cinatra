// Taxonomy module contract tests.
import { describe, it, expect } from "vitest";
import {
  OBJECT_CATEGORIES,
  UI_FAMILIES,
  ARTIFACT_STATUSES,
  WRAPPER_PRIMITIVES,
  OBJECT_RBAC_RESOURCE_TYPES,
  OBJECT_TYPE_FAMILY,
  OBJECT_TYPE_NAMESPACE_RE,
  isNamespacedObjectTypeId,
  assertDomainNamespacedTypeId,
  objectTypeIdsForFamily,
  uiFamilyForTypeId,
  isKnownObjectTypeId,
} from "../taxonomy";

describe("taxonomy taxa sets", () => {
  it("every taxa set is non-empty", () => {
    expect(OBJECT_CATEGORIES.length).toBeGreaterThan(0);
    expect(UI_FAMILIES.length).toBeGreaterThan(0);
    expect(ARTIFACT_STATUSES.length).toBeGreaterThan(0);
    expect(WRAPPER_PRIMITIVES.length).toBeGreaterThan(0);
    expect(OBJECT_RBAC_RESOURCE_TYPES.length).toBeGreaterThan(0);
  });

  it("wrapper primitives cover the legacy accounts_*/contacts_* surface", () => {
    expect(WRAPPER_PRIMITIVES).toContain("accounts_list");
    expect(WRAPPER_PRIMITIVES).toContain("accounts_delete");
    expect(WRAPPER_PRIMITIVES).toContain("contacts_sources_list");
    // 5 accounts_* + 6 contacts_* = 11
    expect(WRAPPER_PRIMITIVES.length).toBe(11);
  });
});

describe("domain-namespaced type id scheme", () => {
  it("accepts a domain-namespaced id", () => {
    expect(isNamespacedObjectTypeId("@cinatra-ai/entity-contacts:contact")).toBe(true);
    expect(OBJECT_TYPE_NAMESPACE_RE.test("@cinatra-ai/campaigns:campaign")).toBe(true);
    expect(() => assertDomainNamespacedTypeId("@cinatra-ai/assets:blog-post")).not.toThrow();
  });

  it("rejects bare or malformed ids", () => {
    expect(isNamespacedObjectTypeId("contact")).toBe(false);
    expect(isNamespacedObjectTypeId("@cinatra-ai/entity-contacts")).toBe(false); // no :type
    expect(() => assertDomainNamespacedTypeId("contact")).toThrow(/not domain-namespaced/);
  });

  it("every locked type id is itself domain-namespaced", () => {
    for (const id of Object.keys(OBJECT_TYPE_FAMILY)) {
      expect(isNamespacedObjectTypeId(id)).toBe(true);
    }
  });
});

describe("OBJECT_TYPE_FAMILY locked set", () => {
  it("maps accounts + contacts to the entity family", () => {
    expect(objectTypeIdsForFamily("entity")).toEqual([
      "@cinatra-ai/entity-accounts:account",
      "@cinatra-ai/entity-contacts:contact",
    ]);
  });

  it("maps lists and agent templates to their OWN families", () => {
    expect(uiFamilyForTypeId("@cinatra-ai/lists:list")).toBe("list");
    expect(uiFamilyForTypeId("@cinatra-ai/agent-builder:agent-template")).toBe("agent");
    // ...and therefore NOT entity.
    expect(objectTypeIdsForFamily("entity")).not.toContain("@cinatra-ai/lists:list");
    expect(objectTypeIdsForFamily("entity")).not.toContain(
      "@cinatra-ai/agent-builder:agent-template",
    );
  });

  it("maps every asset type to the asset family", () => {
    // Legacy @cinatra-ai/asset-blog:* types are excluded; the asset family is
    // exactly the canonical @cinatra-ai/assets:* model written by the current
    // source of truth.
    expect(objectTypeIdsForFamily("asset").sort()).toEqual(
      [
        "@cinatra-ai/assets:blog-project",
        "@cinatra-ai/assets:blog-idea",
        "@cinatra-ai/assets:blog-post",
      ].sort(),
    );
  });

  it("isKnownObjectTypeId narrows correctly", () => {
    expect(isKnownObjectTypeId("@cinatra-ai/entity-accounts:account")).toBe(true);
    expect(isKnownObjectTypeId("@cinatra-ai/dynamic:email-drafts-bundle")).toBe(false);
  });

  it("every family in the locked map is a valid UiFamily", () => {
    for (const fam of Object.values(OBJECT_TYPE_FAMILY)) {
      expect(UI_FAMILIES).toContain(fam);
    }
  });
});
