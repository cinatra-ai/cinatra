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

// Approved app-extensions §IV.1: the actual scope card withholds Run, while
// the side links and scoped targets keep the same behavior as a runnable card.
const AVAILABILITY_SCOPES: ScopeSurfaceRef[] = [
  { kind: "personal" }, { kind: "workspace" }, { kind: "organization", id: "org-a" },
  { kind: "team", id: "team-a" }, { kind: "project", id: "proj-a" },
];
const MISSING_DEPENDENCY = {
  state: "missing-required-dependency" as const,
  missing: [{ packageName: "@acme/list-skill", displayName: "List Curation Skill", kind: "skill", reason: "not-installed" as const }],
};

describe("#3960 dependency availability on actual scope cards", () => {
  for (const scope of AVAILABILITY_SCOPES) {
    for (const admin of [false, true]) {
      it(`${scope.kind}: ${admin ? "admin requirements" : "member unavailable"} replaces Run only on the blocked card`, () => {
        const rows = buildScopeSurfaceAgentRows(scope, FIXTURES, {
          availabilityByPackage: new Map([[FIXTURES[0].packageName, MISSING_DEPENDENCY]]),
          canViewRequirements: admin,
        });
        const cards = cardSegments(renderToStaticMarkup(<ScopeAgentsTab rows={rows} />));
        expect(cards).toHaveLength(2);
        const blocked = cards[0];
        expect(blocked).not.toContain(`href="${scopeSurfaceAgentLaunchHref(scope, FIXTURES[0].packageName)}"`);
        expect(blocked).not.toContain(">Run<");
        expect(blocked).not.toContain("lucide-play");
        expect(blocked).toContain('title="This agent cannot run: List Curation Skill is not installed."');
        expect(blocked).toContain(`href="${scopeSurfaceAgentSettingsHref(scope, FIXTURES[0].packageName)}"`);
        expect(blocked).toContain("More details");
        expect(rows[0].detailHref).toBeNull();
        const side = textLinks(blocked);
        expect(classOf(side.settings)).toBe(classOf(side.moreDetails));
        expect(side.between).toBe("");
        expect(blocked).not.toContain('data-slot="installed-status-indicator"');
        if (admin) {
          expect(blocked).toContain(">View requirements<");
          expect(blocked).toContain('href="/configuration/marketplace/acme/research-assistant"');
          expect(blocked).toContain('aria-label="Research Assistant cannot run — List Curation Skill not installed. View requirements"');
          expect(blocked).toContain('data-variant="outline"');
        } else {
          expect(blocked).toContain(">Unavailable<");
          expect(blocked).not.toContain("/configuration");
          expect(blocked).not.toContain(">View requirements<");
        }
        expect(cards[1]).toContain(`href="${scopeSurfaceAgentLaunchHref(scope, FIXTURES[1].packageName)}"`);
        expect(cards[1]).toContain(">Run<");
      });
    }
  }
  it("uses comma-separated product names, package fallback, and plural reason", () => {
    const rows = buildScopeSurfaceAgentRows(SCOPE, FIXTURES.slice(0, 1), {
      canViewRequirements: true,
      availabilityByPackage: new Map([[FIXTURES[0].packageName, {
        state: "missing-required-dependency",
        missing: [...MISSING_DEPENDENCY.missing, { packageName: "@acme/unnamed", displayName: null, kind: "connector", reason: "archived" }],
      }]]),
    });
    const html = renderToStaticMarkup(<ScopeAgentsTab rows={rows} />);
    expect(html).toContain('title="This agent cannot run: List Curation Skill, @acme/unnamed are not installed."');
    expect(html).toContain('aria-label="Research Assistant cannot run — List Curation Skill, @acme/unnamed not installed. View requirements"');
    expect(html).not.toContain(">Run<");
  });
  it("blank dependency display names use the package fallback on the actual card", () => {
    const rows = buildScopeSurfaceAgentRows(SCOPE, FIXTURES.slice(0, 1), {
      availabilityByPackage: new Map([[FIXTURES[0].packageName, { state: "missing-required-dependency", missing: [
        { ...MISSING_DEPENDENCY.missing[0], displayName: "" },
        { ...MISSING_DEPENDENCY.missing[0], packageName: "@acme/other-skill", displayName: "   " },
      ] }]]), canViewRequirements: true,
    });
    const html = renderToStaticMarkup(<ScopeAgentsTab rows={rows} />);
    expect(html).toContain('title="This agent cannot run: @acme/list-skill, @acme/other-skill are not installed."');
    expect(html).toContain('aria-label="Research Assistant cannot run — @acme/list-skill, @acme/other-skill not installed. View requirements"');
    expect(html).not.toContain(">Run<");
  });
  it("a legacy package with no marketplace route never receives an admin dead link", () => {
    const row = { ...FIXTURES[0], packageName: "legacy-agent" };
    const rows = buildScopeSurfaceAgentRows(SCOPE, [row], { canViewRequirements: true, availabilityByPackage: new Map([[row.packageName, MISSING_DEPENDENCY]]) });
    const html = renderToStaticMarkup(<ScopeAgentsTab rows={rows} />);
    expect(html).toContain(">Unavailable<");
    expect(html).not.toContain("/configuration");
    expect(html).not.toContain(">Run<");
  });
  it("does not list a package proven archived or not installed", () => {
    const rows = buildScopeSurfaceAgentRows(SCOPE, FIXTURES, { availabilityByPackage: new Map([
      [FIXTURES[0].packageName, { state: "archived" }],
      [FIXTURES[1].packageName, { state: "not-installed", displayName: "Media Transcript Agent" }],
    ]) });
    expect(rows).toEqual([]);
    expect(renderToStaticMarkup(<ScopeAgentsTab rows={rows} />)).not.toContain('data-slot="installed-extension-card"');
  });
  it("a fresh runnable verdict restores the original scoped Run and side links", () => {
    const blocked = buildScopeSurfaceAgentRows(SCOPE, FIXTURES, { availabilityByPackage: new Map([[FIXTURES[0].packageName, MISSING_DEPENDENCY]]) });
    expect(renderToStaticMarkup(<ScopeAgentsTab rows={blocked} />)).toContain(">Unavailable<");
    const restored = buildScopeSurfaceAgentRows(SCOPE, FIXTURES, { availabilityByPackage: new Map([[FIXTURES[0].packageName, { state: "runnable" }]]) });
    expect(renderToStaticMarkup(<ScopeAgentsTab rows={restored} />)).toBe(render());
  });
});
