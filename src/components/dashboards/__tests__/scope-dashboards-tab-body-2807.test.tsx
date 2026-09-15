// @vitest-environment jsdom
//
// cinatra#2807 fix leg 3 — the Dashboards tab BODY, held to the ratified
// drawing's Dashboards-tab section sentence by sentence.
//
// The third proof round graded the body absent or replaced on four of the five
// scopes. Every assertion below quotes the sentence it locks:
//
//   - "The dashboards in <b>Team: Growth</b>." — a muted 13px line naming the
//     ENTITY, drawn as `font-size:13px; color:var(--muted)` with the entity in
//     ink inside it. NOT a bold heading naming the scope kind.
//   - "On a personal scope the tab shows the acting user's own dashboards" —
//     drawn with the caption "The dashboards you own."
//   - "a personal user scope and the whole-workspace scope are not add-to-scope
//     targets — they carry no Add".
//   - "Add dashboard and every row's Remove appear only to a principal who may
//     write (manage) this scope's Dashboards collection … Suppression, not a
//     disabled control".
//   - "Each row carries a leading dashboard glyph, the dashboard name, the
//     updated time, and an Open affordance … no row repeats a Dashboards type
//     label … there is no Home or Listed badge."
//   - "The panel sits inside the tab body: no bespoke panel, and no page-wide
//     dashed frame" (the Application Design page's Workspace section).
//   - the empty reading: "No dashboards in this scope yet".
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { Button } from "@/components/ui/button";
import { ScopeDashboardsTab } from "@/components/dashboards/scope-dashboards-tab";
import type {
  ScopeDashboardsTabData,
  ScopeDashboardTabRow,
} from "@/components/dashboards/scope-dashboards-contract";

afterEach(cleanup);

const ROW: ScopeDashboardTabRow = {
  dashboardId: "d1",
  name: "Pipeline health — Q3",
  metaLine: "updated 20 minutes ago",
  relation: "home",
  canonicalHref: "/dashboards/d1",
  canRemove: false,
};

function data(over: Partial<ScopeDashboardsTabData> = {}): ScopeDashboardsTabData {
  return { scopeKind: "team", rows: [], canManage: false, ...over };
}

describe("the drawn caption", () => {
  it("names the ENTITY in a muted, non-bold 13px line — not a kind-named heading", () => {
    render(
      <ScopeDashboardsTab
        data={data()}
        caption={{ kind: "entity", entityLabel: "Team: Growth" }}
      />,
    );
    const caption = screen.getByTestId("scope-dashboards-caption");
    // The drawn treatment: 13px, the muted ink token, and NOT a heading.
    expect(caption.className).toContain("text-scope-caption");
    expect(caption.className).toContain("text-muted-foreground");
    expect(caption.className).not.toContain("font-semibold");
    expect(caption.tagName).toBe("P");
    expect(caption.textContent).toBe("The dashboards in Team: Growth.");
    // The entity itself is the ink half of that line.
    const entity = caption.querySelector("b");
    expect(entity?.textContent).toBe("Team: Growth");
    expect(entity?.className).toContain("text-foreground");
    // The kind-named heading the third round graded is gone.
    expect(document.querySelector("h2")).toBeNull();
    expect(caption.textContent).not.toContain("Dashboards in this team");
  });

  it("reads 'The dashboards you own.' on the personal scope", () => {
    render(<ScopeDashboardsTab data={data({ scopeKind: "personal" })} caption={{ kind: "own" }} />);
    expect(screen.getByTestId("scope-dashboards-caption").textContent).toBe(
      "The dashboards you own.",
    );
  });
});

describe("the Add affordance", () => {
  it("sits in the caption row where the drawing puts it", () => {
    render(
      <ScopeDashboardsTab
        data={data({ canManage: true })}
        caption={{ kind: "entity", entityLabel: "Team: Growth" }}
        add={<Button type="button">Add dashboard</Button>}
      />,
    );
    const caption = screen.getByTestId("scope-dashboards-caption");
    const add = screen.getByRole("button", { name: "Add dashboard" });
    expect(caption.parentElement).toBe(add.parentElement);
  });

  it("is ABSENT — never disabled — where the scope carries no Add", () => {
    render(<ScopeDashboardsTab data={data({ scopeKind: "personal" })} caption={{ kind: "own" }} />);
    expect(screen.queryByRole("button", { name: /add dashboard/i })).toBeNull();
    expect(document.querySelector("button[disabled]")).toBeNull();
  });
});

describe("the body's frame", () => {
  it("grows no page-wide dashed frame — only the empty panel is dashed", () => {
    const { container } = render(
      <ScopeDashboardsTab
        data={data()}
        caption={{ kind: "entity", entityLabel: "Workspace" }}
      />,
    );
    const dashed = container.querySelectorAll("[class*='border-dashed']");
    expect(dashed.length).toBe(1);
    expect(dashed[0]).toBe(screen.getByTestId("scope-dashboards-empty"));
    const section = container.querySelector("[data-conformance-id='scope-dashboards-tab']");
    expect(section?.className).not.toContain("border-dashed");
  });

  it("renders the drawn empty reading, and never the manager sentence where there is no manager", () => {
    render(<ScopeDashboardsTab data={data({ scopeKind: "workspace" })} caption={{ kind: "own" }} />);
    expect(screen.getByText("No dashboards in this scope yet")).toBeTruthy();
    expect(document.body.textContent).not.toContain("A manager can");
  });
});

