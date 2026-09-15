// ---------------------------------------------------------------------------
// The first-account step's registration answer, held in the operator's own
// browser until somebody exists who can own it.
//
// A brand-new instance is closed. The person setting it up is offered the
// choice to open it on the very step that creates the first account — but at
// that moment nobody has an account yet, so nobody can prove they are this
// instance's operator: that step is reachable by anyone who can reach the
// instance at all. Writing the answer straight into the instance there would
// let a passer-by open registration on somebody else's new instance and walk
// away, leaving the real operator with an open door they never asked for.
//
// So the answer is kept in a short-lived cookie in the browser that gave it,
// and it reaches the instance only once that same browser carries the session
// of a full-access admin — which, on the first-account step, is the account the
// operator has just created. An answer that is never followed by that session
// never reaches the instance, and the instance stays closed.
//
// The answer is applied at most once: it is ignored as soon as the instance
// carries a recorded answer of its own, so it can never reopen an instance an
// admin has since closed on the access-control screen.
// ---------------------------------------------------------------------------
import "server-only";

import { cookies } from "next/headers";

import { isPlatformAdmin } from "@/lib/auth-session";
import { setRegistrationClosed } from "@/lib/authz/instance-mode";

export const BOOTSTRAP_REGISTRATION_CHOICE_COOKIE = "cinatra_bootstrap_registration";

/** Long enough to finish creating the first account, short enough to be gone after that. */
export const BOOTSTRAP_REGISTRATION_CHOICE_MAX_AGE_SECONDS = 30 * 60;

export type BootstrapRegistrationChoice = "open" | "closed";

/** Hold the operator's answer in their own browser. */
export async function writeBootstrapRegistrationChoice(
  choice: BootstrapRegistrationChoice,
): Promise<void> {
  const jar = await cookies();
  jar.set(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE, choice, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: BOOTSTRAP_REGISTRATION_CHOICE_MAX_AGE_SECONDS,
  });
}

/** The held answer, or null when there is none (anything unrecognised is none). */
export async function readBootstrapRegistrationChoice(): Promise<BootstrapRegistrationChoice | null> {
  try {
    const value = (await cookies()).get(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE)?.value;
    if (value === "open") return "open";
    if (value === "closed") return "closed";
    return null;
  } catch {
    return null;
  }
}

export async function clearBootstrapRegistrationChoice(): Promise<void> {
  try {
    (await cookies()).delete(BOOTSTRAP_REGISTRATION_CHOICE_COOKIE);
  } catch {
    // Cookies can only be changed from an action or a route handler. When the
    // caller is a page render there is nothing to do: the answer is applied at
    // most once anyway, because a recorded answer wins over a held one.
  }
}

/** Does the instance already carry an answer of its own? */
async function hasRecordedRegistrationAnswer(): Promise<boolean> {
  const { readConnectorConfigFromDatabase } = await import("@/lib/database");
  const cfg = readConnectorConfigFromDatabase<Record<string, unknown> | null>(
    "instance_identity",
    null,
  );
  return Boolean(cfg) && Object.prototype.hasOwnProperty.call(cfg, "closedRegistration");
}

/**
 * Write a held answer into the instance, if the caller is entitled to it.
 *
 * Returns true only when the instance was actually changed. Every refusal and
 * every failure is silent and leaves the instance untouched — which means
 * closed, the safe answer — because this runs inside a page render that must
 * not break over it.
 */
export async function applyPendingBootstrapRegistrationChoice(
  session: { user?: { role?: string | null } | null } | null | undefined,
): Promise<boolean> {
  try {
    if (!isPlatformAdmin(session)) return false;

    const choice = await readBootstrapRegistrationChoice();
    if (!choice) return false;

    if (await hasRecordedRegistrationAnswer()) {
      await clearBootstrapRegistrationChoice();
      return false;
    }

    await setRegistrationClosed(choice !== "open");
    await clearBootstrapRegistrationChoice();
    return true;
  } catch {
    return false;
  }
}
