/**
 * THE ASSISTANTS TAB OF A SCOPE BASE (cinatra#2808, per-scope surfaces S2).
 *
 * The issue's change item 3: "EXTEND the rows around the preserved Chat
 * button(s) with Settings (Skills-only page) and the installed-card fields."
 *
 * design#156 (specs/app-extensions.html §IV) settles the right panel: "The
 * assistant row of the Assistants tab carries the same right panel with Chat as
 * its primary action and the same two text links, the Settings link opening the
 * assistant's assignment page of §VII ... with the Skills pane alone" — on the
 * §IV card, which is the installed card minus the version/status row. So this
 * suite asserts all of it at once: the Chat control(s) still there and scoped,
 * the Settings href exactly as #2809 mints it and drawn as a text link beside
 * More details, the remaining installed-card fields rendered, and the version
 * and status absent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: async () => ({ status: "error", message: "stub" }),
}));

import { ScopeAssistantsTab } from "@/components/scope-surfaces/scope-assistants-tab";
import { buildScopeSurfaceAssistantRows } from "@/lib/scope-surface-rows";
import type { ScopeSurfaceEligibilityRow } from "@/lib/scope-surface-eligibility";
import {
  scopeSurfaceAssistantLaunchHref,
  scopeSurfaceAssistantSettingsHref,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const SCOPE: ScopeSurfaceRef = { kind: "organization", id: "org-a" };

const DIRECTORY = [
  {
    packageName: "@acme/research-assistant",
    vendor: "acme",
    slug: "research-assistant",
    displayName: "Research Assistant",
    remoteCapable: false,
    remoteInstances: [],
  },
  {
    packageName: "@acme/site-assistant",
    vendor: "acme",
    slug: "site-assistant",
    displayName: "Site Assistant",
    remoteCapable: true,
    remoteInstances: [
      { instanceId: "site-1", name: "Marketing site", remoteHref: "https://site.example/wp-admin" },
    ],
  },
];

const ELIGIBLE: ScopeSurfaceEligibilityRow[] = [
  {
    packageName: "@acme/research-assistant",
    displayName: "Research Assistant",
    description: "Cited answers grounded in your own documents.",
    version: "0.4.2",
    status: "active",
    installId: "install-research",
    executionOrgIds: ["org-a"],
  },
  {
    packageName: "@acme/site-assistant",
    displayName: "Site Assistant",
    description: "Answers on your connected site.",
    version: "2.1.0",
    status: "locked",
    installId: "install-site",
    executionOrgIds: ["org-a"],
  },
];

/**
 * The two text links of one row: the Settings tag, the More-details tag, and
 * whatever sits BETWEEN them — which "side by side" leaves empty.
 */
