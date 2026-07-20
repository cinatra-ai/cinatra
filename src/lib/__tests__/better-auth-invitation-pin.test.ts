// cinatra#1907: a custom `advanced.database.generateId` flips better-auth's
// invitation accept/reject/get default to verified-email-only (installed
// 1.6.23: plugins/organization/routes/crud-invites.mjs —
// `shouldRequireVerifiedEmailForInvitationIdAction` returns the explicit
// option when defined, else "no built-in opaque id generation" = true under a
// custom generator). This app deliberately permits emailVerified=false
// accounts, so the factory pins the option to `false`. The pin must be
// PRESENT-with-value-false — a truthiness-conditional spread would silently
// drop it and re-enable the flip; these tests catch exactly that regression.

import { describe, it, expect } from "vitest";
import { buildCinatraOrganizationPlugin } from "../better-auth-plugins";

type WithOptions = { options: Record<string, unknown> };

describe("invitation verification pin (#1907)", () => {
  it("defaults requireEmailVerificationOnInvitation to an EXPLICIT false", () => {
    const plugin = buildCinatraOrganizationPlugin() as unknown as WithOptions;
    expect("requireEmailVerificationOnInvitation" in plugin.options).toBe(true);
    expect(plugin.options.requireEmailVerificationOnInvitation).toBe(false);
  });

  it("forwards an explicit override (tightening stays a deliberate choice)", () => {
    const plugin = buildCinatraOrganizationPlugin({
      requireEmailVerificationOnInvitation: true,
    }) as unknown as WithOptions;
    expect(plugin.options.requireEmailVerificationOnInvitation).toBe(true);
  });
});
