// Renderer ids for context selector fields are resolved from the canonical
// context-selection-agent package id or the bare `context-selector` alias.
//
// Paused-run alias safety matters because HITL runs can checkpoint renderer
// ids in snapshots. The removed context-agent renderer id is intentionally not
// accepted: runtime rendering composes the renderer id from the migrated
// template packageName, and the removed id is not a supported persisted shape.
//
// This test pins the removal contract: the canonical id and the bare
// `context-selector` shape resolve; the removed renderer id does NOT.

import { describe, it, expect } from "vitest";
import {
  isContextSelectorField,
  CONTEXT_SELECTOR_RENDERER_ID,
} from "../context-selector-renderer";

const LEGACY_RENDERER_ID = "@cinatra-ai/context-agent:context-selector";

describe("ContextSelector renderer id resolution for removed alias", () => {
  it("matches the canonical @cinatra-ai/context-selection-agent:context-selector id", () => {
    expect(
      isContextSelectorField(
        "field" as never,
        { "x-renderer": CONTEXT_SELECTOR_RENDERER_ID } as never,
        { connectedApps: [] } as never,
      ),
    ).toBe(true);
  });

  it("still matches the bare `context-selector` alias", () => {
    expect(
      isContextSelectorField(
        "field" as never,
        { "x-renderer": "context-selector" } as never,
        { connectedApps: [] } as never,
      ),
    ).toBe(true);
  });

  it("does NOT match the removed @cinatra-ai/context-agent:context-selector id", () => {
    expect(
      isContextSelectorField(
        "field" as never,
        { "x-renderer": LEGACY_RENDERER_ID } as never,
        { connectedApps: [] } as never,
      ),
    ).toBe(false);
  });

  it("does NOT match a different renderer id", () => {
    expect(
      isContextSelectorField(
        "field" as never,
        { "x-renderer": "@cinatra-ai/other:something" } as never,
        { connectedApps: [] } as never,
      ),
    ).toBe(false);
  });
});
