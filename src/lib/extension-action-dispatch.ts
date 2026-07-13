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
  /**
   * Whether the addressed install is the package's DEFAULT version. Absent /
   * true → the global ui registry serves (byte-identical pre-S9 behavior). When
   * explicitly `false`, the install is a NON-DEFAULT side-by-side version and
   * its ui action must be served EDGE-BOUND from the version-keyed registry —
   * never the default's action (cinatra#1392 S9 ui-surface serve).
   */
  isDefault?: boolean;
  /** The install's pinned version — required to serve a NON-DEFAULT version. */
  version?: string | null;
};

/**
 * A fail-closed version-keyed ui-action serve decision (cinatra#1392 S9). `serve`
 * carries the retained non-default version's action handler; `refuse` carries the
 * evidence and NEVER a handler, so the dispatch physically cannot fall through to
 * the default version's action for a non-default addressed install.
 */
export type VersionedActionServeResult =
  | { kind: "serve"; handler: (input: unknown) => Promise<unknown> }
  | { kind: "refuse"; code: string; message: string };

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
  /** Look up a registered action by (packageName, actionId) in the global (default) ui registry. */
  resolveAction: (packageName: string, actionId: string) => ExtensionUiAction | null | undefined;
  /**
   * Serve a NON-DEFAULT version's ui action from the version-keyed registry
   * (cinatra#1392 S9). Supplied by the route from `resolveVersionKeyedUiAction`.
   * REQUIRED whenever a non-default install can be addressed; its absence for a
   * non-default row is itself a fail-closed refusal (never a silent default
   * serve). Only consulted when the resolved install row is `isDefault === false`.
   */
  resolveVersionedAction?: (
    packageName: string,
    version: string | null | undefined,
    actionId: string,
  ) => VersionedActionServeResult;
};

export type DispatchExtensionUiActionResult = {
  status: number;
  result?: unknown;
  error?: string;
};

const LIVE_STATUSES = new Set(["active", "locked"]);

/**
 * Map a version-keyed serve refusal to an HTTP-shaped status. A pinned version
 * that simply registered no action under the id is a genuine 404 (no such
 * action for THIS version); every other refusal is torn edge-bound retention
 * (the addressed non-default install exists, but its version's serving state is
 * unpinned / unknown / not-yet-servable) — a 500 server-state error, never a
 * 404 that would read as "the install has no such action".
 */
function statusForVersionedRefuse(code: string): number {
  return code === "NO_SUCH_HANDLER" ? 404 : 500;
}

/**
 * Resolve + run a named extension UI action, fully authorized:
 *  1. 401 when no actor.
 *  2. 404 when the install id maps to no row, the row is not live (archived), or
 *     the actor is not authorized (cross-org / no access — not leaked as 403).
 *  3. When the addressed install is a NON-DEFAULT side-by-side version
 *     (`isDefault === false`), the action is served EDGE-BOUND from the
 *     version-keyed registry, fail-closed — never the default version's action
 *     (cinatra#1392 S9 ui-surface serve): a missing action for the version is a
 *     404; torn retention (unpinned / unknown / not-servable) or an unwired
 *     version-keyed resolver is a 500. A DEFAULT/legacy install keeps the global
 *     registry path (byte-identical pre-S9 behavior).
 *  4. 404 when no action is registered for (packageName, actionId).
 *  5. 200 with the handler's return value on success.
 *  6. 500 with the error message when the handler throws.
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

  // The invocation to run, resolved from the DEFAULT global registry or, for a
  // NON-DEFAULT addressed install, the version-keyed retention (fail-closed).
  // Built as a closure so the DEFAULT path stays a METHOD call on the action
  // object (`action.handler(input)`) — preserving the pre-S9 `this` receiver
  // (the public handler type does not declare `this: void`, so a detached call
  // would change a normal-function handler's receiver — codex S9 round-2) — and
  // the handler-property access stays INSIDE the try below.
  let run: () => unknown | Promise<unknown>;
  if (install.isDefault === false) {
    // A non-default sibling MUST be served its OWN version's retained action —
    // the global registry only holds the default's. Fail-closed: a torn/unwired
    // resolver never falls through to the default.
    if (!deps.resolveVersionedAction) {
      return {
        status: 500,
        error:
          `edge-bound ui serving refused — install "${installId}" (${install.packageName}) is a ` +
          `non-default version but no version-keyed action resolver is wired; refusing rather ` +
          `than serving the default version's action.`,
      };
    }
    const served = deps.resolveVersionedAction(install.packageName, install.version, actionId);
    if (served.kind === "refuse") {
      const status = statusForVersionedRefuse(served.code);
      return {
        status,
        error:
          status === 404
            ? `No registered UI action "${actionId}" for "${install.packageName}@${install.version ?? "(unpinned)"}".`
            : `edge-bound ui serving refused for "${install.packageName}@${install.version ?? "(unpinned)"}" ` +
              `action "${actionId}": ${served.message}`,
      };
    }
    // The version-keyed retained action is a standalone registration (not a
    // method on the resolver result); invoke it detached, matching how
    // `extension-edge-bound-serving.ts` invokes retained handlers.
    const versionedHandler = served.handler;
    run = () => versionedHandler(input);
  } else {
    const action = deps.resolveAction(install.packageName, actionId);
    if (!action) {
      return { status: 404, error: `No registered UI action "${actionId}" for "${install.packageName}".` };
    }
    // METHOD call on the action object — receiver preserved (byte-identical to
    // the pre-S9 `await action.handler(input)`).
    run = () => action.handler(input);
  }

  try {
    const result = await run();
    return { status: 200, result };
  } catch (error) {
    return {
      status: 500,
      error: error instanceof Error ? error.message : "Action handler failed.",
    };
  }
}
