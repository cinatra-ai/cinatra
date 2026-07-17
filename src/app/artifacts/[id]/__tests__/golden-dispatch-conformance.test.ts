/**
 * Golden dispatch conformance (cinatra#1629, epic #1620 S2, AC-7): a synthetic
 * fixture extension with a `ui.renderers.detail` entry renders through the two
 * arbitration registries + the generated build map with ZERO core per-type
 * branches — the dispatch is driven entirely by registry state + generated-map
 * presence, never by a concrete type id or representation form baked into core.
 * Extends the zero-core-per-type-branches proof from registration to rendering.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

// vi.mock is hoisted above imports — the factory must not close over module
// locals, so the fixture keys are inlined here and mirrored in the constants
// below (asserted equal in a guard test).
const DETAIL_KEY = "@fixture/detail-ext::detail";
// The detail page resolves the representation at slot `detail` (Slice B); the
// fixture representation provider therefore ships a `detail` build entry. Its
// `representations` are DELIBERATELY empty so the system-base boot registrar
// (which projects providers from every build-map entry that DECLARES
// representations) does NOT auto-bind this fixture — the test drives resolution
// through EXPLICIT `registerProvider` calls, exactly as before.
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
import {
  resolveArtifactDispatchInputs,
  _resetFirstPartySeedForTests,
} from "../renderer-resolution";
import { pickArtifactRenderer } from "../renderer-dispatch";

const ORG = "org_golden";

afterEach(() => {
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
});

function winner(extension: string): EffectiveIdentity {
  return { kind: "extension", extension, basis: "binding", selectable: true, assertionId: "sa_1" };
}

function dispatchFor(args: { baseType: string; identity: EffectiveIdentity; mime: string }) {
  return pickArtifactRenderer(
    resolveArtifactDispatchInputs({
      orgId: ORG,
      baseType: args.baseType,
      identity: args.identity,
      mime: args.mime,
    }),
  );
}

describe("golden dispatch — a fixture extension renders through the registries", () => {
  it("routes a fixture semantic detail renderer through the spine to its generated build entry", () => {
    const type = "@fixture/detail-ext:artifact";
    semanticRendererRegistry.register({
      objectTypeId: type,
      packageName: "@fixture/detail-ext",
    });
    expect(dispatchFor({ baseType: type, identity: winner("@fixture/detail-ext"), mime: "application/json" })).toEqual({
      kind: "semantic",
      packageName: "@fixture/detail-ext",
      generatedKey: DETAIL_KEY,
    });
  });

  it("a fixture claimant registered but NOT in the build degrades to requires-rebuild (never blank)", () => {
    const type = "@fixture/unbuilt-ext:artifact";
    semanticRendererRegistry.register({
      objectTypeId: type,
      packageName: "@fixture/unbuilt-ext",
    });
    expect(dispatchFor({ baseType: type, identity: winner("@fixture/unbuilt-ext"), mime: "application/json" })).toEqual({
      kind: "requires-rebuild",
      packageName: "@fixture/unbuilt-ext",
      slot: "detail",
    });
  });

  it("routes a fixture representation provider through the spine to its generated build entry", () => {
    representationProviderRegistry.registerProvider(ORG, {
      packageName: "@fixture/rep-ext",
      pattern: "application/pdf",
      slot: "detail",
      generation: 1,
    });
    const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "f" };
    expect(dispatchFor({ baseType: "@cinatra-ai/artifact:object", identity: floor, mime: "application/pdf" })).toEqual({
      kind: "representation",
      packageName: "@fixture/rep-ext",
      generatedKey: REP_KEY,
      pattern: "application/pdf",
    });
  });

  it("without any provider, a PDF row falls through to the always-effective first-party host handler", () => {
    const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "f" };
    expect(dispatchFor({ baseType: "@cinatra-ai/artifact:object", identity: floor, mime: "application/pdf" })).toEqual({
      kind: "mime",
      handler: "pdf",
    });
  });
});

describe("zero core per-type branches — the dispatch is type-agnostic", () => {
  // The SAME code path resolves ANY fixture type identically: register a detail
  // renderer under an arbitrary type id + its build entry, and the dispatch
  // routes to it — no core branch names the type. (Only the detail-ext build key
  // exists in the fixture map, so we bind each arbitrary type to that same
  // claimant to prove the routing is registry-driven, not type-driven.)
  it.each([
    "@fixture/detail-ext:artifact",
    "@fixture/detail-ext:memo",
    "@fixture/detail-ext:whatever-local-id",
  ])("routes an arbitrary registered type %s with no core knowledge of it", (type) => {
    semanticRendererRegistry.register({
      objectTypeId: type,
      packageName: "@fixture/detail-ext",
    });
    expect(dispatchFor({ baseType: type, identity: winner("@fixture/detail-ext"), mime: "" })).toEqual({
      kind: "semantic",
      packageName: "@fixture/detail-ext",
      generatedKey: DETAIL_KEY,
    });
  });

  it("an unregistered type gets no semantic renderer — falls to the generic floor", () => {
    expect(dispatchFor({ baseType: "@fixture/never-registered:artifact", identity: winner("@fixture/never-registered"), mime: "" })).toEqual({
      kind: "fallback",
    });
  });
});
