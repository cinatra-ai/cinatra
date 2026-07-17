/**
 * G3 — golden dispatch conformance (epic #1620 / #1624 S6). The POSITIVE
 * extensibility proof: a synthetic arm dispatches correctly with ZERO core
 * knowledge of its concrete identity — adding a type / representation is registry
 * + generated-map state, never a core edit. (The NEGATIVE — no new core→identity
 * keying — is owned by G1.) Two complementary proofs:
 *   1. REAL arbitration: a fixture arm registered in the actual semantic /
 *      representation-provider registries resolves through the real resolution
 *      seam (`resolveArtifactDispatchInputs`) + generated build map to its
 *      extension dispatch; unregistering falls to the first-party floor. (Mirrors
 *      the S2 golden test's vi.mock of the generated map.)
 *   2. FULL cutover matrix: the artifact-detail probe drives the real precedence
 *      leaf across all ten G2 world-states and reports `ready`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

const DETAIL_KEY = "@fixture/detail-ext::detail";
// The detail page resolves the representation at slot `detail` (Slice B); the
// fixture representation provider ships a `detail` build entry with EMPTY
// `representations` so the system-base boot registrar does not auto-bind it (the
// test drives resolution through an explicit `registerProvider`).
const REP_KEY = "@fixture/rep-ext::detail";

vi.mock("@/lib/generated/artifact-renderers", () => ({
  GENERATED_ARTIFACT_RENDERERS: {
    "@fixture/detail-ext::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/detail-ext",
      slot: "detail",
      representations: [],
      propsApiVersion: 1,
      load: async () => ({ default: () => null }),
    },
    "@fixture/rep-ext::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/rep-ext",
      slot: "detail",
      representations: [],
      propsApiVersion: 1,
      load: async () => ({ default: () => null }),
    },
  },
}));

import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import { pickArtifactRenderer } from "../../renderer-dispatch";
import { resolveArtifactDispatchInputs, _resetFirstPartySeedForTests } from "../../renderer-resolution";
import { evaluateArtifactDetailArmCutover } from "../artifact-detail-cutover-probe";

const ORG = "org_g3";

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
});

function dispatchViaRealRegistries(args: { baseType: string; identity: EffectiveIdentity; mime: string }) {
  return pickArtifactRenderer(
    resolveArtifactDispatchInputs({ orgId: ORG, baseType: args.baseType, identity: args.identity, mime: args.mime }),
  );
}

describe("G3 — real arbitration through the registries + generated map", () => {
  it("a fixture representation PROVIDER routes through the real registry + build map to its extension viewer", () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: "@fixture/rep-ext",
      pattern: "application/pdf",
      slot: "detail",
      generation: 1,
    });
    const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "f" };
    expect(dispatchViaRealRegistries({ baseType: "@cinatra-ai/artifact:object", identity: floor, mime: "application/pdf" })).toEqual({
      kind: "representation",
      packageName: "@fixture/rep-ext",
      generatedKey: REP_KEY,
      pattern: "application/pdf",
    });
  });

  it("with NO provider installed (mocked map has no pdf base), the same PDF row falls to the generic never-blank floor", () => {
    // Post-G2-cutover: no host pdf handler + no pdf base in this fixture map → the
    // row reaches the generic floor deterministically (never blank).
    const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "f" };
    expect(dispatchViaRealRegistries({ baseType: "@cinatra-ai/artifact:object", identity: floor, mime: "application/pdf" })).toEqual({
      kind: "fallback",
    });
  });

  it("a fixture SEMANTIC renderer routes through the real semantic registry (effective-identity winner) to its extension detail view", () => {
    semanticRendererRegistry.register({ objectTypeId: "@fixture/detail-ext:artifact", packageName: "@fixture/detail-ext" });
    const winner: EffectiveIdentity = { kind: "extension", extension: "@fixture/detail-ext", basis: "binding", selectable: true, assertionId: "sa" };
    expect(dispatchViaRealRegistries({ baseType: "@fixture/detail-ext:artifact", identity: winner, mime: "application/json" })).toEqual({
      kind: "semantic",
      packageName: "@fixture/detail-ext",
      generatedKey: DETAIL_KEY,
    });
  });
});

describe("G3 — full G2 cutover matrix through the real precedence leaf", () => {
  it("a synthetic REPRESENTATION-viewer arm is cutover-ready across all ten world-states", () => {
    const report = evaluateArtifactDetailArmCutover({ system: "representation-viewer", mime: "application/pdf", firstPartyHandler: "pdf" });
    expect(report.ready, JSON.stringify(report.unmet)).toBe(true);
  });

  it("a synthetic SEMANTIC-renderer arm is cutover-ready across all ten world-states", () => {
    const report = evaluateArtifactDetailArmCutover({ system: "semantic-renderer", objectTypeId: "@vendor/anything:local-id", extension: "@vendor/anything" });
    expect(report.ready, JSON.stringify(report.unmet)).toBe(true);
  });
});

describe("G3 — zero core diffs", () => {
  it("an ARBITRARY, never-seen type id routes to its semantic renderer with no core branch", () => {
    for (const ext of ["@vendor/brand-new", "@third-party/whatever", "@x/z-artifact"]) {
      const winner: EffectiveIdentity = { kind: "extension", extension: ext, basis: "binding", selectable: true, assertionId: "sa" };
      expect(
        pickArtifactRenderer({ identity: winner, semantic: { packageName: ext, generatedKey: `${ext}::detail`, built: true }, representation: null }),
      ).toEqual({ kind: "semantic", packageName: ext, generatedKey: `${ext}::detail` });
    }
  });

  it("an arbitrary unregistered identity always lands on the never-blank floor", () => {
    const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "f" };
    expect(pickArtifactRenderer({ identity: floor, semantic: null, representation: null })).toEqual({ kind: "fallback" });
  });
});
