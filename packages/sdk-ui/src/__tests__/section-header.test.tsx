import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Rendered via react-dom/server static markup — works in the node vitest env
// (the sdk-ui test convention: no jsdom / testing-library needed).
import {
  Kicker,
  kickerVariants,
  SectionHeader,
  sectionTitleVariants,
} from "../section-header";

describe("kickerVariants", () => {
  it("defaults to the .section-kicker scale: badge-xs size + kicker tracking tokens", () => {
    const classes = kickerVariants();
    expect(classes).toContain("font-mono");
    expect(classes).toContain("uppercase");
    expect(classes).toContain("font-semibold");
    expect(classes).toContain("text-muted-foreground");
    expect(classes).toContain("text-badge-xs"); // 10px token — the .section-kicker scale
    expect(classes).toContain("tracking-kicker"); // 0.18em token
  });

  it("exposes the sm size lane (12px token)", () => {
    expect(kickerVariants({ size: "sm" })).toContain("text-xs");
  });

  it("exposes the wide and label tracking lanes as named tokens", () => {
    expect(kickerVariants({ tracking: "wide" })).toContain("tracking-kicker-wide");
    expect(kickerVariants({ tracking: "label" })).toContain("tracking-page-label");
  });

  it("uses only named/token utilities — no bracket-literal classes", () => {
    for (const variant of [
      kickerVariants(),
      kickerVariants({ size: "sm", tracking: "wide" }),
      kickerVariants({ tracking: "label" }),
    ]) {
      expect(variant).not.toMatch(/[[\]]/);
    }
  });
});

describe("Kicker", () => {
  it("renders a p with the kicker slot and default token classes", () => {
    const html = renderToStaticMarkup(createElement(Kicker, null, "MCP Access"));
    expect(html).toContain("<p");
    expect(html).toContain('data-slot="kicker"');
    expect(html).toContain("MCP Access");
    expect(html).toContain("text-badge-xs");
    expect(html).toContain("tracking-kicker");
    expect(html).toContain("font-mono");
    expect(html).toContain("uppercase");
  });

  it("applies the size and tracking variant lanes", () => {
    const html = renderToStaticMarkup(
      createElement(Kicker, { size: "sm", tracking: "wide" }, "Skill"),
    );
    expect(html).toContain("text-xs");
    expect(html).toContain("tracking-kicker-wide");
    expect(html).not.toContain("text-badge-xs");
  });

  it("merges a caller className and forwards element props", () => {
    const html = renderToStaticMarkup(
      createElement(Kicker, { className: "mb-2", id: "k1" }, "Label"),
    );
    expect(html).toContain("mb-2");
    expect(html).toContain('id="k1"');
  });
});

describe("sectionTitleVariants", () => {
  it("maps the size lanes to the type-scale tokens with tight title tracking", () => {
    expect(sectionTitleVariants()).toContain("text-2xl"); // md default
    expect(sectionTitleVariants({ size: "sm" })).toContain("text-xl");
    expect(sectionTitleVariants({ size: "lg" })).toContain("text-3xl");
    expect(sectionTitleVariants()).toContain("tracking-title-tight");
    expect(sectionTitleVariants()).toContain("font-semibold");
  });
});

describe("SectionHeader", () => {
  it("renders kicker + h2 title by default, with spacing between them", () => {
    const html = renderToStaticMarkup(
      createElement(SectionHeader, { kicker: "OAuth Clients", title: "MCP applications" }),
    );
    expect(html).toContain('data-slot="section-header"');
    expect(html).toContain('data-slot="kicker"');
    expect(html).toContain("OAuth Clients");
    expect(html).toContain("<h2");
    expect(html).toContain("MCP applications");
    expect(html).toContain("mt-2");
  });

  it("renders the requested heading level via the as prop", () => {
    const h1 = renderToStaticMarkup(
      createElement(SectionHeader, { title: "Account settings", as: "h1" }),
    );
    expect(h1).toContain("<h1");
    const h3 = renderToStaticMarkup(
      createElement(SectionHeader, { title: "Sub", as: "h3" }),
    );
    expect(h3).toContain("<h3");
  });

  it("omits the kicker slot (and its title offset) when no kicker is given", () => {
    const html = renderToStaticMarkup(createElement(SectionHeader, { title: "Plain" }));
    expect(html).not.toContain('data-slot="kicker"');
    expect(html).not.toContain("mt-2");
  });

  it("passes the kicker size/tracking lanes through", () => {
    const html = renderToStaticMarkup(
      createElement(SectionHeader, {
        kicker: "Skill",
        kickerSize: "sm",
        kickerTracking: "label",
        title: "T",
      }),
    );
    expect(html).toContain("text-xs");
    expect(html).toContain("tracking-page-label");
  });

  it("renders description and actions when provided", () => {
    const html = renderToStaticMarkup(
      createElement(SectionHeader, {
        title: "T",
        description: "Manage the sign-in details.",
        actions: createElement("button", null, "Back"),
      }),
    );
    expect(html).toContain("Manage the sign-in details.");
    expect(html).toContain("max-w-prose");
    expect(html).toContain("<button");
  });
});
