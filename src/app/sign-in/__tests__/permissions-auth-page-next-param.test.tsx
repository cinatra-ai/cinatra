/**
 * cinatra#2359 — `PermissionsAuthPage` is the SECOND of the two chokepoints:
 * it must honor a `next` search param post-auth instead of the old hardcoded
 * `/`, thread it into the rendered auth form's `redirectTo` prop so a
 * successful sign-in/sign-up client-side navigates there, and preserve it
 * across the fresh-install sign-in -> sign-up server hop.
 *
 * SECURITY: every one of those three surfaces re-validates `next` itself
 * (never trusts the query param blindly, even though this app is the only
 * writer of it) — a hostile value must degrade to `/` / no `redirectTo`
 * override / a bare `/sign-up`, never get echoed into a redirect Location or
 * a `redirectTo` prop.
 *
 * Mirrors the mock-shape conventions of
 * fresh-install-signup-redirect.test.tsx (same directory) so both files stay
 * hermetic and easy to read side by side.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("@daveyplate/better-auth-ui/server", () => ({
  authViewPaths: { SIGN_IN: "sign-in", SIGN_UP: "sign-up", SIGN_OUT: "sign-out" },
}));

// Stub the client re-exports with markers that surface the `redirectTo` prop
// so tests can assert on it directly.
vi.mock("@/components/auth-view-client", () => ({
  AuthView: ({ path, redirectTo }: { path: string; redirectTo?: string }) => (
    <div data-testid="auth-view" data-path={path} data-redirect-to={redirectTo ?? ""} />
  ),
  SignUpForm: ({ redirectTo }: { redirectTo?: string }) => (
    <form data-testid="sign-up-form" data-redirect-to={redirectTo ?? ""} />
  ),
}));

vi.mock("@/lib/auth", () => ({
  hasAnyBetterAuthUsers: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(),
}));
vi.mock("@/lib/authz/instance-mode", () => ({
  isRegistrationClosed: vi.fn(),
}));

async function mockAuthState({
  hasUsers,
  session,
}: {
  hasUsers: boolean;
  session: unknown;
}) {
  const { hasAnyBetterAuthUsers } = await import("@/lib/auth");
  const { getAuthSession } = await import("@/lib/auth-session");
  const { isRegistrationClosed } = await import("@/lib/authz/instance-mode");
  (hasAnyBetterAuthUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(hasUsers);
  (getAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(session);
  (isRegistrationClosed as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
}

async function renderAuthPage(path: string, next?: string): Promise<string> {
  const { PermissionsAuthPage } = await import("@cinatra-ai/permissions/pages");
  const ui = (await PermissionsAuthPage({
    params: Promise.resolve({ path }),
    searchParams: Promise.resolve(next !== undefined ? { next } : {}),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

async function expectAuthPageRedirect(path: string, next: string | undefined, destination: string) {
  const { PermissionsAuthPage } = await import("@cinatra-ai/permissions/pages");
  await expect(
    PermissionsAuthPage({
      params: Promise.resolve({ path }),
      searchParams: Promise.resolve(next !== undefined ? { next } : {}),
    }),
  ).rejects.toThrow(`NEXT_REDIRECT:${destination}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PermissionsAuthPage — post-auth destination honors ?next= (cinatra#2359)", () => {
  it("an authenticated visitor with a safe next is sent to next, not /", async () => {
    await mockAuthState({ hasUsers: true, session: { user: { id: "user-1" } } });
    await expectAuthPageRedirect("sign-in", "/artifacts", "/artifacts");
  });

  it("an authenticated visitor with NO next still lands on / (unchanged default)", async () => {
    await mockAuthState({ hasUsers: true, session: { user: { id: "user-1" } } });
    await expectAuthPageRedirect("sign-in", undefined, "/");
  });

  it.each([
    ["//evil.com", "protocol-relative"],
    ["https://evil.com", "absolute URL"],
    ["/\\evil.com", "backslash trick"],
  ])("SECURITY: an authenticated visitor with a hostile next (%s — %s) still lands on /, never off-site", async (hostile) => {
    await mockAuthState({ hasUsers: true, session: { user: { id: "user-1" } } });
    await expectAuthPageRedirect("sign-in", hostile, "/");
  });
});

describe("PermissionsAuthPage — threads next into the rendered form's redirectTo (cinatra#2359)", () => {
  it("passes a safe next as AuthView's redirectTo on the sign-in view", async () => {
    await mockAuthState({ hasUsers: true, session: null });
    const html = await renderAuthPage("sign-in", "/connectors/my-connector");
    expect(html).toMatch(/data-redirect-to="\/connectors\/my-connector"/);
  });

  it("SECURITY: a hostile next never reaches AuthView's redirectTo", async () => {
    await mockAuthState({ hasUsers: true, session: null });
    const html = await renderAuthPage("sign-in", "https://evil.com");
    expect(html).toMatch(/data-testid="auth-view"/);
    expect(html).not.toMatch(/evil\.com/);
    expect(html).toMatch(/data-redirect-to=""/);
  });

  it("cinatra#2386: first-admin bootstrap no longer renders SignUpForm HERE — it redirects to /setup/sign-up, next carried on the URL, not a redirectTo prop", async () => {
    await mockAuthState({ hasUsers: false, session: null });
    await expectAuthPageRedirect("sign-up", "/artifacts", "/setup/sign-up?next=%2Fartifacts");
    // The rendered form + its redirectTo threading now live at the new page's
    // own test suite: src/app/setup/sign-up/__tests__/page.test.tsx.
  });
});

describe("PermissionsAuthPage — preserves next across the fresh-install sign-in -> /setup/sign-up hop (cinatra#2359, inverted by cinatra#2386)", () => {
  it("carries a safe next through the bootstrap redirect", async () => {
    await mockAuthState({ hasUsers: false, session: null });
    await expectAuthPageRedirect("sign-in", "/artifacts", "/setup/sign-up?next=%2Fartifacts");
  });

  it("SECURITY: a hostile next is dropped, not carried through the bootstrap redirect", async () => {
    await mockAuthState({ hasUsers: false, session: null });
    await expectAuthPageRedirect("sign-in", "https://evil.com", "/setup/sign-up");
  });

  it("no next present still hops to a bare /setup/sign-up (regression)", async () => {
    await mockAuthState({ hasUsers: false, session: null });
    await expectAuthPageRedirect("sign-in", undefined, "/setup/sign-up");
  });

  it("a direct /sign-up visit also hops to /setup/sign-up while zero users exist (cinatra#2386)", async () => {
    await mockAuthState({ hasUsers: false, session: null });
    await expectAuthPageRedirect("sign-up", "/artifacts", "/setup/sign-up?next=%2Fartifacts");
  });
});
