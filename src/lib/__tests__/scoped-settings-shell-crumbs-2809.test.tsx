// @vitest-environment jsdom
/**
 * THE SCOPED SETTINGS SHELL NAMES ITS SCOPE (cinatra#2809, per-scope surfaces
 * S3 — forward + fix leg 2).
 *
 * The first proof round read `<scope-base>/agents/<vendor>/<package>/settings`
 * with the trail "88c63f08… > Agents > Settings" while the SIBLING pages under
 * the same base resolved the same scope by name in the same session. So the
 * name was available and the crumb still showed an abbreviated id — which is
 * not the drawing's genuinely-unavailable arm:
 *
 *   "the first crumb on every scoped page is the scope's NAME (a resolved label
 *    via the contribution channel, never the raw id) linking to the scope
 *    landing" (issue #2809, acceptance item 3)
 *
 *   "While a name is genuinely unavailable, the crumb shows the id's first eight
 *    characters plus an ellipsis ('9c0dfce6…') — never a title-cased raw id."
 *
 * The cause is here: the shell published its tab crumb and a Settings crumb at a
 * path no route answers on, and published NOTHING for the scope itself. It is
 * the page that resolved the scope behind that scope's own gate, so it is the
 * page that must publish the name — through the same `scopeSurfaceCrumbEntries`
 * road every other scope surface publishes through.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  clearCrumbContributions,
  selectCrumbContributions,
} from "@/lib/breadcrumb-contributions";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";
import type { ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";
const TEAM_ID = "9c0dfce6-1b7a-4a51-8f30-5c2e91b7d4aa";
const EPOCH = "anon";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { ScopeSurfaceSettingsShell } from "@/components/scope-surface-settings-shell";

function renderShell(scope: ScopeSurfaceRef, pathname: string, scopeTitle: string | null) {
  nav.pathname = pathname;
  return render(
    <ScopeSurfaceSettingsShell
      scope={scope}
      scopeTitle={scopeTitle}
      subject={{ kind: "agent", packageName: "@cinatra-ai/author-agent" }}
    />,
  );
}

function trailOn(pathname: string) {
  return buildBreadcrumbTrail(pathname, {
    contributions: selectCrumbContributions(pathname, EPOCH),
  });
}

beforeEach(() => {
  clearCrumbContributions();
});

afterEach(() => {
  cleanup();
  clearCrumbContributions();
});

describe("the scoped agent settings shell (issue #2809 item 3)", () => {
  const PATH = `/organizations/${ORG_ID}/agents/cinatra-ai/author-agent/settings`;

  it("heads the trail with the scope's resolved NAME, linked to the scope landing", () => {
    renderShell({ kind: "organization", id: ORG_ID }, PATH, "Northwind Labs");
    const crumbs = trailOn(PATH);
    expect(crumbs.map((c) => c.label)).toEqual(["Northwind Labs", "Agents", "Settings"]);
    expect(crumbs[0]!.href).toBe(`/organizations/${ORG_ID}`);
  });

  it("publishes the scope's own crumb, not only the tab's", () => {
    renderShell({ kind: "organization", id: ORG_ID }, PATH, "Northwind Labs");
    expect(
      selectCrumbContributions(PATH, EPOCH).map((c) => ({ prefix: c.prefix, label: c.label })),
    ).toEqual([
      { prefix: `/organizations/${ORG_ID}`, label: "Northwind Labs" },
      { prefix: `/organizations/${ORG_ID}/agents`, label: "Agents" },
    ]);
  });

  it("falls back to the id's first eight characters plus an ellipsis while the name is genuinely unavailable", () => {
    const teamPath = `/teams/${TEAM_ID}/agents/cinatra-ai/author-agent/settings`;
    renderShell({ kind: "team", id: TEAM_ID }, teamPath, null);
    const labels = trailOn(teamPath).map((c) => c.label);
    expect(labels).toEqual([`${TEAM_ID.slice(0, 8)}…`, "Agents", "Settings"]);
    expect(labels[0]).not.toContain("-1b7a");
  });

  it("names the workspace and the personal scope by their own word", () => {
    const workspacePath = "/workspace/agents/cinatra-ai/author-agent/settings";
    renderShell({ kind: "workspace" }, workspacePath, null);
    expect(trailOn(workspacePath).map((c) => c.label)).toEqual([
      "Workspace",
      "Agents",
      "Settings",
    ]);
  });
});
