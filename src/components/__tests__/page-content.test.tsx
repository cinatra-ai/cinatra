/**
 * THE PAGE CONTENT WRAPPER FORWARDS WHAT IT IS GIVEN (cinatra#3319).
 *
 * `PageContent` is the shared content-region wrapper every route's `page.tsx`
 * draws inside. Surfaces address that region by writing a host attribute on it —
 * the artifact page writes `data-render-dispatch` there so a reader can tell
 * WHICH precedence rung answered for the row — and a wrapper that declares only
 * `children` and `className` discards every such attribute before React renders
 * the node, silently and without a type error (a hyphenated JSX attribute is not
 * checked against a component's props type).
 *
 * This is the smallest statement of the contract the artifact page relies on:
 * the root element carries the attributes the caller passed, and the class list
 * is still the wrapper's own with the caller's extra classes merged in. It is a
 * UNIT file — it renders the wrapper itself, mocks nothing and restores nothing,
 * so it cannot pass by standing in for the component under test.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PageContent } from "../page-content";

/** The opening tag of the wrapper's single root element. */
function rootTag(html: string): string {
  const match = html.match(/<div[^>]*>/);
  return match ? match[0] : html;
}

describe("PageContent forwards the caller's attributes onto its root element", () => {
  it("renders a data-* attribute the caller passed", () => {
    const html = renderToStaticMarkup(
      <PageContent data-render-dispatch="semantic">
        <span>body</span>
      </PageContent>,
    );

    expect(rootTag(html)).toContain('data-render-dispatch="semantic"');
  });

  it("renders an aria-* attribute the caller passed", () => {
    const html = renderToStaticMarkup(
      <PageContent aria-label="Artifact content">
        <span>body</span>
      </PageContent>,
    );

    expect(rootTag(html)).toContain('aria-label="Artifact content"');
  });

  it("carries both at once on the SAME node — one region, not two", () => {
    const html = renderToStaticMarkup(
      <PageContent
        className="flex flex-col gap-6 pb-8"
        data-render-dispatch="fallback"
        aria-label="Artifact content"
      >
        <span>body</span>
      </PageContent>,
    );

    const tag = rootTag(html);
    expect(tag).toContain('data-render-dispatch="fallback"');
    expect(tag).toContain('aria-label="Artifact content"');
    // Exactly one element in the whole output carries the dispatch attribute:
    // forwarding must not be satisfied by adding a second node to hold it.
    expect(html.match(/data-render-dispatch=/g)).toHaveLength(1);
  });
});

describe("PageContent keeps the class list it had", () => {
  it("merges an extra class name into its own layout classes", () => {
    const html = renderToStaticMarkup(
      <PageContent className="flex flex-col gap-6 pb-8">
        <span>body</span>
      </PageContent>,
    );

    const tag = rootTag(html);
    expect(tag).toContain("mx-auto");
    expect(tag).toContain("max-w-7xl");
    expect(tag).toContain("pb-8");
  });

  it("keeps its own layout classes when the caller passes none", () => {
    const html = renderToStaticMarkup(
      <PageContent>
        <span>body</span>
      </PageContent>,
    );

    expect(rootTag(html)).toContain("max-w-7xl");
  });

  it("does not leak the merged class list as a second attribute", () => {
    const html = renderToStaticMarkup(
      <PageContent className="pb-8" data-render-dispatch="representation">
        <span>body</span>
      </PageContent>,
    );

    expect(html.match(/class=/g)).toHaveLength(1);
  });
});

describe("PageContent draws its children unchanged", () => {
  it("renders the children inside the root element", () => {
    const html = renderToStaticMarkup(
      <PageContent data-render-dispatch="requires-rebuild">
        <p data-testid="child">the artifact body</p>
      </PageContent>,
    );

    expect(html).toContain('<p data-testid="child">the artifact body</p>');
    expect(html).toContain('data-render-dispatch="requires-rebuild"');
  });
});
