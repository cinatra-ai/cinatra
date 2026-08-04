/**
 * Always-on truncation hover text on BOTH in-app card families (cinatra#2363,
 * spec design#105).
 *
 * The product choice being locked here: `title` is UNCONDITIONAL, not
 * overflow-detected. A truncation-only tooltip would need a client leaf plus a
 * per-card resize observer to measure the clamp; the always-on attribute costs
 * nothing, is identical from a hover's point of view, and additionally keeps
 * the untruncated string in the accessibility tree at every width. These tests
 * therefore assert the title on SHORT values too — a "only when it overflows"
 * regression would still pass a long-value-only suite.
 *
 * Coverage split, and why it is one file:
 *   - the NAME is clamped by `ExtensionCardListingBanner`, which BOTH families
 *     render, so one attribute serves the browse card and the installed card
 *     alike — asserted through both entry points so a future fork is caught;
 *   - the installed card's BYLINE has its own ellipsised span (the browse
 *     card's equivalent is covered in the extensions package, beside the rest
 *     of that card's contract).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ExtensionCard } from "../extension-card";
import { InstalledExtensionCard } from "../extensions/installed-extension-card";
import { resolveVendorPresentation } from "@/lib/vendor-presentation";
import {
  classifyExtensionSource,
  resolveConfiguredRegistryIdentities,
} from "@cinatra-ai/extensions/screens/extension-source-label";

const SHORT_NAME = "Research Assistant";
const LONG_NAME =
  "Enterprise Knowledge Base Connector for Confluence, Notion & SharePoint";

/** The name node's opening tag. */
function nameTag(html: string): string | undefined {
  return html.match(/<div data-slot="extension-card-name"[^>]*>/)?.[0];
}

/** The `title` value on the name node, decoded for the entities React escapes. */
function nameTitle(html: string): string | undefined {
  const raw = nameTag(html)?.match(/title="([^"]*)"/)?.[1];
  return raw?.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
}

function knownVendor(name: string) {
  return resolveVendorPresentation(
    { name },
    { surface: "extension-card-hover-title-test", ref: "@cinatra-ai/fixture" },
  );
}

describe("Card name hover text — the clamped name carries its full string", () => {
  const listingProps = {
    variant: "listing" as const,
    accentColor: "plum" as const,
    emblem: <svg data-testid="kind-emblem" />,
    description: "Gathers sources and cites answers.",
  };

  it("titles a SHORT name too (the attribute is always-on, not overflow-detected)", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...listingProps} name={SHORT_NAME} />,
    );
    expect(nameTitle(html)).toBe(SHORT_NAME);
  });

  it("titles a LONG name with the EXACT full string the clamp cuts", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...listingProps} name={LONG_NAME} />,
    );
    expect(nameTitle(html)).toBe(LONG_NAME);
    // The titled node is the one that clamps — a title on a non-clipping
    // ancestor would leave the visibly-cut text without a hover target.
    expect(nameTag(html)).toContain("line-clamp-2");
  });

  it("reaches the INSTALLED card family through the same banner", () => {
    const html = renderToStaticMarkup(
      <InstalledExtensionCard
        name={LONG_NAME}
        accentColor="green"
        emblem={<svg />}
        kindLabel="Connector"
        vendor={knownVendor("Meridian Labs")}
        description="Bridges the workspace to external knowledge bases."
      />,
    );
    expect(nameTitle(html)).toBe(LONG_NAME);
    expect(nameTag(html)).toContain("line-clamp-2");
  });

  it("keeps the title when the badge overlay reserves room (the pr-20 branch)", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...listingProps} name={LONG_NAME} badges={<span>Free</span>} />,
    );
    expect(nameTitle(html)).toBe(LONG_NAME);
    expect(nameTag(html)).toContain("pr-20");
  });
});

describe("InstalledExtensionCard byline hover text — the ellipsised line carries its full string", () => {
  function renderInstalled(
    over: Partial<Parameters<typeof InstalledExtensionCard>[0]> = {},
  ): string {
    return renderToStaticMarkup(
      <InstalledExtensionCard
        name="Web Research Agent"
        accentColor="green"
        emblem={<svg />}
        kindLabel="Agent"
        vendor={knownVendor("Cinatra")}
        description="Stateless schema-driven web research enricher."
        {...over}
      />,
    );
  }

  /** The byline's ellipsised span (the ONLY node that can clip the line). */
  function bylineSpan(html: string): string | undefined {
    return html.match(/<span class="overflow-hidden text-ellipsis"[^>]*>/)?.[0];
  }

  it("titles a SHORT byline with the exact '{Kind} by {Vendor}' text", () => {
    const html = renderInstalled();
    expect(bylineSpan(html)).toContain('title="Agent by Cinatra"');
  });

  it("titles a LONG byline that the line visibly truncates", () => {
    const vendor = "Meridian Labs Knowledge Systems International";
    const html = renderInstalled({ kindLabel: "Connector", vendor: knownVendor(vendor) });
    expect(bylineSpan(html)).toContain(`title="Connector by ${vendor}"`);
  });

  it("titles the missing-vendor placeholder line as rendered (never a bare kind label)", () => {
    const html = renderInstalled({ vendor: undefined });
    const title = bylineSpan(html)?.match(/title="([^"]+)"/)?.[1];
    expect(title).toBe("Agent by Unknown vendor");
  });

  it("leaves the §VI source clause's OWN tooltip intact and unduplicated", () => {
    // The REAL classifier, not a hand-written literal: the source clause's
    // tooltip copy is the thing this test claims survives, so it has to be the
    // copy the app actually resolves.
    const source = classifyExtensionSource(
      {
        packageName: "@cinatra-ai/fixture",
        source: { type: "github", repo: "cinatra-ai/fixture" },
      } as unknown as Parameters<typeof classifyExtensionSource>[0],
      resolveConfiguredRegistryIdentities({}),
    );
    const html = renderInstalled({ source });
    // The source keeps its own tooltip (innermost title wins on hover)…
    // React escapes attribute text, so compare against the escaped form.
    const escaped = source.tooltip
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#x27;");
    expect(source.tooltip.length).toBeGreaterThan(0);
    expect(html).toContain(`title="${escaped}"`);
    // …and the line title stays the vendor clause, not a concatenation that
    // would read back the source label a second time.
    expect(bylineSpan(html)).toContain('title="Agent by Cinatra"');
    expect(bylineSpan(html)).not.toContain(source.label);
  });

  it("matches the byline's visible text exactly (title is never a second source of truth)", () => {
    const html = renderInstalled({ kindLabel: "Artifact", vendor: knownVendor("Vantage") });
    const title = bylineSpan(html)?.match(/title="([^"]+)"/)?.[1];
    const kind = html.match(/data-slot="installed-extension-kind-label"[^>]*>([^<]*)</)?.[1];
    const vendor = html.match(/data-slot="installed-extension-vendor-label"[^>]*>([^<]*)</)?.[1];
    expect(title).toBe(`${kind} by ${vendor}`);
  });
});
