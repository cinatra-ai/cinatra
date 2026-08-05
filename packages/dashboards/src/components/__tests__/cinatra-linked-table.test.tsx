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
    const html = render([{ "llm_usage.id": "e1", "llm_usage.name": "Event" }]);
    expect(html).not.toContain("<a ");
    expect(html).toContain("Event");
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

// cinatra#2448 — the /agents/executions "5 latest agent runs" portlet is
// PER-RUN: the cube is seeded with 2 runs of one agent + 1 run of another
// and the renderer must paint 3 DISTINCT rows (no per-agent collapsing),
// each with the run name LINKED to /agents/<vendor>/<packageName>/<runId>,
// the agent name, and the status. run_id/vendor/package_name are hidden
// link material, never display columns.
describe("CinatraLinkedTable — agent_runs rows are per-run and link to the run (#2448)", () => {
  // Two runs of @acme/blog-draft-writer-agent (one custom title, one
  // falling back to the agent name) + one run of @acme/research-agent —
  // exactly the drizzle-cube row shape the seed query produces.
  const runRows = [
    {
      "agent_runs.run_id": "run-3",
      "agent_runs.run_name": "Custom launch-post draft",
      "agent_runs.agent_name": "Blog Draft Writer",
      "agent_runs.status": "running",
      "agent_runs.created_at": new Date().toISOString(),
      "agent_runs.vendor": "acme",
      "agent_runs.package_name": "blog-draft-writer-agent",
    },
    {
      "agent_runs.run_id": "run-2",
      "agent_runs.run_name": "Blog Draft Writer",
      "agent_runs.agent_name": "Blog Draft Writer",
      "agent_runs.status": "completed",
      "agent_runs.created_at": new Date(Date.now() - 3_600_000).toISOString(),
      "agent_runs.vendor": "acme",
      "agent_runs.package_name": "blog-draft-writer-agent",
    },
    {
      "agent_runs.run_id": "run-1",
      "agent_runs.run_name": "Research: pricing",
      "agent_runs.agent_name": "Research Agent",
      "agent_runs.status": "failed",
      "agent_runs.created_at": new Date(Date.now() - 90_000_000).toISOString(),
      "agent_runs.vendor": "acme",
      "agent_runs.package_name": "research-agent",
    },
  ];

  it("renders 3 distinct rows — two runs of the same agent do NOT collapse", () => {
    const html = render(runRows);
    expect(html.match(/<tr/g)?.length).toBe(4); // header + 3 data rows
    expect(html).toContain("Custom launch-post draft");
    expect(html).toContain("Research: pricing");
  });

  it("links each run name to /agents/<vendor>/<packageName>/<runId>", () => {
    const html = render(runRows);
    expect(html).toMatch(
      /<a[^>]*href="\/agents\/acme\/blog-draft-writer-agent\/run-3"[^>]*>Custom launch-post draft<\/a>/,
    );
    expect(html).toMatch(
      /<a[^>]*href="\/agents\/acme\/blog-draft-writer-agent\/run-2"[^>]*>Blog Draft Writer<\/a>/,
    );
    expect(html).toMatch(
      /<a[^>]*href="\/agents\/acme\/research-agent\/run-1"[^>]*>Research: pricing<\/a>/,
    );
  });

  it("shows agent and status columns; hides run_id/vendor/package_name", () => {
    const html = render(runRows);
    // Headers for the visible columns.
    expect(html).toContain("Run Name");
    expect(html).toContain("Agent Name");
    expect(html).toContain("Status");
    expect(html).toContain("Created At");
    // Status values are displayed.
    expect(html).toContain("running");
    expect(html).toContain("completed");
    expect(html).toContain("failed");
    // Link material never shows as a column.
    expect(html).not.toContain("Run Id");
    expect(html).not.toContain("Vendor");
    expect(html).not.toContain("Package Name");
    expect(html).not.toContain(">run-3<");
  });

  it("humanizes created_at as a relative-time string", () => {
    const html = render(runRows);
    expect(html).toContain("just now"); // the freshest run
    expect(html).toContain("ago"); // the older ones
  });

  it("degrades to plain text when a href coordinate is missing (unscoped package → empty vendor)", () => {
    const html = render([
      {
        "agent_runs.run_id": "run-9",
        "agent_runs.run_name": "Orphan run",
        "agent_runs.agent_name": "Orphan",
        "agent_runs.status": "queued",
        "agent_runs.created_at": new Date().toISOString(),
        "agent_runs.vendor": "",
        "agent_runs.package_name": "bare-package",
      },
    ]);
    expect(html).not.toContain("<a ");
    expect(html).toContain("Orphan run");
  });
});