describe("the ORGANIZATION scope draws the whole drawn body (fix leg 5)", () => {
  // The fourth proof round graded this cell at 11 of 16: the organization
  // landing drew no tab body at all. The landing's own wiring is fixed at the
  // screen (see the screens suite); this locks WHAT that body must read once it
  // renders — the drawing gives an organization the same body it gives a team,
  // with the entity named in the caption and the manager's Add in that row.
  it("names the organization in the caption, over the drawn empty reading, with the Add in the caption row", () => {
    render(
      <ScopeDashboardsTab
        data={data({ scopeKind: "organization", canManage: true })}
        caption={{ kind: "entity", entityLabel: "Organization: Acme Inc" }}
        add={<Button type="button">Add dashboard</Button>}
      />,
    );
    const caption = screen.getByTestId("scope-dashboards-caption");
    expect(caption.textContent).toBe(
      "The dashboards in Organization: Acme Inc.",
    );
    expect(caption.querySelector("b")?.textContent).toBe(
      "Organization: Acme Inc",
    );
    const add = screen.getByRole("button", { name: "Add dashboard" });
    expect(caption.parentElement).toBe(add.parentElement);
    const empty = screen.getByTestId("scope-dashboards-empty");
    expect(empty.className).toContain("border-dashed");
    expect(empty.textContent).toBe(
      "No dashboards in this scope yetA manager can Add an existing dashboard, or create one that homes here.",
    );
    // Leaf text below the tablist is exactly what the round found missing.
    expect(document.body.textContent).toContain(
      "No dashboards in this scope yet",
    );
  });
});

describe("the empty block, at the drawn type step and under the drawing's own suppression rule (fix leg 5)", () => {
  // The load-states drawing gives the empty panel two lines at two different
  // steps: the headline at `font-weight:600; font-size:12.5px; color:var(--ink)`
  // over the helper at `font-size:11px; color:var(--muted); line-height:1.5`.
  it("draws the headline one step over the helper, at the drawn sizes", () => {
    render(
      <ScopeDashboardsTab
        data={data({ scopeKind: "team" })}
        caption={{ kind: "entity", entityLabel: "Team: Growth" }}
      />,
    );
    const headline = screen.getByText("No dashboards in this scope yet");
    expect(headline.className).toContain("text-scope-empty-title");
    expect(headline.className).toContain("font-semibold");
    expect(headline.className).toContain("text-foreground");
    const helper = screen.getByText(/an existing dashboard, or create one/);
    expect(helper.className).toContain("text-scope-empty-help");
    expect(helper.className).not.toContain("font-semibold");
    expect(helper.className).toContain("text-muted-foreground");
    // The two steps are distinct — the round graded them equal.
    expect(headline.className).not.toContain("text-scope-empty-help");
    expect(helper.className).not.toContain("text-scope-empty-title");
  });

  // "a personal user scope and the whole-workspace scope are not add-to-scope
  // targets — they carry no Add, so add-to-scope is the three shared scopes
  // only", and §IX.2: "Suppression, not a disabled control: a management action
  // the member cannot take is not rendered." A helper sentence whose whole
  // subject is an Add this scope does not offer is that same unavailable action
  // in prose, so it is not rendered either — the headline stands alone.
  it.each(["personal", "workspace"] as const)(
    "on %s the headline stands ALONE inside the dashed container — no helper sentence at all",
    (scopeKind) => {
      render(
        <ScopeDashboardsTab
          data={data({ scopeKind })}
          caption={{ kind: "own" }}
        />,
      );
      const empty = screen.getByTestId("scope-dashboards-empty");
      expect(empty.textContent).toBe("No dashboards in this scope yet");
      expect(empty.querySelectorAll("p").length).toBe(1);
      expect(empty.className).toContain("border-dashed");
      // Neither the drawn manager sentence nor the invented substitute.
      expect(document.body.textContent).not.toContain("A manager can");
      expect(document.body.textContent).not.toContain(
        "Dashboards homed or listed here will appear on this tab.",
      );
    },
  );

  // On a scope that DOES offer an Add the drawing's one helper sentence is the
  // reading, verbatim — it is third-person prose about what a manager can do,
  // not a control, so it does not depend on this viewer's own authority.
  it.each(["team", "project", "organization"] as const)(
    "on %s the drawn manager sentence renders verbatim, even for a read-only member",
    (scopeKind) => {
      render(
        <ScopeDashboardsTab
          data={data({ scopeKind, canManage: false })}
          caption={{ kind: "entity", entityLabel: "Team: Growth" }}
        />,
      );
      const empty = screen.getByTestId("scope-dashboards-empty");
      expect(empty.textContent).toBe(
        "No dashboards in this scope yetA manager can Add an existing dashboard, or create one that homes here.",
      );
      expect(empty.textContent).not.toContain(
        "Dashboards homed or listed here will appear on this tab.",
      );
    },
  );
});

describe("row anatomy", () => {
  it("draws the glyph, the name, the updated time and Open — and no relation badge", () => {
    const { container } = render(
      <ScopeDashboardsTab
        data={data({ rows: [ROW] })}
        caption={{ kind: "entity", entityLabel: "Team: Growth" }}
      />,
    );
    expect(screen.getByText("Pipeline health — Q3")).toBeTruthy();
    expect(screen.getByText("updated 20 minutes ago")).toBeTruthy();
    const open = screen.getByRole("link", { name: "Open" });
    expect(open.getAttribute("href")).toBe("/dashboards/d1");
    // The tab POINTS: no dashboard is rendered inline, and no row advertises
    // where the dashboard lives.
    expect(container.textContent).not.toContain("Listed");
    expect(container.textContent).not.toContain("home:");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
