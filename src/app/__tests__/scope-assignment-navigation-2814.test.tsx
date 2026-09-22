// @vitest-environment jsdom
/**
 * FROM THE CARD'S SETTINGS LINK TO THE ASSIGNMENT PAGE, ON EVERY SCOPE
 * (cinatra#2814, per-scope assignment S2).
 *
 * Acceptance, in the issue's words:
 *
 *   - "Pages on all five scopes render the named assignment-content root with
 *     the resolved package identity, the default Skills tab, and the
 *     route-derived scope (empty #2809 shells are insufficient);
 *     forged-identifier fixture (server re-resolution)."
 *   - "End-to-end navigation: from each scope page, an agent card's Settings
 *     button opens that agent's scoped settings page and an assistant card's
 *     Settings button opens the Skills-only page (fixture per scope)."
 *   - "Assistants: Skills tab only, no Artifacts trigger and no Artifacts
 *     content render; `?tab=artifacts` normalizes to Skills."
 *
 * Each fixture renders the scope's real Agents or Assistants tab (the #2808
 * cards over the #2809 href contract), reads the Settings link's href out of
 * the rendered card, resolves that href through the SAME scoped route the ten
 * `[...launch]` pages delegate to, and renders what the route returns. Only
 * the I/O at the edges is stubbed: the session, the membership reads, the
 * scope tab's eligible rows and the stores.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ScopeSurfaceEligibilityRow } from "@/lib/scope-surface-eligibility";
import { buildScopeSurfaceAgentRows, buildScopeSurfaceAssistantRows } from "@/lib/scope-surface-rows";
import { scopeSurfaceBase, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ME = "user_me";
const ORG = "org_acme";
const TEAM = "team_growth";
const PROJECT = "proj_launch";
const AGENT_PKG = "@cinatra-ai/research-agent";
const ASSISTANT_PKG = "@cinatra-ai/support-assistant";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({ user: { id: ME }, session: { activeOrganizationId: ORG } }),
  requireActorContext: async () => ({
    principalType: "HumanUser",
    principalId: ME,
    authSource: "ui",
    policyVersion: "v2",
    organizationId: ORG,
    platformRole: "member",
    orgRole: "member",
    teamIds: [],
    projectGrants: [],
  }),
  resolveActorGrantsForUserInOrg: async () => ({
    orgRole: "org_admin",
    teamIds: [TEAM],
    teamRoles: { [TEAM]: "team_admin" },
    projectGrants: [{ projectId: PROJECT, effectiveRole: "admin", accessSource: "user" }],
  }),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUserActiveOnly: async () => [
    { id: ORG, name: "Acme", teams: [{ id: TEAM, name: "Growth" }] },
  ],
  readProjectsForUser: async () => [{ id: PROJECT, name: "Launch" }],
}));

const eligible: ScopeSurfaceEligibilityRow[] = [
  {
    packageName: AGENT_PKG,
    displayName: "Research Agent",
    description: "Finds sources.",
    status: "active",
    version: "1.0.0",
  } as ScopeSurfaceEligibilityRow,
  {
    packageName: ASSISTANT_PKG,
    displayName: "Support Assistant",
    description: null,
    status: "active",
    version: "1.0.0",
  } as ScopeSurfaceEligibilityRow,
];

const directory = [
  {
    packageName: ASSISTANT_PKG,
    vendor: "cinatra-ai",
    slug: "support",
    displayName: "Support Assistant",
    remoteCapable: false,
    remoteInstances: [],
  },
];

vi.mock("@/lib/scope-surface-eligibility.server", () => ({
  readScopeSurfaceAgentRows: async (scope: ScopeSurfaceRef) =>
    buildScopeSurfaceAgentRows(scope, eligible.filter((r) => r.packageName === AGENT_PKG)),
  readScopeSurfaceAssistantRows: async (scope: ScopeSurfaceRef) =>
    buildScopeSurfaceAssistantRows(scope, directory, eligible),
}));

vi.mock("@/lib/scope-surface-entity-name", () => ({
  readScopeSurfaceEntityName: async (scope: ScopeSurfaceRef) =>
    scope.kind === "organization" ? "Acme" : scope.kind === "team" ? "Growth" : scope.kind === "project" ? "Launch" : null,
}));

vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: async () => ({ status: "error", message: "stub" }),
}));

vi.mock("@cinatra-ai/skills/agent-package-resolver", () => ({
  assertAgentWriteTarget: async () => ({ ok: true }),
}));

vi.mock("@/lib/agent-assigned-skills-store", () => ({
  readAssignedSkillsForAgentScope: async () => [],
}));

import { ScopedAgentsRoute, ScopedAssistantsRoute } from "@/app/scoped-launch-routes";
import { ScopeAgentsTab } from "@/components/scope-surfaces/scope-agents-tab";
import { ScopeAssistantsTab } from "@/components/scope-surfaces/scope-assistants-tab";

/** The Settings link's href, read out of the scope tab's rendered card. */
function settingsHrefOnCard(html: string, slot: string): string {
  const mark = html.indexOf(`data-slot="${slot}"`);
  expect(mark, `no ${slot} link on the card`).toBeGreaterThan(-1);
  const tag = html.slice(html.lastIndexOf("<", mark), html.indexOf(">", mark) + 1);
  const href = /href="([^"]+)"/.exec(tag)?.[1];
  expect(href).toBeTruthy();
  return href!.replaceAll("&amp;", "&");
}

