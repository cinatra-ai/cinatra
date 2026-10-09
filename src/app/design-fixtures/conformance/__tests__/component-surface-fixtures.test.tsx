// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ComponentSurfaceConformanceFixtures } from "../component-surface-fixtures";

// The components drawing's surfaces the harness mounts, in manifest order, each
// with the primitive's OWN data-slot markers its driver reads in the closed state
// (tests/e2e/design/conformance/component-surface-drivers.ts).
const COMPONENT_SURFACES: ReadonlyArray<[string, string[]]> = [
  ["button", ["button"]],
  ["card", ["card"]],
  ["input", ["input"]],
  ["select", ["select-trigger"]],
  ["dialog", ["dialog-trigger"]],
  ["badge", ["badge"]],
  ["tabs", ["tabs", "tabs-list", "tabs-trigger"]],
  ["toolbar", ["toolbar"]],
  ["toolbar-nested", ["toolbar", "toolbar-child"]],
  ["sidebar", ["sidebar"]],
  ["sidebar-group-label", ["sidebar-group-label"]],
  ["tooltip", ["tooltip-trigger"]],
  ["avatar", ["avatar"]],
  ["form", ["form-item", "form-label", "form-control"]],
  ["checkbox", ["checkbox"]],
  ["alert", ["alert"]],
  ["table", ["table"]],
  ["command", ["command"]],
  ["breadcrumb", ["breadcrumb"]],
  ["pagination", ["pagination"]],
  ["skeleton", ["skeleton"]],
  ["empty", ["empty"]],
  ["accordion", ["accordion"]],
  ["separator", ["separator"]],
  ["toggle", ["toggle"]],
  ["calendar", ["calendar"]],
  ["combobox", ["combobox-trigger"]],
  ["scroll-area", ["scroll-area"]],
  ["input-otp", ["input-otp", "input-otp-slot"]],
];

// jsdom implements none of the layout and pointer hooks the Radix, cmdk and
// one-time-code primitives call at mount; each is installed here for this file
// only and removed again after it.
const PROTOTYPE_SHIMS = ["scrollIntoView", "hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const;
const installedShims: string[] = [];

beforeAll(() => {
  for (const name of PROTOTYPE_SHIMS) {
    if (name in Element.prototype) continue;
    Object.defineProperty(Element.prototype, name, { configurable: true, writable: true, value: () => false });
    installedShims.push(name);
  }
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

afterAll(() => {
  for (const name of installedShims.splice(0)) {
    Reflect.deleteProperty(Element.prototype, name);
  }
});

describe("component surfaces of the components drawing on the conformance harness", () => {
  it("lists the twenty-nine component surfaces once each", () => {
    expect(COMPONENT_SURFACES).toHaveLength(29);
    expect(new Set(COMPONENT_SURFACES.map(([id]) => id)).size).toBe(29);
  });

  it.each(COMPONENT_SURFACES)("mounts %s once, holding the primitive's own markers", (id, markers) => {
    const { container } = render(<ComponentSurfaceConformanceFixtures />);
    const mounts = container.querySelectorAll(`[data-surface-id="${id}"]`);
    expect(mounts).toHaveLength(1);
    for (const marker of markers) {
      expect(mounts[0].querySelectorAll(`[data-slot="${marker}"]`).length, `${id} holds ${marker}`).toBeGreaterThan(0);
    }
  });
});
