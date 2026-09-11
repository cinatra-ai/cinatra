// @vitest-environment jsdom
//
// The two tab BODIES on the shared scope shell (cinatra#2808, per-scope
// surfaces S2).
//
// The shell S1 (#2807) mounted is honest about what it does not know: with no
// rows read it says "this tab is not ready yet" and never that the scope is
// empty. This slice fills the two tabs, so three readings must be kept apart:
// rows read and present, rows read and none, and no read at all.
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { ScopeAgentsTab } from "@/components/scope/scope-agents-tab";
import { ScopeAssistantsTab } from "@/components/scope/scope-assistants-tab";
import { buildScopeAgentRows, buildScopeAssistantRows } from "@/lib/scope-surface-rows";
import type { ScopeEligibilityRow } from "@/lib/scope-surface-eligibility";

const TEAM = { kind: "team", id: "team-7" } as const;

const AGENT: ScopeEligibilityRow = {
  packageName: "@acme/orbit-agent",
  displayName: "Orbit Agent",
  description: "Plans recurring passes.",
  version: "1.2.0",
  status: "active",
  isAssistant: false,
  executionOrganizationIds: ["org-1"],
};

const ASSISTANT: ScopeEligibilityRow = {
  ...AGENT,
  packageName: "@acme/atlas-assistant",
  displayName: "Atlas Assistant",
  isAssistant: true,
};

afterEach(cleanup);

describe("the Agents tab body", () => {
  it("renders the scope's rows through AgentRunClient, with each row's Run href", () => {
    render(
      <ScopeSurfacePage
        scope={TEAM}
        tab="agents"
        title="Growth"
        tabRead
        tabBody={<ScopeAgentsTab rows={buildScopeAgentRows(TEAM, [AGENT, ASSISTANT])} />}
      />,
    );
    const list = within(screen.getByTestId("scope-agents-list"));
    expect(list.getByRole("link", { name: /run/i }).getAttribute("href")).toBe(
      "/teams/team-7/agents/acme/orbit-agent/new",
    );
    // The assistant package belongs to the OTHER tab.
    expect(screen.queryByText("Atlas Assistant")).toBeNull();
    expect(screen.queryByText(/this tab is not ready yet/i)).toBeNull();
  });

  it("says the scope holds none once the rows HAVE been read", () => {
    render(<ScopeSurfacePage scope={TEAM} tab="agents" title="Growth" tabRead />);
    expect(screen.getByText(/no agents here yet/i)).toBeTruthy();
    expect(screen.queryByText(/this tab is not ready yet/i)).toBeNull();
  });

  it("keeps the S1 placeholder when no rows were read at all", () => {
    render(<ScopeSurfacePage scope={TEAM} tab="agents" title="Growth" />);
    expect(screen.getByText(/this tab is not ready yet/i)).toBeTruthy();
  });
});

describe("the Assistants tab body", () => {
  const directory = [
    {
      packageName: "@acme/atlas-assistant",
      vendor: "acme",
      slug: "atlas-assistant",
      displayName: "Atlas Assistant",
      localChatHref: "/chat/acme/atlas-assistant",
      remoteInstances: [],
    },
  ];

  it("renders the scope's assistant rows with their scoped Chat and Settings hrefs", () => {
    render(
      <ScopeSurfacePage
        scope={TEAM}
        tab="assistants"
        title="Growth"
        tabRead
        tabBody={
          <ScopeAssistantsTab rows={buildScopeAssistantRows(TEAM, directory, [AGENT, ASSISTANT])} />
        }
      />,
    );
    // Scoped to the LIST: the scope's own tab strip carries a Settings tab of
    // its own, and this assertion is about the card's control.
    const list = within(screen.getByTestId("scope-assistants-list"));
    expect(list.getByRole("link", { name: /^chat$/i }).getAttribute("href")).toBe(
      "/teams/team-7/assistants/acme/atlas-assistant",
    );
    expect(list.getByRole("link", { name: /settings/i }).getAttribute("href")).toBe(
      "/teams/team-7/assistants/acme/atlas-assistant/settings",
    );
  });

  it("says the scope holds none once the rows HAVE been read", () => {
    render(<ScopeSurfacePage scope={TEAM} tab="assistants" title="Growth" tabRead />);
    expect(screen.getByText(/no assistants here yet/i)).toBeTruthy();
  });
});
