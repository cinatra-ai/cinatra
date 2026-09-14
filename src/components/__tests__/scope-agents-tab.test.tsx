/**
 * THE AGENTS TAB OF A SCOPE BASE (cinatra#2808, per-scope surfaces S2).
 *
 * The acceptance: "two fixtures with differing versions and statuses assert
 * each row's actual rendered values (static labels are insufficient)" and
 * "Every Settings control carries the exact scope- and package-specific href
 * produced by #2809's contract; the card fixture asserts the href, not merely
 * the label."
 *
 * So both fixtures below differ in version AND status, and every href is
 * compared against #2809's own builder rather than a retyped literal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The detail modal's default loader is a server action reaching the storefront;
// nothing in this suite opens the modal, so the module is stubbed to keep the
// render free of that graph.
vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: async () => ({ status: "error", message: "stub" }),
}));

import { ScopeAgentsTab } from "@/components/scope-surfaces/scope-agents-tab";
import { buildScopeSurfaceAgentRows } from "@/lib/scope-surface-rows";
import type { ScopeSurfaceEligibilityRow } from "@/lib/scope-surface-eligibility";
import {
  scopeSurfaceAgentLaunchHref,
  scopeSurfaceAgentSettingsHref,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

afterEach(() => {
  // Leave the module registry and every spy exactly as they were found, so this
  // file's stub can never change another file's run.
  vi.resetModules();
  vi.restoreAllMocks();
});

const SCOPE: ScopeSurfaceRef = { kind: "workspace" };

const FIXTURES: ScopeSurfaceEligibilityRow[] = [
  {
    packageName: "@acme/research-assistant",
    displayName: "Research Assistant",
    description: "Gathers sources, summarises, and cites answers.",
    version: "0.4.2",
    status: "active",
    installId: "install-research",
    executionOrgIds: ["org-a"],
  },
  {
    packageName: "@acme/media-transcript",
    displayName: "Media Transcript Agent",
    description: "Transcribes audio or video URLs to text.",
    version: "1.9.0",
    status: "locked",
    installId: "install-transcript",
    executionOrgIds: ["org-a"],
  },
];

/** The markup of each card, cut at the shared card root — so a value can be
 *  read against the card it is actually on, not against the whole page. */
function cardSegments(html: string): string[] {
  const parts = html.split('data-slot="installed-extension-card"');
  return parts.slice(1);
}

function render(scope: ScopeSurfaceRef = SCOPE) {
  return renderToStaticMarkup(
    <ScopeAgentsTab rows={buildScopeSurfaceAgentRows(scope, FIXTURES)} />,
  );
}

describe("ScopeAgentsTab", () => {
  it("renders one card per eligible agent", () => {
    const html = render();
    expect(html).toContain("Research Assistant");
    expect(html).toContain("Media Transcript Agent");
  });

  it("carries each row's OWN Run href — #2809's scoped launcher", () => {
    const html = render();
    for (const row of FIXTURES) {
      expect(html).toContain(`href="${scopeSurfaceAgentLaunchHref(SCOPE, row.packageName)}"`);
    }
    expect(html).toContain(">Run<");
  });

  it("carries each row's OWN Settings href — the exact #2809 address, not just the label", () => {
    const html = render();
    for (const row of FIXTURES) {
      expect(html).toContain(`href="${scopeSurfaceAgentSettingsHref(SCOPE, row.packageName)}"`);
    }
    expect(html).toContain(">Settings<");
  });

  it("renders the DIFFERING versions each row actually has", () => {
    const html = render();
    expect(html).toContain("v0.4.2");
    expect(html).toContain("v1.9.0");
  });

  it("renders the DIFFERING statuses each row actually has", () => {
    const html = render();
    expect(html).toContain('data-status="active"');
    expect(html).toContain('data-status="locked"');
    expect(html).toContain(">Active<");
    expect(html).toContain(">Locked<");
  });

  it("re-addresses every control when the scope changes", () => {
    const team: ScopeSurfaceRef = { kind: "team", id: "team-1" };
    const html = render(team);
    expect(html).toContain(
      `href="${scopeSurfaceAgentLaunchHref(team, "@acme/research-assistant")}"`,
    );
    expect(html).toContain(
      `href="${scopeSurfaceAgentSettingsHref(team, "@acme/research-assistant")}"`,
    );
    // The workspace addresses must be gone — a launch from a team belongs to it.
    expect(html).not.toContain('href="/workspace/agents/acme/research-assistant/new"');
  });

  // PER-CARD ASSOCIATION (convergence round, cinatra#2808). The whole-markup
  // assertions above prove the values are PRESENT; they cannot tell whether
  // each value sits on the card it belongs to — swapping the two versions, or
  // the two Settings hrefs, between the cards would still satisfy them. These
  // cases cut the markup at the card boundary and read each card on its own.
  it("puts each row's OWN version, status and hrefs on that row's OWN card", () => {
    const cards = cardSegments(render());
    expect(cards).toHaveLength(FIXTURES.length);
    for (const row of FIXTURES) {
      const card = cards.find((c) => c.includes(row.displayName));
      expect(card, `no card for ${row.displayName}`).toBeTruthy();
      expect(card!).toContain(`v${row.version}`);
      expect(card!).toContain(`data-status="${row.status}"`);
      expect(card!).toContain(`href="${scopeSurfaceAgentLaunchHref(SCOPE, row.packageName)}"`);
      expect(card!).toContain(`href="${scopeSurfaceAgentSettingsHref(SCOPE, row.packageName)}"`);
      // ...and NOT the other row's values.
      for (const other of FIXTURES) {
        if (other.packageName === row.packageName) continue;
        expect(card!).not.toContain(`v${other.version}`);
        expect(card!).not.toContain(
          `href="${scopeSurfaceAgentSettingsHref(SCOPE, other.packageName)}"`,
        );
      }
    }
  });

  it("offers a member NO link into the admin-only marketplace route", () => {
    expect(render()).not.toContain("/configuration");
  });

  it("still offers More details, so the member reaches the detail modal in place", () => {
    expect(render()).toContain("More details");
  });
});
