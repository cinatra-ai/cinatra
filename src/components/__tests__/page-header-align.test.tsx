// cinatra#2528 — on /setup/* the "Setup" title and the Cinatra BrandMark did
// not sit on one line: the mark rendered lower than the title.
//
// PageHeader lays its title/actions row out `items-start`, which is right for
// every page whose actions slot is a control row above a description — so the
// fix is an opt-in alignment variant, not a change to the shared default.
//
// Three nudges have to move together for the two to sit level, which is why
// this is a variant rather than a one-line class swap at the call site:
//   · the row aligns center instead of start,
//   · the actions slot drops its `pt-1`, and
//   · the title drops the `-mt-2` optical lift, which pulls the h1 out of its
//     own box — top-aligned that is the intended look, but under centering it
//     re-introduces the very offset being fixed.
//
// The default path is asserted alongside so no other PageHeader user moves.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/page-header-title-sync", () => ({
  PageHeaderTitleSync: () => null,
}));

import { PageHeader } from "@/components/page-header";

function rowClasses(html: string): string {
  const match = html.match(/<div class="([^"]*flex[^"]*justify-between[^"]*)"/);
  if (!match) throw new Error(`no title/actions row found in: ${html.slice(0, 200)}`);
  return match[1];
}

const centered = renderToStaticMarkup(
  <PageHeader title="Setup" actions={<span data-testid="mark" />} align="center" />,
);
const def = renderToStaticMarkup(
  <PageHeader title="Setup" actions={<span data-testid="mark" />} />,
);

describe("PageHeader align variant (#2528)", () => {
  it("centers the row only under align=center", () => {
    expect(rowClasses(centered)).toContain("items-center");
    expect(rowClasses(centered)).not.toContain("items-start");
    expect(rowClasses(def)).toContain("items-start");
    expect(rowClasses(def)).not.toContain("items-center");
  });

  it("drops the top-aligned nudges under align=center", () => {
    // the actions slot's pt-1
    expect(centered).not.toMatch(/items-center gap-3 pt-1/);
    expect(def).toMatch(/items-center gap-3 pt-1/);
    // the h1's -mt-2 optical lift
    expect(centered).not.toMatch(/-mt-2/);
    expect(def).toMatch(/-mt-2/);
  });

  it("does not resurrect the lift where it never applied (labelled, or non-lg)", () => {
    // `-mt-2` is scoped to an unlabelled lg title, so these two are unaffected
    // by the variant in either direction — pin that align= leaves them alone.
    for (const html of [
      renderToStaticMarkup(
        <PageHeader title="Setup" label="Wizard" actions={<span />} align="center" />,
      ),
      renderToStaticMarkup(
        <PageHeader title="Setup" size="sm" actions={<span />} align="center" />,
      ),
      renderToStaticMarkup(<PageHeader title="Setup" size="md" actions={<span />} />),
    ]) {
      expect(html).not.toMatch(/-mt-2/);
    }
  });

  it("renders the title and the actions slot in both modes", () => {
    for (const html of [centered, def]) {
      expect(html).toContain("Setup");
      expect(html).toContain('data-testid="mark"');
    }
  });
});

describe("setup layout wiring (#2528)", () => {
  it("the /setup header opts into the centered variant", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "app", "setup", "layout.tsx"),
      "utf8",
    );
    // The call sits on one line; take it whole so a partial match (e.g. the
    // nested <BrandMark … /> self-close) cannot truncate the assertion.
    const call = source.split("\n").find((line) => line.includes("<PageHeader"));
    expect(call).toBeDefined();
    expect(call).toContain('title="Setup"');
    expect(call).toContain("BrandMark");
    expect(call).toContain('align="center"');
  });
});
