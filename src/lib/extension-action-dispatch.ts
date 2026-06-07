import "server-only";

// Host-owned dispatch for named extension UI actions.
//
// Extensions never define their own Next.js Server Actions. Instead, an
// extension declares named actions at `register(ctx)` via `ctx.ui`
// (recorded in `src/lib/extension-ui-registry.ts`, keyed by packageName +
// actionId). The host owns ONE generic Route Handler that resolves an action
// by INSTALLED-EXTENSION id and runs its handler.
//
// AUTHORIZATION: an authenticated session is necessary but NOT sufficient. The
// dispatch resolves the canonical install row, requires it to be live
// (active|locked — never an archived row), and enforces the uniform extension
// access policy for the actor (cross-org / no-access map to 404 so existence
// isn't leaked). Only then is the registered action handler invoked.
//
// Pure + dependency-injected so it is unit-testable without a live DB, the
// in-memory registry, or the kernel: the route supplies `resolveInstall`
// (canonical-store read), `authorize` (the uniform-access check), `resolveAction`
// (registry read), and a pre-resolved `actor`.

import type { ExtensionUiAction } from "@/lib/extension-ui-registry";

/** The canonical install row fields the dispatch + authz need. */
export type DispatchInstallRow = {
  packageName: string;
  status: string;
};

export type DispatchExtensionUiActionInput = {
  installId: string;
  actionId: string;
  input: unknown;
  /**
   * The resolved actor for the current request, or `null` when no auth session
   * could be resolved. Passing `null` yields a 401-shaped result.
   */
  actor: unknown;
};

export type DispatchExtensionUiActionDeps = {
  /** Resolve an installed-extension id → the canonical row (or null if missing). */
  resolveInstall: (installId: string) => Promise<DispatchInstallRow | null>;
  /**
   * Authorize the actor against the install row under the uniform extension
   * access policy. Returns false for a cross-org / no-access actor (the dispatch
   * maps that to 404, not 403, so existence is not leaked across orgs).
   */
  authorize: (install: DispatchInstallRow, actor: unknown) => Promise<boolean>;
  /** Look up a registered action by (packageName, actionId). */
  resolveAction: (packageName: string, actionId: string) => ExtensionUiAction | null | undefined;
};

export type DispatchExtensionUiActionResult = {
  status: number;
  result?: unknown;
  error?: string;
};

const LIVE_STATUSES = new Set(["active", "locked"]);

/**
 * Resolve + run a named extension UI action, fully authorized:
 *  1. 401 when no actor.
 *  2. 404 when the install id maps to no row, the row is not live (archived), or
 *     the actor is not authorized (cross-org / no access — not leaked as 403).
 *  3. 404 when no action is registered for (packageName, actionId).
 *  4. 200 with the handler's return value on success.
 *  5. 500 with the error message when the handler throws.
 */
export async function dispatchExtensionUiAction(
  { installId, actionId, input, actor }: DispatchExtensionUiActionInput,
  deps: DispatchExtensionUiActionDeps,
): Promise<DispatchExtensionUiActionResult> {
  if (!actor) {
    return { status: 401, error: "Authentication required." };
  }

  const install = await deps.resolveInstall(installId);
  // A missing row, a non-live row, and an unauthorized actor all map to the SAME
  // 404 — never reveal that an install exists to someone who can't access it.
  const notFound: DispatchExtensionUiActionResult = {
    status: 404,
    error: `No accessible installed extension for id "${installId}".`,
  };
  if (!install) return notFound;
  if (!LIVE_STATUSES.has(install.status)) return notFound;
  if (!(await deps.authorize(install, actor))) return notFound;

  const action = deps.resolveAction(install.packageName, actionId);
  if (!action) {
    return { status: 404, error: `No registered UI action "${actionId}" for "${install.packageName}".` };
  }

  try {
    const result = await action.handler(input);
    return { status: 200, result };
  } catch (error) {
    return {
      status: 500,
      error: error instanceof Error ? error.message : "Action handler failed.",
    };
  }
}
