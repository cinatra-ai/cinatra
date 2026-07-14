import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  buildInvitationAcceptUrl,
  buildInvitationEmail,
  INVITATION_ACCEPT_PATH,
  INVITATION_ID_QUERY_PARAM,
} from "../org-invitation-email";
import { buildCinatraOrganizationPlugin } from "../better-auth-plugins";

// ---------------------------------------------------------------------------
// cinatra#1565 — org member-invitation email wiring.
//
// Better Auth ships NO default invitation sender, so `inviteMember` created a
// `public.invitation` row but dispatched nothing. This suite locks the new
// wiring: the pure link/body builders, the shared-factory threading of
// `organization.sendInvitationEmail`, and the auth.ts source contract (which
// cannot be imported here — the vitest setup stubs `@/lib/auth` to keep the
// server-only / React barrel out of the test graph, mirroring
// better-auth-schema.test.ts).
// ---------------------------------------------------------------------------

describe("buildInvitationAcceptUrl", () => {
  it("targets the accept-invitation card route with the invitationId query param", () => {
    const url = buildInvitationAcceptUrl("https://app.example.com", "inv_123");
    expect(url).toBe(
      "https://app.example.com/permissions/accept-invitation?invitationId=inv_123",
    );
    // The path + param name match better-auth-ui's AcceptInvitationCard, which
    // reads `getSearchParam("invitationId")` at the `accept-invitation` view.
    expect(url).toContain(INVITATION_ACCEPT_PATH);
    expect(url).toContain(`${INVITATION_ID_QUERY_PARAM}=`);
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(buildInvitationAcceptUrl("https://app.example.com/", "inv_1")).toBe(
      "https://app.example.com/permissions/accept-invitation?invitationId=inv_1",
    );
  });

  it("url-encodes the invitation id", () => {
    const url = buildInvitationAcceptUrl("https://app.example.com", "a b/c?d");
    expect(url).toContain("invitationId=a%20b%2Fc%3Fd");
  });
});

describe("buildInvitationEmail", () => {
  it("includes org, inviter, role and the accept link in the body", () => {
    const acceptUrl =
      "https://app.example.com/permissions/accept-invitation?invitationId=inv_9";
    const { subject, text } = buildInvitationEmail({
      organizationName: "Acme",
      inviterLabel: "Marcus",
      role: "admin",
      acceptUrl,
    });
    expect(subject).toContain("Acme");
    expect(text).toContain("Marcus");
    expect(text).toContain("Acme");
    expect(text).toContain("admin");
    expect(text).toContain(acceptUrl);
  });

  it("never emits raw undefined when org/inviter/role are missing", () => {
    const { subject, text } = buildInvitationEmail({ acceptUrl: "https://x/y" });
    expect(subject).not.toContain("undefined");
    expect(text).not.toContain("undefined");
    expect(text).toContain("member"); // defaulted role
  });

  // Better Auth does not normalize the role before the callback: it can be a
  // single string, an ARRAY of roles, or a comma-separated string.
  it("renders an array of roles as a readable list (no .trim crash)", () => {
    const { text } = buildInvitationEmail({
      role: ["admin", "member"],
      acceptUrl: "https://x/y",
    });
    expect(text).toContain("as admin, member.");
  });

  it("renders a comma-separated role string readably and defaults empty arrays", () => {
    expect(
      buildInvitationEmail({ role: "admin,member", acceptUrl: "https://x/y" }).text,
    ).toContain("as admin, member.");
    expect(buildInvitationEmail({ role: [], acceptUrl: "https://x/y" }).text).toContain(
      "as member.",
    );
    expect(
      buildInvitationEmail({ role: ["  "], acceptUrl: "https://x/y" }).text,
    ).toContain("as member.");
  });
});

describe("organization plugin factory threads sendInvitationEmail (cinatra#1565)", () => {
  it("forwards a provided callback onto the plugin options", () => {
    const spy = vi.fn(async () => {});
    const plugin = buildCinatraOrganizationPlugin({ sendInvitationEmail: spy });
    const options = (plugin as { options?: { sendInvitationEmail?: unknown } }).options;
    expect(options?.sendInvitationEmail).toBe(spy);
  });

  it("omits sendInvitationEmail when none is provided (no accidental default sender)", () => {
    const plugin = buildCinatraOrganizationPlugin({});
    const options = (plugin as { options?: { sendInvitationEmail?: unknown } }).options;
    expect(options?.sendInvitationEmail).toBeUndefined();
  });

  it("end-to-end: a threaded callback emits the right recipient/subject/link", async () => {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    // Mirror auth.ts's callback shape: build via the shared pure helpers,
    // dispatch via a capturing spy in place of dispatchPlatformEmail.
    const plugin = buildCinatraOrganizationPlugin({
      sendInvitationEmail: async (data) => {
        const acceptUrl = buildInvitationAcceptUrl("https://app.example.com", data.id);
        const { subject, text } = buildInvitationEmail({
          organizationName: data.organization?.name,
          inviterLabel: data.inviter?.user?.name || data.inviter?.user?.email,
          role: data.role,
          acceptUrl,
        });
        sent.push({ to: data.email, subject, text });
      },
    });
    const cb = (
      plugin as { options?: { sendInvitationEmail?: (d: unknown) => Promise<void> } }
    ).options?.sendInvitationEmail;
    expect(cb).toBeDefined();
    await cb!({
      id: "inv_42",
      role: "member",
      email: "invitee@example.com",
      organization: { name: "Acme" },
      inviter: { user: { name: "Marcus", email: "marcus@example.com" } },
      invitation: {},
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("invitee@example.com");
    expect(sent[0].text).toContain(
      "https://app.example.com/permissions/accept-invitation?invitationId=inv_42",
    );
    expect(sent[0].subject).toContain("Acme");
  });
});

describe("auth.ts wires sendInvitationEmail via the platform-email path", () => {
  const AUTH_SOURCE = readFileSync("src/lib/auth.ts", "utf-8");

  it("passes sendInvitationEmail into the organization plugin options", () => {
    expect(AUTH_SOURCE).toContain("sendInvitationEmail: async (data) =>");
  });

  it("dispatches through dispatchPlatformEmail with a dedicated context", () => {
    expect(AUTH_SOURCE).toContain("dispatchPlatformEmail(");
    expect(AUTH_SOURCE).toContain('context: "sendInvitationEmail"');
    // The recipient is the invitee (data.email), never the inviter.
    expect(AUTH_SOURCE).toContain("to: data.email");
  });

  it("builds the accept link + body from the shared pure helpers", () => {
    expect(AUTH_SOURCE).toContain("buildInvitationAcceptUrl(authBaseUrl, data.id)");
    expect(AUTH_SOURCE).toContain("buildInvitationEmail(");
  });
});
