// @vitest-environment jsdom
//
// Breadcrumb — the graded checklist for the components drawing's "Breadcrumb"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/breadcrumb-drawing-conformance.test.tsx
//
// The section's spec-column clauses, quoted verbatim:
//
//   "chevron 12px 50% opacity"
//   "slate links · ink current"
//   "max 3–4 crumbs"
//
// and the prose the primitive can answer for:
//
//   "Always in the topbar. Three to four crumbs maximum; truncate the middle
//    with an ellipsis if longer. Never combine with tabs."
//
// NO DEPARTURE FOUND in this primitive's own chrome; the committed checklist is
// the record. The section's long trail-content prose — what a crumb stands for,
// the id placeholder, the not-found reading — governs the trail BUILDER, not
// this primitive, and is already covered by the repository's own
// breadcrumb-conformance fixtures; the rows below say so where they apply.
//
// This is also the primitive the issue flags as sitting on the drifted pin:
// the clauses above are quoted from the drawing's live content on the
// documentation mirror, not from the conformance manifest's pinned copy.
// Reconciling the pin is #3144's scope.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

afterEach(cleanup);

function renderTrail() {
  const { container } = render(
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/agents">Agents</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Blog Draft Writer Agent (1)</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>,
  );
  const q = (slot: string) =>
    container.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
  return {
    container,
    nav: q("breadcrumb"),
    list: q("breadcrumb-list"),
    link: q("breadcrumb-link"),
    page: q("breadcrumb-page"),
    separator: q("breadcrumb-separator"),
  };
}

describe('clause: "chevron 12px 50% opacity"', () => {
  it("draws the separator chevron at the 12px step", () => {
    const { separator } = renderTrail();
    // `[&>svg]:size-3` is the 12px step. The computed width/height is read on
    // the boot ("breadcrumb chevron", primitive-wave-leg1.spec.ts).
    expect(separator.className).toContain("[&>svg]:size-3");
    expect(separator.querySelector("svg")).not.toBeNull();
  });

  it("holds the chevron at half opacity", () => {
    const { separator } = renderTrail();
    expect(separator.className).toContain("opacity-50");
  });

  it("keeps the chevron out of the accessible name of the trail", () => {
    const { separator } = renderTrail();
    expect(separator.getAttribute("aria-hidden")).toBe("true");
    expect(separator.getAttribute("role")).toBe("presentation");
  });
});

describe('clause: "slate links · ink current"', () => {
  it("draws the trail's links in the slate muted tone", () => {
    const { list, link } = renderTrail();
    // The tone is set once on the list and inherited by the links, so a new
    // crumb cannot arrive in the wrong colour by forgetting a class.
    expect(list.className).toContain("text-muted-foreground");
    // Rest state only: the link carries a hover-only ink rule, which is the
    // separate clause asserted below. At rest it must add no ink of its own.
    expect(/(^|\s)text-foreground(\s|$)/.test(link.className)).toBe(false);
  });

  it("lifts the current crumb to ink, and marks it current", () => {
    const { page } = renderTrail();
    expect(page.className).toContain("text-foreground");
    expect(page.getAttribute("aria-current")).toBe("page");
  });

  it("lifts a link to ink only on hover, never at rest", () => {
    const { link } = renderTrail();
    expect(link.className).toContain("hover:text-foreground");
  });

  it("names itself as the breadcrumb landmark", () => {
    const { nav } = renderTrail();
    expect(nav.tagName).toBe("NAV");
    expect(nav.getAttribute("aria-label")).toBe("breadcrumb");
  });
});

describe('clause: "Three to four crumbs maximum; truncate the middle with an ellipsis if longer."', () => {
  it("provides the middle-truncation crumb the sentence names", () => {
    const { container } = render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/agents">Agents</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Review</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );
    const ellipsis = container.querySelector(
      '[data-slot="breadcrumb-ellipsis"]',
    ) as HTMLElement;
    expect(ellipsis).not.toBeNull();
    // It is a presentational stand-in, and it carries a readable name for
    // assistive technology rather than reading as three dots.
    expect(ellipsis.getAttribute("aria-hidden")).toBe("true");
    expect(ellipsis.textContent).toContain("More");
  });

  // NOT APPLICABLE at the primitive, with the reason: the count limit reads on
  // the trail BUILDER — the shell that turns a route into crumbs — not on the
  // list, which renders the crumbs it is handed. Enforcing a cap inside
  // `BreadcrumbList` would silently drop a crumb a caller deliberately drew and
  // would change rendered trails app-wide; the issue keeps page-shaped trail
  // findings with the pages that own them.
  it.skip(
    "not applicable at the primitive: the three-to-four cap reads on the trail builder, not on the list that renders the crumbs it is handed",
    () => {},
  );
});

describe('clause: "Always in the topbar." / "Never combine with tabs."', () => {
  // NOT APPLICABLE at the primitive, with the reason: both sentences constrain
  // WHERE a consumer may place the trail. The primitive renders a nav landmark
  // and has no way to observe, or refuse, its placement.
  it.skip(
    "not applicable at the primitive: both sentences constrain placement, which the component cannot observe",
    () => {},
  );
});

describe("section prose on trail CONTENT (names, ids, the not-found reading)", () => {
  // NOT APPLICABLE at the primitive, with the reason: the section's long prose
  // — what a crumb stands for, the eight-character id placeholder, the cleared
  // name on a refused surface, the not-found single crumb — governs the trail
  // builder and its server render. The repository already grades it on the live
  // boot through src/app/design-fixtures/conformance/breadcrumb-conformance-
  // fixtures.tsx and its conformance driver; re-asserting it here would grade a
  // component this file does not render.
  it.skip(
    "not applicable at the primitive: the name/id/not-found prose governs the trail builder and is graded on the boot by the existing breadcrumb conformance fixture",
    () => {},
  );
});
