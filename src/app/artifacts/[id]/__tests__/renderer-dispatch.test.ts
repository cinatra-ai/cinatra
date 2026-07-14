/**
 * §III renderer-dispatch tests (cinatra#1431, spec design@4c6799db §III).
 *
 * Pins the three dispatch cases and their precedence:
 *   - a claimed typed-data row (installed extension + a registered type
 *     renderer) → typed renderer;
 *   - an uploaded file-form row (no type renderer) → its MIME viewer handler;
 *   - a plain default-artifact row / an extension without a renderer / an
 *     unknown MIME → the generic fallback ("there is always a renderer").
 * Also pins the activation barrier: a catalog (browse-only) identity is
 * "preparing" for selection; a settled identity is not.
 */
import { describe, expect, it } from "vitest";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import {
  pickArtifactRenderer,
  isSelectionPreparing,
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

describe("pickArtifactRenderer — typed-data artifact (case 1)", () => {
  it("dispatches to the type renderer when an installed binding identity has a registered detail renderer", () => {
    expect(
      pickArtifactRenderer({
        identity: bindingIdentity,
        hasTypedRenderer: true,
        mime: "application/json",
      }),
    ).toEqual({ kind: "typed", extension: "@cinatra-ai/outreach" });
  });

  it("dispatches to the type renderer for a classic extension identity", () => {
    expect(
      pickArtifactRenderer({
        identity: classicIdentity,
        hasTypedRenderer: true,
        mime: "",
      }),
    ).toEqual({ kind: "typed", extension: "@cinatra-ai/outreach" });
  });

  it("renders a catalog (browse-only) identity through the type renderer too — the barrier gates selection, not rendering", () => {
    expect(
      pickArtifactRenderer({
        identity: catalogIdentity,
        hasTypedRenderer: true,
        mime: "",
      }),
    ).toEqual({ kind: "typed", extension: "@cinatra-ai/outreach" });
  });
});

describe("pickArtifactRenderer — file-form representation (case 2)", () => {
  it("keeps the MIME viewer handler for an uploaded PDF (no type renderer)", () => {
    expect(
      pickArtifactRenderer({
        identity: floorIdentity,
        hasTypedRenderer: false,
        mime: "application/pdf",
      }),
    ).toEqual({ kind: "mime", handler: "pdf" });
  });

  it("routes an image representation to the image handler", () => {
    expect(
      pickArtifactRenderer({
        identity: plainIdentity,
        hasTypedRenderer: false,
        mime: "image/png",
      }),
    ).toEqual({ kind: "mime", handler: "image" });
  });

  it("a claimed row whose extension ships NO renderer for the representation still gets the MIME handler", () => {
    expect(
      pickArtifactRenderer({
        identity: bindingIdentity,
        hasTypedRenderer: false,
        mime: "text/markdown",
      }),
    ).toEqual({ kind: "mime", handler: "markdown" });
  });
});

describe("pickArtifactRenderer — generic fallback (case 3)", () => {
  it("falls back for a plain default-artifact row with no renderable MIME", () => {
    expect(
      pickArtifactRenderer({
        identity: floorIdentity,
        hasTypedRenderer: false,
        mime: "application/json",
      }),
    ).toEqual({ kind: "fallback" });
  });

  it("falls back for a plain object with an empty MIME", () => {
    expect(
      pickArtifactRenderer({
        identity: plainIdentity,
        hasTypedRenderer: false,
        mime: "",
      }),
    ).toEqual({ kind: "fallback" });
  });

  it("falls back for a claimed extension row that has no type renderer and an unrenderable MIME (there is always a renderer)", () => {
    expect(
      pickArtifactRenderer({
        identity: bindingIdentity,
        hasTypedRenderer: false,
        mime: "application/x-unknown",
      }),
    ).toEqual({ kind: "fallback" });
  });
});

describe("isSelectionPreparing — §III activation barrier", () => {
  it("a catalog browse-only identity is preparing (Pin / Add-to-context replaced by Preparing)", () => {
    expect(isSelectionPreparing(catalogIdentity)).toBe(true);
  });

  it("a settled binding identity is not preparing", () => {
    expect(isSelectionPreparing(bindingIdentity)).toBe(false);
  });

  it("a settled classic identity is not preparing", () => {
    expect(isSelectionPreparing(classicIdentity)).toBe(false);
  });

  it("a default-artifact floor identity is not preparing", () => {
    expect(isSelectionPreparing(floorIdentity)).toBe(false);
  });

  it("a plain object is not preparing (it is never selectable, but there is nothing to prepare)", () => {
    expect(isSelectionPreparing(plainIdentity)).toBe(false);
  });
});
