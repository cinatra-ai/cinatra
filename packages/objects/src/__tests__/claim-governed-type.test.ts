/**
 * A PACK'S OWN CLAIM GOVERNS A TYPE NOBODY REGISTERS (cinatra#3089).
 *
 * A claim of a type in another package's namespace is never registered by the
 * artifact bridge as that package's type. When nothing in the process has
 * registered such a type, the claiming pack's own claim governs it: its inline
 * schema validates the records and the identity it declares in that schema,
 * the keyword `x-cinatra-identity`, gives each record its key. A definition the
 * host or the type's own package makes always wins over such a claim.
 *
 * Every package and type below is under a fixture scope, never a real
 * organisation's slug. The suite never calls `_clearForTests` (other suites of
 * the same worker rely on their registrations): it removes its fixture
 * packages' registrations with `removeByPackage` and drops only its own two
 * fixture host types.
 *
 *   cd packages/objects && pnpm exec vitest run src/__tests__/claim-governed-type.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { objectTypeRegistry } from "../registry";
import { registerParsedArtifactManifest } from "../integration/register-artifact-extensions";
import type { ObjectTypeDefinition, SemanticArtifactManifest } from "../types";

const CLAIMANT = "@fixture-scope/fixture-artifacts";
const SECOND_CLAIMANT = "@fixture-scope/other-artifacts";
const UNOWNED = "@fixture-scope/virtual-mail";
const RECORD = `${UNOWNED}:record`;
const HOSTED = `${UNOWNED}:hosted`;

const DISPOSITIONS = {
  projection: "none",
  pinnable: false,
  snapshotPolicy: "none",
  sensitivity: "sensitive",
  mutability: "record",
} as const;

/** The artifact pack's recipient claim schema, its fields renamed (runId, key,
 *  address), with or without the identity declaration. */
function recordSchema(identity?: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      runId: { type: "string", minLength: 1 },
      key: { type: "string" },
      address: { type: "string", minLength: 1, pattern: "\\S" },
    },
    required: ["runId"],
    anyOf: [
      { required: ["address"] },
      { required: ["key"], properties: { key: { minLength: 1 } } },
    ],
    additionalProperties: true,
    ...(identity === undefined ? {} : { "x-cinatra-identity": identity }),
  };
}

function schemaWithoutProperties(): Record<string, unknown> {
  const schema = recordSchema(["runId"]);
  delete schema.properties;
  return schema;
}

function manifest(type: string, schema: Record<string, unknown> | undefined): SemanticArtifactManifest {
  return {
    accepts: { file: { mimeTypes: ["text/markdown"] } },
    objectTypes: [
      {
        type,
        claim: "dedicated",
        dispositions: { ...DISPOSITIONS },
        ...(schema === undefined ? {} : { schema }),
      },
    ],
  };
}

function definition(type: string): ObjectTypeDefinition<unknown> {
  return {
    type,
    category: "report",
    schema: z.object({ runId: z.string().min(1), address: z.string().trim().min(1) }),
    lifecycle: { sources: ["agent", "import"], mutableBy: ["agent"] },
    renderers: { listRow: null, card: null, detail: null },
  };
}

/** The registry offers no removal of a provenance-less (host) registration, so
 *  the suite drops its OWN two fixture host ids from the registry's map. */
function dropFixtureHostTypes(): void {
  const entries: unknown = Reflect.get(objectTypeRegistry, "entries");
  if (!(entries instanceof Map)) {
    throw new Error("the object type registry keeps no entry map where this suite reads it");
  }
  for (const id of [RECORD, HOSTED]) {
    if (objectTypeRegistry.resolve(id) !== null && objectTypeRegistry.definerOf(id) === null) {
      entries.delete(id);
    }
  }
}

function cleanUp(): void {
  for (const pkg of [CLAIMANT, SECOND_CLAIMANT, UNOWNED]) objectTypeRegistry.removeByPackage(pkg);
  dropFixtureHostTypes();
}

