/**
 * createOrganizationAction — creation, gating, slug allocation, and
 * destination contract (#1496).
 *
 * The action must:
 *   (a) reject an empty name before doing any work,
 *   (b) enforce the app-level create gate (`userCanCreateOrganizations`)
 *       before calling the endpoint, so a direct POST reaches no further
 *       than the UI allows,
 *   (c) create through Better Auth's org-create endpoint (the SAME path the
 *       global `+` menu dialog uses) with a slug derived from the name,
 *   (d) retry with `-<n>` suffixes when the globally-unique slug is taken
 *       and fail over to a visible error once the budget is exhausted,
 *   (e) NEVER pass `keepCurrentActiveOrganization` — the endpoint's default
 *       switches the session's active org to the new org, which is the
 *       #1495-class destination guard for the landing page, and
 *   (f) let unexpected errors propagate (no silent success redirect).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { APIError } from "better-auth/api";

const h = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  userCanCreateOrganizations: vi.fn(async () => true),
  createOrganization: vi.fn(
    async (_input: {
      headers: Headers;
      body: { name: string; slug: string } & Record<string, unknown>;
    }): Promise<unknown> => ({}),
  ),
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: h.requireAuthSession,
}));

vi.mock("@/lib/authz/organization-create-gate", () => ({
  userCanCreateOrganizations: h.userCanCreateOrganizations,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { createOrganization: h.createOrganization } },
}));

vi.mock("next/headers", () => ({ headers: h.headers }));

vi.mock("next/navigation", () => ({
  // Next's redirect() throws to unwind; mirror that so we can assert the
  // destination and prove control flow stopped at the redirect.
  redirect: vi.fn((url: string) => {
    throw new Error("REDIRECT:" + url);
  }),
}));

import { createOrganizationAction } from "../actions";

/** The taken-slug rejection the create endpoint throws (verified shape:
 *  `body.code` carries the SCREAMING_SNAKE key). */
function slugTakenError() {
  return APIError.from("BAD_REQUEST", {
    code: "ORGANIZATION_ALREADY_EXISTS",
    message: "Organization already exists",
  });
}

function forbiddenError() {
  return APIError.from("FORBIDDEN", {
    code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION",
    message: "You are not allowed to create a new organization",
  });
}

/** Run the action and return the redirect destination it unwound to. */
async function runAndCaptureRedirect(formData: FormData): Promise<string> {
  try {
    await createOrganizationAction(formData);
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (message.startsWith("REDIRECT:")) {
      return message.slice("REDIRECT:".length);
    }
    throw err;
  }
  throw new Error("createOrganizationAction did not redirect");
}

function formFor(name: string): FormData {
  const fd = new FormData();
  fd.set("name", name);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAuthSession.mockResolvedValue({
    user: { id: "user-1", role: "user,admin" },
    session: { activeOrganizationId: "org-active" },
  });
  h.userCanCreateOrganizations.mockResolvedValue(true);
  h.createOrganization.mockResolvedValue({ id: "org-new" });
  h.headers.mockResolvedValue(new Headers());
});

describe("createOrganizationAction", () => {
  it("creates with the name-derived slug and redirects to /organizations", async () => {
    const dest = await runAndCaptureRedirect(formFor("UAT Detail Org"));

    expect(dest).toBe("/organizations");
    expect(h.createOrganization).toHaveBeenCalledTimes(1);
    expect(h.createOrganization).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { name: "UAT Detail Org", slug: "uat-detail-org" },
    });
  });

  it("never passes keepCurrentActiveOrganization — the endpoint's default set-active is the #1495 destination guard", async () => {
    await runAndCaptureRedirect(formFor("UAT Detail Org"));

    const body = h.createOrganization.mock.calls[0]?.[0]?.body as Record<
      string,
      unknown
    >;
    expect(body).toBeDefined();
    expect("keepCurrentActiveOrganization" in body).toBe(false);
  });

  it("retries with a -2 suffix when the slug is taken", async () => {
    h.createOrganization
      .mockRejectedValueOnce(slugTakenError())
      .mockResolvedValueOnce({ id: "org-new" });

    const dest = await runAndCaptureRedirect(formFor("UAT Detail Org"));

    expect(dest).toBe("/organizations");
    expect(h.createOrganization).toHaveBeenCalledTimes(2);
    expect(h.createOrganization.mock.calls[0]?.[0]?.body?.slug).toBe(
      "uat-detail-org",
    );
    expect(h.createOrganization.mock.calls[1]?.[0]?.body?.slug).toBe(
      "uat-detail-org-2",
    );
  });

  it("redirects with a visible error when the slug budget is exhausted (100 attempts)", async () => {
    h.createOrganization.mockRejectedValue(slugTakenError());

    const dest = await runAndCaptureRedirect(formFor("UAT Detail Org"));

    expect(dest).toBe("/organizations/new?error=slug-unavailable");
    expect(h.createOrganization).toHaveBeenCalledTimes(100);
  });

  it("redirects to /not-authorized when the app-level gate denies, WITHOUT calling the endpoint", async () => {
    h.userCanCreateOrganizations.mockResolvedValue(false);

    const dest = await runAndCaptureRedirect(formFor("UAT Detail Org"));

    expect(dest).toBe("/not-authorized");
    expect(h.createOrganization).not.toHaveBeenCalled();
  });

  it("redirects to /not-authorized when the endpoint's authoritative gate rejects (no retry)", async () => {
    h.createOrganization.mockRejectedValue(forbiddenError());

    const dest = await runAndCaptureRedirect(formFor("UAT Detail Org"));

    expect(dest).toBe("/not-authorized");
    expect(h.createOrganization).toHaveBeenCalledTimes(1);
  });

  it("redirects with missing-name before consulting the gate or the endpoint", async () => {
    const dest = await runAndCaptureRedirect(formFor("   "));

    expect(dest).toBe("/organizations/new?error=missing-name");
    expect(h.userCanCreateOrganizations).not.toHaveBeenCalled();
    expect(h.createOrganization).not.toHaveBeenCalled();
  });

  it("propagates an unexpected (non-APIError) failure instead of redirecting", async () => {
    h.createOrganization.mockRejectedValue(new Error("connection reset"));

    await expect(
      createOrganizationAction(formFor("UAT Detail Org")),
    ).rejects.toThrow("connection reset");
  });

  it("propagates an APIError with an unrecognized code (no silent retry loop)", async () => {
    h.createOrganization.mockRejectedValue(
      APIError.from("FORBIDDEN", {
        code: "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS",
        message: "You have reached the maximum number of organizations",
      }),
    );

    await expect(
      createOrganizationAction(formFor("UAT Detail Org")),
    ).rejects.toMatchObject({
      body: { code: "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS" },
    });
    expect(h.createOrganization).toHaveBeenCalledTimes(1);
  });
});
