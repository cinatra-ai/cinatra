// @vitest-environment jsdom
/**
 * `/artifacts` — the Type select inside the library toolbar keeps its border
 * and its strong fill (cinatra#4287).
 *
 *   pnpm vitest run --config vitest.config.ts --no-coverage \
 *     src/components/artifacts/__tests__/library-toolbar-type-select-border-4287.test.tsx
 *
 * The agreed drawing (the design ruling recorded on #4287): a select trigger
 * inside a toolbar keeps its 1px `--line` border and its `--surface-strong`
 * fill, as the artifacts screen draws the Type facet. It does not drop them
 * the way a borderless toolbar field would.
 *
 * jsdom loads no stylesheet, so the border and the fill are read where they
 * are declared: the classes on the rendered trigger element.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/artifacts",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { Button } from "@/components/ui/button";
import { LibraryToolbar } from "../library-toolbar";

afterEach(cleanup);

describe("/artifacts — the Type select in the toolbar keeps its border and fill (cinatra#4287)", () => {
  it("the rendered Type trigger inside the toolbar carries the line border and the strong fill", () => {
    const { container, getByTestId } = render(
      <LibraryToolbar
        facetOptions={[{ value: "dashboard", label: "Dashboards" }]}
        scopeValue={[]}
        scopes={{ orgs: [], projects: [], canGrantWorkspace: false }}
        uploadAction={<Button data-testid="artifacts-upload">Upload</Button>}
      />,
    );
    const toolbar = container.querySelector<HTMLElement>('[data-slot="toolbar"]');
    expect(toolbar, "the library mounts its toolbar").toBeTruthy();
    const trigger = getByTestId("artifacts-facet");
    expect(toolbar!.contains(trigger), "the Type select sits inside the toolbar").toBe(true);
    expect(trigger.getAttribute("data-slot")).toBe("select-trigger");

    const classes = trigger.className.split(/\s+/);
    expect(classes, "the trigger draws a 1px border").toContain("border");
    expect(classes, "the border takes the --line colour").toContain("border-line");
    expect(classes, "the trigger keeps the --surface-strong fill").toContain("bg-surface-strong");
    expect(classes, "the border is not dropped inside the toolbar").not.toContain("border-0");
    expect(classes, "the fill is not dropped inside the toolbar").not.toContain("bg-transparent");
  });
});
