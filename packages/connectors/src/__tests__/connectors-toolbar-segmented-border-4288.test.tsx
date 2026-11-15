// @vitest-environment jsdom
/**
 * The /connectors toolbar's segmented filter keeps its one outer border
 * (cinatra#4288).
 *
 *   pnpm exec vitest run --config vitest.config.ts --no-coverage packages/connectors/src/__tests__/connectors-toolbar-segmented-border-4288.test.tsx
 *
 * The drawing says a control inside a toolbar drops its own border, and it says
 * a segmented button group shares one outer border with hairlines between the
 * segments. The design ruling on #4288 settles which sentence wins: a segmented
 * group inside a toolbar keeps its one outer border. This test mounts the real
 * <ConnectorsClient>, finds the connection-state group inside its toolbar, and
 * reads the border classes on the rendered group element. Tailwind is not
 * compiled under jsdom, so the rendered class list is the reading: it is what
 * survives `cn()`/tailwind-merge and reaches the DOM.
 */
import "@/components/__tests__/access-picker-jsdom-shims";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/connectors",
  useSearchParams: () => new URLSearchParams(""),
}));

import { ConnectorsClient } from "../connectors-client";

afterEach(cleanup);

function renderGroup(): { group: HTMLElement; toolbar: HTMLElement } {
  const { container } = render(
    <ConnectorsClient
      cards={[]}
      scopeValue={[]}
      scopes={{ orgs: [], projects: [], canGrantWorkspace: false }}
      canReachMarketplace={false}
    />,
  );
  const group = container.querySelector<HTMLElement>(
    '[data-slot="toggle-group"][aria-label="Filter by connection state"]',
  );
  if (!group) throw new Error("the connectors page rendered no connection-state group");
  const toolbar = group.closest<HTMLElement>('[role="toolbar"]');
  if (!toolbar) throw new Error("the connection-state group is not inside a toolbar");
  return { group, toolbar };
}

describe("cinatra#4288 — /connectors: a segmented group inside a toolbar keeps its one outer border", () => {
  it("renders the connection-state group inside the Connectors filters toolbar", () => {
    const { toolbar } = renderGroup();
    expect(toolbar.getAttribute("aria-label")).toBe("Connectors filters");
  });

  it("the rendered group carries the one outer hairline border (border + border-line, 7px radius)", () => {
    const { group } = renderGroup();
    const classes = group.className.split(/\s+/);
    expect(classes).toContain("border");
    expect(classes).toContain("border-line");
    expect(classes).toContain("rounded-[7px]");
    expect(classes).not.toContain("border-0");
    expect(classes).not.toContain("border-none");
  });
});
