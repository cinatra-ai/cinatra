/**
 * Renderer dispatch spine — pure precedence tests (cinatra#1629, epic #1620 S2;
 * spec design@4c6799db §III).
 *
 * The pre-spine `hasTypedRenderer` boolean is REPLACED by claimant-keyed
 * resolution: the caller resolves the semantic + representation inputs and this
 * leaf composes the total precedence — semantic detail renderer → representation
 * viewer (an installed extension provider) → the terminal floor,
 * with never-built claimants degrading to requires-rebuild. Also pins the
 * (retired) activation barrier.
 */
import { describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import {
  pickArtifactRenderer,
  isSelectionPreparing,
  type SemanticRendererResolution,
  type RepresentationRendererResolution,
} from "../renderer-dispatch";

// Type-driven identity (epic #1785): a row's identity is either its installed
// defining extension or no-primary — there is no binding/classic/catalog basis
// and no selectable activation barrier anymore.
const extensionIdentity: EffectiveIdentity = {
  kind: "extension",
  extension: "@cinatra-ai/outreach",
};
const noPrimaryIdentity: EffectiveIdentity = { kind: "no-primary" };

const builtSemantic: SemanticRendererResolution = {
  packageName: "@cinatra-ai/outreach",
  generatedKey: "@cinatra-ai/outreach::detail",
  built: true,
};
const unbuiltSemantic: SemanticRendererResolution = {
  packageName: "@cinatra-ai/outreach",
  generatedKey: "@cinatra-ai/outreach::detail",
  built: false,
};
// THE HOST HAS NO VIEWER UNDER THE PROVIDER TIER any more (cinatra#3319): a
// representation resolves to an installed extension provider or to nothing, so
// the fixtures below are extension providers and the fall-throughs land on the
// terminal floor.
const builtImageProvider: RepresentationRendererResolution = {
  tier: "extension",
  packageName: "@cinatra-ai/image-artifact",
  generatedKey: "@cinatra-ai/image-artifact::detail",
  pattern: "image/png",
  slot: "detail",
  built: true,
};
const imageDispatch = {
  kind: "representation",
  packageName: "@cinatra-ai/image-artifact",
  generatedKey: "@cinatra-ai/image-artifact::detail",
  pattern: "image/png",
} as const;
const builtRepProvider: RepresentationRendererResolution = {
  tier: "extension",
  packageName: "@cinatra-ai/pdf-viewer",
  generatedKey: "@cinatra-ai/pdf-viewer::preview",
  pattern: "application/pdf",
  slot: "preview",
  built: true,
};
const unbuiltRepProvider: RepresentationRendererResolution = {
  tier: "extension",
  packageName: "@cinatra-ai/pdf-viewer",
  generatedKey: "@cinatra-ai/pdf-viewer::preview",
  pattern: "application/pdf",
  slot: "preview",
  built: false,
};

describe("pickArtifactRenderer — semantic tier (case 1)", () => {
  it("dispatches to the built semantic renderer when the effective-identity winner ships one", () => {
    expect(
      pickArtifactRenderer({ identity: extensionIdentity, semantic: builtSemantic, representation: builtImageProvider }),
    ).toEqual({ kind: "semantic", packageName: "@cinatra-ai/outreach", generatedKey: "@cinatra-ai/outreach::detail" });
  });

  it("a NEVER-BUILT semantic claimant degrades to requires-rebuild (terminal — does NOT fall through to representation)", () => {
    expect(
      pickArtifactRenderer({ identity: extensionIdentity, semantic: unbuiltSemantic, representation: builtImageProvider }),
    ).toEqual({ kind: "requires-rebuild", packageName: "@cinatra-ai/outreach", slot: "detail" });
  });

  it("an extension identity whose winner ships NO semantic renderer falls through to the representation tier", () => {
    expect(
      pickArtifactRenderer({ identity: extensionIdentity, semantic: null, representation: builtImageProvider }),
    ).toEqual(imageDispatch);
  });

  it("does not apply a stray semantic resolution to a non-extension identity (defensive gate)", () => {
    expect(
      pickArtifactRenderer({ identity: noPrimaryIdentity, semantic: builtSemantic, representation: builtImageProvider }),
    ).toEqual(imageDispatch);
  });

  it("does not render a semantic resolution whose claimant is NOT the effective-identity winner (defensive winner-binding)", () => {
    const mismatched: SemanticRendererResolution = {
      packageName: "@cinatra-ai/loser",
      generatedKey: "@cinatra-ai/loser::detail",
      built: true,
    };
    // identity winner is @cinatra-ai/outreach but the semantic names @cinatra-ai/loser
    // → the semantic tier is skipped; falls through to the representation tier.
    expect(
      pickArtifactRenderer({ identity: extensionIdentity, semantic: mismatched, representation: builtImageProvider }),
    ).toEqual(imageDispatch);
  });
});

describe("pickArtifactRenderer — representation tier (case 2)", () => {
  it("routes to a built extension representation provider", () => {
    expect(
      pickArtifactRenderer({ identity: noPrimaryIdentity, semantic: null, representation: builtRepProvider }),
    ).toEqual({
      kind: "representation",
      packageName: "@cinatra-ai/pdf-viewer",
      generatedKey: "@cinatra-ai/pdf-viewer::preview",
      pattern: "application/pdf",
    });
  });

  it("a never-built representation provider degrades to requires-rebuild carrying the RESOLVED slot (preview)", () => {
    expect(
      pickArtifactRenderer({ identity: noPrimaryIdentity, semantic: null, representation: unbuiltRepProvider }),
    ).toEqual({ kind: "requires-rebuild", packageName: "@cinatra-ai/pdf-viewer", slot: "preview" });
  });

  it("a never-built representation resolved at slot DETAIL degrades reporting slot detail (not a hardcoded preview)", () => {
    const unbuiltDetailRepProvider: RepresentationRendererResolution = {
      tier: "extension",
      packageName: "@cinatra-ai/pdf-viewer",
      generatedKey: "@cinatra-ai/pdf-viewer::detail",
      pattern: "application/pdf",
      slot: "detail",
      built: false,
    };
    expect(
      pickArtifactRenderer({ identity: noPrimaryIdentity, semantic: null, representation: unbuiltDetailRepProvider }),
    ).toEqual({ kind: "requires-rebuild", packageName: "@cinatra-ai/pdf-viewer", slot: "detail" });
  });

  it("a representation NO installed package covers lands on the terminal floor, not a host viewer", () => {
    expect(
      pickArtifactRenderer({ identity: noPrimaryIdentity, semantic: null, representation: null }),
    ).toEqual({ kind: "fallback" });
  });
});

describe("pickArtifactRenderer — generic fallback (case 3)", () => {
  it("falls back when there is neither a semantic renderer nor a representation viewer", () => {
    expect(
      pickArtifactRenderer({ identity: noPrimaryIdentity, semantic: null, representation: null }),
    ).toEqual({ kind: "fallback" });
  });
});

describe("isSelectionPreparing — §III activation barrier RETIRED (epic #1785)", () => {
  it("is never preparing under type-driven identity — an extension identity is settled", () => {
    expect(isSelectionPreparing(extensionIdentity)).toBe(false);
  });
  it("is never preparing for a no-primary identity", () => {
    expect(isSelectionPreparing(noPrimaryIdentity)).toBe(false);
  });
});
