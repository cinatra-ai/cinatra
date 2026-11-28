// red-first-expect: Cannot find package '@/lib/extension-declared-consumes'
// cinatra#4894 — the declared-consumes module on its own: reading a pack's raw
// `cinatra.consumes` (manifest text and store record) and refusing a primitive
// it does not declare. Fixture packs are made up; the compiled-in generated map
// is replaced with a fixture map.
import { describe, it, expect, vi } from "vitest";
import { parseConsumedPrimitives } from "@cinatra-ai/sdk-extensions/consumes";
import {
  assertPrimitiveDeclared,
  consumesDeclarationOfManifestText,
  consumesDeclarationOfStoreRecord,
} from "@/lib/extension-declared-consumes";

const PKG = "@example-org/sample-agent";

vi.mock("@/lib/generated/extensions.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  GENERATED_EXTENSION_CONSUMES_DECLARATIONS: {
    "@example-org/sample-agent": { consumes: [{ primitive: "bundled_only_tool", requirement: "required" }] },
    "@example-org/broken-agent": { consumes: null },
  },
}));

const DECLARATION = {
  consumes: [
    { primitive: "sample_record_get", requirement: "required" },
    { primitive: "sample_record_list", requirement: "optional" },
  ],
};

describe("assertPrimitiveDeclared", () => {
  it("finds a declared primitive, required or optional", async () => {
    await expect(assertPrimitiveDeclared(PKG, "sample_record_get", DECLARATION)).resolves.toBeUndefined();
    await expect(assertPrimitiveDeclared(PKG, "sample_record_list", DECLARATION)).resolves.toBeUndefined();
  });

  it("refuses an undeclared primitive, a non-string name, and a pack that declares nothing", async () => {
    await expect(assertPrimitiveDeclared(PKG, "sample_record_delete", DECLARATION)).rejects.toThrow(
      /@example-org\/sample-agent.*"sample_record_delete".*not declared in the package's cinatra\.consumes/,
    );
    await expect(assertPrimitiveDeclared(PKG, 42, DECLARATION)).rejects.toThrow(/not declared/);
    await expect(assertPrimitiveDeclared(PKG, "sample_record_get", {})).rejects.toThrow(/not declared/);
  });

  it("a missing or malformed declaration cannot be determined", async () => {
    await expect(assertPrimitiveDeclared(PKG, "sample_record_get", null)).rejects.toThrow(/cannot be determined/);
    await expect(assertPrimitiveDeclared(PKG, "sample_record_get", { consumes: null })).rejects.toThrow(
      /cannot be determined/,
    );
    await expect(assertPrimitiveDeclared("@example-org/never-generated", "x", undefined)).rejects.toThrow(
      /cannot be determined/,
    );
    await expect(assertPrimitiveDeclared("@example-org/broken-agent", "x", undefined)).rejects.toThrow(
      /cannot be determined/,
    );
  });

  it("a store-supplied declaration wins over the compiled-in map for the same package name", async () => {
    await expect(assertPrimitiveDeclared(PKG, "bundled_only_tool", undefined)).resolves.toBeUndefined();
    await expect(assertPrimitiveDeclared(PKG, "bundled_only_tool", DECLARATION)).rejects.toThrow(/not declared/);
    await expect(assertPrimitiveDeclared(PKG, "sample_record_get", DECLARATION)).resolves.toBeUndefined();
  });
});

describe("reading the raw declaration", () => {
  it("consumesDeclarationOfManifestText carries consumes as-is, {} when absent, null without a cinatra block", () => {
    expect(consumesDeclarationOfManifestText(JSON.stringify({ name: PKG, cinatra: DECLARATION }))).toEqual(DECLARATION);
    expect(consumesDeclarationOfManifestText(JSON.stringify({ name: PKG, cinatra: {} }))).toEqual({});
    expect(consumesDeclarationOfManifestText(JSON.stringify({ name: PKG }))).toBeNull();
    expect(consumesDeclarationOfManifestText("{not json")).toBeNull();
  });

  it("consumesDeclarationOfStoreRecord reads the record's field, null when it carries none", () => {
    expect(consumesDeclarationOfStoreRecord({ packageName: PKG, consumesDeclaration: DECLARATION })).toEqual(
      DECLARATION,
    );
    expect(consumesDeclarationOfStoreRecord({ packageName: PKG })).toBeNull();
    expect(consumesDeclarationOfStoreRecord({ packageName: PKG, consumesDeclaration: [] })).toBeNull();
  });

  it("the primitives it lets through are exactly the ones parseConsumedPrimitives reads", async () => {
    const parsed = parseConsumedPrimitives({ cinatra: DECLARATION }, { packageName: PKG }).map((c) => c.primitive);
    for (const name of ["sample_record_get", "sample_record_list", "sample_record_delete"]) {
      const allowed = await assertPrimitiveDeclared(PKG, name, DECLARATION).then(
        () => true,
        () => false,
      );
      expect(allowed).toBe(parsed.includes(name));
    }
  });
});
