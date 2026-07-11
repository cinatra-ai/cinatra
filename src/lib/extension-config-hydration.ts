import "server-only";

// Host-owned SERVER-side hydration of a schema-config connector's setup form
// (the owner-ratified opt-in hydration read-action contract; cinatra#1082
// item 3).
//
// A connector that declares `hydrateAction` in its `configSchema` names ONE of
// its `ctx.ui`-registered actions as a side-effect-free READ returning its
// saved NON-SECRET values keyed by field key. The setup route calls this
// resolver while rendering (the browser never drives the hydration flow) and
// threads the result in as `<SchemaConfigConnectorForm initialValues={…}>`.
//
// FAIL-CLOSED at every step — hydration can only ever produce a blank form,
// never an error page and never a hang:
//   - no declaration (opt-out default)            → `{}` (no lookup, no call)
//   - no addressable live install for the actor   → `{}`
//   - declared action not registered              → `{}`
//   - handler throws or times out                 → `{}`
//   - malformed top-level result                  → `{}`
//   - secret / unknown / malformed entries        → dropped (valid entries kept)
// The non-secret boundary is enforced HERE (via the SDK sanitizer + the
// surface-derived key sets), regardless of what the action returns.
//
// Dependency-injected like `extension-action-dispatch.ts` so the logic is
// unit-testable without the in-memory registry: the route supplies
// `resolveAction` (the `extension-ui-registry` read).

import {
  collectHydrationKeySets,
  type SchemaConfigSurface,
} from "@/lib/extension-schema-config";
import { sanitizeConfigHydrationValues } from "@cinatra-ai/sdk-extensions/config-hydration";

export type ResolveSchemaConfigInitialValuesInput = {
  /** The VALIDATED surface (parseSchemaConfig output — never raw JSON). */
  surface: SchemaConfigSurface;
  /** The connector's package name (keys the registered-action lookup). */
  packageName: string;
  /**
   * The actor's addressable ACTIVE install id, or null when the connector is
   * not installed/active for this actor. Consumed only as proof that an
   * authorized, addressable install exists (the render path resolved it
   * actor-scoped via `resolveActiveInstallIdForActor`); the action lookup
   * itself is keyed by `packageName`. Callers must pass the id resolved for
   * the SAME package + actor as the surface being rendered.
   */
  installId: string | null;
};

export type ResolveSchemaConfigInitialValuesDeps = {
  /** Look up a registered `ctx.ui` action — the `extension-ui-registry` read. */
  resolveAction: (
    packageName: string,
    actionId: string,
  ) => { handler: (input: unknown) => Promise<unknown> } | null | undefined;
  /**
   * Upper bound on the handler call so a slow/hung connector read can never
   * suspend the setup page render (timeout → `{}`). The race does NOT cancel
   * the underlying call — one more reason the declared action must be a
   * side-effect-free read. Non-finite/non-positive values fall back to the
   * default. Injectable for tests; production callers omit it.
   */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5000;

/** Unique sentinel so a handler legitimately resolving `undefined`/null is
 *  never mistaken for a timeout. */
const TIMED_OUT: unique symbol = Symbol("schema-config-hydration-timeout");

/**
 * Resolve the `initialValues` map for a schema-config setup form render.
 * Never throws; every failure path resolves `{}` (a blank form).
 */
export async function resolveSchemaConfigInitialValues(
  { surface, packageName, installId }: ResolveSchemaConfigInitialValuesInput,
  deps: ResolveSchemaConfigInitialValuesDeps,
): Promise<Record<string, string>> {
  // Opt-out default: no declaration → blank form, no registry lookup, no call.
  if (!surface.hydrateAction) return {};
  // Not installed/active for this actor → nothing to hydrate (the route shows
  // the Install/Activate CTA instead of the form on this branch anyway).
  if (!installId) return {};

  const action = deps.resolveAction(packageName, surface.hydrateAction);
  if (!action) return {};

  const timeoutMs =
    typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
      ? deps.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      action.handler({}),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === TIMED_OUT) return {};
    return sanitizeConfigHydrationValues(result, collectHydrationKeySets(surface));
  } catch {
    // A throwing handler (or hostile result reflection the sanitizer already
    // guards) fail-closes to a blank form — never to an error page.
    return {};
  } finally {
    // Don't retain the timer once the handler settles.
    if (timer !== undefined) clearTimeout(timer);
  }
}

