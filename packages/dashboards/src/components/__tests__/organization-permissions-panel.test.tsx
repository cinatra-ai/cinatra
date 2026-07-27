// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

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
    render(
      <OrganizationPermissionsPanel
        orgName="Acme"
        accessModel={MODEL}
        viewerCanManageMembers={false}
      />,
    );
    expect(screen.getByText("Ann Owner")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("Al Admin")).toBeTruthy();
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByText("Zed Member")).toBeTruthy();
    expect(screen.getByText("Member")).toBeTruthy();
  });

  test("renders the org's teams", () => {
    render(
      <OrganizationPermissionsPanel
        orgName="Acme"
        accessModel={MODEL}
        viewerCanManageMembers={false}
      />,
    );
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
  });

  test("manager copy points at the Members & invitations card below — no workspace-settings link (cinatra#1510)", () => {
    render(
      <OrganizationPermissionsPanel
        orgName="Acme"
        accessModel={MODEL}
        viewerCanManageMembers={true}
      />,
    );
    expect(screen.getByText("Members & invitations")).toBeTruthy();
    expect(screen.getByText(/card below/)).toBeTruthy();
    // The old copy sent every viewer to the platform-admin-gated
    // /configuration/workspace — a dead end for org members. Gone entirely:
    // the read-only panel carries NO links at all.
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/workspace settings/i)).toBeNull();
  });

  test("non-manager copy names the owning role instead of dead-end instructions (cinatra#1510 AC: explanatory copy for viewers)", () => {
    render(
      <OrganizationPermissionsPanel
        orgName="Acme"
        accessModel={MODEL}
        viewerCanManageMembers={false}
      />,
    );
    expect(
      screen.getByText(/managed by this organization's owners/),
    ).toBeTruthy();
    // No pointer to a management card the viewer cannot see…
    expect(screen.queryByText(/card below/)).toBeNull();
    // …and no link anywhere (the workspace-settings dead end stays gone).
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/workspace settings/i)).toBeNull();
  });

  test("shows NO management controls in either branch (read-only panel)", () => {
    render(
      <OrganizationPermissionsPanel
        orgName="Acme"
        accessModel={MODEL}
        viewerCanManageMembers={true}
      />,
    );
    // Even for a manager the panel stays a pure read: the pointer copy is
    // text-only — no invite / add-member / customer controls, no inputs.
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
        viewerCanManageMembers={false}
      />,
    );
    expect(screen.getByText("No teams yet.")).toBeTruthy();
  });

  test("surfaces the member and team counts", () => {
    const { container } = render(
      <OrganizationPermissionsPanel
        orgName="Acme"
        accessModel={MODEL}
        viewerCanManageMembers={false}
      />,
    );
    const panel = container.querySelector(
      '[data-cinatra-org-permissions="true"]',
    ) as HTMLElement;
    expect(within(panel).getByText("3")).toBeTruthy();
    expect(within(panel).getByText("2")).toBeTruthy();
  });
});
