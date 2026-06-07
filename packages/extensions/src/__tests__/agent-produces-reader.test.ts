import { describe, it, expect } from "vitest";
import { readAgentProducesFromPackageManifest } from "../agent-produces-reader";
// LEAF subpath import - NOT `@cinatra-ai/agents` barrel. The leaf
// export keeps this test on the narrow package-contract surface; the
// barrel is too heavy and the byte-mirror test must not drag it in.
import { agentPackageManifestSchema } from "@cinatra-ai/agents/package-contract";

// Agent-produces reader unit + byte-mirror lock.
//
// The reader lives in `packages/extensions/src/agent-produces-reader.ts`
// (NOT in `@cinatra-ai/agents`) to preserve dep direction. The schema
// for `produces` is intentionally byte-mirrored across:
//   - the agents-side write surface (agentPackageManifestSchema.cinatra.produces)
//   - this reader's local validator
// The byte-mirror lock test below asserts both schemas accept and
// reject the SAME inputs.

// Minimal manifest accepted by `agentPackageManifestSchema`. The `cinatra`
// block carries every field the schema requires (no `.optional()`).
// `packageType` is the literal "agent" (CINATRA_AGENT_PACKAGE_TYPE) and
// `manifestVersion` is the literal 1 (CINATRA_AGENT_MANIFEST_VERSION).
const minimalManifest = {
  name: "@vendor/agent-x",
  version: "1.0.0",
  cinatra: {
    packageType: "agent",
    manifestVersion: 1,
    sourceTemplateId: "tpl",
    sourceVersionId: "v",
    sourceVersionNumber: 1,
    riskLevel: "low",
    hasApprovalGates: false,
    toolAccess: [],
    ownerOrgId: null,
  },
};

describe("readAgentProducesFromPackageManifest", () => {
  it("returns [] for a manifest with no `produces` field", () => {
    expect(readAgentProducesFromPackageManifest(minimalManifest)).toEqual([]);
  });

  it("returns [] for a null/undefined input", () => {
    expect(readAgentProducesFromPackageManifest(null)).toEqual([]);
    expect(readAgentProducesFromPackageManifest(undefined)).toEqual([]);
  });

  it("returns [] for a manifest without a `cinatra` block", () => {
    expect(readAgentProducesFromPackageManifest({ name: "x", version: "1" })).toEqual(
      [],
    );
  });

  it("returns the declared `produces` array (defensive copy of objects)", () => {
    const declared = [
      { extension: "@cinatra-ai/marketing-icp-artifact" },
      { extension: "@vendor/icp-artifact" },
    ];
    const out = readAgentProducesFromPackageManifest({
      ...minimalManifest,
      cinatra: { ...minimalManifest.cinatra, produces: declared },
    });
    expect(out).toEqual(declared);
    // Defensive copy: mutating the returned array does not affect the
    // input (i.e. produces objects are NEW, not the caller's refs).
    expect(out[0]).not.toBe(declared[0]);
  });

  it("returns [] for malformed produces (entries missing extension)", () => {
    const out = readAgentProducesFromPackageManifest({
      ...minimalManifest,
      cinatra: {
        ...minimalManifest.cinatra,
        produces: [{ wrongField: "x" }, { extension: "@ok/y" }],
      },
    });
    expect(out).toEqual([]);
  });

  it("strips smuggled extra fields from each produces entry (strict schema)", () => {
    const out = readAgentProducesFromPackageManifest({
      ...minimalManifest,
      cinatra: {
        ...minimalManifest.cinatra,
        produces: [{ extension: "@vendor/x", smuggled: "high-confidence" }],
      },
    });
    // strict() rejects unknown keys -> entry is dropped -> []
    expect(out).toEqual([]);
  });

  // Regression coverage: hostile getter / Proxy must not crash the
  // reader. The contract is "quietly empty on bad input, NEVER throws".
  // A hostile manifest could carry a throwing getter on `cinatra`
  // (e.g. via JSON.parse + Object.defineProperty, a Proxy trap that
  // escaped a sandbox, or a deserialized class with a getter that hits
  // a torn-down DB).
  it("returns [] without throwing when `cinatra` is a throwing getter", () => {
    const hostile = {
      get cinatra() {
        throw new Error("intentionally hostile getter");
      },
    };
    expect(() => readAgentProducesFromPackageManifest(hostile)).not.toThrow();
    expect(readAgentProducesFromPackageManifest(hostile)).toEqual([]);
  });

  it("returns [] without throwing when `produces` is a throwing getter", () => {
    const hostile = {
      cinatra: {
        get produces() {
          throw new Error("intentionally hostile produces getter");
        },
      },
    };
    expect(() => readAgentProducesFromPackageManifest(hostile)).not.toThrow();
    expect(readAgentProducesFromPackageManifest(hostile)).toEqual([]);
  });
});

describe("byte-mirror lock - agents-side write schema vs extensions-side read schema", () => {
  // Both schemas MUST accept/reject the same inputs. A drift here would
  // either let a published manifest carry a `produces` shape the reader
  // refuses, or let the reader return values the write schema would
  // have rejected at publish time.

  const cases: Array<{ name: string; produces: unknown; acceptable: boolean }> = [
    { name: "missing", produces: undefined, acceptable: true },
    { name: "empty array", produces: [], acceptable: true },
    {
      name: "valid single",
      produces: [{ extension: "@a/x" }],
      acceptable: true,
    },
    {
      name: "valid two",
      produces: [{ extension: "@a/x" }, { extension: "@b/y" }],
      acceptable: true,
    },
    { name: "non-array", produces: "@a/x", acceptable: false },
    { name: "missing extension", produces: [{}], acceptable: false },
    {
      name: "smuggled extra field",
      produces: [{ extension: "@a/x", confidence: 1 }],
      acceptable: false,
    },
  ];

  for (const c of cases) {
    it(`agents-write and extensions-read agree: ${c.name}`, () => {
      const manifestInput = {
        ...minimalManifest,
        cinatra: {
          ...minimalManifest.cinatra,
          ...(c.produces === undefined ? {} : { produces: c.produces }),
        },
      };
      const writeOk = agentPackageManifestSchema.safeParse(manifestInput).success;
      // For the reader: "accept" means "returns at least the input's
      // canonical produces array" (or [] when produces was missing).
      const readResult = readAgentProducesFromPackageManifest(manifestInput);
      const readOk =
        c.produces === undefined
          ? readResult.length === 0
          : Array.isArray(c.produces) &&
            readResult.length === (c.produces as unknown[]).length;

      if (c.acceptable) {
        expect(writeOk).toBe(true);
        expect(readOk).toBe(true);
      } else {
        // Both must reject. The write schema throws; the reader
        // returns [] (its quietly-empty fallback shape).
        expect(writeOk).toBe(false);
        // Reader fallback: empty result when invalid.
        if (c.produces !== undefined) {
          // for a non-empty-but-invalid input, reader returns [].
          expect(readResult).toEqual([]);
        }
      }
    });
  }
});
