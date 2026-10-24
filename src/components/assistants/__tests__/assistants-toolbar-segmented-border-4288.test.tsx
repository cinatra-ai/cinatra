// @vitest-environment jsdom
/**
 * The /assistants toolbar's segmented filter keeps its one outer border
 * (cinatra#4288).
 *
 *   pnpm exec vitest run --config vitest.config.ts --no-coverage src/components/assistants/__tests__/assistants-toolbar-segmented-border-4288.test.tsx
 *
 * The drawing says a control inside a toolbar drops its own border, and it says
 * a segmented button group shares one outer border with hairlines between the
 * segments. The design ruling on #4288 settles which sentence wins: a segmented
 * group inside a toolbar keeps its one outer border. This test mounts the real
 * <AssistantsDirectoryClient>, finds the assistant-type group inside its
 * toolbar, and reads the border classes on the rendered group element.
 * Tailwind is not compiled under jsdom, so the rendered class list is the
 * reading: it is what survives `cn()`/tailwind-merge and reaches the DOM.
 */
import "../../__tests__/access-picker-jsdom-shims";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => "/assistants",
  useSearchParams: () => new URLSearchParams(""),
}));

import { AssistantsDirectoryClient } from "../assistants-directory-client";

afterEach(cleanup);

function renderGroup(): { group: HTMLElement; toolbar: HTMLElement } {
  const { container } = render(
    <AssistantsDirectoryClient
      rows={[]}
      scopeValue={[]}
      scopes={{ orgs: [], projects: [], canGrantWorkspace: false }}
      canReachMarketplace={false}
      canUploadExtension={false}
    />,
  );
  const group = container.querySelector<HTMLElement>(
    '[data-slot="toggle-group"][aria-label="Filter by assistant type"]',
  );
  if (!group) throw new Error("the assistants directory rendered no assistant-type group");
  const toolbar = group.closest<HTMLElement>('[role="toolbar"]');
  if (!toolbar) throw new Error("the assistant-type group is not inside a toolbar");
  return { group, toolbar };
}

describe("cinatra#4288 — /assistants: a segmented group inside a toolbar keeps its one outer border", () => {
  it("renders the assistant-type group inside the Assistants filters toolbar", () => {
    const { toolbar } = renderGroup();
    expect(toolbar.getAttribute("aria-label")).toBe("Assistants filters");
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
