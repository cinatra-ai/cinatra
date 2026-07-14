/**
 * Grant-form picker contract for the ProjectAccessSection
 * (cinatra#1505 / #1509 §4.2).
 *
 * Two layers:
 *  1. SSR render (renderToStaticMarkup — the permissions-page.test.tsx
 *     pattern): the default user level renders the Title-Case "User" label,
 *     the mounted EntitySearchCombobox, and the manual-ID escape hatch; the
 *     lowercase `user id` label is gone.
 *  2. Source-text: the `${principalLevel} id` template is dead, labels come
 *     from the static PRINCIPAL_LEVEL_LABELS map, candidates come from the
 *     dedicated grant-candidate actions (never availableScopes), and the
 *     already-granted marking + h-8 alignment are wired.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectPermissionsTabClient } from "../permissions-tab-client";
import type { ProjectAccessRow } from "../actions";

const SOURCE = readFileSync(
  "src/app/projects/[projectId]/permissions/permissions-tab-client.tsx",
  "utf-8",
);

const accessRows = [
  {
    principalLevel: "user",
    principalId: "user-owner",
    role: "owner",
    grantedBy: "system",
    grantedAt: new Date("2026-01-01T00:00:00Z"),
    accessSource: "direct",
  },
] as unknown as ProjectAccessRow[];

function renderTab(): string {
  return renderToStaticMarkup(
    <ProjectPermissionsTabClient
      activeOrgId="org-1"
      projectId="proj-1"
      projectName="Demo project"
      initialAccess="owner"
      canEdit={true}
      availableScopes={{
        teams: [],
        projects: [],
        orgName: "Acme Corp",
        workspaceExposed: false,
      }}
      resourceOwner={null}
      coOwners={[]}
      currentUserId="user-owner"
      projectAccessRows={accessRows}
    />,
  );
}

describe("grant form render (default level: user)", () => {
  it("renders the Title-Case principal label — no lowercase `user id`", () => {
    const html = renderTab();
    expect(html).toMatch(/>User</);
    expect(html).not.toMatch(/user id/i);
    expect(html).not.toMatch(/Identifier/);
  });

  it("mounts the user search combobox (the §4.0-b foundation) in the form", () => {
    const html = renderTab();
    expect(html).toMatch(/Search users by name or email/);
    expect(html).toMatch(/role="combobox"/);
    expect(html).toMatch(/id="principal-id"/);
  });

  it("offers the manual-ID escape hatch and the immediate-mode helper copy", () => {
    const html = renderTab();
    expect(html).toMatch(/Enter ID manually/);
    expect(html).toMatch(/Changes apply immediately\./);
    expect(html).toMatch(/Grant access/);
  });

  it("keeps the section + control sentinels stable", () => {
    const html = renderTab();
    expect(html).toMatch(/data-testid="project-access-section"/);
    expect(html).toMatch(/id="principal-level"/);
    expect(html).toMatch(/id="role"/);
  });
});

describe("grant form source contract (cinatra#1505 AC)", () => {
  it("the `${principalLevel} id` label template is gone for good", () => {
    expect(SOURCE).not.toMatch(/\$\{principalLevel\} id/);
    expect(SOURCE).not.toMatch(/Enter \$\{principalLevel\}/);
  });

  it("labels come from the static Title-Case map", () => {
    expect(SOURCE).toMatch(/PRINCIPAL_LEVEL_LABELS\[principalLevel\]/);
  });

  it("candidates come from the dedicated grant-candidate actions — never availableScopes (codex F6)", () => {
    expect(SOURCE).toMatch(/searchProjectGrantUserCandidates\(projectId, query\)/);
    expect(SOURCE).toMatch(/listProjectGrantTeamCandidates\(projectId\)/);
    expect(SOURCE).toMatch(/readProjectGrantOrgCandidate\(projectId\)/);
    // The grant form never reads the viewer-membership availableScopes prop.
    const grantSection = SOURCE.slice(SOURCE.indexOf("function ProjectAccessSection"));
    expect(grantSection).not.toMatch(/availableScopes/);
  });

  it("already-granted principals are excluded (users) or marked with a reason", () => {
    expect(SOURCE).toMatch(/grantedPrincipalIds\(effectiveRows, "user"\)/);
    expect(SOURCE).toMatch(/Already granted — \{granted\}/);
    expect(SOURCE).toMatch(/Already granted — \{fixedRowGrantedRole\}/);
  });

  it("the workspace fixed row keeps the sentinel value but never renders the raw id", () => {
    expect(SOURCE).toMatch(/WORKSPACE_PRINCIPAL_ID/);
    expect(SOURCE).toMatch(/Whole workspace/);
  });

  it("mixed-control row alignment: Selects at the shared h-8 height (§3.2)", () => {
    expect(SOURCE).toMatch(/id="principal-level" size="sm"/);
    expect(SOURCE).toMatch(/id="role" size="sm"/);
  });
});