beforeEach(() => {
  cleanUp();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanUp();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

describe("a pack's own claim governs a type nobody registers", () => {
  it("A1 the claim governs the unowned type by its own schema, identity and dispositions", () => {
    expect(registerParsedArtifactManifest(manifest(RECORD, recordSchema(["runId", "key"])), CLAIMANT)).toBe(
      false,
    );
    const def = objectTypeRegistry.resolve(RECORD);
    expect(def).not.toBeNull();
    expect(def?.schema.safeParse({ runId: "r1", key: "k1" }).success).toBe(true);
    expect(def?.schema.safeParse({ runId: "r1", address: "a@example.org" }).success).toBe(true);
    expect(def?.schema.safeParse({ runId: "r1" }).success).toBe(false);
    expect(def?.schema.safeParse({ key: "k1" }).success).toBe(false);
    expect(def?.identityKey?.({ runId: "r1", key: "k1" })).toBe("r1:k1");
    expect(def?.identityKey?.({ runId: "r1", key: " " })).toBeNull();
    expect(def?.identityKey?.({ runId: "r1", address: "a@example.org" })).toBeNull();
    expect(def?.dispositions).toEqual(DISPOSITIONS);
    expect(def?.lifecycle).toEqual({ sources: ["agent", "import"], mutableBy: ["agent"] });
    expect(def?.isArtifact).toBeUndefined();
    expect(objectTypeRegistry.listArtifacts().some((d) => d.type === RECORD)).toBe(false);
    expect(objectTypeRegistry.getRegisteringPackage(RECORD)).toBe(CLAIMANT);
    expect(objectTypeRegistry.definerOf(RECORD)).toBe(CLAIMANT);
  });

  it("A2 a type the host registered first is not taken over by the claim", () => {
    const hosted = definition(HOSTED);
    objectTypeRegistry.register(hosted);
    expect(() =>
      registerParsedArtifactManifest(manifest(HOSTED, recordSchema(["runId", "key"])), CLAIMANT),
    ).not.toThrow();
    expect(objectTypeRegistry.resolve(HOSTED)).toBe(hosted);
    expect(objectTypeRegistry.resolve(HOSTED)?.schema.safeParse({ runId: "r1", key: "k1" }).success).toBe(
      false,
    );
    expect(objectTypeRegistry.definerOf(HOSTED)).toBeNull();
  });

  it("A3 a claim-governed type that the host then registers is replaced, and stays the host's", () => {
    const declared = manifest(RECORD, recordSchema(["runId", "key"]));
    registerParsedArtifactManifest(declared, CLAIMANT);
    expect(objectTypeRegistry.definerOf(RECORD)).toBe(CLAIMANT);
    const hosted = definition(RECORD);
    expect(() => objectTypeRegistry.register(hosted)).not.toThrow();
    expect(objectTypeRegistry.resolve(RECORD)).toBe(hosted);
    expect(objectTypeRegistry.definerOf(RECORD)).toBeNull();
    expect(() => registerParsedArtifactManifest(declared, CLAIMANT)).not.toThrow();
    expect(objectTypeRegistry.resolve(RECORD)).toBe(hosted);
    objectTypeRegistry.removeByPackage(CLAIMANT);
    expect(objectTypeRegistry.resolve(RECORD)).toBe(hosted);
  });

  it("A4 removing the claimant removes the claim-governed type, and a rescan registers it again", () => {
    const declared = manifest(RECORD, recordSchema(["runId", "key"]));
    registerParsedArtifactManifest(declared, CLAIMANT);
    expect(objectTypeRegistry.resolve(RECORD)).not.toBeNull();
    expect(objectTypeRegistry.removeByPackage(CLAIMANT)).toEqual([RECORD]);
    expect(objectTypeRegistry.resolve(RECORD)).toBeNull();
    registerParsedArtifactManifest(declared, CLAIMANT);
    expect(objectTypeRegistry.resolve(RECORD)).not.toBeNull();
    expect(objectTypeRegistry.definerOf(RECORD)).toBe(CLAIMANT);
  });

  it("A5 a second claimant of the same id changes nothing and throws nothing", () => {
    registerParsedArtifactManifest(manifest(RECORD, recordSchema(["runId", "key"])), CLAIMANT);
    const first = objectTypeRegistry.resolve(RECORD);
    expect(first).not.toBeNull();
    expect(() =>
      registerParsedArtifactManifest(manifest(RECORD, recordSchema(["runId", "key"])), SECOND_CLAIMANT),
    ).not.toThrow();
    expect(objectTypeRegistry.resolve(RECORD)).toBe(first);
    expect(objectTypeRegistry.definerOf(RECORD)).toBe(CLAIMANT);
    objectTypeRegistry.removeByPackage(SECOND_CLAIMANT);
    expect(objectTypeRegistry.resolve(RECORD)).toBe(first);
    expect(objectTypeRegistry.definerOf(RECORD)).toBe(CLAIMANT);
  });

  it("A6 a claim with an inline schema and no identity declaration registers nothing", () => {
    expect(() => registerParsedArtifactManifest(manifest(RECORD, recordSchema()), CLAIMANT)).not.toThrow();
    expect(objectTypeRegistry.resolve(RECORD)).toBeNull();
    expect(objectTypeRegistry.definerOf(RECORD)).toBeNull();
  });

  it.each([
    { form: "not an array", schema: recordSchema("runId") },
    { form: "an empty array", schema: recordSchema([]) },
    { form: "a repeated field", schema: recordSchema(["runId", "runId"]) },
    { form: "a non-string entry", schema: recordSchema(["runId", 7]) },
    { form: "a field that is not a key of properties", schema: recordSchema(["runId", "missing"]) },
    { form: "a schema without properties", schema: schemaWithoutProperties() },
  ])("A7 a malformed declaration ($form) registers nothing and throws nothing", ({ schema }) => {
    expect(() => registerParsedArtifactManifest(manifest(RECORD, schema), CLAIMANT)).not.toThrow();
    expect(objectTypeRegistry.resolve(RECORD)).toBeNull();
  });

  it("A8 the namespace's own package replaces a claim-governed type and keeps it after the claimant leaves", () => {
    registerParsedArtifactManifest(manifest(RECORD, recordSchema(["runId", "key"])), CLAIMANT);
    expect(objectTypeRegistry.definerOf(RECORD)).toBe(CLAIMANT);
    const owned = definition(RECORD);
    expect(() => objectTypeRegistry.register(owned, UNOWNED)).not.toThrow();
    expect(objectTypeRegistry.resolve(RECORD)).toBe(owned);
    expect(objectTypeRegistry.definerOf(RECORD)).toBe(UNOWNED);
    objectTypeRegistry.removeByPackage(CLAIMANT);
    expect(objectTypeRegistry.resolve(RECORD)).toBe(owned);
    expect(objectTypeRegistry.definerOf(RECORD)).toBe(UNOWNED);
  });

  it("A9 a declaration beside an inline schema that does not compile registers nothing", () => {
    // Two subschemas share one `$id`: the JSON Schema validator refuses to
    // compile it, so the bridge has no validator to govern the type with.
    const uncompilable = {
      ...recordSchema(["runId", "key"]),
      $id: "https://example.org/fixture-schema",
      properties: {
        runId: { type: "string", $id: "https://example.org/fixture-schema" },
        key: { type: "string" },
      },
    };
    expect(() => registerParsedArtifactManifest(manifest(RECORD, uncompilable), CLAIMANT)).not.toThrow();
    expect(objectTypeRegistry.resolve(RECORD)).toBeNull();
  });
});
