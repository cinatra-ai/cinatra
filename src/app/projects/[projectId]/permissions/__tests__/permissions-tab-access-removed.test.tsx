/**
 * The retired ownership-ratchet "Access" section is fully REMOVED from the
 * project permissions tab (owner ratified Open Decision 3 = Remove,
 * cinatra#1509):
 *   - no "Current visibility" caption, no `data-testid="access-combobox"`
 *     wrapper, no AccessCombobox import on this page — visibility is managed
 *     exclusively through the Project access grants section
 *   - the retired `updateProjectScopeAction` server action is gone from
 *     actions.ts (post-retirement it only ever threw)
 *   - the Ownership panel and the Project access grants area still render
 *
 * Static render (node env, renderToStaticMarkup — the permissions-page.test
 * precedent) + source-text locks on the wiring (the repo's source-text test
 * convention; no @testing-library at root).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// guest-actions imports @/lib/auth (top-level-await better-auth boot) — that
// module is always mocked in the vitest sandbox, so mock the actions surface.
vi.mock("../guest-actions", () => ({
  inviteGuestByEmailAction: async () => ({ ok: false, error: "unknown" }),
  revokeGuestAction: async () => ({ ok: false }),
  listGuestRows: async () => [],
}));

import { ProjectPermissionsTabClient } from "../permissions-tab-client";

const CLIENT_SOURCE = readFileSync(
  "src/app/projects/[projectId]/permissions/permissions-tab-client.tsx",
  "utf-8",
);
const PAGE_SOURCE = readFileSync(
  "src/app/projects/[projectId]/permissions/page.tsx",
  "utf-8",
);
const ACTIONS_SOURCE = readFileSync(
  "src/app/projects/[projectId]/permissions/actions.ts",
  "utf-8",
);

const RETIRED_CAPTION = "Current visibility — managed via Project access below.";

function renderTab(canEdit: boolean): string {
  return renderToStaticMarkup(
    <ProjectPermissionsTabClient
      activeOrgId="org-A"
      projectId="proj-1"
      projectName="Demo project"
      canEdit={canEdit}
      resourceOwner={null}
      coOwners={[]}
      currentUserId="user-1"
      projectAccessRows={[]}
      guestRows={[]}
    />,
  );
}

describe("retired Access section is gone (rendered output)", () => {
  it("renders no visibility caption and no access-combobox wrapper — for editors", () => {
    const html = renderTab(true);
    expect(html).not.toContain(RETIRED_CAPTION);
    expect(html).not.toMatch(/data-testid="access-combobox"/);
  });

  it("renders no visibility caption and no access-combobox wrapper — for non-editors", () => {
    const html = renderTab(false);
    expect(html).not.toContain(RETIRED_CAPTION);
    expect(html).not.toMatch(/data-testid="access-combobox"/);
  });

  it("still renders the Ownership panel and the Project access grants area", () => {
    const html = renderTab(true);
    expect(html).toMatch(/data-testid="project-sharing-panel"/);
    expect(html).toMatch(/data-testid="project-access-section"/);
    expect(html).toMatch(/>Project access</);
  });
});

describe("retired Access section is gone (source-text wiring)", () => {
  it("drops the AccessCombobox wiring from the tab client entirely", () => {
    expect(CLIENT_SOURCE).not.toContain("AccessCombobox");
    expect(CLIENT_SOURCE).not.toContain("access-combobox");
    expect(CLIENT_SOURCE).not.toContain(RETIRED_CAPTION);
    expect(CLIENT_SOURCE).not.toContain("availableScopes");
    expect(CLIENT_SOURCE).not.toContain("initialAccess");
  });

  it("drops the availableScopes / access-expression plumbing from the page RSC", () => {
    expect(PAGE_SOURCE).not.toContain("AccessCombobox");
    expect(PAGE_SOURCE).not.toContain("availableScopes");
    expect(PAGE_SOURCE).not.toContain("initialAccess");
    expect(PAGE_SOURCE).not.toContain("access-team-hydration");
  });

  it("drops the retired updateProjectScopeAction export from actions.ts", () => {
    expect(ACTIONS_SOURCE).not.toContain("updateProjectScopeAction");
    expect(ACTIONS_SOURCE).not.toContain("assertScopeRatchet");
  });
});
