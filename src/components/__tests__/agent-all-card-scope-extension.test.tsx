/**
 * THE AGENT CARD'S RIGHT PANEL, AS THE DRAWING GIVES IT (cinatra#2808 fix leg).
 *
 * design#156, specs/app-extensions.html §IV: "The right panel drops to a single
 * primary action, Run, plus Settings (the §VII assignment page at the card's
 * scope) and More details (the §II detail modal). The two text links sit side by
 * side in the same treatment, Settings to the left; the Settings link carries
 * the address §VII gives it ... at the card's scope." The card is the §III
 * Installed-extensions card "but without the version and the Active / Archived
 * indicator".
 *
 * So all four of those are read off the markup here, directly on the card, with
 * no scope-surface row builder in between:
 *
 *   • Settings is a TEXT LINK — a real anchor at the row's href, in the same
 *     class and style as More details, and immediately to its LEFT;
 *   • the card renders no version and no status indicator;
 *   • a row that passes no `settingsHref` (the /agents "All Agents" tab) still
 *     renders exactly Run plus More details.
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

/** The /agents row as that page builds it today — no Settings href at all. */
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

/** A per-scope Agents-tab row: the same card, with the §VII assignment page. */
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
};

/**
 * The two text links as the markup actually carries them: the Settings tag, the
 * More-details tag, and whatever sits BETWEEN them — which the drawing's "side
 * by side" leaves empty (they are siblings of one row, nothing in between).
 */
function textLinks(html: string, settingsMark: string) {
  const sMark = html.indexOf(settingsMark);
  expect(sMark, `no ${settingsMark} in the markup`).toBeGreaterThan(-1);
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

describe("AgentAllCard — Run plus the two text links", () => {
  it("renders Settings as a text link at the href the row carries", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={SCOPE_TAB_ROW} />);
    const { settings } = textLinks(html, 'data-slot="agent-card-settings"');
    // A real anchor, not a button, and no gear glyph beside the word.
    expect(settings.startsWith("<a")).toBe(true);
    expect(settings).toContain('href="/teams/team-1/agents/acme/research-assistant/settings"');
    expect(html).toContain(">Settings<");
    expect(html.slice(html.indexOf(settings), html.indexOf(">Settings<"))).not.toContain("<svg");
  });

  it("gives Settings the SAME class and style as More details", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={SCOPE_TAB_ROW} />);
    const { settings, moreDetails } = textLinks(html, 'data-slot="agent-card-settings"');
    expect(classOf(settings)).not.toBe("");
    expect(classOf(settings)).toBe(classOf(moreDetails));
  });

  it("puts Settings side by side with More details, and to its LEFT", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={SCOPE_TAB_ROW} />);
    const { wrapper, between } = textLinks(html, 'data-slot="agent-card-settings"');
    expect(html.indexOf(">Settings<")).toBeLessThan(html.indexOf("More details"));
    expect(between).toBe("");
    // A ROW, not a column: "side by side" is the WRAPPER's own layout, so a
    // flex-col wrapper — which keeps source order and adjacency intact while
    // stacking the two links — fails here.
    expect(classOf(wrapper)).toContain("flex");
    expect(classOf(wrapper)).toContain("items-center");
    expect(classOf(wrapper)).not.toContain("flex-col");
    // …and a ROW that is not REVERSED: flex-row-reverse would keep source order
    // and adjacency while drawing Settings to the RIGHT of More details.
    expect(classOf(wrapper)).not.toContain("flex-row-reverse");
  });

  it("carries NO version and NO status indicator, even from a row that holds them", () => {
    // The two fields are off the card for good (design#156), so a row still
    // carrying them — the shape this branch shipped before the fix — renders
    // neither. Cast, because the type no longer admits them.
    const html = renderToStaticMarkup(
      <AgentAllCard
        row={{ ...SCOPE_TAB_ROW, version: "v0.4.2", status: "locked" } as unknown as AgentAllCardRow}
      />,
    );
    expect(html).not.toContain("v0.4.2");
    expect(html).not.toContain('data-slot="installed-status-indicator"');
    expect(html).not.toContain(">Locked<");
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

  it("THE /agents CARD IS UNTOUCHED: a row passing no Settings href renders none", () => {
    const html = renderToStaticMarkup(<AgentAllCard row={AGENTS_PAGE_ROW} />);
    expect(html).not.toContain(">Settings<");
    expect(html).not.toContain('data-slot="agent-card-settings"');
    expect(html).not.toContain('data-slot="installed-status-indicator"');
    // … and it still carries exactly Run plus More details.
    expect(html).toContain(">Run<");
    expect(html).toContain("More details");
  });
});
