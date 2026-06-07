/**
 * Source-text contract test for the Invite-member toolbar on
 * /configuration/permissions.
 *
 * Component tests at the repo root use source-file text assertions because
 * @testing-library/react is not a root dev-dependency (see
 * access-combobox-disabled-scopes.test.ts for the same approach). These
 * assertions lock the load-bearing contract:
 *
 *   1. The toolbar is FAIL-CLOSED — the page resolves the actor's Better Auth
 *      `invitation:create` permission server-side and the button only renders
 *      when that check passed AND an active organization exists.
 *   2. The dialog invites through Better Auth's own client API
 *      (`authClient.organization.inviteMember`), not a bespoke route.
 *   3. The role picker offers the full Better Auth invite enum so the surface
 *      matches the workspace-members widget's API semantics (the server
 *      enforces who may actually assign each role).
 *   4. The action sits in the canonical Toolbar surface, not a hand-rolled row.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const DIALOG_SOURCE = readFileSync("src/components/invite-member-dialog.tsx", "utf-8");
const PAGE_SOURCE = readFileSync("src/app/configuration/permissions/page.tsx", "utf-8");

describe("invite-member dialog source contract", () => {
  it("is a client island", () => {
    expect(DIALOG_SOURCE.startsWith('"use client"')).toBe(true);
  });

  it("invites through Better Auth's organization client API", () => {
    expect(DIALOG_SOURCE).toContain("authClient.organization.inviteMember");
    // It targets a specific organization id passed in by the (server-gated) caller.
    expect(DIALOG_SOURCE).toContain("organizationId");
  });

  it("offers the full invite enum (member/admin/owner) to match API semantics", () => {
    expect(DIALOG_SOURCE).toContain('value: "member"');
    expect(DIALOG_SOURCE).toContain('value: "admin"');
    // owner is offered too — the server enforces that only an owner may
    // actually assign it, and that rejection surfaces as an error toast.
    expect(DIALOG_SOURCE).toContain('value: "owner"');
  });

  it("trims the email and surfaces a failed invite instead of silently swallowing it", () => {
    expect(DIALOG_SOURCE).toContain("email.trim()");
    expect(DIALOG_SOURCE).toContain("result.error");
    expect(DIALOG_SOURCE).toContain("toast.error");
  });
});

describe("permissions page invite gating contract", () => {
  it("resolves the invite gate from the Better Auth invitation:create permission", () => {
    expect(PAGE_SOURCE).toContain("auth.api.hasPermission");
    expect(PAGE_SOURCE).toContain('invitation: ["create"]');
    // success === true is the only path that opens the gate.
    expect(PAGE_SOURCE).toContain("result?.success === true");
  });

  it("is fail-closed: any thrown check leaves canInvite false", () => {
    expect(/catch\s*\{\s*canInvite = false;/.test(PAGE_SOURCE)).toBe(true);
    // No active organization => no invite gate evaluated.
    expect(PAGE_SOURCE).toContain("if (activeOrganizationId) {");
  });

  it("only renders the toolbar when the gate passed AND an org is active", () => {
    expect(PAGE_SOURCE).toContain("props.canInvite && props.organizationId");
    expect(PAGE_SOURCE).toContain("<InviteMemberDialog organizationId={props.organizationId} />");
  });

  it("mounts the invite action inside the canonical Toolbar surface", () => {
    expect(PAGE_SOURCE).toContain('from "@/components/ui/toolbar"');
    expect(/<Toolbar>\s*<ToolbarGroup/.test(PAGE_SOURCE)).toBe(true);
  });
});
