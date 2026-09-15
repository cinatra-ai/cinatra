// @vitest-environment jsdom
/**
 * `/artifacts` — the library toolbar WRAPS on a narrow viewport instead of
 * scrolling its controls off-canvas (cinatra#3283).
 *
 *   pnpm vitest run --config vitest.config.ts --no-coverage \
 *     src/components/artifacts/__tests__/library-toolbar-narrow-wrap-3283.test.tsx
 *
 * The ratified drawing, artifacts page, Responsive: "On a narrow viewport the
 * toolbar wraps — the search field takes the full row, the Type / Scope /
 * Upload controls wrap beneath it, and Upload stays reachable (never behind an
 * overflow)."
 *
 * jsdom computes no layout, so the wrap is pinned where it is DECLARED: the
 * bar carries the wrapping form rather than the shared bar's horizontal
 * scroll, the search slot claims the full row under the small breakpoint, and
 * Upload stays a child of the bar (never moved behind an overflow affordance).
 * The screen reading at the narrow viewport is the second half of this proof.
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

function renderToolbar() {
  return render(
    <LibraryToolbar
      facetOptions={[{ value: "dashboard", label: "Dashboards" }]}
      scopeValue={[]}
      scopes={{ orgs: [], projects: [], canGrantWorkspace: false }}
      uploadAction={<Button data-testid="artifacts-upload">Upload</Button>}
    />,
  );
}

describe("/artifacts — the library toolbar wraps on a narrow viewport (cinatra#3283)", () => {
  it("1. the bar wraps its controls rather than scrolling them off-canvas", () => {
    const { container } = renderToolbar();
    const toolbar = container.querySelector<HTMLElement>('[data-slot="toolbar"]');
    expect(toolbar, "the library mounts its toolbar").toBeTruthy();
    const classes = toolbar!.className.split(/\s+/);
    expect(classes, "the controls wrap onto a further row").toContain("flex-wrap");
    expect(
      classes,
      "Upload stays reachable — never behind a horizontal overflow",
    ).not.toContain("overflow-x-auto");
  });

  it("2. the search field takes the full row at the narrow width", () => {
    const { container } = renderToolbar();
    const search = container.querySelector<HTMLElement>(
      '[data-slot="toolbar-search-group"]',
    );
    expect(search).toBeTruthy();
    expect(search!.className.split(/\s+/)).toContain("max-sm:w-full");
  });

  it("3. Upload is drawn inside the bar, after the Type and Scope controls", () => {
    const { container, getByTestId } = renderToolbar();
    const toolbar = container.querySelector<HTMLElement>('[data-slot="toolbar"]')!;
    const upload = getByTestId("artifacts-upload");
    expect(toolbar.contains(upload)).toBe(true);
    const all = Array.from(toolbar.querySelectorAll("*"));
    const facet = container.querySelector('[data-testid="artifacts-facet"]')!;
    expect(all.indexOf(upload)).toBeGreaterThan(all.indexOf(facet));
  });
});
