/**
 * ProjectSubnav — the shared Overview / Permissions section bar rendered on
 * the /projects/[projectId] route-section sub-pages (cinatra#1504; the
 * Customers + Agents sections were removed in #707).
 *
 * Mirrors the established route-tab pattern (src/components/agents-tab-nav.tsx):
 * each tab renders as a real <Link> (a full route navigation), and the active
 * section is driven by the `activeSection` prop the caller passes per-route
 * (not client-side tab state) — Radix's Tabs.Root marks the matching
 * TabsTrigger `data-state="active"` deterministically from `value`, so this
 * is fully assertable via static SSR markup.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectSubnav } from "../project-subnav";
import { projectNav } from "@/lib/project-nav";

const PROJECT_ID = "59fb73d3-8d69-4186-ac3e-039de3cc33d1";

// Find the rendered anchor for one section — order-independent match on
// href + label without assuming attribute order. The Link is wrapped by
// Tabs.Trigger (asChild), so data-state lives on the same rendered anchor
// element via Radix's Slot merge.
function trigger(html: string, href: string, label: string): string {
  const match = html.match(
    new RegExp(`<a[^>]*href="${href}"[^>]*>${label}</a>`),
  )?.[0];
  expect(match, `expected a rendered trigger for ${label} (${href})`).toBeTruthy();
  return match as string;
}

describe("ProjectSubnav", () => {
  it("renders both sibling sections with the correct hrefs", () => {
    const html = renderToStaticMarkup(
      <ProjectSubnav projectId={PROJECT_ID} activeSection="overview" />,
    );
    trigger(html, `/projects/${PROJECT_ID}`, "Overview");
    trigger(html, `/projects/${PROJECT_ID}/permissions`, "Permissions");
    // The Agents (and Customers) sections were removed in #707.
    expect(html).not.toContain(`/projects/${PROJECT_ID}/agents`);
    expect(html).not.toContain(`/projects/${PROJECT_ID}/customers`);
  });

  it("marks exactly the active section active, for every section", () => {
    const items = projectNav(PROJECT_ID);
    for (const active of items) {
      const html = renderToStaticMarkup(
        <ProjectSubnav projectId={PROJECT_ID} activeSection={active.value} />,
      );
      for (const item of items) {
        const anchor = trigger(html, item.href, item.label);
        expect(anchor).toContain(
          item.value === active.value
            ? 'data-state="active"'
            : 'data-state="inactive"',
        );
      }
      // Exactly one active trigger per render.
      expect(html.match(/data-state="active"/g)).toHaveLength(1);
    }
  });

  it("keeps the section row horizontally scrollable on narrow viewports", () => {
    const html = renderToStaticMarkup(
      <ProjectSubnav projectId={PROJECT_ID} activeSection="overview" />,
    );
    expect(html).toContain("overflow-x-auto");
  });
});
