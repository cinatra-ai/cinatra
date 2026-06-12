// Renderer ids for context selector fields are resolved from the canonical
// context-selection-agent package id or the bare `context-selector` alias.
//
// Paused-run alias safety matters because HITL runs can checkpoint renderer
// ids in snapshots. The removed context-agent renderer id is intentionally not
// accepted: runtime rendering composes the renderer id from the migrated
// template packageName, and the removed id is not a supported persisted shape.
//
// This test pins the removal contract THROUGH THE REGISTRY (cinatra#151
// Stage 5 — the canonical id is manifest-declared by the
// context-selection-agent and registered from the generated bindings; the
// bare alias is the host kind table's compat alias): the canonical id and the
// bare `context-selector` shape resolve to the ContextSelectorRenderer; the
// removed renderer id does NOT resolve to it.

import { describe, it, expect, beforeAll } from "vitest";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { ContextSelectorRenderer } from "../context-selector-renderer";

const CANONICAL_ID = "@cinatra-ai/context-selection-agent:context-selector";
const LEGACY_RENDERER_ID = "@cinatra-ai/context-agent:context-selector";

function resolveRendererFor(xRenderer: string) {
  return fieldRendererRegistry.resolve(
    "field",
    { "x-renderer": xRenderer },
    { connectedApps: [] },
  );
}

beforeAll(() => {
  ensureDefaultFieldRenderersRegistered();
});

describe("ContextSelector renderer id resolution for removed alias", () => {
  it("matches the canonical @cinatra-ai/context-selection-agent:context-selector id", () => {
    expect(resolveRendererFor(CANONICAL_ID)?.renderer).toBe(ContextSelectorRenderer);
  });

  it("still matches the bare `context-selector` alias", () => {
    expect(resolveRendererFor("context-selector")?.renderer).toBe(ContextSelectorRenderer);
  });

  it("carries the manifest-declared midRunHitl classification", () => {
    expect(resolveRendererFor(CANONICAL_ID)?.midRunHitl).toBe(true);
  });

  it("does NOT match the removed @cinatra-ai/context-agent:context-selector id", () => {
    expect(resolveRendererFor(LEGACY_RENDERER_ID)?.renderer ?? null).not.toBe(
      ContextSelectorRenderer,
    );
  });

  it("does NOT match a different renderer id", () => {
    expect(resolveRendererFor("@cinatra-ai/other:something")?.renderer ?? null).not.toBe(
      ContextSelectorRenderer,
    );
  });
});
