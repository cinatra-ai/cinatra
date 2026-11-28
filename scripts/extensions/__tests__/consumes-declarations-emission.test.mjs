// cinatra#4894 — the manifest generator emits each compiled-in pack's RAW
// `cinatra.consumes` declaration into GENERATED_EXTENSION_CONSUMES_DECLARATIONS
// (src/lib/generated/extensions.server.ts), the map the host reads at call time
// to refuse `ctx.mcp.callPrimitive` of an undeclared primitive. Pins the raw
// pass-through, the emitted map for a fixture tree of made-up packs, and that the
// host's reading of the emitted entry (`parseConsumedPrimitives`) names the same
// primitives the CI check (`collectConsumedTools`) reads from the manifest.
import { describe, it, expect } from "vitest";
import * as generator from "../generate-extension-manifest.mjs";
import { collectConsumedTools } from "../../audit/extension-produces-deps-gate.mjs";
import { parseConsumedPrimitives } from "../../../packages/sdk-extensions/src/consumes";

const { consumesDeclarationOf, emitConsumesDeclarations } = generator;

const FIXTURE_TREE = [
  {
    packageName: "@example-org/alpha-agent",
    cinatra: {
      kind: "agent",
      consumes: [
        { primitive: "alpha_record_get", requirement: "required" },
        { primitive: "alpha_record_list", requirement: "optional" },
      ],
    },
  },
  { packageName: "@example-org/beta-connector", cinatra: { kind: "connector", consumes: [] } },
  { packageName: "@example-org/gamma-skill", cinatra: { kind: "skill" } },
];

/** The emitted body parsed back into the object the generated module exports. */
function parseEmittedBody(body) {
  return JSON.parse(`{${body.replace(/,\s*$/, "")}}`);
}

describe("consumesDeclarationOf — the raw cinatra.consumes pass-through", () => {
  it("is exported by the generator", () => {
    expect(typeof consumesDeclarationOf).toBe("function");
    expect(typeof emitConsumesDeclarations).toBe("function");
  });

  it("carries a present consumes list as-is and an absent one as an empty declaration", () => {
    expect(typeof consumesDeclarationOf).toBe("function");
    const list = [{ primitive: "alpha_record_get", requirement: "required" }];
    expect(consumesDeclarationOf({ consumes: list })).toEqual({ consumes: list });
    expect(consumesDeclarationOf({ consumes: [] })).toEqual({ consumes: [] });
    expect(consumesDeclarationOf({})).toEqual({});
  });

  it("carries a malformed value UNVALIDATED, so the host refuses it at call time", () => {
    expect(typeof consumesDeclarationOf).toBe("function");
    expect(consumesDeclarationOf({ consumes: null })).toEqual({ consumes: null });
    expect(consumesDeclarationOf({ consumes: "alpha_record_get" })).toEqual({ consumes: "alpha_record_get" });
  });
});

describe("emitConsumesDeclarations — the generated map for a fixture tree", () => {
  it("lists every pack, keyed by package name, with its raw declaration", () => {
    expect(typeof emitConsumesDeclarations).toBe("function");
    const records = FIXTURE_TREE.map((p) => ({
      packageName: p.packageName,
      consumesDeclaration: consumesDeclarationOf(p.cinatra),
    }));
    const map = parseEmittedBody(emitConsumesDeclarations(records));
    expect(Object.keys(map)).toEqual(FIXTURE_TREE.map((p) => p.packageName));
    expect(map["@example-org/alpha-agent"]).toEqual({ consumes: FIXTURE_TREE[0].cinatra.consumes });
    expect(map["@example-org/beta-connector"]).toEqual({ consumes: [] });
    expect(map["@example-org/gamma-skill"]).toEqual({});
  });

  it("the host's reading of each emitted entry names the primitives the CI check reads", () => {
    expect(typeof emitConsumesDeclarations).toBe("function");
    const records = FIXTURE_TREE.map((p) => ({
      packageName: p.packageName,
      consumesDeclaration: consumesDeclarationOf(p.cinatra),
    }));
    const map = parseEmittedBody(emitConsumesDeclarations(records));
    for (const pack of FIXTURE_TREE) {
      const hostReads = parseConsumedPrimitives({ cinatra: map[pack.packageName] }, { packageName: pack.packageName })
        .map((c) => c.primitive);
      const checkReads = collectConsumedTools({ name: pack.packageName, cinatra: pack.cinatra }).uses.map(
        (u) => u.primitive,
      );
      expect(hostReads).toEqual(checkReads);
    }
  });
});
