/**
 * Field-renderer per-binding G2 cutover — RESOLUTION half (cinatra#1625, epic
 * #1620 S8 — M3 spine). The pure-logic (no-render) proof of the resolution
 * wiring: the loader degrade taxonomy, the map-presence signal, and which
 * component each binding RESOLVES to (registry identity) — including the
 * behavior-preserving empty-map path and legacy-alias resolution. The DOM proof
 * (never blank/crash under render) lives in the sibling
 * field-renderer-component-cutover.test.tsx (render-based; runs in the full-tree
 * CI environment like every other packages/agents render test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fieldRendererRegistry } from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import {
  loadFieldRendererComponent,
  hasFieldRendererComponent,
  __setFieldRendererComponentMapForTests,
  __resetFieldRendererComponentMapForTests,
} from "../field-renderer-components";
import type { GeneratedFieldRendererComponentEntry } from "@/lib/generated/field-renderer-components";
import { EmailDraftsReviewRenderer } from "../email-drafts-review-renderer";
import { ReviewerAgentOutputRenderer } from "../reviewer-agent-output-renderer";
import type { FieldRendererProps } from "../field-renderer-registry";

const BINDING_ID = "@cinatra-ai/email-drafting-agent:email-drafts-review";
const BINDING_KIND = "email-drafts-review";
const BARE_ALIAS = "email-drafts-review";
const PKG = "@cinatra-ai/email-drafting-agent";

function FixtureExtensionRenderer(_props: FieldRendererProps): null {
  return null;
}

function Entry(
  load: GeneratedFieldRendererComponentEntry["load"],
  propsApiVersion = 1,
): GeneratedFieldRendererComponentEntry {
  return { resolution: "guardedOptional", packageName: PKG, propsApiVersion, load };
}

const schema = { "x-renderer": BINDING_ID, type: "string", title: "T" };
const aliasSchema = { "x-renderer": BARE_ALIAS, type: "string", title: "T" };

beforeEach(() => {
  fieldRendererRegistry.clear();
  __resetFieldRendererComponentMapForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  __resetFieldRendererComponentMapForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// loadFieldRendererComponent — the pre-render degrade taxonomy.
// ---------------------------------------------------------------------------
describe("loadFieldRendererComponent — degrade taxonomy", () => {
  it("resolves the extension component when the build map carries the binding", async () => {
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(async () => ({ default: FixtureExtensionRenderer })),
    });
    const res = await loadFieldRendererComponent({ bindingId: BINDING_ID });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.Component).toBe(FixtureExtensionRenderer);
  });

  it("degrades to not-in-map when the binding is absent", async () => {
    __setFieldRendererComponentMapForTests({});
    const res = await loadFieldRendererComponent({ bindingId: BINDING_ID });
    expect(res).toEqual({ ok: false, failureClass: "not-in-map" });
  });

  it("degrades to abi-incompatible when propsApiVersion differs (no module executed)", async () => {
    const load = vi.fn(async () => ({ default: FixtureExtensionRenderer }));
    __setFieldRendererComponentMapForTests({ [BINDING_ID]: Entry(load, 2) });
    const res = await loadFieldRendererComponent({
      bindingId: BINDING_ID,
      expectedPropsApiVersion: 1,
    });
    expect(res).toEqual({ ok: false, failureClass: "abi-incompatible" });
    expect(load).not.toHaveBeenCalled(); // pre-load check, no module executed
  });

  it("degrades to load-failed when the literal import rejects", async () => {
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(async () => {
        throw new Error("chunk unavailable");
      }),
    });
    const res = await loadFieldRendererComponent({ bindingId: BINDING_ID });
    expect(res).toEqual({ ok: false, failureClass: "load-failed" });
  });

  it("degrades to invalid-export when the module has no component default", async () => {
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(async () => ({ default: 42 })),
    });
    const res = await loadFieldRendererComponent({ bindingId: BINDING_ID });
    expect(res).toEqual({ ok: false, failureClass: "invalid-export" });
  });

  it("executes ONLY the resolved binding's loader", async () => {
    const loadA = vi.fn(async () => ({ default: FixtureExtensionRenderer }));
    const loadB = vi.fn(async () => ({ default: FixtureExtensionRenderer }));
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(loadA),
      "@cinatra-ai/other-agent:review": Entry(loadB),
    });
    await loadFieldRendererComponent({ bindingId: BINDING_ID });
    expect(loadA).toHaveBeenCalledOnce();
    expect(loadB).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Registration resolution — which component each binding resolves to.
// ---------------------------------------------------------------------------
describe("registration resolution", () => {
  it("routes a mapped binding to the extension wrapper (map hit)", () => {
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(async () => ({ default: FixtureExtensionRenderer })),
    });
    expect(hasFieldRendererComponent(BINDING_ID)).toBe(true);
    registerFieldRendererBindings([
      { id: BINDING_ID, kind: BINDING_KIND, priority: 80 },
    ]);
    const resolved = fieldRendererRegistry.resolve("f", schema, { connectedApps: [] });
    expect(resolved).not.toBeNull();
    expect(resolved!.renderer.displayName).toMatch(/^ExtensionFieldRenderer\(/);
  });

  it("resolves the same migrated wrapper via the kind's bare compat alias (legacy alias)", () => {
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: Entry(async () => ({ default: FixtureExtensionRenderer })),
    });
    registerFieldRendererBindings([
      { id: BINDING_ID, kind: BINDING_KIND, priority: 80 },
    ]);
    const viaId = fieldRendererRegistry.resolve("f", schema, { connectedApps: [] });
    const viaAlias = fieldRendererRegistry.resolve("f", aliasSchema, { connectedApps: [] });
    expect(viaAlias).not.toBeNull();
    expect(viaAlias!.renderer).toBe(viaId!.renderer);
    expect(viaAlias!.renderer.displayName).toMatch(/^ExtensionFieldRenderer\(/);
  });

  it("resolves to the host KIND component when the build map is empty (behavior-preserving)", () => {
    expect(hasFieldRendererComponent(BINDING_ID)).toBe(false); // real empty map
    registerFieldRendererBindings([
      { id: BINDING_ID, kind: BINDING_KIND, priority: 80 },
    ]);
    const resolved = fieldRendererRegistry.resolve("f", schema, { connectedApps: [] });
    expect(resolved?.renderer).toBe(EmailDraftsReviewRenderer);
  });

  it("scoped-id resolution is map-first per binding even when a kind is shared; the unscoped bare alias stays first-registered (documented shared-alias caveat)", () => {
    // Two real bindings share kind "email-drafts-review" (and its bare alias).
    // Migrate ONLY the reviewer one.
    const REVIEWER_ID = "@cinatra-ai/reviewer-agent:drafts-output";
    __setFieldRendererComponentMapForTests({
      [REVIEWER_ID]: Entry(async () => ({ default: FixtureExtensionRenderer })),
    });
    registerFieldRendererBindings([
      { id: BINDING_ID, kind: BINDING_KIND, priority: 80 }, // host (unmapped), registered first
      { id: REVIEWER_ID, kind: BINDING_KIND, priority: 80 }, // extension-backed (mapped)
    ]);
    // Each binding's OWN scoped id resolves correctly (map-first for the mapped
    // one, host for the unmapped one).
    expect(
      fieldRendererRegistry.resolve("f", { "x-renderer": BINDING_ID }, { connectedApps: [] })
        ?.renderer,
    ).toBe(EmailDraftsReviewRenderer);
    expect(
      fieldRendererRegistry
        .resolve("f", { "x-renderer": REVIEWER_ID }, { connectedApps: [] })
        ?.renderer.displayName,
    ).toMatch(/^ExtensionFieldRenderer\(/);
    // The UNSCOPED bare alias resolves to the first-registered equal-priority
    // binding (here the host one) — the pre-existing ambiguity the code comment
    // documents as a per-claimant-migration concern, NOT a regression.
    expect(
      fieldRendererRegistry.resolve("f", aliasSchema, { connectedApps: [] })?.renderer,
    ).toBe(EmailDraftsReviewRenderer);
  });

  it("keeps the retired-scope standalone alias resolving to its host component", () => {
    // The spine must not disturb the host-registered legacy aliases wired by
    // ensureDefaultFieldRenderersRegistered() (real, empty build map).
    ensureDefaultFieldRenderersRegistered();
    const resolved = fieldRendererRegistry.resolve(
      "f",
      { "x-renderer": "@cinatra/email-reviewer-agent:output" },
      { connectedApps: [] },
    );
    expect(resolved?.renderer).toBe(ReviewerAgentOutputRenderer);
  });
});
