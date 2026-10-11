// @vitest-environment jsdom
//
// cinatra#2811 (per-scope surfaces S5): the workspace Dashboards tab, held to
// the amended drawing's sentences (§IX, §IX.1, §IX.3, §IX.4):
//
//   - "its Dashboards tab behaves exactly like the other scopes' Dashboards tab
//     (§IX.3): the same per-user dashboard shell with its non-removable Overview
//     default, and the same single Add dashboard popup, whose Reference a
//     dashboard from the scopes below section is how a lower-scope dashboard is
//     brought up to the workspace";
//   - "Each row carries a leading dashboard glyph, the dashboard name, the
//     updated time, and an Open affordance ... The single place the home /
//     listing difference shows is the Remove control";
//   - "The control is a platform administrator's alone. For every other
//     principal it is drawn muted and disabled with the reason named";
//   - "Unsetting the mark, or removing the link, revokes it".
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: () => {} }),
}));

import { ScopeCatalogSection } from "@/components/dashboards/scope-catalog-section";
import { ScopeDashboardsTab } from "@/components/dashboards/scope-dashboards-tab";
import { WorkspaceAddDashboardButton } from "@/components/dashboards/workspace-add-dashboard-button";
import { WORKSPACE_CATALOG_WORDS } from "@/lib/dashboards/installed-catalog-contract";
import type {
  ScopeDashboardTabRow,
  ScopeReferenceSource,
} from "@/components/dashboards/scope-dashboards-contract";

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

const OVERVIEW: ScopeDashboardTabRow = {
  dashboardId: "w-ov",
  name: "Overview",
  metaLine: "updated 5 minutes ago",
  relation: "home",
  canonicalHref: "/workspace/dashboards/w-ov",
  canRemove: false,
};
const PIPELINE: ScopeDashboardTabRow = {
  dashboardId: "d-pipe",
  name: "Pipeline health",
  metaLine: "updated 20 minutes ago",
  relation: "listed",
  canonicalHref: "/organizations/o1/dashboards/d-pipe",
  canRemove: true,
  everyone: { granted: false, canSet: false },
};
const REVENUE: ScopeDashboardTabRow = {
  dashboardId: "d-rev",
  name: "Revenue attribution",
  metaLine: "updated 2 hours ago",
  relation: "listed",
  canonicalHref: "/teams/t1/dashboards/d-rev",
  canRemove: true,
  everyone: { granted: true, canSet: false },
};

const REASON = "Only a platform administrator can set or unset who a reference is visible to.";

function renderTab(rows: ScopeDashboardTabRow[], opts: { setGrant?: (id: string, g: boolean) => Promise<{ ok: true }> } = {}) {
  return render(
    <ScopeDashboardsTab
      data={{ scopeKind: "workspace", rows, canManage: true }}
      removal={{ removeListing: async () => ({ ok: true }) }}
      everyoneGrant={opts.setGrant ? { setGrant: opts.setGrant } : undefined}
      caption={{ kind: "workspace" }}
    />,
  );
}

function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest("li") as HTMLElement;
}

