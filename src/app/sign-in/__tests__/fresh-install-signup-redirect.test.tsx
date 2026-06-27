/**
 * Fresh-install canonical auth URL coverage for `PermissionsAuthPage`.
 *
 * On a fresh install (0 Better Auth users) an unauthenticated visitor to a
 * protected route must END UP on /sign-up — not /sign-in — via the two-hop
 * flow:
 *
 *   protected route → /sign-in   (middleware guardAppRoute, cookie-only)
 *   /sign-in        → /sign-up   (PermissionsAuthPage server redirect)
 *
 * The guard stays DB-free, so the user-count-aware hop lives in the page.
 * A guard-only unit test cannot prove the visitor lands on /sign-up; these
 * tests exercise the page (server-component) layer and assert the rendered
 * destination for BOTH user-count states, plus the bootstrap-form and
 * authenticated-redirect regressions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { NextRequest } from "next/server";

// Mirror Next's redirect() control-flow: it throws, so the page body after a
// redirect never executes. The thrown message carries the destination URL.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// Only generatePermissionsAuthStaticParams consumes authViewPaths; keep the
// test hermetic instead of loading the real better-auth-ui server entry.
vi.mock("@daveyplate/better-auth-ui/server", () => ({
  authViewPaths: { SIGN_IN: "sign-in", SIGN_UP: "sign-up", SIGN_OUT: "sign-out" },
}));

// The real module re-exports @daveyplate/better-auth-ui client components;
// stub them with markers so renderToStaticMarkup output is assertable.
vi.mock("@/components/auth-view-client", () => ({
  AuthView: ({ path }: { path: string }) => <div data-testid="auth-view" data-path={path} />,
  SignUpForm: () => <form data-testid="sign-up-form" />,
}));

vi.mock("@/lib/auth", () => ({
  hasAnyBetterAuthUsers: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(),
}));
// PermissionsAuthPage now reads the closed-registration flag on the display
// side (D7). Mock the instance-mode module so the page stays hermetic (the real
// module is `server-only` + reaches @/lib/database).
vi.mock("@/lib/authz/instance-mode", () => ({
  isRegistrationClosed: vi.fn(),
}));

async function mockAuthState({
  hasUsers,
  session,
  registrationClosed = false,
}: {
  hasUsers: boolean;
  session: unknown;
  registrationClosed?: boolean;
}) {
  const { hasAnyBetterAuthUsers } = await import("@/lib/auth");
  const { getAuthSession } = await import("@/lib/auth-session");
  const { isRegistrationClosed } = await import("@/lib/authz/instance-mode");
  (hasAnyBetterAuthUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(hasUsers);
  (getAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(session);
  (isRegistrationClosed as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(registrationClosed);
}

async function renderAuthPage(path: string): Promise<string> {
  const { PermissionsAuthPage } = await import("@cinatra-ai/permissions/pages");
  const ui = (await PermissionsAuthPage({ params: Promise.resolve({ path }) })) as ReactElement;
  return renderToStaticMarkup(ui);
}

async function expectAuthPageRedirect(path: string, destination: string) {
  const { PermissionsAuthPage } = await import("@cinatra-ai/permissions/pages");
  await expect(
    PermissionsAuthPage({ params: Promise.resolve({ path }) }),
  ).rejects.toThrow(`NEXT_REDIRECT:${destination}`);
}

/** First hop: where does the cookie-less middleware guard send a protected route? */
async function guardDestination(pathname: string): Promise<string | null> {
  const { guardAppRoute } = await import("@/lib/auth-route-guard");
  const response = await guardAppRoute(new NextRequest(`http://localhost:3000${pathname}`));
  const location = response.headers.get("location");
  return location ? new URL(location).pathname : null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fresh install (0 Better Auth users)", () => {
  beforeEach(async () => {
    await mockAuthState({ hasUsers: false, session: null });
  });

  it("unauthenticated visitor to a protected route ends up on /sign-up (full two-hop flow)", async () => {
    // Hop 1 — middleware guard (cookie-only, DB-free) still targets /sign-in.
    expect(await guardDestination("/")).toBe("/sign-in");
    // Hop 2 — the /sign-in page performs the user-count-aware server redirect,
    // so the rendered destination (browser URL) is /sign-up.
    await expectAuthPageRedirect("sign-in", "/sign-up");
  });

  it("visiting /sign-up directly still renders the bootstrap 'Create the first account' form (no redirect loop)", async () => {
    const html = await renderAuthPage("sign-up");
    expect(html).toMatch(/Create the first account/);
    expect(html).toMatch(/data-testid="sign-up-form"/);
  });

  it("sign-out is NOT bounced to /sign-up", async () => {
    const html = await renderAuthPage("sign-out");
    expect(html).toMatch(/data-testid="auth-view"/);
    expect(html).toMatch(/data-path="sign-out"/);
  });
});