const SCOPES: ScopeSurfaceRef[] = [
  { kind: "workspace" },
  { kind: "personal" },
  { kind: "organization", id: ORG },
  { kind: "team", id: TEAM },
  { kind: "project", id: PROJECT },
];

/** Split a card's Settings href into what the scoped catch-all receives. */
function routeFor(scope: ScopeSurfaceRef, href: string, tree: "agents" | "assistants") {
  const [path, query = ""] = href.split("?");
  const prefix = `${scopeSurfaceBase(scope)}/${tree}/`;
  expect(path.startsWith(prefix)).toBe(true);
  const segments = path.slice(prefix.length).split("/");
  const searchParams = Object.fromEntries(new URLSearchParams(query));
  return { path, segments, searchParams };
}

async function openAgentSettings(scope: ScopeSurfaceRef, tab?: string) {
  const rows = buildScopeSurfaceAgentRows(scope, eligible.filter((r) => r.packageName === AGENT_PKG));
  const href = settingsHrefOnCard(renderToStaticMarkup(<ScopeAgentsTab rows={rows} />), "agent-card-settings");
  const { path, segments, searchParams } = routeFor(scope, href, "agents");
  nav.pathname = path;
  const element = await ScopedAgentsRoute({
    scope,
    segments,
    searchParams: Promise.resolve(tab ? { ...searchParams, tab } : searchParams),
  });
  return render(<>{element}</>);
}

async function openAssistantSettings(scope: ScopeSurfaceRef, tab?: string) {
  const rows = buildScopeSurfaceAssistantRows(scope, directory, eligible);
  const href = settingsHrefOnCard(renderToStaticMarkup(<ScopeAssistantsTab rows={rows} />), "scope-assistant-settings");
  const { path, segments, searchParams } = routeFor(scope, href, "assistants");
  nav.pathname = path;
  const element = await ScopedAssistantsRoute({
    scope,
    segments,
    searchParams: Promise.resolve(tab ? { ...searchParams, tab } : searchParams),
  });
  return render(<>{element}</>);
}

beforeEach(() => {
  nav.pathname = "/";
});

afterEach(() => {
  cleanup();
});

