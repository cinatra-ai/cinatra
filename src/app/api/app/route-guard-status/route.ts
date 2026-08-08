// The shell's fresh-state reconciliation source.
//
// cinatra#2544 — the root layout's `connectionReady` is a snapshot taken at the
// last full document load, and the App Router does not re-render a root layout
// on client navigation. AppShell therefore treats that prop as a first-paint
// hint and asks THIS route for the authoritative verdict before it redirects
// anyone to /setup (see `useSetupRedirectGate` in src/components/app-shell.tsx).
//
// It answers with the SAME gate the root layout evaluates — `evaluateSetupGate`
// — so the two can never re-create the split-brain #2503 closed. That means
// three states, not two: an errored read is `indeterminate`, never `incomplete`.
// The client refuses to redirect off anything but a determinate `incomplete`.
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { evaluateSetupGate, type SetupGateState } from "@/lib/setup-wizard";

export type RouteGuardStatus = {
  authenticated: boolean;
  /**
   * Pre-existing field, meaning unchanged: true only on a successfully-read
   * COMPLETE gate. Kept so any client reading just this boolean is unaffected.
   * A caller that must distinguish "not set up" from "could not find out" reads
   * `setupGate` instead — that is what it is for.
   */
  setupComplete: boolean;
  /**
   * cinatra#2544 — the tri-state gate. Absent on the sessionless branch, which
   * deliberately discloses nothing about this instance's configuration state.
   */
  setupGate?: SetupGateState;
};

export async function GET() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    // Unchanged, byte for byte. `setupComplete: false` here has never meant
    // "this instance is not set up" — it means "no session, nothing to tell
    // you" — and the gate is deliberately NOT disclosed to an anonymous caller.
    // The shell never consults this branch: a sessionless visitor on an app
    // route is 307'd to /sign-in by the auth route guard long before the shell
    // could ask, and /sign-in is one of the paths the shell never redirects
    // away from.
    return NextResponse.json<RouteGuardStatus>({
      authenticated: false,
      setupComplete: false,
    });
  }

  // `evaluateSetupGate()` cannot reject — it converts its own read failure into
  // `indeterminate` — so this route no longer 500s on a transient DB blip. That
  // matters: a 500 is indistinguishable from a network failure at the client,
  // and both used to collapse into the same "assume not set up" guess that the
  // redirect loop is made of.
  const setupGate = await evaluateSetupGate();

  return NextResponse.json<RouteGuardStatus>({
    authenticated: true,
    setupComplete: setupGate === "complete",
    setupGate,
  });
}
