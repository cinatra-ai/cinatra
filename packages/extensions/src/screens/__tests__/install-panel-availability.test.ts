// Availability model for the in-card install panel (cinatra#2373).
//
// The ORDER is the contract: `no-active-organization` is decided before any
// role reasoning, then `ready` (defaulting to the `Workspace: All` AUDIENCE
// row), then the role-oriented `no-installable-scope` empty state. Getting the
// order wrong mis-describes the cause to the admin — a session with no active
// organization would be told "you need org admin", which is false.

import { describe, expect, it } from "vitest";
import { resolveInstallPanelAvailability } from "../install-panel-availability";
import type { InstallTarget } from "@cinatra-ai/agents/install-targets";

const ORG_ID = "org-acme";

const orgRow = (disabled: boolean): InstallTarget => ({
  value: `org:${ORG_ID}`,
  label: "Anyone in Acme",
  level: "organization",
  id: ORG_ID,
  disabled,
  ...(disabled ? { reason: "Requires org admin." } : {}),
});

const workspaceRow = (disabled: boolean): InstallTarget => ({
  value: "workspace",
  label: "Whole Workspace",
  level: "workspace",
  id: ORG_ID,
  disabled,
  ...(disabled ? { reason: "Requires platform admin." } : {}),
});

const adminRow = (disabled: boolean): InstallTarget => ({
  value: "admin",
  label: "Admins only",
  level: "admin",
  id: ORG_ID,
  disabled,
  ...(disabled ? { reason: "Requires platform admin." } : {}),
});

describe("resolveInstallPanelAvailability", () => {
  it("defaults to the Workspace: All row when the server offered it enabled", () => {
    expect(
      resolveInstallPanelAvailability({
        activeOrgId: ORG_ID,
        installTargets: [orgRow(false), workspaceRow(false), adminRow(false)],
        fallbackDefaultValue: `org:${ORG_ID}`,
      }),
    ).toEqual({ state: "ready", defaultValue: "workspace" });
  });

  it("never defaults to the admins-only row (it is a NARROWER audience)", () => {
    const result = resolveInstallPanelAvailability({
      activeOrgId: ORG_ID,
      installTargets: [workspaceRow(false), adminRow(false)],
      fallbackDefaultValue: null,
    });
    expect(result).toEqual({ state: "ready", defaultValue: "workspace" });
  });

  it("falls back to the SHARED picker default when Workspace: All is server-disabled", () => {
    // A non-platform admin: the workspace rows are offered but disabled
    // (installer AUTHORITY), so the panel opens on a row the viewer can
    // actually install at rather than a locked one.
    expect(
      resolveInstallPanelAvailability({
        activeOrgId: ORG_ID,
        installTargets: [orgRow(false), workspaceRow(true), adminRow(true)],
        fallbackDefaultValue: `org:${ORG_ID}`,
      }),
    ).toEqual({ state: "ready", defaultValue: `org:${ORG_ID}` });
  });

  it("reports no-active-organization BEFORE any role reasoning", () => {
    // Rows present and enabled — but there is no active org, so the audience
    // has no tenant anchor and the server action would refuse the target.
    expect(
      resolveInstallPanelAvailability({
        activeOrgId: "",
        installTargets: [orgRow(false), workspaceRow(false)],
        fallbackDefaultValue: "workspace",
      }),
    ).toEqual({ state: "no-active-organization" });
  });

  it("treats a whitespace-only active organization id as absent", () => {
    expect(
      resolveInstallPanelAvailability({
        activeOrgId: "   ",
        installTargets: [workspaceRow(false)],
        fallbackDefaultValue: "workspace",
      }),
    ).toEqual({ state: "no-active-organization" });
  });

  it("reports no-installable-scope only when nothing is installable at all", () => {
    expect(
      resolveInstallPanelAvailability({
        activeOrgId: ORG_ID,
        installTargets: [orgRow(true), workspaceRow(true), adminRow(true)],
        fallbackDefaultValue: null,
      }),
    ).toEqual({ state: "no-installable-scope" });
  });

  it("reports no-installable-scope with no rows at all", () => {
    expect(
      resolveInstallPanelAvailability({
        activeOrgId: ORG_ID,
        installTargets: [],
        fallbackDefaultValue: null,
      }),
    ).toEqual({ state: "no-installable-scope" });
  });
});
