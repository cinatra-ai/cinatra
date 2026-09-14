/**
 * THE ASSISTANTS TAB OF A SCOPE BASE (cinatra#2808, per-scope surfaces S2).
 *
 * The issue's change item 3: "EXTEND the rows around the preserved Chat
 * button(s) with Settings (Skills-only page) and the installed-card fields."
 * So this suite asserts all three at once — the Chat control(s) still there and
 * scoped, the Settings href exactly as #2809 mints it, and the installed-card
 * fields (name, vendor, description, version, status) actually rendered.
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

  it("renders the installed-card fields: name, vendor, description, version, status", () => {
    const html = render();
    expect(html).toContain("Research Assistant");
    expect(html).toContain("Site Assistant");
    expect(html).toContain("Cinatra"); // the resolved vendor byline
    expect(html).toContain("Cited answers grounded in your own documents.");
    expect(html).toContain("v0.4.2");
    expect(html).toContain("v2.1.0");
    expect(html).toContain('data-status="active"');
    expect(html).toContain('data-status="locked"');
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
    const jumpOut = html.slice(html.indexOf('href="https://site.example/wp-admin"'));
    expect(jumpOut.slice(0, 200)).toContain('target="_blank"');
    expect(jumpOut.slice(0, 200)).toContain('rel="noreferrer noopener"');
  });
});
