// THE CARD DRAWS THE RENDERER ON THE IDENTITY LINE, WHERE THE DISPLAY NAMES IT
// (cinatra#3092).
//
// lifecycle-cards §XIII.7 draws the CMS page's line on the card as
// "@cinatra-ai/website-artifacts:page-snapshot · drawn by
// @cinatra-ai/website-artifacts:page-diff · revision rev_c410… · pinned ·
// WordPress · Team: Growth · Private · acme.example/pricing", and the
// dashboard's (§XIII.5) with no renderer at all. The composer words the facts;
// the card draws the name after the type, as text, and nothing for a header
// that carries none. Stand-in vendor names here; core names no extension.

// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { LifecycleTargetHeader } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { ReviewTargetHeader } from "../review-gate-card";

const DASHBOARD: LifecycleTargetHeader = {
  title: "Pipeline health — Q3",
  typeLabel: "Dashboard",
  objectType: "@acme/dashboard:dashboard",
  revisionId: "rev_2e77",
  facts: ["Team: Growth", "Private", "application/json", "updated 8 min ago"],
};

function page(platform: string, drawnBy = "@acme/cms-page:page-diff"): LifecycleTargetHeader {
  return {
    title: "Pricing — 2026 plans",
    typeLabel: "CMS page",
    objectType: "@acme/cms-page:content-snapshot",
    revisionId: "rev_c410",
    facts: [platform, "Team: Growth", "Private", "acme.example/pricing"],
    drawnBy,
  };
}

afterEach(() => cleanup());

/** The drawn mono line, read from the rendered DOM as a reader sees it. */
function metaText(header: LifecycleTargetHeader): string {
  const { container } = render(<ReviewTargetHeader header={header} />);
  return (container.querySelector("p")?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("the identity line on the card", () => {
  it("draws the renderer right after the type, for a WordPress and a Drupal page alike", () => {
    expect(metaText(page("WordPress"))).toBe(
      "@acme/cms-page:content-snapshot · drawn by @acme/cms-page:page-diff · revision rev_c410 · pinned · WordPress · Team: Growth · Private · acme.example/pricing",
    );
    expect(metaText(page("Drupal"))).toBe(
      "@acme/cms-page:content-snapshot · drawn by @acme/cms-page:page-diff · revision rev_c410 · pinned · Drupal · Team: Growth · Private · acme.example/pricing",
    );
  });

  it("carries the name on its own attribute, for a reader and a grader to find", () => {
    const html = renderToStaticMarkup(<ReviewTargetHeader header={page("WordPress")} />);
    expect(html).toContain('data-review-target-drawn-by="@acme/cms-page:page-diff"');
  });

  it("draws a dashboard header byte for byte as before: no renderer, no new element", () => {
    expect(renderToStaticMarkup(<ReviewTargetHeader header={DASHBOARD} />)).toBe(
      '<div data-conformance-id="review-target-header" class="rounded-control border border-line bg-surface-strong px-4 py-3"><div class="flex flex-wrap items-center gap-2"><span class="font-sans text-sm font-bold text-foreground">Pipeline health — Q3</span><span data-review-target-type="Dashboard" class="inline-flex items-center rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-xs font-semibold text-info">Dashboard</span></div><p class="mt-1 font-mono text-badge-xs tracking-tight text-muted-foreground"><span>@acme/dashboard:dashboard · </span><span data-review-target-revision="rev_2e77" title="rev_2e77">revision rev_2e77</span><span class="text-mustard-ink"> · pinned</span> · Team: Growth · Private · application/json · updated 8 min ago</p></div>',
    );
  });

  it("draws hostile name text as text, never as markup, and lets a long name break inside the line", () => {
    const hostile = `<img src=x onerror=alert(1)><script>alert(2)</script>${"x".repeat(120)}`;
    const { container } = render(<ReviewTargetHeader header={page("WordPress", hostile)} />);
    // No element is made of the name: no image, no script, nothing but the
    // header's own spans inside the line.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    const drawnBy = container.querySelector("[data-review-target-drawn-by]");
    expect(drawnBy?.children).toHaveLength(0);
    // The name is the span's text, character for character.
    expect(drawnBy?.textContent).toBe(`drawn by ${hostile} · `);
    expect(drawnBy?.getAttribute("data-review-target-drawn-by")).toBe(hostile);
    expect(drawnBy?.className).toBe("break-words");
  });
});
