/**
 * TeamSettingsForm render contract (cinatra#1687): the capability flags gate
 * each control — SSR render (renderToStaticMarkup), the
 * team-members-section.test.tsx pattern.
 *
 * The two flags deliberately differ (each mirrors its OWN server action's
 * gate — see actions.ts): `canRenameName` = the canManageTeamMembers tiers;
 * `canRenameSlug` = team member AND org owner/admin. An unauthorized viewer
 * gets a disabled input, NO Save affordance, and an explanatory note instead
 * of a control that only fails after submit.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The "use server" actions module reaches auth/db at import time in the app
// graph — stub it; this test exercises only the client render contract.
vi.mock("../actions", () => ({
  renameTeamNameAction: vi.fn(),
  renameTeamSlugAction: vi.fn(),
}));

import { TeamSettingsForm } from "../team-settings-form";

function renderForm(caps: { canRenameName: boolean; canRenameSlug: boolean }) {
  return renderToStaticMarkup(
    <TeamSettingsForm
      teamId="team-1"
      currentSlug="growth"
      currentName="Growth Team"
      orgName="Acme Inc"
      orgSlug="acme"
      {...caps}
    />,
  );
}

describe("TeamSettingsForm — capability gating", () => {
  it("fully authorized: both controls editable with Save buttons", () => {
    const html = renderForm({ canRenameName: true, canRenameSlug: true });
    expect(html.match(/>Save</g)?.length).toBe(2);
    // Neither input is pre-disabled.
    expect(html).not.toMatch(/id="team-name"[^>]*disabled/);
    expect(html).not.toMatch(/id="team-slug"[^>]*disabled/);
  });

  it("no name authority: name input disabled, no Save, explanatory note", () => {
    const html = renderForm({ canRenameName: false, canRenameSlug: true });
    expect(html).toMatch(/id="team-name"[^>]*disabled/);
    expect(html.match(/>Save</g)?.length).toBe(1); // only the slug form's
    expect(html).toContain(
      "Only a team admin, org owner/admin, or platform admin can rename the team.",
    );
  });

  it("no slug authority: slug input disabled, no Save, explanatory note", () => {
    const html = renderForm({ canRenameName: true, canRenameSlug: false });
    expect(html).toMatch(/id="team-slug"[^>]*disabled/);
    expect(html.match(/>Save</g)?.length).toBe(1); // only the name form's
    expect(html).toContain(
      "Only an organization owner/admin who is on this team can rename it.",
    );
  });

  it("read-only viewer: no mutation affordance at all; org stays visible", () => {
    const html = renderForm({ canRenameName: false, canRenameSlug: false });
    expect(html).not.toContain(">Save<");
    expect(html).toContain("Acme Inc");
    expect(html).toContain("(acme)");
  });
});
