// cinatra#4894 — the declared-consumes module on its own: reading a pack's raw
// `cinatra.consumes` (manifest text and store record) and refusing a primitive
// it does not declare. Fixture packs are made up; the compiled-in generated map
// is replaced with a fixture map.
import { describe, it, expect, vi } from "vitest";
import { parseConsumedPrimitives } from "@cinatra-ai/sdk-extensions/consumes";

// Loaded inside each test, so a missing module is a failed assertion, not a
// file that cannot load.
type DeclaredConsumesModule = typeof import("@/lib/extension-declared-consumes");
const load = (): Promise<DeclaredConsumesModule | null> =>
  import("@/lib/extension-declared-consumes").catch(() => null);
async function loadModule(): Promise<DeclaredConsumesModule> {
  const mod = await load();
  expect(mod, "the module exists").not.toBeNull();
  return mod!;
}

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
    const m = await loadModule();
    await expect(m.assertPrimitiveDeclared(PKG, "sample_record_get", DECLARATION)).resolves.toBeUndefined();
    await expect(m.assertPrimitiveDeclared(PKG, "sample_record_list", DECLARATION)).resolves.toBeUndefined();
  });

  it("refuses an undeclared primitive, a non-string name, and a pack that declares nothing", async () => {
    const m = await loadModule();
    await expect(m.assertPrimitiveDeclared(PKG, "sample_record_delete", DECLARATION)).rejects.toThrow(
      /@example-org\/sample-agent.*"sample_record_delete".*not declared in the package's cinatra\.consumes/,
    );
    await expect(m.assertPrimitiveDeclared(PKG, 42, DECLARATION)).rejects.toThrow(/not declared/);
    await expect(m.assertPrimitiveDeclared(PKG, "sample_record_get", {})).rejects.toThrow(/not declared/);
  });

  it("a missing or malformed declaration cannot be determined", async () => {
    const m = await loadModule();
    await expect(m.assertPrimitiveDeclared(PKG, "sample_record_get", null)).rejects.toThrow(/cannot be determined/);
    await expect(m.assertPrimitiveDeclared(PKG, "sample_record_get", { consumes: null })).rejects.toThrow(
      /cannot be determined/,
    );
    await expect(m.assertPrimitiveDeclared("@example-org/never-generated", "x", undefined)).rejects.toThrow(
      /cannot be determined/,
    );
    await expect(m.assertPrimitiveDeclared("@example-org/broken-agent", "x", undefined)).rejects.toThrow(
      /cannot be determined/,
    );
  });

  it("a store-supplied declaration wins over the compiled-in map for the same package name", async () => {
    const m = await loadModule();
    await expect(m.assertPrimitiveDeclared(PKG, "bundled_only_tool", undefined)).resolves.toBeUndefined();
    await expect(m.assertPrimitiveDeclared(PKG, "bundled_only_tool", DECLARATION)).rejects.toThrow(/not declared/);
    await expect(m.assertPrimitiveDeclared(PKG, "sample_record_get", DECLARATION)).resolves.toBeUndefined();
  });
});

describe("reading the raw declaration", () => {
  it("consumesDeclarationOfManifestText carries consumes as-is, {} when absent, null without a cinatra block", async () => {
    const m = await loadModule();
    expect(m.consumesDeclarationOfManifestText(JSON.stringify({ name: PKG, cinatra: DECLARATION }))).toEqual(DECLARATION);
    expect(m.consumesDeclarationOfManifestText(JSON.stringify({ name: PKG, cinatra: {} }))).toEqual({});
    expect(m.consumesDeclarationOfManifestText(JSON.stringify({ name: PKG }))).toBeNull();
    expect(m.consumesDeclarationOfManifestText("{not json")).toBeNull();
  });

  it("consumesDeclarationOfStoreRecord reads the record's field, null when it carries none", async () => {
    const m = await loadModule();
    expect(m.consumesDeclarationOfStoreRecord({ packageName: PKG, consumesDeclaration: DECLARATION })).toEqual(
      DECLARATION,
    );
    expect(m.consumesDeclarationOfStoreRecord({ packageName: PKG })).toBeNull();
    expect(m.consumesDeclarationOfStoreRecord({ packageName: PKG, consumesDeclaration: [] })).toBeNull();
  });

  it("the primitives it lets through are exactly the ones parseConsumedPrimitives reads", async () => {
    const m = await loadModule();
    const parsed = parseConsumedPrimitives({ cinatra: DECLARATION }, { packageName: PKG }).map((c) => c.primitive);
    for (const name of ["sample_record_get", "sample_record_list", "sample_record_delete"]) {
      const allowed = await m.assertPrimitiveDeclared(PKG, name, DECLARATION).then(
        () => true,
        () => false,
      );
      expect(allowed).toBe(parsed.includes(name));
    }
  });
});
