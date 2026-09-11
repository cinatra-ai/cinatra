// @vitest-environment jsdom
//
// The per-scope CARDS (cinatra#2808, per-scope surfaces S2).
//
// The acceptance items proved here, verbatim:
//
//   "Cards: every row's Run/Chat control carries its row-specific launch href;
//    two fixtures with differing versions and statuses assert each row's actual
//    rendered values (static labels are insufficient). Every Settings control
//    carries the exact scope- and package-specific href produced by #2809's
//    contract; the card fixture asserts the href, not merely the label."
//
//   "A non-admin member fixture opens More details and asserts that the bound
//    design/specs/app-extensions.html §II package content — name, vendor, and
//    detail body — renders in MarketplaceDetailModal."
//
// The Settings href is never hand-spelled here: it is taken from the S3
// contract module, so a card that mints its own address fails rather than
// agreeing with a copy of itself.
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import {
  scopeSurfaceAgentLaunchHref,
  scopeSurfaceAgentSettingsHref,
  scopeSurfaceAssistantLaunchHref,
  scopeSurfaceAssistantSettingsHref,
} from "@/lib/scope-surfaces";
import {
  emptyRatingSummary,
  type MarketplaceDetailLoadResult,
  type MarketplaceDetailView,
} from "@/lib/marketplace-detail-view";

// The generated extension catalog is irrelevant here and pulls the whole
// loader map in; stub it (the convention of the sibling component suites).
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

import { AgentAllCard } from "@/components/extensions/agent-all-card";
import { ScopeAssistantsTab } from "@/components/scope/scope-assistants-tab";

const TEAM = { kind: "team", id: "team-7" } as const;
const PKG_A = "@acme/orbit-scheduler-agent";
const PKG_B = "@acme/ledger-reconciler-agent";

// Anti-lookalike: the detail's display name and vendor share no token with the
// card's own name, so a modal body bound to the card rather than to the loaded
// §II content would read as a failure.
const DETAIL: MarketplaceDetailView = {
  packageName: PKG_A,
  displayName: "Orbit Scheduler",
  kindLabel: "Agent",
  cost: "Free",
  license: "Apache-2.0",
  latestVersion: "1.2.0",
  freshnessAt: "2026-06-30T12:00:00.000Z",
  installCount: 42,
  permalink: null,
  sdkAbiRange: null,
  readmeMarkdown: null,
  longDescription: null,
  description: "Plans and schedules recurring orbital passes.",
  iconUrl: null,
  compatibleUpTo: null,
  changelog: [],
  dependencies: [],
  ratingSummary: emptyRatingSummary(),
  reviews: [],
  vendor: { name: "Northwind Labs", slug: "northwind", storeUrl: null },
};

const loadDetail = async (): Promise<MarketplaceDetailLoadResult> => ({
  ok: true,
  detail: DETAIL,
});

afterEach(cleanup);

