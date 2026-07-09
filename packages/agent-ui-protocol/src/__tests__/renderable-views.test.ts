import { describe, expect, it } from "vitest";

import {
  isRenderableViewDataPart,
  isRenderableViewOfType,
  renderableViewType,
  renderableViewDataPart,
  type RenderableViewBase,
} from "../renderable-views";

// ---------------------------------------------------------------------------
// S4-seam proof: a later stage registers a renderable-view payload type by
// declaration-merging into `RenderableViewRegistry` — no contract fork, no new
// top-level event. This is exactly the mechanism S4 uses for
// `content_change_proposal`; here we use a demo name so the proof does not
// pre-empt S4's registration.
// ---------------------------------------------------------------------------
type ExampleSeamView = RenderableViewBase & {
  viewType: "example_seam_view";
  label: string;
  count: number;
};

declare module "../renderable-views" {
  interface RenderableViewRegistry {
    example_seam_view: ExampleSeamView;
  }
}

describe("renderableViewType", () => {
  it("reads a non-empty string `viewType` off an object payload", () => {
    expect(renderableViewType({ viewType: "x" })).toBe("x");
    expect(renderableViewType({ viewType: "content_change_proposal", a: 1 })).toBe(
      "content_change_proposal",
    );
  });

  it("returns undefined for a payload without a usable `viewType`", () => {
    expect(renderableViewType({})).toBeUndefined();
    expect(renderableViewType({ viewType: "" })).toBeUndefined();
    expect(renderableViewType({ viewType: 5 })).toBeUndefined();
    expect(renderableViewType(null)).toBeUndefined();
    expect(renderableViewType([{ viewType: "x" }])).toBeUndefined();
    expect(renderableViewType("string")).toBeUndefined();
  });
});

describe("renderableViewDataPart", () => {
  it("wraps a view payload into a DATA_PART event", () => {
    const ev = renderableViewDataPart({ viewType: "example_seam_view", label: "hi", count: 1 });
    expect(ev.type).toBe("DATA_PART");
    expect(ev.data).toMatchObject({ viewType: "example_seam_view", label: "hi", count: 1 });
    expect("partIndex" in ev).toBe(false);
  });

  it("carries an optional partIndex for ordering", () => {
    const ev = renderableViewDataPart({ viewType: "example_seam_view", label: "hi", count: 1 }, 2);
    expect(ev.partIndex).toBe(2);
  });
});

describe("isRenderableViewDataPart", () => {
  it("is true for a DATA_PART whose payload is a renderable view", () => {
    const ev = renderableViewDataPart({ viewType: "example_seam_view", label: "hi", count: 1 });
    expect(isRenderableViewDataPart(ev)).toBe(true);
  });

  it("is false for a plain DATA_PART with no viewType", () => {
    expect(isRenderableViewDataPart({ type: "DATA_PART", data: { plain: true } })).toBe(false);
  });

  it("is false for a non-DATA_PART event", () => {
    expect(isRenderableViewDataPart({ type: "TEXT_MESSAGE_CONTENT", data: { viewType: "x" } })).toBe(
      false,
    );
  });
});

describe("isRenderableViewOfType (registered narrowing)", () => {
  it("narrows a matching payload to the registered type", () => {
    const ev = renderableViewDataPart({ viewType: "example_seam_view", label: "hi", count: 3 });
    expect(isRenderableViewOfType(ev.data, "example_seam_view")).toBe(true);
    if (isRenderableViewOfType(ev.data, "example_seam_view")) {
      // Compile-time proof: `ev.data` is `ExampleSeamView` inside this guard.
      const label: string = ev.data.label;
      const count: number = ev.data.count;
      expect(label).toBe("hi");
      expect(count).toBe(3);
    }
  });

  it("is false for a different (or unknown) viewType — renderer falls back", () => {
    const unknown = renderableViewDataPart({ viewType: "future_view_not_yet_registered", x: 1 });
    // Still a renderable-view data part…
    expect(isRenderableViewDataPart(unknown)).toBe(true);
    // …but not the registered one, so the surface renders its safe fallback.
    expect(isRenderableViewOfType(unknown.data, "example_seam_view")).toBe(false);
  });
});
