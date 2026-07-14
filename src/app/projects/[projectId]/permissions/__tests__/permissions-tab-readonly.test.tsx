/**
 * The retired Access section is GENUINELY read-only (cinatra#1509 §4.1,
 * codex F4):
 *   - the AccessCombobox renders with `disabled` unconditionally (a display of
 *     current visibility, not a control)
 *   - the caption "Current visibility — managed via Project access below."
 *     makes the mode legible (§3.2 staged-vs-immediate rule)
 *   - the no-op submit/toast path is GONE: no form, no page-level Save button,
 *     no retired-ratchet explanatory toast, no updateProjectScopeAction wiring
 *
 * Static render (node env, renderToStaticMarkup — the permissions-page.test
 * precedent) + source-text locks on the wiring (the repo's source-text test
 * convention; no @testing-library at root).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectPermissionsTabClient } from "../permissions-tab-client";

const SOURCE = readFileSync(
  "src/app/projects/[projectId]/permissions/permissions-tab-client.tsx",
  "utf-8",
);

const CAPTION = "Current visibility — managed via Project access below.";

function renderTab(canEdit: boolean): string {
  return renderToStaticMarkup(
    <ProjectPermissionsTabClient
      activeOrgId="org-A"
      projectId="proj-1"
      projectName="Demo project"
      initialAccess="team:team-x"
      canEdit={canEdit}
      availableScopes={{
        teams: [{ id: "team-x", name: "Growth" }],
        projects: [],
        orgName: "Acme",
        workspaceExposed: false,
      }}
      resourceOwner={null}
      coOwners={[]}
      currentUserId="user-1"
      projectAccessRows={[]}
    />,
  );
}

describe("Access section is genuinely read-only (rendered output)", () => {
  it("disables the combobox trigger and shows the caption — even for editors", () => {
    const html = renderTab(true);
    expect(html).toContain(CAPTION);
    // The access-combobox section's trigger button carries the disabled attr.
    expect(html).toMatch(/data-testid="access-combobox"[\s\S]*?<button[^>]*\bdisabled\b/);
    // No page-level Save button / no-op submit remains.
    expect(html).not.toContain("Save changes");
    expect(html).not.toMatch(/<form/);
  });

  it("renders identically read-only for non-editors", () => {
    const html = renderTab(false);
    expect(html).toContain(CAPTION);
    expect(html).toMatch(/data-testid="access-combobox"[\s\S]*?<button[^>]*\bdisabled\b/);
  });
});

describe("Access section is genuinely read-only (source-text wiring)", () => {
  it("passes `disabled` to AccessCombobox unconditionally (no canEdit/pending ternary)", () => {
    const jsx = SOURCE.match(/<AccessCombobox[\s\S]*?\/>/)?.[0] ?? "";
    expect(jsx).toMatch(/^\s*disabled\s*$/m);
    expect(jsx).not.toMatch(/disabled=\{/);
  });

  it("carries the §4.1 caption", () => {
    expect(SOURCE).toContain(CAPTION);
  });

  it("drops the retired no-op submit/toast path entirely", () => {
    expect(SOURCE).not.toContain("updateProjectScopeAction");
    expect(SOURCE).not.toContain("ownership transfer is retired");
    expect(SOURCE).not.toContain("useForm");
    expect(SOURCE).not.toContain("handleSubmit");
    expect(SOURCE).not.toContain("Save changes");
    expect(SOURCE).not.toMatch(/<form\b/);
  });

  it("keeps the section itself (full removal is owner-routed — Open Decision 3)", () => {
    expect(SOURCE).toMatch(/data-testid="access-combobox"/);
    expect(SOURCE).toMatch(/>Access</);
  });
});
