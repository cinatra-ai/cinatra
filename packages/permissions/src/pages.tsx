import { redirect } from "next/navigation";
import { authViewPaths } from "@daveyplate/better-auth-ui/server";
import { AuthView, SignUpForm } from "@/components/auth-view-client";
import { hasAnyBetterAuthUsers } from "@/lib/auth";
import { isRegistrationClosed } from "@/lib/authz/instance-mode";
import { getAuthSession } from "@/lib/auth-session";
import { resolvePostAuthDestination, buildSetupSignUpPath, sanitizeNextPath } from "@/lib/auth-redirect-target";
import { Main } from "@/components/layout/main";
import { BrandMark } from "@/components/brand-mark";
import { PasswordToggleA11y, ForgotPasswordBelowField } from "@/components/password-toggle-a11y";
import { FORGOT_PASSWORD_LINK_CLASS } from "@/lib/password-toggle-a11y";

export function generatePermissionsAuthStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

export async function PermissionsAuthPage({
  params,
  searchParams,
}: {
  params: Promise<{ path: string }>;
  // cinatra#2359 — `next` carries the destination the caller was headed to
  // before being bounced here. `guardAppRoute` / `requireAuthSession` (and the
  // ad hoc gates that mirror it) are the only writers of this param; it is
  // re-validated here regardless (never trust a query param, even one this
  // app minted, without checking it at the point of use).
  searchParams?: Promise<{ next?: string }>;
}) {
  const [{ path }, sp, session, hasUsers, registrationClosed] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<{ next?: string }>({}),
    getAuthSession(),
    hasAnyBetterAuthUsers(),
    // DISPLAY-side read only (the real gate is the auth.ts hook — D1/D2).
    // Fail-soft to false (open) so a transient read error never wrongly shows
    // the "closed" notice on an otherwise-open instance (D7).
    isRegistrationClosed().catch(() => false),
  ]);

  // SECURITY: only a same-origin relative path is ever honored — see
  // isSafeNextPath's doc comment for the exact open-redirect vectors it
  // rejects (protocol-relative //, absolute/scheme URLs, backslash tricks).
  const rawNext = sp.next;
  const safeNext = sanitizeNextPath(rawNext);

  if (session && path !== "sign-out") {
    redirect(resolvePostAuthDestination(safeNext));
  }

  // Fresh install (no Better Auth users yet): the bootstrap step now lives in
  // the setup wizard (cinatra#2386), not at this bare auth-page URL. The
  // middleware route guard (cookie-only, DB-free) still sends sessionless
  // visitors to /sign-in first; this server redirect performs the second hop
  // so the browser lands on /setup/sign-up instead of rendering the sign-up
  // form here — whether the visitor was headed to /sign-in OR typed /sign-up
  // directly. Carry `next` across the hop (cinatra#2359) — otherwise this
  // bootstrap redirect would drop it even though the sign-in <-> sign-up
  // client-side toggle preserves it. Once at least one user exists, /sign-up
  // resumes serving later accounts here, unchanged.
  //
  // A `next` of exactly "/" is dropped rather than carried: the route guard
  // (auth-route-guard.ts) always stamps `?next=<currentPath>` on its /sign-in
  // redirect, even for the plain, common case of a sessionless GET / — so
  // "/" here carries no more caller intent than "no next at all" would, and
  // /setup/sign-up's own redirectTo default already resolves the no-next
  // case straight into the wizard (see src/app/setup/sign-up/page.tsx). This
  // keeps the landing URL a clean, query-free /setup/sign-up for the common
  // root-visit case instead of a redundant /setup/sign-up?next=%2F.
  if (!hasUsers && (path === "sign-in" || path === "sign-up")) {
    redirect(buildSetupSignUpPath(rawNext === "/" ? undefined : rawNext));
  }

  const showBootstrapRegistration = !hasUsers && path !== "sign-out";

  // D7 state machine:
  //   zero humans            → bootstrap create-first-account (above), regardless of flag.
  //   humans + closed + /sign-up → "Registration is closed" notice instead of the form.
  //   humans + closed + /sign-in → login-only (the signup footer is hidden by the
  //                                root AuthUIProvider's signUp={false}; nothing to do here).
  //   humans + open          → existing behavior.
  const showRegistrationClosedNotice =
    hasUsers && registrationClosed && path === "sign-up";

  return (
    <Main className="flex min-h-screen items-start justify-center pt-10">
      <div className="flex w-full max-w-md flex-col items-center">
        <div className="mb-8 flex items-center">
          <BrandMark size={30} />
        </div>
        {showBootstrapRegistration ? (
          <div className="grid gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Setup</p>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Create the first account</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                This workspace has no users yet. The first account registered here becomes the initial full-access admin automatically.
              </p>
            </div>
            {/* cinatra#484: keep the better-auth-ui password show/hide toggle out
                of the Tab flow and give it an accessible name. */}
            <PasswordToggleA11y>
              <SignUpForm localization={{}} redirectTo={safeNext} />
            </PasswordToggleA11y>
          </div>
        ) : showRegistrationClosedNotice ? (
          <div className="grid gap-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Registration closed</p>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Registration is closed</h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                New account registration is closed on this instance. Contact your administrator to request access. Existing users can sign in below.
              </p>
            </div>
            {/* cinatra#883: keep the "Forgot your password?" link directly
                below the password field here too. */}
            <ForgotPasswordBelowField>
              <AuthView path="sign-in" redirectTo={safeNext} classNames={{ form: { forgotPasswordLink: FORGOT_PASSWORD_LINK_CLASS } }} />
            </ForgotPasswordBelowField>
          </div>
        ) : (
          // cinatra#883: reposition "Forgot your password?" below the
          // password field (better-auth-ui hard-codes it inline with the
          // label; classNames.form.forgotPasswordLink is only a style hook,
          // not a position override).
          <ForgotPasswordBelowField>
            <PasswordToggleA11y>
              <AuthView path={path} redirectTo={safeNext} classNames={{ form: { forgotPasswordLink: FORGOT_PASSWORD_LINK_CLASS } }} />
            </PasswordToggleA11y>
          </ForgotPasswordBelowField>
        )}
      </div>
    </Main>
  );
}
