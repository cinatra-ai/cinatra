// Public field-renderer props contract — export-surface + ABI-version authority
// (cinatra#1625, epic #1620 S8 — M3). Proves @cinatra-ai/sdk-ui is the stable
// public mirror a claiming extension imports its renderer props type from, and
// that FIELD_RENDERER_PROPS_API_VERSION is a single integer authority == 1.
//
// vitest env here is node (no DOM) — these are structural/type + value checks,
// no render.

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  FIELD_RENDERER_PROPS_API_VERSION as VERSION_FROM_LEAF,
} from "../field-renderer-props";
import type {
  FieldRendererProps as PropsFromLeaf,
  FieldRendererContext as ContextFromLeaf,
  RendererMode as ModeFromLeaf,
  GmailSendAsAliasOption as AliasFromLeaf,
} from "../field-renderer-props";
import type {
  FieldRendererProps as PropsFromRoot,
  FieldRendererContext as ContextFromRoot,
  RendererMode as ModeFromRoot,
  GmailSendAsAliasOption as AliasFromRoot,
} from "../index";

describe("@cinatra-ai/sdk-ui field-renderer props contract", () => {
  it("exposes FIELD_RENDERER_PROPS_API_VERSION === 1 from the leaf subpath", () => {
    expect(VERSION_FROM_LEAF).toBe(1);
  });

  it("does NOT re-export the runtime version VALUE from the sdk-ui root barrel (the value lives only on the ./field-renderer-props subpath, keeping the hot barrel zero-runtime w.r.t. the props leaf)", async () => {
    // The root barrel re-exports the field-renderer props TYPES (erased at
    // build) but NOT the runtime constant — re-exporting the value would pull
    // the props leaf into every route whose first-party graph reaches sdk-ui.
    // The sole host consumer imports the constant from the subpath instead.
    const rootBarrel = await import("../index");
    expect("FIELD_RENDERER_PROPS_API_VERSION" in rootBarrel).toBe(false);
    // The single integer authority still resolves to 1 via the leaf subpath.
    expect(VERSION_FROM_LEAF).toBe(1);
  });

  it("exports the props type as a usable structural shape (edit-mode renderer props)", () => {
    // A minimal renderer props object type-checks against the public contract —
    // the exact surface a migrated extension renderer consumes.
    const props: PropsFromLeaf = {
      fieldName: "subject",
      schema: { type: "string" },
      value: "",
      onChange: () => {},
      context: { connectedApps: [] },
    };
    expect(props.fieldName).toBe("subject");
    expect(props.context.connectedApps).toEqual([]);
  });

  it("root and leaf export the identical props/context/mode/alias types", () => {
    // Type-level identity: the root barrel re-export must not drift from the leaf.
    expectTypeOf<PropsFromRoot>().toEqualTypeOf<PropsFromLeaf>();
    expectTypeOf<ContextFromRoot>().toEqualTypeOf<ContextFromLeaf>();
    expectTypeOf<ModeFromRoot>().toEqualTypeOf<ModeFromLeaf>();
    expectTypeOf<AliasFromRoot>().toEqualTypeOf<AliasFromLeaf>();
  });

  it("RendererMode is the closed edit|view union", () => {
    expectTypeOf<ModeFromLeaf>().toEqualTypeOf<"edit" | "view">();
  });

  it("declares the package.json exports subpath for the props leaf", async () => {
    const pkg = (await import("../../package.json", { with: { type: "json" } }))
      .default as { exports: Record<string, unknown> };
    expect(pkg.exports["./field-renderer-props"]).toBe(
      "./src/field-renderer-props.ts",
    );
  });
});