describe("the rows", () => {
  it("draws the Overview first with Open and no Remove, and a reference with Remove", () => {
    renderTab([OVERVIEW, PIPELINE]);
    const items = document.querySelectorAll("li");
    expect(items[0].textContent).toContain("Overview");
    const overview = rowFor("Overview");
    expect(within(overview).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(overview).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      "/workspace/dashboards/w-ov",
    );
    expect(within(rowFor("Pipeline health")).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("carries no Home or Listed badge and no everyone mark on a dashboard homed here", () => {
    renderTab([OVERVIEW]);
    expect(document.body.textContent).not.toMatch(/\bHome\b|\bListed\b/);
    expect(document.body.textContent).not.toContain("Visible to everyone");
  });
});

describe("the everyone mark (§IX.4)", () => {
  it("shows a member the mark on a granted reference, with the control muted, disabled and its reason named", () => {
    renderTab([REVENUE]);
    const row = rowFor("Revenue attribution");
    expect(within(row).getAllByText("Visible to everyone").length).toBeGreaterThan(0);
    const control = within(row).getByRole("switch");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(row.textContent).toContain(REASON);
  });

  it("draws nothing for a member on an ungranted reference", () => {
    renderTab([PIPELINE]);
    const row = rowFor("Pipeline health");
    expect(within(row).queryByRole("switch")).toBeNull();
    expect(row.textContent).not.toContain("Visible to everyone");
  });

  it("gives a platform administrator a working control that sets and unsets the grant", async () => {
    const setGrant = vi.fn(async () => ({ ok: true as const }));
    renderTab(
      [
        { ...PIPELINE, everyone: { granted: false, canSet: true } },
        { ...REVENUE, everyone: { granted: true, canSet: true } },
      ],
      { setGrant },
    );
    const off = within(rowFor("Pipeline health")).getByRole("switch");
    expect(off.hasAttribute("disabled")).toBe(false);
    expect(off.getAttribute("aria-checked")).toBe("false");
    expect(off.getAttribute("data-action")).toBe("everyone-grant-set -> everyone-grant-set");
    fireEvent.click(off);
    await waitFor(() => expect(setGrant).toHaveBeenCalledWith("d-pipe", true));
    const on = within(rowFor("Revenue attribution")).getByRole("switch");
    expect(on.getAttribute("data-action")).toBe("everyone-grant-revoke -> everyone-grant-revoked");
    fireEvent.click(on);
    await waitFor(() => expect(setGrant).toHaveBeenCalledWith("d-rev", false));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("the Add dashboard popup on the workspace", () => {
  const reference: ScopeReferenceSource = {
    listCandidates: async () => [
      { dashboardId: "a-team", name: "Support load", homeNote: "homed in Team: Support", disposition: "addable" },
    ],
    addListing: async () => ({ ok: true }),
    requestPromotion: async () => ({ ok: false, reason: "invalid" }),
  };

  it("offers every viewer Add dashboard, with Create new, and the reference section only to a curator", async () => {
    const create = vi.fn(async () => ({ ok: true as const, dashboard: { id: "w-new", name: "Mine", isDefault: false, canWrite: true } }));
    const { unmount } = render(<WorkspaceAddDashboardButton createDashboard={create} reference={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
    expect(await screen.findByText("Create new")).toBeTruthy();
    expect(screen.queryByText(/Reference/)).toBeNull();
    unmount();

    render(<WorkspaceAddDashboardButton createDashboard={create} reference={reference} />);
    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
    expect(await screen.findByText("Create new")).toBeTruthy();
    expect(await screen.findByText("Support load")).toBeTruthy();
    expect(screen.getByText("homed in Team: Support")).toBeTruthy();
  });

  it("creates a dashboard that homes in the workspace, through the name prompt", async () => {
    const create = vi.fn(async () => ({ ok: true as const, dashboard: { id: "w-new", name: "Mine", isDefault: false, canWrite: true } }));
    render(<WorkspaceAddDashboardButton createDashboard={create} reference={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Create/ }));
    const field = await screen.findByRole("textbox");
    fireEvent.change(field, { target: { value: "Mine" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    await waitFor(() => expect(create).toHaveBeenCalledWith("Mine"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// The amended drawing's own words, on the four workspace surfaces
// (workspace-dashboards-landing, workspace-dashboards-add-popup,
// workspace-dashboards-everyone-grant, workspace-dashboards-viewer-reading).
//
// Each string below is the drawing's, transcribed. The one glyph that differs is
// the apostrophe: the drawing is raw HTML and carries a straight one, while every
// sibling string in these components carries the typographic one, so the word is
// the drawing's and the glyph is the house form.
// ---------------------------------------------------------------------------

const DRAWN = {
  landingCaption:
    "Your dashboards in the whole workspace — and the ones referenced up from the scopes below.",
  popupTitle: "Add dashboard",
  opening:
    "One popup, three sections. A reference lists an existing dashboard here as a link — its canonical home does not move, and nobody gains access by the listing alone.",
  sections: [
    "Create new",
    "Reference a dashboard from the scopes below",
    "Add from the installed catalog",
  ],
  createHelper: "Homes in the workspace.",
  createButton: "Create",
  nameField: "Dashboard name",
  referenceRowNote: "homed in Team: Support",
  referenceButton: "Reference",
  referenceHelper:
    "The link never widens access. A member reads the entry only when they already pass the target’s home access, or a platform administrator marks it visible to everyone (§IX.4).",
  catalogRowNote: "@cinatra-ai/adoption-artifact:dashboard",
  catalogButton: "Add",
  catalogHelper:
    "A catalog dashboard homes in the workspace, exactly as a created one does.",
} as const;

const WORKSPACE_REFERENCE: ScopeReferenceSource = {
  listCandidates: async () => [
    {
      dashboardId: "a-team",
      name: "Support load — weekly",
      homeNote: DRAWN.referenceRowNote,
      disposition: "addable",
    },
  ],
  addListing: async () => ({ ok: true }),
  requestPromotion: async () => ({ ok: false, reason: "invalid" }),
};

const CATALOG_TEMPLATES = [
  {
    templateId: "t-adopt",
    name: "Adoption overview",
    packageName: "@cinatra-ai/adoption-artifact",
  },
] as const;

/** The workspace's catalog section, exactly as the page hands it down. */
function workspaceCatalogNode() {
  return (
    <ScopeCatalogSection
      templates={CATALOG_TEMPLATES}
      source={{ add: async () => ({ ok: true, dashboard: { id: "d", name: "Adoption overview", isDefault: false, canWrite: true } }) }}
      words={WORKSPACE_CATALOG_WORDS}
    />
  );
}

function openWorkspacePopup() {
  render(
    <WorkspaceAddDashboardButton
      createDashboard={async () => ({ ok: true, dashboard: { id: "w-new", name: "Mine", isDefault: false, canWrite: true } })}
      reference={WORKSPACE_REFERENCE}
      catalog={workspaceCatalogNode()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Add dashboard/ }));
}

/** Collapse the DOM's own whitespace so a sentence assembled from several spans
 *  is compared as the sentence a reader reads. */
const said = (el: Element | null) =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the landing caption (workspace-dashboards-landing)", () => {
  it("reads the drawn sentence, not the tenant tabs' pattern", () => {
    renderTab([OVERVIEW]);
    expect(said(screen.getByTestId("scope-dashboards-caption"))).toBe(
      DRAWN.landingCaption,
    );
  });
});

describe("the Add dashboard popup (workspace-dashboards-add-popup)", () => {
  it("is titled and opened with the drawn lines", async () => {
    openWorkspacePopup();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe(
      DRAWN.popupTitle,
    );
    expect(said(dialog)).toContain(DRAWN.opening);
  });

  it("carries the three drawn sections, in the drawn order, each findable by its drawn name", async () => {
    openWorkspacePopup();
    const dialog = await screen.findByRole("dialog");
    const sections = dialog.querySelector('[data-slot="add-dashboard-sections"]');
    expect(sections).not.toBeNull();
    // The sections themselves, in DOM order, not every labelled node inside
    // them: the picker's search field carries a label of its own.
    const named = [...sections!.querySelectorAll(":scope > [aria-label]")].map(
      (s) => s.getAttribute("aria-label"),
    );
    expect(named).toEqual([...DRAWN.sections]);
  });

  it("Create new: the drawn helper, the drawn button, and the drawn field in the prompt", async () => {
    openWorkspacePopup();
    const create = await screen.findByRole("region", { name: DRAWN.sections[0] });
    expect(said(create)).toContain(DRAWN.createHelper);
    const button = within(create).getByRole("button");
    expect(button.textContent).toBe(DRAWN.createButton);
    fireEvent.click(button);
    expect(await screen.findByLabelText(DRAWN.nameField)).toBeTruthy();
  });

  it("Reference a dashboard from the scopes below: the row's home, the Reference control, the drawn helper", async () => {
    openWorkspacePopup();
    const section = await screen.findByRole("region", { name: DRAWN.sections[1] });
    expect(await within(section).findByText(DRAWN.referenceRowNote)).toBeTruthy();
    expect(
      within(section).getByRole("button", { name: DRAWN.referenceButton }),
    ).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "Add" })).toBeNull();
    expect(said(section)).toContain(DRAWN.referenceHelper);
  });

  it("Add from the installed catalog: the package and its kind, the Add control, the drawn helper", async () => {
    openWorkspacePopup();
    const section = await screen.findByRole("region", { name: DRAWN.sections[2] });
    expect(within(section).getByText(DRAWN.catalogRowNote)).toBeTruthy();
    expect(
      within(section).getByRole("button", { name: DRAWN.catalogButton }),
    ).toBeTruthy();
    expect(said(section)).toContain(DRAWN.catalogHelper);
  });

  it("says nothing the tenant tabs say in its place", async () => {
    openWorkspacePopup();
    const dialog = await screen.findByRole("dialog");
    const text = said(dialog);
    expect(text).not.toContain("Add a dashboard to Workspace");
    expect(text).not.toContain("Reference an existing dashboard");
    expect(text).not.toContain("From the installed catalog’");
    expect(text).not.toContain(
      "Dashboards that installed extensions have added to this workspace.",
    );
  });
});
