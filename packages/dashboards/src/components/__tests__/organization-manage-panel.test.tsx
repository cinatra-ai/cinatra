// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Stub the interactive children (they pull authClient / toast / router) — this
// test asserts the PANEL's composition + the catalog-truth visibility split,
// not the child controls (covered by the actions + gate tests).
vi.mock("../organization-settings-form", () => ({
  OrganizationSettingsForm: (props: { organizationId: string }) => (
    <div data-testid="settings-form" data-org={props.organizationId} />
  ),
}));
vi.mock("../organization-members-manager", () => ({
  OrganizationMembersManager: (props: { organizationId: string }) => (
    <div data-testid="members-manager" data-org={props.organizationId} />
  ),
}));
vi.mock("../organization-delete-danger-form", () => ({
  OrganizationDeleteDangerForm: (props: { organizationId: string }) => (
    <div data-testid="delete-danger-form" data-org={props.organizationId} />
  ),
}));

import { OrganizationManagePanel } from "../organization-manage-panel";

afterEach(() => cleanup());

const NO_BLOCKERS = {
  teams: 0,
  activeProjects: 0,
  connectors: 0,
  dashboards: 0,
  agents: 0,
} as const;

const BASE = {
  organizationId: "org_1",
  orgName: "Acme",
  currentSlug: "acme",
  currentUserId: "user_1",
  canDelete: false,
  members: [],
  invitations: [],
} as const;

describe("OrganizationManagePanel — catalog-truth visibility split", () => {
  test("org_owner (settings + members): both the settings form AND the members manager render", () => {
    render(
      <OrganizationManagePanel {...BASE} canManageSettings canManageMembers />,
    );
    expect(screen.getByTestId("settings-form")).toBeTruthy();
    expect(screen.getByTestId("members-manager")).toBeTruthy();
    // Teams/projects are LINK-OUTS, not new CRUD.
    expect(screen.getByRole("link", { name: "Manage teams" }).getAttribute("href")).toBe("/teams");
    expect(screen.getByRole("link", { name: "Manage projects" }).getAttribute("href")).toBe(
      "/projects",
    );
  });

  test("org_admin (settings ONLY): settings form renders, members manager does NOT", () => {
    render(
      <OrganizationManagePanel {...BASE} canManageSettings canManageMembers={false} />,
    );
    expect(screen.getByTestId("settings-form")).toBeTruthy();
    expect(screen.queryByTestId("members-manager")).toBeNull();
  });

  test("no settings capability: the settings card does not render", () => {
    render(
      <OrganizationManagePanel {...BASE} canManageSettings={false} canManageMembers={false} />,
    );
    expect(screen.queryByTestId("settings-form")).toBeNull();
    expect(screen.queryByTestId("members-manager")).toBeNull();
  });

  test("canDelete + pre-counted blockers: the Danger zone renders (org_owner, structurally deletable)", () => {
    render(
      <OrganizationManagePanel
        {...BASE}
        canManageSettings
        canManageMembers
        canDelete
        deleteBlockers={NO_BLOCKERS}
      />,
    );
    expect(screen.getByTestId("delete-danger-form")).toBeTruthy();
  });

  test("no delete capability (structural block or lower role): NO Danger zone", () => {
    render(
      <OrganizationManagePanel {...BASE} canManageSettings canManageMembers />,
    );
    expect(screen.queryByTestId("delete-danger-form")).toBeNull();
  });

  test("canDelete without a readable pre-count: fail-closed — NO Danger zone", () => {
    render(
      <OrganizationManagePanel {...BASE} canManageSettings canManageMembers canDelete />,
    );
    expect(screen.queryByTestId("delete-danger-form")).toBeNull();
  });
});
