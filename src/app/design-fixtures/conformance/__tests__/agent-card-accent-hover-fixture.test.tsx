// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Read-only transport boundary, never a component or presentation substitute
// (the form of agent-run-eligibility-fixtures.test.tsx).
vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: () => { throw new Error("Fixture must use its own read-only detail port"); },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/design-fixtures/conformance",
  useRouter: () => { throw new Error("No navigation expected in static native fixture"); },
}));

import { AgentCardAccentHoverFixture } from "../agent-card-accent-hover-fixture";

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
  vi.doUnmock("@/lib/marketplace-detail-actions");
  vi.doUnmock("next/navigation");
  vi.resetModules();
});

describe("agent card accent hover on the conformance harness", () => {
  it("mounts the real agent card once with its interactive coloured panel and kind label", () => {
    const { container } = render(<AgentCardAccentHoverFixture />);
    const mounts = container.querySelectorAll('[data-surface-id="agent-card-accent-hover"]');
    expect(mounts).toHaveLength(1);
    const mount = mounts[0];
    const banners = mount.querySelectorAll('[data-slot="extension-card-banner"][data-accent-detail]');
    expect(banners).toHaveLength(1);
    expect(banners[0].getAttribute("aria-haspopup")).toBe("dialog");
    expect(banners[0].querySelectorAll('[data-slot="extension-card-accent-hover"]')).toHaveLength(1);
    expect(mount.querySelector('[data-slot="installed-extension-kind-label"]')?.textContent).toBe("Agent");
  });
});
