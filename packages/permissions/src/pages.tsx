import { redirect } from "next/navigation";
import { authViewPaths } from "@daveyplate/better-auth-ui/server";
import { AuthView, SignUpForm } from "@/components/auth-view-client";
import { hasAnyBetterAuthUsers } from "@/lib/auth";
import { isRegistrationClosed } from "@/lib/authz/instance-mode";
import { getAuthSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { BrandMark } from "@/components/brand-mark";
import { PasswordToggleA11y } from "@/components/password-toggle-a11y";

export function generatePermissionsAuthStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }));
}

export async function PermissionsAuthPage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  const [{ path }, session, hasUsers, registrationClosed] = await Promise.all([
    params,
    getAuthSession(),
    hasAnyBetterAuthUsers(),
    // DISPLAY-side read only (the real gate is the auth.ts hook — D1/D2).
    // Fail-soft to false (open) so a transient read error never wrongly shows
    // the "closed" notice on an otherwise-open instance (D7).
    isRegistrationClosed().catch(() => false),
  ]);

  if (session && path !== "sign-out") {
    redirect("/");
  }

  // Fresh install (no Better Auth users yet): make /sign-up the canonical URL
  // for the bootstrap state. The middleware route guard (cookie-only, DB-free)
  // still sends sessionless visitors to /sign-in first; this server redirect
  // performs the second hop so the browser lands on /sign-up instead of
  // rendering the sign-up form under the /sign-in URL.
  if (!hasUsers && path === "sign-in") {
    redirect("/sign-up");
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
              <SignUpForm localization={{}} />
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
            <AuthView path="sign-in" />
          </div>
        ) : (
          <PasswordToggleA11y>
            <AuthView path={path} />
          </PasswordToggleA11y>
        )}
      </div>
    </Main>
  );
}
