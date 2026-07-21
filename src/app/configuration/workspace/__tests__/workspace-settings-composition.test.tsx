import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as WorkspaceSettingsMod from "@/app/configuration/workspace/page";
import * as WorkspaceMembersMod from "@/app/configuration/workspace/members/page";

const SETTINGS_SOURCE = readFileSync(
  "src/app/configuration/workspace/page.tsx",
  "utf-8",
);
const MEMBERS_SOURCE = readFileSync(
  "src/app/configuration/workspace/members/page.tsx",
  "utf-8",
);

// cinatra#1936: the native Better Auth organization-deletion endpoint is
// disabled (see src/lib/auth.ts `disableOrganizationDeletion: true` and
// organization-native-delete-disabled.test.ts), which makes the vendored
// DeleteOrganizationCard a dead control. `OrganizationView path="settings"`
// renders that card UNCONDITIONALLY (no option gates it), so the workspace
// settings page composes the two live cards directly instead. These
// source-shape pins keep the dead control from riding back in via the
// monolithic view — and keep the sweep surgical (the members view has no
// delete card and stays on OrganizationView).

describe("/configuration/workspace settings composition (cinatra#1936)", () => {
  it("both page modules load and export a default async component", () => {
    expect(typeof WorkspaceSettingsMod.default).toBe("function");
    expect(typeof WorkspaceMembersMod.default).toBe("function");
  });

  it("settings page composes the name + slug cards directly", () => {
    expect(SETTINGS_SOURCE).toMatch(/OrganizationNameCard/);
    expect(SETTINGS_SOURCE).toMatch(/OrganizationSlugCard/);
  });

  it("settings page does NOT render the monolithic settings view or any delete affordance", () => {
    // OrganizationView's SETTINGS branch unconditionally appends
    // DeleteOrganizationCard; OrganizationSettingsCards IS that trio. None may
    // be rendered or imported here — matched as JSX / inside the vendored
    // import (NOT bare names: the page's own comments rightly name what was
    // replaced and why).
    expect(SETTINGS_SOURCE).not.toMatch(/<OrganizationView/);
    expect(SETTINGS_SOURCE).not.toMatch(/<OrganizationSettingsCards/);
    expect(SETTINGS_SOURCE).not.toMatch(/<DeleteOrganizationCard/);
    const vendoredImport = SETTINGS_SOURCE.match(
      /import\s*\{[^}]*\}\s*from\s*"@daveyplate\/better-auth-ui"/,
    )?.[0];
    expect(vendoredImport).toBeTruthy();
    expect(vendoredImport).not.toMatch(/OrganizationView/);
    expect(vendoredImport).not.toMatch(/OrganizationSettingsCards/);
    expect(vendoredImport).not.toMatch(/DeleteOrganizationCard/);
  });

  it("settings page stays server-gated by requireAdminSession", () => {
    // The recomposition drops the vendored view's client-side useAuthenticate;
    // the server gate is the load-bearing one and must remain.
    expect(SETTINGS_SOURCE).toMatch(/requireAdminSession\(\)/);
  });

  it("members page still uses OrganizationView (path=\"members\" has no delete card)", () => {
    expect(MEMBERS_SOURCE).toMatch(/OrganizationView/);
    expect(MEMBERS_SOURCE).toMatch(/path="members"/);
    expect(MEMBERS_SOURCE).not.toMatch(/DeleteOrganizationCard/);
  });
});