describe("an agent card's Settings link opens that agent's page at the card's scope", () => {
  for (const scope of SCOPES) {
    it(`on the ${scope.kind} page`, async () => {
      await openAgentSettings(scope);
      const root = screen.getByTestId("scope-assignment-page");
      expect(root.getAttribute("data-surface")).toBe("agent");
      expect(root.getAttribute("data-package")).toBe(AGENT_PKG);
      expect(root.getAttribute("data-scope-kind")).toBe(scope.kind);
      expect(root.getAttribute("data-scope-id")).toBe("id" in scope ? scope.id : null);
      expect(root.getAttribute("data-tab")).toBe("skills");
      // The default pane is Skills, and the strip offers both.
      const tabs = within(root).getAllByRole("tab");
      expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([
        ["Skills", "true"],
        ["Artifacts", "false"],
      ]);
      expect(root.querySelector('[data-slot="scope-assignment-skills-pane"]')).not.toBeNull();
      expect(root.querySelector('[data-slot="scope-assignment-artifacts-pane"]')).toBeNull();
      // The empty #2809 shell is gone.
      expect(screen.queryByTestId("scope-surface-settings-shell")).toBeNull();
      expect(screen.queryByText("This surface is not ready yet")).toBeNull();
    });
  }

  it("names the scope being configured above the package", async () => {
    await openAgentSettings({ kind: "team", id: TEAM });
    const root = screen.getByTestId("scope-assignment-page");
    expect(root.querySelector('[data-slot="scope-assignment-scope"]')?.textContent).toBe("Team · Growth");
    expect(root.querySelector('[data-slot="scope-assignment-name"]')?.textContent).toBe("Research Agent");
  });

  it("carries the whole workspace vantage on the workspace page, and one scope everywhere else", async () => {
    await openAgentSettings({ kind: "workspace" });
    const keys = [...document.querySelectorAll('[data-slot="scope-assignment-section"]')].map((n) =>
      n.getAttribute("data-scope-key"),
    );
    expect(keys).toEqual(["workspace", "personal", `organization:${ORG}`, `team:${TEAM}`, `project:${PROJECT}`]);
    cleanup();
    await openAgentSettings({ kind: "project", id: PROJECT });
    expect(
      [...document.querySelectorAll('[data-slot="scope-assignment-section"]')].map((n) => n.getAttribute("data-scope-key")),
    ).toEqual([`project:${PROJECT}`]);
  });
});

describe("an assistant card's Settings link opens the Skills-only page at the card's scope", () => {
  for (const scope of SCOPES) {
    it(`on the ${scope.kind} page`, async () => {
      await openAssistantSettings(scope);
      const root = screen.getByTestId("scope-assignment-page");
      expect(root.getAttribute("data-surface")).toBe("assistant");
      expect(root.getAttribute("data-package")).toBe(ASSISTANT_PKG);
      expect(root.getAttribute("data-scope-kind")).toBe(scope.kind);
      expect(root.getAttribute("data-tab")).toBe("skills");
      expect(within(root).queryAllByRole("tab")).toHaveLength(0);
      expect(within(root).queryByRole("tablist")).toBeNull();
      expect(root.querySelector('[data-slot="scope-assignment-artifacts-pane"]')).toBeNull();
    });
  }

  it("normalizes ?tab=artifacts to Skills: no Artifacts trigger, no Artifacts content", async () => {
    await openAssistantSettings({ kind: "organization", id: ORG }, "artifacts");
    const root = screen.getByTestId("scope-assignment-page");
    expect(root.getAttribute("data-tab")).toBe("skills");
    expect(within(root).queryByText("Artifacts")).toBeNull();
    expect(within(root).queryByText("Context artifacts")).toBeNull();
    expect(root.querySelector('[data-slot="scope-assignment-skills-pane"]')).not.toBeNull();
  });
});

describe("the server re-resolves the address (forged identifiers)", () => {
  it("answers not found for a pair the scope's tab does not list", async () => {
    await expect(
      ScopedAgentsRoute({
        scope: { kind: "team", id: TEAM },
        segments: ["cinatra-ai", "forged-agent", "settings"],
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      ScopedAssistantsRoute({
        scope: { kind: "personal" },
        segments: ["cinatra-ai", "forged", "settings"],
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("answers not found for an assistant addressed through the agents tree", async () => {
    await expect(
      ScopedAgentsRoute({
        scope: { kind: "personal" },
        segments: ["cinatra-ai", "support-assistant", "settings"],
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("answers not found for a scope outside the reader's memberships", async () => {
    await expect(
      ScopedAgentsRoute({
        scope: { kind: "organization", id: "org_elsewhere" },
        segments: ["cinatra-ai", "research-agent", "settings"],
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
