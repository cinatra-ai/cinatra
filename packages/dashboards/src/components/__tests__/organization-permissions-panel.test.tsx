// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// next/link needs no app-router context to render an anchor, but stub it to a
// bare anchor so this presentational test never reaches into Next internals.
// Built via `createElement` (not raw JSX `<a>`) to satisfy the shadcn-link
// lint rule in a test double.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => React.createElement("a", { href, ...rest }, children),
}));

import { OrganizationPermissionsPanel } from "../organization-permissions-panel";
import type { OrganizationAccessModel } from "../../screens/organization-detail-model";

afterEach(cleanup);

const MODEL: OrganizationAccessModel = {
  members: [
    { userId: "u_own", displayName: "Ann Owner", role: "owner" },
    { userId: "u_adm", displayName: "Al Admin", role: "admin" },
    { userId: "u_mem", displayName: "Zed Member", role: "member" },
  ],
  teams: [
    { id: "t1", name: "Platform" },
    { id: "t2", name: "Research" },
  ],
  memberCount: 3,
  teamCount: 2,
};

describe("OrganizationPermissionsPanel", () => {
  test("renders each member with a normalized role label", () => {
    render(<OrganizationPermissionsPanel orgName="Acme" accessModel={MODEL} />);
    expect(screen.getByText("Ann Owner")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("Al Admin")).toBeTruthy();
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByText("Zed Member")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
  });

  test("renders the org's teams", () => {
    render(<OrganizationPermissionsPanel orgName="Acme" accessModel={MODEL} />);
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
  });

  test("links to Workspace settings for membership management (no in-tab management)", () => {
    render(<OrganizationPermissionsPanel orgName="Acme" accessModel={MODEL} />);
    const link = screen.getByRole("link", { name: /workspace settings/i });
    expect(link.getAttribute("href")).toBe("/configuration/workspace");
  });

  test("shows NO customer-invite affordance (issue: no customer invite)", () => {
    render(<OrganizationPermissionsPanel orgName="Acme" accessModel={MODEL} />);
    // No invite / add-member / customer controls anywhere in the read-only tab.
    expect(screen.queryByRole("button", { name: /invite/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add member/i })).toBeNull();
    expect(screen.queryByText(/customer/i)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("renders empty states for an org with no teams", () => {
    render(
      <OrganizationPermissionsPanel
        orgName="Solo"
        accessModel={{ members: MODEL.members, teams: [], memberCount: 3, teamCount: 0 }}
      />,
    );
    expect(screen.getByText("No teams yet.")).toBeTruthy();
  });

  test("surfaces the member and team counts", () => {
    const { container } = render(
      <OrganizationPermissionsPanel orgName="Acme" accessModel={MODEL} />,
    );
    const panel = container.querySelector(
      '[data-cinatra-org-permissions="true"]',
    ) as HTMLElement;
    expect(within(panel).getByText("3")).toBeTruthy();
    expect(within(panel).getByText("2")).toBeTruthy();
  });
});
