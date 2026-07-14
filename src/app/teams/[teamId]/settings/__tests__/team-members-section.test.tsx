/**
 * TeamMembersSection render contract (cinatra#1567).
 *
 * Two layers (the grant-form-pickers.test.tsx pattern):
 *  1. SSR render (renderToStaticMarkup): the member list renders name+email
 *     rows; `canManage` gates the Remove buttons and the add-member control
 *     (the shared EntitySearchCombobox) — a non-manager sees a read-only
 *     list with NO mutation affordances.
 *  2. Source-text: candidates come from the dedicated authority-gated
 *     `searchTeamMemberCandidates` action (never the viewer's scopes), the
 *     combobox excludes current members, removal is AlertDialog-confirmed,
 *     and no per-member role UI exists (deferred to #1566).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// The "use server" actions module reaches auth/db at import time in the app
// graph — stub it; this test exercises only the client render contract.
vi.mock("../member-actions", () => ({
  addTeamMemberAction: vi.fn(),
  removeTeamMemberAction: vi.fn(),
  searchTeamMemberCandidates: vi.fn(),
}));

import { TeamMembersSection } from "../team-members-section";

const SOURCE = readFileSync(
  "src/app/teams/[teamId]/settings/team-members-section.tsx",
  "utf-8",
);

const members = [
  { userId: "u-1", name: "Ada Lovelace", email: "ada@example.com" },
  { userId: "u-2", name: "Grace Hopper", email: "grace@example.com" },
];

function render(canManage: boolean): string {
  return renderToStaticMarkup(
    <TeamMembersSection teamId="team-1" members={members} canManage={canManage} />,
  );
}

describe("TeamMembersSection render", () => {
  it("renders every member with name and email", () => {
    const html = render(false);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain("grace@example.com");
  });

  it("non-managers get a read-only list: no Remove, no add control", () => {
    const html = render(false);
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("Add member");
    expect(html).not.toContain("team-member-candidate");
  });

  it("managers get Remove buttons and the add-member combobox", () => {
    const html = render(true);
    expect(html).toContain("Remove");
    expect(html).toContain("Add a member");
    expect(html).toContain("Add member");
    // the shared EntitySearchCombobox mounts as the labeled candidate input
    expect(html).toContain('id="team-member-candidate"');
    expect(html).toContain('role="combobox"');
  });

  it("renders the empty state when the team has no members", () => {
    const html = renderToStaticMarkup(
      <TeamMembersSection teamId="team-1" members={[]} canManage={false} />,
    );
    expect(html).toContain("No members yet.");
  });
});

describe("TeamMembersSection source contract", () => {
  it("mounts the SHARED EntitySearchCombobox fed by the dedicated candidate action", () => {
    expect(SOURCE).toMatch(
      /from\s+"@\/components\/entity-search-combobox"/,
    );
    expect(SOURCE).toMatch(/searchTeamMemberCandidates\(teamId, query\)/);
  });

  it("excludes current members from the candidate list client-side", () => {
    expect(SOURCE).toMatch(/excludeIds=\{memberIds\}/);
  });

  it("confirms removal through an AlertDialog before calling the action", () => {
    expect(SOURCE).toMatch(/AlertDialogAction/);
    expect(SOURCE).toMatch(/setRemovalTarget\(member\)/);
    // the list button opens the dialog; only the dialog action removes
    expect(SOURCE).toMatch(/handleRemove\(target\)/);
  });

  it("has NO per-member role UI (deferred to the #1566 role model)", () => {
    expect(SOURCE).not.toMatch(/<Select|role=["']?(admin|owner|member)/);
  });
});
