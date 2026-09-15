/**
 * THE AGENTS TAB OF A SCOPE BASE (cinatra#2808, per-scope surfaces S2).
 *
 * The acceptance: "Every Settings control carries the exact scope- and
 * package-specific href produced by #2809's contract; the card fixture asserts
 * the href, not merely the label."
 *
 * design#156 (specs/app-extensions.html §IV) settled what that control IS: "The
 * two text links sit side by side in the same treatment, Settings to the left",
 * on a card that keeps the §III anatomy "minus the version/status row". So every
 * href is compared against #2809's own builder rather than a retyped literal,
 * the two links are read as links, and the version/status row is read as absent.
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

/**
 * The two text links of one card: the Settings tag, the More-details tag, and
 * whatever sits BETWEEN them — which "side by side" leaves empty.
 */
function textLinks(html: string) {
  const sMark = html.indexOf('data-slot="agent-card-settings"');
  expect(sMark, "no Settings link in the markup").toBeGreaterThan(-1);
  const sStart = html.lastIndexOf("<", sMark);
  const sTag = html.slice(sStart, html.indexOf(">", sMark) + 1);
  // The tag that OPENS the row holding the pair — "side by side" is ITS layout.
  const wStart = html.lastIndexOf("<", sStart - 1);
  const wrapper = wStart < 0 ? "" : html.slice(wStart, html.indexOf(">", wStart) + 1);
  const sEnd = html.indexOf("</a>", sMark) + "</a>".length;
  const mText = html.indexOf("More details", sEnd);
  expect(mText, "no More details after the Settings link").toBeGreaterThan(-1);
  const mStart = html.lastIndexOf("<", mText);
  return {
    settings: sTag,
    wrapper,
    moreDetails: html.slice(mStart, mText),
    between: html.slice(sEnd, mStart),
  };
}

const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1] ?? "";

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

  it("draws Settings as a TEXT LINK in the same treatment as More details, to its LEFT", () => {
    const cards = cardSegments(render());
    // …and this loop reads EVERY card, so a card marker that stopped matching
    // cannot let the case pass with nothing asserted.
    expect(cards).toHaveLength(FIXTURES.length);
    for (const card of cards) {
      const { settings, moreDetails, between, wrapper } = textLinks(card);
      expect(settings.startsWith("<a")).toBe(true);
      expect(classOf(settings)).not.toBe("");
      expect(classOf(settings)).toBe(classOf(moreDetails));
      expect(between).toBe("");
      expect(card.indexOf(">Settings<")).toBeLessThan(card.indexOf("More details"));
      // A ROW, not a column: "side by side" is the WRAPPER's own layout, so a
      // flex-col wrapper — which keeps source order and adjacency intact while
      // stacking the two links — fails here.
      expect(classOf(wrapper)).toContain("flex");
      expect(classOf(wrapper)).toContain("items-center");
      expect(classOf(wrapper)).not.toContain("flex-col");
      // …and a ROW that is not REVERSED: flex-row-reverse would keep source order
      // and adjacency while drawing Settings to the RIGHT of More details.
      expect(classOf(wrapper)).not.toContain("flex-row-reverse");
      // No gear glyph: a text link, not the button this branch first shipped.
      expect(card.slice(card.indexOf(settings), card.indexOf(">Settings<"))).not.toContain("<svg");
    }
  });

  it("renders NO version, on any card", () => {
    const html = render();
    expect(html).not.toContain("v0.4.2");
    expect(html).not.toContain("v1.9.0");
  });

  it("renders NO Active / Archived indicator, on any card", () => {
    const html = render();
    expect(html).not.toContain('data-slot="installed-status-indicator"');
    expect(html).not.toContain('data-status="active"');
    expect(html).not.toContain('data-status="locked"');
    expect(html).not.toContain(">Active<");
    expect(html).not.toContain(">Locked<");
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
  // each value sits on the card it belongs to — swapping the two Settings hrefs
  // between the cards would still satisfy them. This case cuts the markup at
  // the card boundary and reads each card on its own.
  it("puts each row's OWN hrefs on that row's OWN card", () => {
    const cards = cardSegments(render());
    expect(cards).toHaveLength(FIXTURES.length);
    for (const row of FIXTURES) {
      const card = cards.find((c) => c.includes(row.displayName));
      expect(card, `no card for ${row.displayName}`).toBeTruthy();
      expect(card!).toContain(`href="${scopeSurfaceAgentLaunchHref(SCOPE, row.packageName)}"`);
      expect(card!).toContain(`href="${scopeSurfaceAgentSettingsHref(SCOPE, row.packageName)}"`);
      // ...and NOT the other row's addresses.
      for (const other of FIXTURES) {
        if (other.packageName === row.packageName) continue;
        expect(card!).not.toContain(
          `href="${scopeSurfaceAgentSettingsHref(SCOPE, other.packageName)}"`,
        );
        expect(card!).not.toContain(
          `href="${scopeSurfaceAgentLaunchHref(SCOPE, other.packageName)}"`,
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
