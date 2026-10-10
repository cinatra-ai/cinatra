/**
 * ExtensionCard — marketplace listing-card banner (design spec §IV).
 *
 * Shell mode (the marketplace storefront tile) renders the §IV banner: the
 * 46×46 SQUARE icon tile + the human-readable name INSIDE the coloured banner,
 * with the icon resolving a hosted-URL → kind-emblem fallback chain. Button
 * mode (the §V running-agent chip) is unchanged and keeps its accessible name.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { dirname, join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "tailwindcss";
import { renderToStaticMarkup } from "react-dom/server";

import { ExtensionCard, ExtensionCardListingBanner } from "../extension-card";
import { compositeOver, contrastAgainst, contrastRatio, parseCssColor } from "@/lib/color-contrast";

const SquareEmblem = () => <svg data-testid="kind-emblem" />;

describe("ExtensionCard listing banner (§IV, shell mode, variant=listing)", () => {
  const shellProps = {
    variant: "listing" as const,
    name: "Research Assistant",
    accentColor: "plum" as const,
    emblem: <SquareEmblem />,
    description: "Gathers sources and cites answers.",
  };

  it("renders the 0.5.0 §I banner: 88px coloured banner, 46×46 square icon tile, name in the banner", () => {
    const html = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    // Banner area present with the listing-card slot + min-height (0.5.0: 88px,
    // reduced from 96 now the byline shares the banner).
    expect(html).toContain('data-slot="extension-card-banner"');
    expect(html).toContain("min-h-[88px]");
    expect(html).not.toContain("min-h-[96px]");
    // Square icon tile (46×46, 11px radius), NOT the round 42px running-agent pill.
    expect(html).toContain('data-slot="extension-card-icon"');
    expect(html).toContain("h-[46px]");
    expect(html).toContain("w-[46px]");
    expect(html).toContain("rounded-[11px]");
    // Name lives inside the banner (Archivo italic-800, listing-title token =
    // 18px), clamped at 2 lines (0.5.0: was 3; the byline takes the 3rd line).
    expect(html).toContain('data-slot="extension-card-name"');
    expect(html).toContain("Research Assistant");
    expect(html).toContain("line-clamp-2");
    expect(html).not.toContain("line-clamp-3");
    expect(html).toContain("text-listing-title");
  });

  it("carries a native always-on title= on the name, matching the FULL text on both a short AND a truncated (clamped) name (cinatra#2363)", () => {
    // Short name: the always-on contract means title= is present regardless
    // of whether the name actually overflows the clamp.
    const shortHtml = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    const shortNameDiv = shortHtml.match(/<div data-slot="extension-card-name"[^>]*>/)?.[0];
    expect(shortNameDiv).toContain(`title="${shellProps.name}"`);

    // Long name: title= carries the FULL, un-clamped string.
    const longName =
      "A Very Long Extension Display Name That Would Overflow The Two-Line Clamp In A Narrow Card";
    const longHtml = renderToStaticMarkup(<ExtensionCard {...shellProps} name={longName} />);
    const longNameDiv = longHtml.match(/<div data-slot="extension-card-name"[^>]*>/)?.[0];
    expect(longNameDiv).toContain(`title="${longName}"`);
  });

  it("renders the byline slot beneath the name inside the banner (0.5.0 §I)", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...shellProps} byline={<span data-testid="byline-slot">Agent by Cinatra</span>} />,
    );
    // The byline slot is a banner descendant, placed after the name…
    const bannerAt = html.indexOf('data-slot="extension-card-banner"');
    const nameAt = html.indexOf('data-slot="extension-card-name"');
    const bylineAt = html.indexOf('data-testid="byline-slot"');
    const bodyAt = html.indexOf("bg-surface p-4");
    expect(bylineAt).toBeGreaterThan(nameAt);
    expect(bylineAt).toBeGreaterThan(bannerAt);
    // …not in the body block below the banner.
    expect(bylineAt).toBeLessThan(bodyAt);
  });

  it("uses the kind emblem when no icon URL is supplied (fallback chain tail)", () => {
    const html = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    expect(html).toContain('data-testid="kind-emblem"');
    expect(html).not.toContain("<img");
  });

  it("renders the hosted icon image when an icon URL is supplied (fallback chain head)", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...shellProps} iconUrl="https://assets.example/icon.png" />,
    );
    expect(html).toContain('src="https://assets.example/icon.png"');
    expect(html).toContain("object-cover");
    // Decorative alt (the visible name carries the accessible label).
    expect(html).toContain('alt=""');
    // The emblem is NOT rendered when an icon image is present.
    expect(html).not.toContain('data-testid="kind-emblem"');
  });

  it("overlays badges in the banner top-right and reserves name padding so a long name never runs under them", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard {...shellProps} badges={<span>Skill</span>} />,
    );
    expect(html).toContain("Skill");
    expect(html).toContain("absolute right-[14px] top-[14px]");
    // The name reserves right padding when badges are present.
    expect(html).toContain("pr-20");
  });
});

describe("ExtensionCard shell mode default (variant=chip) — non-marketplace lists unchanged", () => {
  it("keeps the §V chip (NOT the §IV listing banner) when no variant is passed (e.g. the agent-run grid)", () => {
    // The agent-run grid renders a shell-mode card with no variant. It MUST
    // keep the §V chip (min-h-150 emblem-above-name) and the indicator, never
    // the marketplace listing banner.
    const html = renderToStaticMarkup(
      <ExtensionCard
        name="Outbound Agent"
        accentColor="plum"
        emblem={<SquareEmblem />}
        description="Runs outbound email."
        indicator={{ label: "Daily 9am" }}
      />,
    );
    expect(html).not.toContain('data-slot="extension-card-banner"');
    expect(html).toContain("min-h-[150px]");
    expect(html).toContain("Daily 9am");
    expect(html).toContain("Outbound Agent");
  });
});

describe("ExtensionCard button mode (§V) — unchanged accessible name", () => {
  it("keeps the explicit aria-label so the font-display name is machine-readable", () => {
    const html = renderToStaticMarkup(
      <ExtensionCard
        name="Email Outreach Agent"
        accentColor="green"
        emblem={<SquareEmblem />}
        indicator={{ label: "Daily 9am" }}
      />,
    );
    expect(html).toContain('aria-label="Email Outreach Agent"');
    // Button mode does NOT use the §IV listing banner.
    expect(html).not.toContain('data-slot="extension-card-banner"');
  });
});

describe("italic overhang safe-area (cinatra#2409)", () => {
  const shellProps = {
    variant: "listing" as const,
    name: "Auditor Agent",
    accentColor: "plum" as const,
    emblem: <SquareEmblem />,
    description: "Audits agent runs.",
  };

  const nameDiv = (html: string) =>
    html.match(/<div data-slot="extension-card-name"[^>]*>/)?.[0] ?? "";

  it("guards the badge-less clamped italic name with the safe-area utility", () => {
    // `line-clamp-2` is an `overflow: hidden` box; without the safe-area the
    // final right-leaning italic glyph ("Auditor Agen*t*") is clipped.
    const html = renderToStaticMarkup(<ExtensionCard {...shellProps} />);
    expect(nameDiv(html)).toContain("italic-overhang-safe");
    expect(nameDiv(html)).not.toContain("pr-20");
  });

  it("lets the badge reservation (a superset safe-area) supersede the utility", () => {
    // With badges the name reserves `pr-20` for the overlay — 80px of trailing
    // padding already keeps every line's last glyph clear of the clip edge, so
    // exactly one of the two paddings applies (no specificity race).
    const html = renderToStaticMarkup(
      <ExtensionCard {...shellProps} badges={<span data-testid="badge" />} />,
    );
    expect(nameDiv(html)).toContain("pr-20");
    expect(nameDiv(html)).not.toContain("italic-overhang-safe");
  });

  it("defines the utility as a zero-layout-shift pad/margin pair, mirrored app <-> design package", () => {
    const globals = readFileSync(
      join(__dirname, "..", "..", "app", "globals.css"),
      "utf8",
    );
    const designUtilities = readFileSync(
      join(__dirname, "..", "..", "..", "packages", "design", "src", "utilities.css"),
      "utf8",
    );

    const appUtility = globals.match(
      /@utility italic-overhang-safe \{[\s\S]*?\n\}/,
    )?.[0];
    const designClass = designUtilities.match(
      /\.italic-overhang-safe \{[\s\S]*?\n\}/,
    )?.[0];
    expect(appUtility).toBeTruthy();
    expect(designClass).toBeTruthy();

    // The pad reserves clip room; the EQUAL negative margin hands the space
    // back to the layout, so alignment and wrap points cannot shift. Read the
    // two values instead of restating them — they are ONE decision.
    const readPair = (css: string) => {
      const pad = css.match(/padding-inline-end:\s*([0-9.]+em)/)?.[1];
      const margin = css.match(/margin-inline-end:\s*-([0-9.]+em)/)?.[1];
      return { pad, margin };
    };
    const app = readPair(appUtility!);
    const design = readPair(designClass!);
    expect(app.pad).toBeTruthy();
    expect(app.pad).toBe(app.margin);
    // The design-package mirror carries the identical pair (SDK consumers get
    // the same treatment the app compiles via Tailwind).
    expect(design).toEqual(app);
  });

  it("pins the sdk-ui card's line-clamp-3 variant to the same treatment", () => {
    const sdkUiSrc = readFileSync(
      join(__dirname, "..", "..", "..", "packages", "sdk-ui", "src", "extension-card.tsx"),
      "utf8",
    );
    expect(sdkUiSrc).toMatch(
      /badges \? "pr-20" : "italic-overhang-safe"/,
    );
  });
});

// REAL SSR and declared inherited ink; no browser computed style or hover grade.
describe("ExtensionCard rose ground Source contract (cinatra#2851)", () => {
  it.each(["button", "chip", "listing"] as const)(
    "%s renders the approved opaque rose/white pair around the actual name",
    (mode) => {
      const html = renderToStaticMarkup(
        <ExtensionCard
          name="Rose workspace"
          accentColor="clay"
          emblem={<SquareEmblem />}
          {...(mode === "button" ? {} : { description: "Category body" })}
          {...(mode === "listing"
            ? { variant: "listing" as const, byline: <span data-testid="rose-byline">Agent by Vendor</span> }
            : {})}
        />,
      );
      const doc: Document = new JSDOM(html).window.document;
      const band = Array.from(doc.querySelectorAll<HTMLElement>("[style]")).find(
        (element) => element.style.background !== "" && element.textContent?.includes("Rose workspace"),
      );
      expect(band, "the real name belongs to the colored chip/listing banner").toBeDefined();
      expect(band!.style.background).toBe("rgb(162, 102, 109)");
      expect(band!.style.color).toBe("rgb(255, 255, 255)");
      expect(contrastAgainst(band!.style.color, band!.style.background)).toBeGreaterThanOrEqual(4.5);
      if (mode === "listing") {
        const byline = band!.querySelector<HTMLElement>('[data-testid="rose-byline"]');
        const name = band!.querySelector<HTMLElement>('[data-slot="extension-card-name"]');
        expect(byline?.textContent).toBe("Agent by Vendor");
        expect(byline?.style.color).toBe("");
        expect(name?.style.color).toBe("");
        expect(name?.className).not.toMatch(/\btext-(?:muted-foreground|foreground|background)\b/);
      }
      expect(html).toContain("Rose workspace");
    },
  );
});

// Approved app-extensions §IV.3: native SSR + real shipped CSS declarations.
// This models the declared wash and contrast; it does not measure browser
// cascade, pointer paint, or independent light/dark picture acceptance.
let accentCss: string;
let accentGlobals: string;
beforeAll(async () => {
  const stylesheet = resolve(process.cwd(), "src/app/globals.css");
  accentGlobals = await readFile(stylesheet, "utf8");
  const require = createRequire(resolve(process.cwd(), "package.json"));
  const compiled = await compile(accentGlobals, {
    base: dirname(stylesheet),
    loadStylesheet: async (id, base) => {
      let path: string;
      if (id === "tw-animate-css") {
        const root = resolve(process.cwd(), "node_modules", id);
        const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
        path = resolve(root, manifest.exports["."].style);
      } else {
        path = id.startsWith(".") ? resolve(base, id) : require.resolve(id, { paths: [base] });
      }
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
  });
  accentCss = compiled.build(["bg-foreground/5", "bg-[#15213a]/5", "duration-150", "opacity-0", "group-hover/accent:opacity-100", "pointer-events-none"]);
});

function declaredWash(element: Element, palette: "cinatra" | "dark") {
  const matches: string[] = [];
  for (const rule of accentCss.matchAll(/(\.bg[^{}]+)\s*\{/g)) {
    if (!element.matches(rule[1].trim())) continue;
    // Read the complete generated rule, including Tailwind's @supports
    // colour-mix override. This is a supported-declaration model, not paint.
    const start = rule.index! + rule[0].length;
    let depth = 1;
    let end = start;
    while (depth > 0 && end < accentCss.length) {
      if (accentCss[end] === "{") depth++;
      if (accentCss[end] === "}") depth--;
      end++;
    }
    for (const declaration of accentCss.slice(start, end).matchAll(/background-color:\s*([^;]+);/g)) {
      matches.push(declaration[1]);
    }
  }
  expect(matches.length).toBeGreaterThan(0);
  const declaration = matches[matches.length - 1];
  const mix = declaration.match(/^color-mix\(in oklab, (#[0-9a-f]+|var\(--foreground\)) ([\d.]+)%, transparent\)$/i);
  if (!mix) throw new Error(`Unsupported generated wash: ${declaration}`);
  const theme = accentGlobals.match(new RegExp(`\\.${palette}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
  const token = theme?.match(/--foreground:\s*([^;]+);/)?.[1];
  const color = parseCssColor(mix[1].startsWith("var(") ? token! : mix[1]);
  if (!color) throw new Error("Missing shipped palette foreground");
  return { ...color, a: Number(mix[2]) / 100 };
}

describe("app-extensions §IV.3 — clay rest and navy hover in both palettes (cinatra#2851)", () => {
  it.each(["cinatra", "dark"] as const)("%s declares the exact ground, inherited white name/byline, five-percent navy wash and contrast floors", (palette) => {
    const html = renderToStaticMarkup(
      <div className={palette}>
        <ExtensionCardListingBanner name="Clay agent" accentColor="clay" emblem={<SquareEmblem />}
          byline={<span data-testid="clay-byline">Agent by Cinatra</span>}
          detailHref="/agents/clay-agent" activateLabel="View details for Clay agent" />
      </div>,
    );
    const doc = new JSDOM(html).window.document;
    const panel = doc.querySelector<HTMLAnchorElement>('a[href="/agents/clay-agent"]')!;
    const name = panel.querySelector<HTMLElement>('[data-slot="extension-card-name"]')!;
    const byline = panel.querySelector<HTMLElement>('[data-testid="clay-byline"]')!;
    expect(panel.style.background).toBe("rgb(162, 102, 109)");
    expect(panel.style.color).toBe("rgb(255, 255, 255)");
    expect(name.style.color).toBe("");
    expect(byline.style.color).toBe("");
    expect(name.className).not.toMatch(/\btext-(?:foreground|muted-foreground|background)\b/);
    const wash = panel.querySelector('[data-slot="extension-card-accent-hover"]')!;
    const ink = declaredWash(wash, palette);
    expect(ink).toEqual({ r: 21, g: 33, b: 58, a: 0.05 });
    const background = parseCssColor(panel.style.background)!;
    const white = parseCssColor(panel.style.color)!;
    expect(contrastRatio(white, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(white, background)).toBeCloseTo(4.5, 1);
    expect(contrastRatio(white, compositeOver(ink, background))).toBeGreaterThanOrEqual(4.8);
    expect(contrastRatio(white, compositeOver(ink, background))).toBeCloseTo(4.8, 1);
    // Wash remains passive, starts hidden, and fades only on panel hover.
    expect(wash.getAttribute("aria-hidden")).toBe("true");
    expect(wash.classList.contains("pointer-events-none")).toBe(true);
    expect(wash.classList.contains("opacity-0")).toBe(true);
    expect(wash.classList.contains("transition-opacity")).toBe(true);
    expect(wash.classList.contains("duration-150")).toBe(true);
    expect(wash.classList.contains("group-hover/accent:opacity-100")).toBe(true);
    expect(accentCss).toMatch(/transition-duration:\s*150ms/);
    expect(panel.getAttribute("aria-label")).toBe("View details for Clay agent");
    expect(panel.getAttribute("href")).toBe("/agents/clay-agent");
    expect(panel.classList.contains("focus-visible:ring-inset")).toBe(true);
  });

  it("keeps non-interactive and muted panels, other grounds, and caller styling intact", () => {
    const html = renderToStaticMarkup(<ExtensionCardListingBanner name="Archived" accentColor="clay" muted
      emblem={<SquareEmblem />} className="caller-card" />);
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('[data-slot="extension-card-accent-hover"]')).toBeNull();
    expect(doc.querySelector("a")).toBeNull();
    expect(doc.querySelector(".caller-card")).not.toBeNull();
    expect(doc.querySelector(".bg-muted.text-muted-foreground")).not.toBeNull();
    expect(html).not.toContain("rgb(162, 102, 109)");
  });
});
