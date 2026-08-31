// Deeplink: setup-flow S1 (cinatra#2386) — the first-account creation step.
// Re-hosts the shared SignUpForm (the same component /sign-up uses for later
// accounts) inside the standard setup step chrome, with the standard
// "Continue" submit label (via the existing `localization` prop) instead of
// SignUpForm's default "Create an account".
//
// This is the ONLY /setup/* route a sessionless visitor can reach — it is the
// sole entry in PUBLIC_EXACT_PATHS under /setup (src/lib/auth-route-guard.ts).
// Every other /setup/* route stays session-protected.
//
// Routing state matrix (all four states handled below, in order):
//   authenticated               -> force the session/bootstrap read (already
//                                   done by getAuthSession()), then redirect
//                                   to the first incomplete setup step. NEVER
//                                   renders the form for an authenticated
//                                   visitor — covers the session-exists-and-
//                                   users==1 case too.
//   humans exist + sessionless  -> redirect to /sign-in with a sanitized
//                                   `next` (this is no longer the bootstrap
//                                   surface once an account exists).
//   zero humans + sessionless   -> renders the step (this is the fresh-
//                                   instance path).
//   reload / double-submit      -> idempotent: once the just-submitted
//                                   account creates a session, EVERY
//                                   subsequent render of this page takes the
//                                   "authenticated" branch above and redirects
//                                   forward — the completed form is never
//                                   re-rendered.
//
// SESSIONLESS CHROME: this page (like its parent layout,
// src/app/setup/layout.tsx) only ever reads getAuthSession() /
// hasAnyBetterAuthUsers() before an account exists — never
// getSetupWizardSteps()/the readiness reader (no setup-status work, no
// readiness disclosure to an unauthenticated visitor). That call is used
// ONLY inside the `if (session)` branch below, which by definition is no
// longer sessionless.
//
// PasswordToggleA11y (cinatra#484) is retained, matching /sign-up.
//
// REGISTRATION CHOICE: a new instance is closed — nobody but this first account
// can be created until someone says otherwise. This step is where that answer
// is given, through the opt-in control in ./bootstrap-registration-choice.tsx
// (off by default). Nothing is written to the instance here: the answer waits
// in the operator's own browser and is applied with the admin account this step
// creates (src/lib/bootstrap-registration-choice.ts), so a passer-by can never
// leave an open door behind on an instance that is not theirs. It stays
// changeable afterwards on the access-control screen, which owns the setting
// from then on.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { hasAnyBetterAuthUsers } from "@/lib/auth";
import { getAuthSession } from "@/lib/auth-session";
import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";
import { buildSignInPath, sanitizeNextPath } from "@/lib/auth-redirect-target";
import { SignUpForm } from "@/components/auth-view-client";
import { readBootstrapRegistrationChoice } from "@/lib/bootstrap-registration-choice";
import { BootstrapRegistrationChoice } from "./bootstrap-registration-choice";
import { PasswordToggleA11y } from "@/components/password-toggle-a11y";

export const metadata: Metadata = { title: "Setup: Account" };

// cinatra#2477 (owner acceptance review) — the SignUpForm submit IS this
// step's Continue, so it must look like every other setup step's Continue:
// right-aligned with the trailing arrow. better-auth-ui renders
// `localization.SIGN_UP_ACTION` directly (and solely) as the submit button's
// children, so a ReactNode passes through and renders like the other steps'
// `Continue <ArrowRight/>` children; the localization slot is TYPED as a
// plain string, hence the cast. The button's base classes already carry
// `gap-2` and size the svg, matching the wizard's own Button.
const SETUP_SIGN_UP_CONTINUE_LABEL = (
  <>
    Continue
    <ArrowRight className="size-4" />
  </>
) as unknown as string;

type SetupSignUpPageProps = {
  searchParams?: Promise<{ next?: string }>;
};

export default async function SetupSignUpPage({ searchParams }: SetupSignUpPageProps) {
  const sp = await (searchParams ?? Promise.resolve<{ next?: string }>({}));

  // getAuthSession() runs the same first-admin-bootstrap enrichment
  // requireAuthSession() does (src/lib/auth-session.ts) — an authenticated
  // caller is fully resolved (admin/org bootstrap included) before the
  // redirect below.
  const [session, hasUsers] = await Promise.all([getAuthSession(), hasAnyBetterAuthUsers()]);

  if (session) {
    // Authenticated visitor: never render the bootstrap form. Forward into
    // the wizard's real, live step rail (a DB/readiness read is legitimate
    // here — the caller is no longer sessionless).
    const steps = await getSetupWizardSteps();
    const next = getFirstIncompleteStep(steps);
    redirect(next?.href ?? "/setup/complete");
  }

  if (hasUsers) {
    // Sessionless, but at least one account already exists: this is no
    // longer the bootstrap surface. Send the visitor to the real sign-in,
    // preserving a sanitized `next` (buildSignInPath re-validates it itself).
    redirect(buildSignInPath(sp.next));
  }

  // Zero humans + sessionless: render the bootstrap step. The post-success
  // destination is the next incomplete setup step, reached through the
  // landed redirectTo/sanitized-next machinery: a caller-supplied `next` is
  // honored if safe (the same "as-is" contract /sign-up already has), else
  // it defaults to /setup, which resolves the first incomplete step under
  // the now-authenticated session — never an arbitrary off-wizard target,
  // since nothing else is reachable until setup completes anyway.
  //
  // A `next` of exactly "/" is treated the same as absent: the caller (the
  // packages/permissions/src/pages.tsx sign-in -> sign-up hop) already drops
  // it before it reaches here, but this stays defensive against any OTHER
  // caller landing here with ?next=%2F — nothing exists at "/" for an admin
  // who just created the very first account, so redirecting there is never
  // more meaningful than going straight into the wizard, and it would only
  // add an extra hop back through "/"'s own incomplete-setup redirect.
  // The answer this browser has already given, if any — a reload shows what
  // the operator said, not a fresh OFF.
  const heldChoice = await readBootstrapRegistrationChoice();

  const safeNext = sanitizeNextPath(sp.next);
  const redirectTarget = safeNext && safeNext !== "/" ? safeNext : "/setup";

  return (
    <div className="grid gap-5">
      <div>
        <p className="text-base font-semibold text-foreground">Create the first account</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          This workspace has no users yet. The first account registered here becomes the initial
          full-access admin automatically.
        </p>
      </div>
      <div className="mx-auto w-full max-w-md">
        {/* The instance is closed to everyone but this first account until the
            operator says otherwise. The choice is offered here, on the step
            that creates that first account, and it starts OFF. */}
        <BootstrapRegistrationChoice initialOpen={heldChoice === "open"}>
          <PasswordToggleA11y>
            {/* cinatra#2477 — `justify-self-end w-auto` right-aligns the submit
                inside the form's grid (twMerge lets `w-auto` supersede the
                form's default full-width button), Continue-button parity with
                the other setup steps. */}
            <SignUpForm
              classNames={{ primaryButton: "w-auto justify-self-end" }}
              localization={{ SIGN_UP_ACTION: SETUP_SIGN_UP_CONTINUE_LABEL }}
              redirectTo={redirectTarget}
            />
          </PasswordToggleA11y>
        </BootstrapRegistrationChoice>
      </div>
    </div>
  );
}
