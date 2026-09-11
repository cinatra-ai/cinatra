// @vitest-environment jsdom
//
// cinatra#2807 fix leg 3, convergence round — the REAL Add affordance, mounted.
//
// The body suite pins where an Add SLOT sits in the caption row by passing an
// arbitrary button into it. That says nothing about the control the landings
// actually mount, so this suite mounts `ScopeAddDashboardButton` itself inside
// `ScopeAddSourcesProvider` and holds it to two things:
//
//   - "Add dashboard and every row's Remove appear only to a principal who may
//     write (manage) this scope's Dashboards collection … Suppression, not a
//     disabled control" — no reference source means NOTHING is rendered, not a
//     disabled button.
//   - The drawn Add is an ADD-TO-SCOPE action, and this tab renders the SCOPE's
//     collection. The create path and the installed-catalog copy both write a row
//     owned by the acting USER, which the scope home read (`owner_level=<kind>`
//     AND `owner_id=<scope id>`, or `project_id` on a project) never returns — so
//     a copy made through them would report success and then appear nowhere on
//     this tab. Neither is offered from here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { ScopeAddDashboardButton } from "@/components/dashboards/scope-add-dashboard-button";
import { ScopeAddSourcesProvider } from "@/components/dashboards/scope-add-sources";
import type { ScopeReferenceSource } from "@/components/dashboards/scope-dashboards-contract";

afterEach(cleanup);

const reference: ScopeReferenceSource = {
  listCandidates: async () => [],
  addListing: async () => ({ ok: true }),
  requestPromotion: async () => ({ ok: true }),
} as unknown as ScopeReferenceSource;

function mount(source: ScopeReferenceSource | null) {
  return render(
    <ScopeAddSourcesProvider scopeLabel="Team: Growth" reference={source}>
      <ScopeAddDashboardButton />
    </ScopeAddSourcesProvider>,
  );
}

describe("the mounted Add affordance", () => {
  it("renders nothing at all — never a disabled control — for a non-manager", () => {
    const { container } = mount(null);
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders the drawn Add for a manager", () => {
    mount(reference);
    expect(screen.getByRole("button", { name: /add dashboard/i })).toBeTruthy();
  });

  it("offers ONLY the add-to-scope picker — no create, no installed catalog", () => {
    mount(reference);
    fireEvent.click(screen.getByRole("button", { name: /add dashboard/i }));
    expect(screen.getByText(/Add a dashboard to Team: Growth/)).toBeTruthy();
    // Both write a user-owned row this tab's scope read never returns.
    expect(screen.queryByRole("button", { name: /create new/i })).toBeNull();
    expect(document.body.textContent).not.toContain("Create new");
    expect(document.body.textContent).not.toContain("installed catalog");
  });
});

// SOURCE locks: the rendered suite above proves the popup as MOUNTED, but the
// landings are server components, so what they WIRE is pinned here.
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("no landing wires a path that writes outside this tab's collection", () => {
  it("the Add control offers neither create nor the installed catalog", () => {
    const src = read("src/components/dashboards/scope-add-dashboard-button.tsx");
    expect(src).toContain("canCreate={false}");
    expect(src).toContain("catalog={null}");
    expect(src).not.toContain("EntityDashboardNameDialog");
    expect(src).not.toContain("sources.create");
  });

  it("the add-sources seam carries no create source to carry", () => {
    const src = read("src/components/dashboards/scope-add-sources.tsx");
    expect(src).not.toContain("ScopeCreateSource");
    expect(src).not.toContain("createDashboard");
  });

  it.each([
    ["organization", "packages/dashboards/src/screens/organization-detail-dashboard.tsx"],
    ["team", "packages/dashboards/src/screens/team-detail-dashboard.tsx"],
    ["project", "src/app/projects/[projectId]/page.tsx"],
  ])("the %s landing binds no create action into the popup", (_kind, path) => {
    const src = read(path);
    expect(src).not.toContain("create={create}");
    expect(src).not.toContain("createDashboard:");
    expect(src).not.toMatch(/create(Organization|Entity)DashboardAction|teamCreateDashboardAction/);
  });
});
