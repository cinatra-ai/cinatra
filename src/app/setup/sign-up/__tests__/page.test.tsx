/**
 * cinatra#2386 (setup-flow S1) — /setup/sign-up routing state matrix.
 *
 * The four states this page must handle, in the order it checks them:
 *   1. authenticated                -> redirect to the first incomplete
 *                                       setup step, NEVER render the form
 *                                       (covers session-exists-users==1 too).
 *   2. humans exist + sessionless   -> redirect to /sign-in with a sanitized
 *                                       `next` (no longer the bootstrap
 *                                       surface once an account exists).
 *   3. zero humans + sessionless    -> renders the bootstrap step, with the
 *                                       standard "Continue" submit label and
 *                                       a redirectTo honoring a safe `next`
 *                                       (falling back to /setup, the next
 *                                       incomplete step, when absent).
 *   4. reload / double-submit       -> idempotent: once a session exists,
 *                                       state 1 always wins — the completed
 *                                       form is never re-rendered.
 *
 * Mirrors the mock-shape conventions of
 * src/app/sign-in/__tests__/fresh-install-signup-redirect.test.tsx and
 * permissions-auth-page-next-param.test.tsx so the whole sign-up surface
 * stays consistent and easy to read side by side.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// Stub the client re-export with a marker that surfaces the props tests care
// about (localization + redirectTo), mirroring the sign-in test suites.
vi.mock("@/components/auth-view-client", () => ({
  SignUpForm: ({
    localization,
    redirectTo,
  }: {
    localization?: { SIGN_UP_ACTION?: string };
    redirectTo?: string;
  }) => (
    <form
      data-testid="sign-up-form"
      data-redirect-to={redirectTo ?? ""}
      data-submit-label={localization?.SIGN_UP_ACTION ?? ""}
    />
  ),
}));

vi.mock("@/lib/auth", () => ({
  hasAnyBetterAuthUsers: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(),
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn(),
  getFirstIncompleteStep: vi.fn(),
}));

async function mockState({
  hasUsers,
  session,
  steps = [],
  firstIncomplete = null,
}: {
  hasUsers: boolean;
  session: unknown;
  steps?: unknown[];
  firstIncomplete?: { id: string; href: string } | null;
}) {
  const { hasAnyBetterAuthUsers } = await import("@/lib/auth");
  const { getAuthSession } = await import("@/lib/auth-session");
  const { getSetupWizardSteps, getFirstIncompleteStep } = await import("@/lib/setup-wizard");
  (hasAnyBetterAuthUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(hasUsers);
  (getAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(session);
  (getSetupWizardSteps as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(steps);
  (getFirstIncompleteStep as unknown as ReturnType<typeof vi.fn>).mockReturnValue(firstIncomplete);
}

async function renderPage(next?: string): Promise<string> {
  const { default: SetupSignUpPage } = await import("../page");
  const ui = (await SetupSignUpPage({
    searchParams: Promise.resolve(next !== undefined ? { next } : {}),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

async function expectPageRedirect(next: string | undefined, destination: string) {
  const { default: SetupSignUpPage } = await import("../page");
  await expect(
    SetupSignUpPage({
      searchParams: Promise.resolve(next !== undefined ? { next } : {}),
    }),
  ).rejects.toThrow(`NEXT_REDIRECT:${destination}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("state 1: authenticated visitor", () => {
  it("redirects to the first incomplete setup step, never renders the form", async () => {
    await mockState({
      hasUsers: true,
      session: { user: { id: "user-1" } },
      firstIncomplete: { id: "key", href: "/setup/key" },
    });
    await expectPageRedirect(undefined, "/setup/key");
  });

  it("falls back to /setup/complete when every step is already ready", async () => {
    await mockState({ hasUsers: true, session: { user: { id: "user-1" } }, firstIncomplete: null });
    await expectPageRedirect(undefined, "/setup/complete");
  });

  it("covers the session-exists-but-users-was-stale==1 case: session always wins, regardless of hasUsers", async () => {
    await mockState({
      hasUsers: false,
      session: { user: { id: "user-1" } },
      firstIncomplete: { id: "key", href: "/setup/key" },
    });
    await expectPageRedirect(undefined, "/setup/key");
  });

  it("idempotent reload/double-submit: a session from a just-created account always redirects forward, never re-renders", async () => {
    await mockState({
      hasUsers: true,
      session: { user: { id: "user-1" } },
      firstIncomplete: { id: "name", href: "/setup/name" },
    });
    await expectPageRedirect(undefined, "/setup/name");
  });
});

describe("state 2: humans exist + sessionless", () => {
  it("redirects to /sign-in (no longer the bootstrap surface)", async () => {
    await mockState({ hasUsers: true, session: null });
    await expectPageRedirect(undefined, "/sign-in");
  });

  it("preserves a safe next on the /sign-in redirect", async () => {
    await mockState({ hasUsers: true, session: null });
    await expectPageRedirect("/artifacts", "/sign-in?next=%2Fartifacts");
  });

  it("SECURITY: a hostile next is dropped, never reaches the /sign-in redirect", async () => {
    await mockState({ hasUsers: true, session: null });
    await expectPageRedirect("https://evil.com", "/sign-in");
  });
});

describe("state 3: zero humans + sessionless — renders the bootstrap step", () => {
  it("renders the SignUpForm with the standard Continue submit label", async () => {
    await mockState({ hasUsers: false, session: null });
    const html = await renderPage();
    expect(html).toMatch(/Create the first account/);
    expect(html).toMatch(/data-testid="sign-up-form"/);
    expect(html).toMatch(/data-submit-label="Continue"/);
  });

  it("defaults redirectTo to /setup (the next incomplete step) when no next is supplied", async () => {
    await mockState({ hasUsers: false, session: null });
    const html = await renderPage();
    expect(html).toMatch(/data-redirect-to="\/setup"/);
  });

  it("honors a safe caller-supplied next as redirectTo (sanitized-next machinery consumed as-is)", async () => {
    await mockState({ hasUsers: false, session: null });
    const html = await renderPage("/artifacts");
    expect(html).toMatch(/data-redirect-to="\/artifacts"/);
  });

  it("SECURITY: a hostile next never reaches redirectTo — falls back to /setup", async () => {
    await mockState({ hasUsers: false, session: null });
    const html = await renderPage("https://evil.com");
    expect(html).not.toMatch(/evil\.com/);
    expect(html).toMatch(/data-redirect-to="\/setup"/);
  });

  it("treats a next of exactly '/' the same as absent — defensive against any caller landing here with ?next=%2F (CI prod-boot-e2e follow-up, cinatra#2386)", async () => {
    await mockState({ hasUsers: false, session: null });
    const html = await renderPage("/");
    expect(html).toMatch(/data-redirect-to="\/setup"/);
  });
});
