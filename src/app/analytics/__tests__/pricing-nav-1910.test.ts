/**
 * cinatra#1910 — Analytics → LLM pricing navigation. Pricing is an admin
 * MANAGEMENT sub-page of /analytics/llm (the settings-surface pattern), not a
 * fourth analytics tab: it edits the price list while Costs/Usage/API Requests
 * are read views. Source locks pin the decision:
 *   - entry pages (Costs, Usage) carry a labeled header button, not the old
 *     icon-only link whose only name was its aria-label
 *   - the pricing page never links to itself, offers a labeled way back,
 *     renders NO tab strip (so no tab can be falsely active), and identifies
 *     itself in its own header
 *   - the breadcrumb contract yields Analytics › LLM › Pricing, with the LLM
 *     crumb linking back to /analytics/llm and the pageless /analytics root
 *     rendered as a non-link (it has no page to land on)
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";
import { ANALYTICS_NAV } from "@/lib/section-nav";

const COSTS_PAGE = "src/app/analytics/llm/page.tsx";
const USAGE_PAGE = "src/app/analytics/llm-usage/page.tsx";
const PRICING_PAGE = "src/app/analytics/llm/pricing/page.tsx";

// The old pattern: an icon-only <Link> named only by this aria-label.
const OLD_ICON_ONLY = 'aria-label="Pricing administration"';

const PRICING_CONTRIBUTIONS = [
  { prefix: "/analytics/llm", label: "LLM" },
  { prefix: "/analytics/llm/pricing", label: "Pricing" },
] as const;

describe("pricing entry affordance (#1910)", () => {
  it.each([COSTS_PAGE, USAGE_PAGE])(
    "%s: labeled header button, not an icon-only link",
    (file) => {
      const src = readFileSync(file, "utf-8");
      expect(src).toContain('<Button asChild variant="outline">');
      expect(src).toContain('<Link href="/analytics/llm/pricing">');
      expect(src).toContain('<Settings2 data-icon="inline-start" aria-hidden="true" />');
      expect(src).toContain("Pricing administration");
      // The visible text IS the accessible name now — the aria-label-only
      // icon pattern must be gone.
      expect(src).not.toContain(OLD_ICON_ONLY);
    },
  );
});

describe("pricing page is a self-identifying sub-page (#1910)", () => {
  const src = readFileSync(PRICING_PAGE, "utf-8");

  it("never links to itself", () => {
    expect(src).not.toContain('href="/analytics/llm/pricing"');
  });

  it("offers a labeled way back to /analytics/llm", () => {
    expect(src).toContain('<Link href="/analytics/llm">');
    expect(src).toContain('<ArrowLeft data-icon="inline-start" aria-hidden="true" />');
    expect(src).toContain("Back to LLM costs");
  });

  it("renders no analytics tab strip, so no tab can be falsely active", () => {
    expect(src).not.toContain("<MetricApiNav");
    expect(src).not.toContain("MetricApiNav");
  });

  it("identifies itself in its own header instead of borrowing the Costs copy", () => {
    expect(src).toContain('title="Model pricing"');
    expect(src).toContain(
      'description="Manage the per-model price list used to compute LLM spend."',
    );
    expect(src).not.toContain("analyticsTabDescription(");
  });

  it("publishes the deliberate crumb contract", () => {
    expect(src).toContain('{ prefix: "/analytics/llm", label: "LLM" }');
    expect(src).toContain('{ prefix: "/analytics/llm/pricing", label: "Pricing" }');
  });
});

describe("pricing stays out of the tab model (#1910 decision pin)", () => {
  it("ANALYTICS_NAV keeps exactly its three read views", () => {
    expect(ANALYTICS_NAV).toHaveLength(3);
    expect(ANALYTICS_NAV.map((i) => i.value)).not.toContain("pricing");
  });
});

describe("breadcrumb trail on the pricing route (#1910)", () => {
  it("reads Analytics › LLM › Pricing with LLM linking back", () => {
    const crumbs = buildBreadcrumbTrail("/analytics/llm/pricing", {
      pageTitle: { title: "Model pricing", pathname: "/analytics/llm/pricing" },
      contributions: PRICING_CONTRIBUTIONS,
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Analytics", "LLM", "Pricing"]);
    expect(crumbs[1].href).toBe("/analytics/llm");
    expect(crumbs[1].nonNavigable).toBeFalsy();
  });

  it("the pageless /analytics root is a non-link on analytics routes", () => {
    for (const pathname of ["/analytics/llm", "/analytics/llm/pricing"]) {
      const crumbs = buildBreadcrumbTrail(pathname);
      expect(crumbs[0].label).toBe("Analytics");
      expect(crumbs[0].nonNavigable).toBe(true);
    }
  });

  it("other section roots stay navigable (the rider is analytics-scoped)", () => {
    const crumbs = buildBreadcrumbTrail("/connectors/acme/some-connector/setup");
    expect(crumbs[0]).toMatchObject({ label: "Connectors", href: "/connectors" });
    expect(crumbs[0].nonNavigable).toBeFalsy();
  });
});