describe("established install (>=1 Better Auth user)", () => {
  beforeEach(async () => {
    await mockAuthState({ hasUsers: true, session: null });
  });

  it("unauthenticated visitor to a protected route ends up on /sign-in (no extra hop)", async () => {
    expect(await guardDestination("/")).toBe("/sign-in");
    const html = await renderAuthPage("sign-in");
    expect(html).toMatch(/data-testid="auth-view"/);
    expect(html).toMatch(/data-path="sign-in"/);
    expect(html).not.toMatch(/Create the first account/);
  });
});

describe("authenticated visitor", () => {
  it("is still redirected from /sign-in and /sign-up to / (session redirect precedes the bootstrap hop)", async () => {
    // hasUsers=false on purpose: the session redirect must WIN over the
    // fresh-install /sign-up hop so an authenticated visitor is never
    // bounced into the bootstrap flow.
    await mockAuthState({ hasUsers: false, session: { user: { id: "user-1" } } });
    await expectAuthPageRedirect("sign-in", "/");
    await expectAuthPageRedirect("sign-up", "/");
  });
});

describe("closed registration (D7 display-side notice)", () => {
  it("humans + closed: /sign-up renders the 'Registration is closed' notice, not the sign-up form", async () => {
    await mockAuthState({ hasUsers: true, session: null, registrationClosed: true });
    const html = await renderAuthPage("sign-up");
    expect(html).toMatch(/Registration is closed/);
    // No bootstrap create-first-account form, and no sign-up form is shown.
    expect(html).not.toMatch(/Create the first account/);
    expect(html).not.toMatch(/data-testid="sign-up-form"/);
    // Existing users can still sign in — the login view is mounted under the notice.
    expect(html).toMatch(/data-path="sign-in"/);
  });

  it("humans + closed: /sign-in stays the normal login view (no notice forced there)", async () => {
    await mockAuthState({ hasUsers: true, session: null, registrationClosed: true });
    const html = await renderAuthPage("sign-in");
    expect(html).toMatch(/data-testid="auth-view"/);
    expect(html).toMatch(/data-path="sign-in"/);
    expect(html).not.toMatch(/Registration is closed/);
  });

  it("zero humans + closed: /sign-up STILL shows the bootstrap create-first-account form (bootstrap wins over flag)", async () => {
    await mockAuthState({ hasUsers: false, session: null, registrationClosed: true });
    const html = await renderAuthPage("sign-up");
    expect(html).toMatch(/Create the first account/);
    expect(html).toMatch(/data-testid="sign-up-form"/);
    expect(html).not.toMatch(/Registration is closed/);
  });

  it("humans + open: /sign-up renders the normal sign-up view (regression)", async () => {
    await mockAuthState({ hasUsers: true, session: null, registrationClosed: false });
    const html = await renderAuthPage("sign-up");
    expect(html).toMatch(/data-testid="auth-view"/);
    expect(html).toMatch(/data-path="sign-up"/);
    expect(html).not.toMatch(/Registration is closed/);
  });
});
