/**
 * CinatraLinkedTable — row-link contract (cinatra#1567 §1).
 *
 * /teams rows must link to /teams/[teamId] (and the sibling entity grids to
 * their detail routes). This is the renderer the seed configs mount via
 * `chartType: "cinatraLinkedTable"`; the truths locked here:
 *  - a `teams` cube row renders its Name cell as a real `<a>` to
 *    `/teams/<id>` (middle/right-click affordances preserved — no row-click);
 *  - the `<cube>.id` column is the link target, not a displayed column;
 *  - ids are URI-encoded into the href;
 *  - projects/organizations/artifacts stay mapped; an unmapped cube
 *    degrades to plain text (never a broken link).
 *
 *   pnpm --filter @cinatra-ai/dashboards exec vitest run \
 *     src/components/__tests__/cinatra-linked-table.test.tsx
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CinatraLinkedTable } from "../cinatra-linked-table";

function render(rows: Array<Record<string, unknown>>): string {
  return renderToStaticMarkup(<CinatraLinkedTable data={rows} />);
}

describe("CinatraLinkedTable — teams rows link to the team detail", () => {
  const teamsRows = [
    {
      "teams.id": "team-abc",
      "teams.name": "Growth",
      "teams.organization_name": "Acme",
    },
    {
      "teams.id": "team-def",
      "teams.name": "Platform",
      "teams.organization_name": "Acme",
    },
  ];

  it("wraps the Name cell in an <a> to /teams/<id>", () => {
    const html = render(teamsRows);
    expect(html).toContain('href="/teams/team-abc"');
    expect(html).toContain('href="/teams/team-def"');
    expect(html).toMatch(/<a[^>]*href="\/teams\/team-abc"[^>]*>Growth<\/a>/);
  });

  it("hides the teams.id column (link target, not display)", () => {
    const html = render(teamsRows);
    expect(html).not.toContain(">team-abc<");
    expect(html).toContain("Organization Name"); // other dims still shown
  });

  it("URI-encodes the id into the href", () => {
    const html = render([
      { "teams.id": "team/1 x", "teams.name": "Weird", "teams.organization_name": "A" },
    ]);
    expect(html).toContain('href="/teams/team%2F1%20x"');
  });
});

describe("CinatraLinkedTable — sibling cubes and fallbacks", () => {
  it("keeps projects/organizations/artifacts mapped to their detail routes", () => {
    expect(
      render([{ "projects.id": "p1", "projects.name": "Proj" }]),
    ).toContain('href="/projects/p1"');
    expect(
      render([{ "organizations.id": "o1", "organizations.name": "Org" }]),
    ).toContain('href="/organizations/o1"');
    expect(
      render([{ "artifacts.id": "a1", "artifacts.name": "Doc" }]),
    ).toContain('href="/artifacts/a1"');
  });

  it("degrades an unmapped cube to plain text (no link)", () => {
    const html = render([{ "agent_runs.id": "r1", "agent_runs.name": "Run" }]);
    expect(html).not.toContain("<a ");
    expect(html).toContain("Run");
  });

  it("degrades a row without an id dimension to plain text", () => {
    const html = render([{ "teams.name": "No id here" }]);
    expect(html).not.toContain("<a ");
    expect(html).toContain("No id here");
  });

  it("renders the empty state for zero rows", () => {
    expect(render([])).toContain("No data");
  });
});