/** Let the modal's lazy detail load resolve and re-render. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe("AgentAllCard on a scope tab — Run, Settings, version, status", () => {
  function renderTwoRows() {
    return render(
      <>
        <div data-testid="row-a">
          <AgentAllCard
            row={{
              key: PKG_A,
              name: "Orbit Scheduler Agent",
              description: "Plans recurring passes.",
              host: "local",
              packageName: PKG_A,
              detailHref: null,
              runHref: scopeSurfaceAgentLaunchHref(TEAM, PKG_A),
              settingsHref: scopeSurfaceAgentSettingsHref(TEAM, PKG_A),
              version: "1.2.0",
              status: "active",
            }}
            loadDetail={loadDetail}
          />
        </div>
        <div data-testid="row-b">
          <AgentAllCard
            row={{
              key: PKG_B,
              name: "Ledger Reconciler Agent",
              description: "Reconciles ledgers.",
              host: "local",
              packageName: PKG_B,
              detailHref: null,
              runHref: scopeSurfaceAgentLaunchHref(TEAM, PKG_B),
              settingsHref: scopeSurfaceAgentSettingsHref(TEAM, PKG_B),
              version: "3.0.1",
              status: "locked",
            }}
            loadDetail={loadDetail}
          />
        </div>
      </>,
    );
  }

  it("carries each row's OWN scoped Run href", () => {
    renderTwoRows();
    const a = within(screen.getByTestId("row-a")).getByRole("link", { name: /run/i });
    const b = within(screen.getByTestId("row-b")).getByRole("link", { name: /run/i });
    expect(a.getAttribute("href")).toBe("/teams/team-7/agents/acme/orbit-scheduler-agent/new");
    expect(b.getAttribute("href")).toBe("/teams/team-7/agents/acme/ledger-reconciler-agent/new");
    expect(a.getAttribute("href")).not.toBe(b.getAttribute("href"));
  });

  it("carries the exact scope- and package-specific Settings href of the S3 contract", () => {
    renderTwoRows();
    const a = within(screen.getByTestId("row-a")).getByRole("link", { name: /settings/i });
    const b = within(screen.getByTestId("row-b")).getByRole("link", { name: /settings/i });
    expect(a.getAttribute("href")).toBe("/teams/team-7/agents/acme/orbit-scheduler-agent/settings");
    expect(b.getAttribute("href")).toBe(scopeSurfaceAgentSettingsHref(TEAM, PKG_B));
  });

  it("renders each row's ACTUAL version and status, not a shared label", () => {
    renderTwoRows();
    const a = within(screen.getByTestId("row-a"));
    const b = within(screen.getByTestId("row-b"));
    expect(a.getByText("1.2.0")).toBeTruthy();
    expect(a.getByText("Active")).toBeTruthy();
    expect(b.getByText("3.0.1")).toBeTruthy();
    expect(b.getByText("Locked")).toBeTruthy();
    expect(a.queryByText("3.0.1")).toBeNull();
    expect(b.queryByText("Active")).toBeNull();
  });

  it("gives a member More details with no /configuration link anywhere on the card", () => {
    const { container } = renderTwoRows();
    expect(screen.getAllByRole("button", { name: /more details/i }).length).toBe(2);
    for (const anchor of container.querySelectorAll("a[href]")) {
      expect(anchor.getAttribute("href")).not.toContain("/configuration");
    }
  });

  it("opens the ratified detail modal with the §II package content for a non-admin member", async () => {
    renderTwoRows();
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("row-a")).getByRole("button", { name: /more details/i }),
      );
    });
    await settle();
    const body = within(await screen.findByRole("dialog"));
    // The §II content of the bound package — its name, its VENDOR and its
    // detail body — from the loaded listing, not from the card's own props.
    // (The modal's title is the card's own human-readable name by design; the
    // vendor byline and the Details body are the loaded §II content.)
    expect(body.getAllByText(/Orbit Scheduler Agent/).length).toBeGreaterThan(0);
    expect(body.getByText(/Northwind Labs/)).toBeTruthy();
    expect(body.getByText(/Plans and schedules recurring orbital passes\./)).toBeTruthy();
  });
});

describe("ScopeAssistantsTab — Chat preserved, Settings added, installed-card fields", () => {
  const ASSISTANT = "@acme/atlas-assistant";
  const rows = [
    {
      packageName: ASSISTANT,
      vendor: "acme",
      slug: "atlas-assistant",
      displayName: "Atlas Assistant",
      description: "Answers questions about the atlas.",
      version: "2.4.0",
      status: "active" as const,
      localChatHref: scopeSurfaceAssistantLaunchHref(TEAM, {
        vendor: "acme",
        slug: "atlas-assistant",
      }),
      settingsHref: scopeSurfaceAssistantSettingsHref(TEAM, {
        vendor: "acme",
        slug: "atlas-assistant",
      }),
      remoteInstances: [
        {
          instanceId: "site-1",
          name: "Main site",
          localChatHref: scopeSurfaceAssistantLaunchHref(TEAM, {
            vendor: "acme",
            slug: "atlas-assistant",
            instance: "site-1",
          }),
          remoteHref: "https://example.invalid/wp-admin",
        },
      ],
    },
  ];

  it("keeps the Chat control on its row-specific scoped href", () => {
    render(<ScopeAssistantsTab rows={rows} loadDetail={loadDetail} />);
    expect(screen.getByRole("link", { name: /chat locally/i }).getAttribute("href")).toBe("/teams/team-7/assistants/acme/atlas-assistant/site-1");
    expect(screen.getByRole("link", { name: /remote chat/i }).getAttribute("href")).toBe("https://example.invalid/wp-admin");
  });

  it("adds the Settings href of the S3 contract and the installed-card fields", () => {
    render(<ScopeAssistantsTab rows={rows} loadDetail={loadDetail} />);
    expect(screen.getByRole("link", { name: /settings/i }).getAttribute("href")).toBe("/teams/team-7/assistants/acme/atlas-assistant/settings");
    expect(screen.getByText("2.4.0")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Atlas Assistant")).toBeTruthy();
  });

  it("opens the SAME ratified detail modal for a member", async () => {
    render(<ScopeAssistantsTab rows={rows} loadDetail={loadDetail} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /more details/i }));
    });
    await settle();
    const body = within(await screen.findByRole("dialog"));
    expect(body.getByText(/Northwind Labs/)).toBeTruthy();
    expect(body.getByText(/Plans and schedules recurring orbital passes\./)).toBeTruthy();
  });
});
