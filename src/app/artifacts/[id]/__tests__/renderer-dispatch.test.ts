/**
 * Renderer dispatch spine — pure precedence tests (cinatra#1629, epic #1620 S2;
 * spec design@4c6799db §III).
 *
 * The pre-spine `hasTypedRenderer` boolean is REPLACED by claimant-keyed
 * resolution: the caller resolves the semantic + representation inputs and this
 * leaf composes the total precedence — semantic detail renderer → representation
 * viewer (extension provider or first-party host default) → generic fallback,
 * with never-built claimants degrading to requires-rebuild. Also pins the
 * activation barrier.
 */
import { describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import {
  pickArtifactRenderer,
  isSelectionPreparing,
  type SemanticRendererResolution,
  type RepresentationRendererResolution,
} from "../renderer-dispatch";

const bindingIdentity: EffectiveIdentity = {
  kind: "extension",
  extension: "@cinatra-ai/outreach",
  basis: "binding",
  selectable: true,
  assertionId: "sa_1",
};
const classicIdentity: EffectiveIdentity = {
  kind: "extension",
  extension: "@cinatra-ai/outreach",
  basis: "classic",
  selectable: true,
  assertionId: "sa_2",
};
const catalogIdentity: EffectiveIdentity = {
  kind: "extension",
  extension: "@cinatra-ai/outreach",
  basis: "catalog",
  selectable: false,
  assertionId: null,
};
const floorIdentity: EffectiveIdentity = {
  kind: "default-artifact",
  selectable: true,
  assertionId: "sa_floor",
};
const plainIdentity: EffectiveIdentity = {
  kind: "plain-object",
  selectable: false,
  assertionId: null,
};

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
const pdfFirstParty: RepresentationRendererResolution = { tier: "first-party", handler: "pdf" };
const imageFirstParty: RepresentationRendererResolution = { tier: "first-party", handler: "image" };
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
      pickArtifactRenderer({ identity: bindingIdentity, semantic: builtSemantic, representation: pdfFirstParty }),
    ).toEqual({ kind: "semantic", packageName: "@cinatra-ai/outreach", generatedKey: "@cinatra-ai/outreach::detail" });
  });

  it("dispatches semantic for a classic identity too (arbitration is the winner, not the basis)", () => {
    expect(
      pickArtifactRenderer({ identity: classicIdentity, semantic: builtSemantic, representation: null }),
    ).toEqual({ kind: "semantic", packageName: "@cinatra-ai/outreach", generatedKey: "@cinatra-ai/outreach::detail" });
  });

  it("renders a catalog (browse-only) identity through the semantic renderer — the barrier gates selection, not rendering", () => {
    expect(
      pickArtifactRenderer({ identity: catalogIdentity, semantic: builtSemantic, representation: null }),
    ).toEqual({ kind: "semantic", packageName: "@cinatra-ai/outreach", generatedKey: "@cinatra-ai/outreach::detail" });
  });

  it("a NEVER-BUILT semantic claimant degrades to requires-rebuild (terminal — does NOT fall through to representation)", () => {
    expect(
      pickArtifactRenderer({ identity: bindingIdentity, semantic: unbuiltSemantic, representation: pdfFirstParty }),
    ).toEqual({ kind: "requires-rebuild", packageName: "@cinatra-ai/outreach", slot: "detail" });
  });

  it("an extension identity whose winner ships NO semantic renderer falls through to the representation tier", () => {
    expect(
      pickArtifactRenderer({ identity: bindingIdentity, semantic: null, representation: pdfFirstParty }),
    ).toEqual({ kind: "mime", handler: "pdf" });
  });

  it("does not apply a stray semantic resolution to a non-extension identity (defensive gate)", () => {
    expect(
      pickArtifactRenderer({ identity: floorIdentity, semantic: builtSemantic, representation: imageFirstParty }),
    ).toEqual({ kind: "mime", handler: "image" });
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
      pickArtifactRenderer({ identity: bindingIdentity, semantic: mismatched, representation: imageFirstParty }),
    ).toEqual({ kind: "mime", handler: "image" });
  });
});

describe("pickArtifactRenderer — representation tier (case 2)", () => {
  it("routes to a built extension representation provider", () => {
    expect(
      pickArtifactRenderer({ identity: floorIdentity, semantic: null, representation: builtRepProvider }),
    ).toEqual({
      kind: "representation",
      packageName: "@cinatra-ai/pdf-viewer",
      generatedKey: "@cinatra-ai/pdf-viewer::preview",
      pattern: "application/pdf",
    });
  });

  it("a never-built representation provider degrades to requires-rebuild carrying the RESOLVED slot (preview)", () => {
    expect(
      pickArtifactRenderer({ identity: floorIdentity, semantic: null, representation: unbuiltRepProvider }),
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
      pickArtifactRenderer({ identity: floorIdentity, semantic: null, representation: unbuiltDetailRepProvider }),
    ).toEqual({ kind: "requires-rebuild", packageName: "@cinatra-ai/pdf-viewer", slot: "detail" });
  });

  it("a first-party default resolves to the host MIME handler", () => {
    expect(
      pickArtifactRenderer({ identity: plainIdentity, semantic: null, representation: imageFirstParty }),
    ).toEqual({ kind: "mime", handler: "image" });
  });
});

describe("pickArtifactRenderer — generic fallback (case 3)", () => {
  it("falls back when there is neither a semantic renderer nor a representation viewer", () => {
    expect(
      pickArtifactRenderer({ identity: floorIdentity, semantic: null, representation: null }),
    ).toEqual({ kind: "fallback" });
  });

  it("falls back for a plain object with nothing to render", () => {
    expect(
      pickArtifactRenderer({ identity: plainIdentity, semantic: null, representation: null }),
    ).toEqual({ kind: "fallback" });
  });
});

describe("isSelectionPreparing — §III activation barrier (unchanged by the spine)", () => {
  it("a catalog browse-only identity is preparing", () => {
    expect(isSelectionPreparing(catalogIdentity)).toBe(true);
  });
  it("a settled binding identity is not preparing", () => {
    expect(isSelectionPreparing(bindingIdentity)).toBe(false);
  });
  it("a default-artifact floor identity is not preparing", () => {
    expect(isSelectionPreparing(floorIdentity)).toBe(false);
  });
  it("a plain object is not preparing", () => {
    expect(isSelectionPreparing(plainIdentity)).toBe(false);
  });
});