function textLinks(html: string) {
  const sMark = html.indexOf('data-slot="scope-assistant-settings"');
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

function rowSegments(html: string): string[] {
  return html.split('data-slot="installed-extension-card"').slice(1);
}

function render(scope: ScopeSurfaceRef = SCOPE) {
  return renderToStaticMarkup(
    <ScopeAssistantsTab rows={buildScopeSurfaceAssistantRows(scope, DIRECTORY, ELIGIBLE)} />,
  );
}

describe("ScopeAssistantsTab", () => {
  it("PRESERVES the single Chat control of a local assistant, scoped by #2809", () => {
    const html = render();
    expect(html).toContain(
      `href="${scopeSurfaceAssistantLaunchHref(SCOPE, {
        vendor: "acme",
        slug: "research-assistant",
      })}"`,
    );
    expect(html).toContain(">Chat<");
  });

  it("PRESERVES the Chat-locally / Remote-chat pair of a remote-capable assistant", () => {
    const html = render();
    expect(html).toContain(
      `href="${scopeSurfaceAssistantLaunchHref(SCOPE, {
        vendor: "acme",
        slug: "site-assistant",
        instance: "site-1",
      })}"`,
    );
    expect(html).toContain(">Chat locally<");
    expect(html).toContain(">Remote chat<");
    // The jump-out addresses the site itself — no scope owns it.
    expect(html).toContain('href="https://site.example/wp-admin"');
  });

  it("carries each row's OWN Settings href — the exact #2809 address", () => {
    const html = render();
    for (const row of DIRECTORY) {
      expect(html).toContain(
        `href="${scopeSurfaceAssistantSettingsHref(SCOPE, {
          vendor: row.vendor,
          slug: row.slug,
        })}"`,
      );
    }
    expect(html).toContain(">Settings<");
  });

  it("draws Settings as a TEXT LINK in the same treatment as More details, to its LEFT", () => {
    const rows = rowSegments(render());
    // …and this loop reads EVERY row, so a card marker that stopped matching
    // cannot let the case pass with nothing asserted.
    expect(rows).toHaveLength(DIRECTORY.length);
    for (const row of rows) {
      const { settings, moreDetails, between, wrapper } = textLinks(row);
      expect(settings.startsWith("<a")).toBe(true);
      expect(classOf(settings)).not.toBe("");
      expect(classOf(settings)).toBe(classOf(moreDetails));
      expect(between).toBe("");
      expect(row.indexOf(">Settings<")).toBeLessThan(row.indexOf("More details"));
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
      expect(row.slice(row.indexOf(settings), row.indexOf(">Settings<"))).not.toContain("<svg");
    }
  });

  it("renders the installed-card fields the §IV card keeps: name, vendor, description", () => {
    const html = render();
    expect(html).toContain("Research Assistant");
    expect(html).toContain("Site Assistant");
    expect(html).toContain("Cinatra"); // the resolved vendor byline
    expect(html).toContain("Cited answers grounded in your own documents.");
  });

  it("renders NO version and NO Active / Archived indicator", () => {
    const html = render();
    expect(html).not.toContain("v0.4.2");
    expect(html).not.toContain("v2.1.0");
    expect(html).not.toContain('data-slot="installed-status-indicator"');
    expect(html).not.toContain('data-status="active"');
    expect(html).not.toContain('data-status="locked"');
  });

  it("re-addresses every in-app control when the scope changes", () => {
    const project: ScopeSurfaceRef = { kind: "project", id: "proj-1" };
    const html = render(project);
    expect(html).toContain(
      `href="${scopeSurfaceAssistantLaunchHref(project, {
        vendor: "acme",
        slug: "research-assistant",
      })}"`,
    );
    expect(html).not.toContain('href="/organizations/org-a/assistants/acme/research-assistant"');
  });

  it("offers a member NO link into the admin-only marketplace route", () => {
    expect(render()).not.toContain("/configuration");
  });

  // ── PRESERVED, NOT RESTATED (convergence round, cinatra#2808) ─────────────
  // The directory these rows come from gates the in-app Chat on `remoteCapable`
  // and states "No connected sites you can access yet." for a remote-capable
  // assistant with no site this reader may use. Preserving the control means
  // preserving THAT reading too — an in-app Chat for an assistant with no site
  // to run on would be a launch into nothing.
  it("states the no-connected-site truth instead of offering Chat, for a remote assistant with no site", () => {
    const directory = [
      {
        packageName: "@acme/site-assistant",
        vendor: "acme",
        slug: "site-assistant",
        displayName: "Site Assistant",
        remoteCapable: true,
        remoteInstances: [],
      },
    ];
    const html = renderToStaticMarkup(
      <ScopeAssistantsTab rows={buildScopeSurfaceAssistantRows(SCOPE, directory, ELIGIBLE)} />,
    );
    expect(html).toContain("No connected sites you can access yet.");
    expect(html).not.toContain(">Chat<");
    expect(html).not.toContain(">Chat locally<");
  });

  it("names each connected site and keeps the jump-out a new-tab, noreferrer link", () => {
    const html = render();
    expect(html).toContain("Marketing site");
    // The whole opening tag of the jump-out, matched by its href: the link is
    // the shadcn pattern the design-system boundary names, and that renderer
    // writes `href` LAST, so a forward slice from the href reads the children
    // rather than the attributes. The coverage is unchanged - the jump-out is
    // still a new-tab, noreferrer link - only its reading is order-independent.
    const jumpOut = html.match(/<a[^>]*href="https:\/\/site\.example\/wp-admin"[^>]*>/)?.[0];
    expect(jumpOut).toBeDefined();
    expect(jumpOut!).toContain('target="_blank"');
    expect(jumpOut!).toContain('rel="noreferrer noopener"');
  });
});
