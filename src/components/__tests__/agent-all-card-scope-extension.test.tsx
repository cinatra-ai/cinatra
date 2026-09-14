/**
 * THE AGENT CARD, EXTENDED BY NAME (cinatra#2808, per-scope surfaces S2).
 *
 * The issue's change item 2: "reuse `AgentAllCard`/`AgentRunClient` with a
 * scoped `runHref` (S3) and EXTEND the card + row model by name: per-entry
 * **Settings** (opens the assignment page — the assignment epic), version,
 * status."
 *
 * EXTENDED BY NAME is the whole point, and both halves are asserted here
 * directly on the card, with no scope-surface row builder in between:
 *
 *   • a row that PASSES the three new inputs renders all three;
 *   • a row that passes NONE of them renders exactly what the ratified §IV
 *     drawing gives the /agents "All Agents" card — "without the version and
 *     the Active / Archived indicator" and with "a single primary action, Run,
 *     plus More details" — so that surface is untouched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: async () => ({ ok: false, reason: "error" }),
}));

import { AgentAllCard, type AgentAllCardRow } from "@/components/extensions/agent-all-card";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

/** The /agents row as that page builds it today — no new inputs at all. */
const AGENTS_PAGE_ROW: AgentAllCardRow = {
  key: "local:t1",
  name: "Research Assistant",
  description: "Gathers sources, summarises, and cites answers.",
  host: "local",
  runHref: "/agents/acme/research-assistant/new",
  packageName: "@acme/research-assistant",
  detailHref: "/configuration/marketplace/acme/research-assistant",
  unavailable: null,
};

/** A per-scope Agents-tab row: the same card, the three new inputs supplied. */
const SCOPE_TAB_ROW: AgentAllCardRow = {
  key: "@acme/research-assistant",
  name: "Research Assistant",
  description: "Gathers sources, summarises, and cites answers.",
  host: "local",
  runHref: "/teams/team-1/agents/acme/research-assistant/new",
  packageName: "@acme/research-assistant",
  // A member-facing scope card mints no admin-only detail route.
  detailHref: null,
  settingsHref: "/teams/team-1/agents/acme/research-assistant/settings",
  version: "v0.4.2",
  status: "locked",
};

describe("AgentAllCard extended by name", () => {
  it("renders the per-entry Settings control at the href the row carries", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={SCOPE_TAB_ROW} />);
    expect(html).toContain('href="/teams/team-1/agents/acme/research-assistant/settings"');
    expect(html).toContain(">Settings<");
  });

  it("renders the row's version", () => {
    expect(renderToStaticMarkup(<AgentAllCard row={SCOPE_TAB_ROW} />)).toContain("v0.4.2");
  });

  it("renders the row's status", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={SCOPE_TAB_ROW} />);
    expect(html).toContain('data-status="locked"');
    expect(html).toContain(">Locked<");
  });

  it("still offers More details to a reader who has no admin-only detail route", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={SCOPE_TAB_ROW} />);
    expect(html).toContain("More details");
    expect(html).not.toContain("/configuration");
  });

  it("keeps Run as the primary action, with its own scoped href", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={SCOPE_TAB_ROW} />);
    expect(html).toContain('href="/teams/team-1/agents/acme/research-assistant/new"');
    expect(html).toContain(">Run<");
  });

  it("THE §IV CARD IS UNTOUCHED: a row passing none of the three renders none of them", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={AGENTS_PAGE_ROW} />);
    expect(html).not.toContain(">Settings<");
    expect(html).not.toContain("data-slot=\"installed-status-indicator\"");
    expect(html).not.toContain("v0.4.2");
    // … and it still carries exactly Run plus More details.
    expect(html).toContain(">Run<");
    expect(html).toContain("More details");
  });
});
