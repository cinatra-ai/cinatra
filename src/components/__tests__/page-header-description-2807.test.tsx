// cinatra#2807 fix leg 5 — the page header's description is ONE line.
//
// The ratified components drawing gives the page header exactly this: "An
// optional mono uppercase kicker label sits above the h1, an optional one-line
// description below it." The fourth proof round graded the project landing's
// header description wrapping onto a second line, so the shared component —
// which every scope header and every other page in the product goes through —
// clamps it to the one line the drawing draws, rather than each caller
// shortening its own string.

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/page-header-title-sync", () => ({
  PageHeaderTitleSync: () => null,
}));

import { PageHeader } from "@/components/page-header";

/** A description as long as the one the project landing carries. */
const LONG =
  "Project in Northwind Analytics — the dashboards, assistants, agents, artifacts and skills that live in this project.";

function descriptionClasses(html: string): string {
  const match = html.match(/<p class="([^"]*text-muted-foreground[^"]*)">Project in/);
  if (!match) throw new Error(`no description paragraph in: ${html}`);
  return match[1];
}

describe("PageHeader description (#2807 — the drawing's one-line description)", () => {
  it("clamps the description to a single line", () => {
    const html = renderToStaticMarkup(
      <PageHeader label="Project" title="Q3 Outbound" description={LONG} />,
    );
    expect(descriptionClasses(html)).toContain("line-clamp-1");
  });

  it("clamps it on every scope header, not only the one that was graded", () => {
    for (const label of ["Organization", "Team", "Project", "Personal"]) {
      const html = renderToStaticMarkup(
        <PageHeader label={label} title="Scope" description={LONG} />,
      );
      expect(descriptionClasses(html)).toContain("line-clamp-1");
    }
  });

  it("still renders the description text itself, and none where there is none", () => {
    const withDesc = renderToStaticMarkup(
      <PageHeader title="Q3 Outbound" description={LONG} />,
    );
    expect(withDesc).toContain("Project in Northwind Analytics");
    const without = renderToStaticMarkup(<PageHeader title="Q3 Outbound" />);
    expect(without).not.toContain("line-clamp-1");
  });
});
