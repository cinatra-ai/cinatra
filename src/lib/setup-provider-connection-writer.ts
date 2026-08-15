import "server-only";

/**
 * HOST-OWNED TYPED SETUP CONNECTION WRITER (cinatra#2390, epic #2385 S5).
 *
 * THE PROBLEM. The setup AI step's credential forms posted to a connector-owned
 * server action that reported failure by REDIRECTING with its error message in
 * the URL. The host setup flash channel is deliberately codes-only, so that
 * text was never rendered — and provider error text should not travel in URLs
 * at all (referrer leakage, history persistence, log lines).
 *
 * THE SHAPE. The connector already registers a NON-REDIRECTING `saveConnection`
 * UI action at `register(ctx)` (the same one its schema-config admin surface
 * dispatches), reusing its validation / connection-service sync / persistence.
 * This writer dispatches that registered action through the host's
 * installed-extension dispatch — the exact authorization pipeline the
 * `/api/extensions/[installId]/actions/[actionId]` route runs — validates the
 * UNTRUSTED result shape, sanitizes any raw error text SERVER-side, and
 * returns `{ok, code, sanitizedMessage}`. No redirect. No error text in any
 * URL. The caller (a setup server action consumed via `useActionState`) hands
 * the sanitized copy to a client toast island.
 *
 * TRUST BOUNDARY. The dispatched handler is EXTENSION code: its return value
 * and its thrown messages are untrusted. Result interpretation is therefore
 * fail-closed — only the known banner names map to success — and every string
 * that could carry provider-echoed content passes through the sanitizer before
 * it becomes part of the typed result.
 */

import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import { canExtensionAccess } from "@cinatra-ai/extensions/enforce-extension-access";
import { applyInstallRowPrecedence } from "@cinatra-ai/extensions/static-bundle-anchor";
import { dispatchExtensionUiAction } from "@/lib/extension-action-dispatch";
import { resolveExtensionUiAction } from "@/lib/extension-ui-registry";
import { resolveVersionKeyedUiAction } from "@/lib/extension-version-keyed-serving";
import { resolveExtensionActorContext } from "@/lib/extension-host-actor";
// The connector PACKAGE identity is resolved from the provider's LIVE
// `llm-provider-surface` capability registration — core never names a concrete
// extension package (the core→extension instance-coupling ban, pinned empty).
import { getLlmProviderSurfacePackageName } from "@/lib/llm-provider-surfaces";
import { sanitizeReadinessMessage } from "@/lib/setup-readiness-saga";
// Side-effect import: loads the host extension wiring so `ctx.ui` action
// registrations exist in THIS graph (mirrors the dispatch route).
import "@/lib/extensions";

/** The providers the setup wizard's typed writer serves. */
export type SetupConnectionProvider = "openai" | "anthropic";

/**
 * The typed result every setup save path returns. `code` is a STABLE
 * machine-readable identifier; the writer itself emits `saved`,
 * `saved-degraded` (validated + saved, connection-service copy incomplete),
 * `connector-unavailable`, `save-rejected`, and `save-failed`, and the setup
 * actions layered on top add their own (e.g. `consent-required`).
 * `sanitizedMessage` is the ONLY operator-facing text and has always passed
 * the server-side sanitizer when it could carry provider-echoed content.
 */
export type SetupConnectionSaveResult =
  | { ok: true; code: "saved" | "saved-degraded"; sanitizedMessage: string | null }
  | { ok: false; code: string; sanitizedMessage: string };

/** The degraded-save operator copy (static — mirrors the connector's own
 *  `savedWithoutConnectionService` banner semantics without trusting its text). */
const SAVED_DEGRADED_MESSAGE =
  "The key was validated and saved, but the connection-service copy did not complete. " +
  "The provider works now; check the connection service and save again so the copy is re-made.";

type DispatchDeps = Parameters<typeof dispatchExtensionUiAction>[1];

export type SaveSetupProviderConnectionDeps = {
  /** providerId → the registering connector's package name (live capability
   *  registration), or null when the provider's connector is absent. */
  resolvePackageName: (providerId: string) => string | null;
  resolveInstallRows: typeof readInstalledExtensionsByPackageName;
  resolveActor: () => Promise<unknown>;
  dispatch: (
    input: Parameters<typeof dispatchExtensionUiAction>[0],
    deps: DispatchDeps,
  ) => ReturnType<typeof dispatchExtensionUiAction>;
};

function defaultDeps(): SaveSetupProviderConnectionDeps {
  return {
    resolvePackageName: getLlmProviderSurfacePackageName,
    resolveInstallRows: readInstalledExtensionsByPackageName,
    resolveActor: resolveExtensionActorContext,
    dispatch: dispatchExtensionUiAction,
  };
}

const LIVE_STATUSES = new Set(["active", "locked"]);

/**
 * Interpret the UNTRUSTED handler result. Only `{banner: "saved"}` and
 * `{banner: "savedWithoutConnectionService"}` are success — everything else
 * (unknown banner, `{banner:"error"}`, no banner at all) is a rejection with
 * STATIC copy, never text lifted from the untrusted result object.
 */
function interpretActionResult(result: unknown): SetupConnectionSaveResult {
  const banner =
    result && typeof result === "object" && "banner" in result
      ? (result as { banner?: unknown }).banner
      : null;
  if (banner === "saved") return { ok: true, code: "saved", sanitizedMessage: null };
  if (banner === "savedWithoutConnectionService") {
    return { ok: true, code: "saved-degraded", sanitizedMessage: SAVED_DEGRADED_MESSAGE };
  }
  return {
    ok: false,
    code: "save-rejected",
    sanitizedMessage:
      "The connector did not accept the connection settings. Check the key and try again.",
  };
}

/**
 * Dispatch the connector's registered non-redirecting `saveConnection` action
 * and return the typed, sanitized outcome.
 *
 * AUTHORIZATION is the dispatch pipeline's, unchanged: resolved actor, live
 * canonical install row, uniform extension access ("use" tier), and the
 * registered handler's own gate (the connector's action cores keep their
 * fail-closed admin gate). The caller additionally holds an admin session —
 * setup actions require one before ever reaching this writer.
 */
export async function saveSetupProviderConnection(
  provider: SetupConnectionProvider,
  values: Record<string, string>,
  deps: SaveSetupProviderConnectionDeps = defaultDeps(),
): Promise<SetupConnectionSaveResult> {
  // The registering connector's package identity, off the LIVE capability
  // registration. Absent → the connector is not installed/active, which is
  // the same degraded state every other consumer of the surface reports.
  const packageName = deps.resolvePackageName(provider);
  if (!packageName) {
    return {
      ok: false,
      code: "connector-unavailable",
      sanitizedMessage: `The ${provider} connector is not installed or active on this instance.`,
    };
  }

  let rows: Awaited<ReturnType<typeof readInstalledExtensionsByPackageName>>;
  try {
    rows = await deps.resolveInstallRows(packageName);
  } catch (err) {
    return {
      ok: false,
      code: "save-failed",
      sanitizedMessage: sanitizeReadinessMessage(
        `Could not resolve the ${provider} connector install: ${errMessage(err)}`,
      ),
    };
  }
  // The DEFAULT live install row is the addressable identity (a non-default
  // side-by-side version is never the setup surface's target).
  // SOURCE PRECEDENCE (the shared policy): a bare first-live-default `.find()`
  // would write the connection against whichever of the bundled and marketplace
  // rows the query returned first. The writer must target the same row setup and
  // settings resolve, so the override wins here too.
  const install = applyInstallRowPrecedence(
    rows.filter((row) => LIVE_STATUSES.has(row.status)),
  ).find((row) => row.isDefault !== false);
  if (!install) {
    return {
      ok: false,
      code: "connector-unavailable",
      sanitizedMessage: `The ${provider} connector is not installed or active on this instance.`,
    };
  }

  const actor = await deps.resolveActor();

  const dispatch = await deps.dispatch(
    { installId: install.id, actionId: "saveConnection", input: values, actor },
    {
      resolveInstall: async (id) =>
        id === install.id
          ? {
              packageName: install.packageName,
              status: install.status,
              isDefault: install.isDefault,
              version: install.version,
            }
          : null,
      authorize: async (_row, act) => {
        const decision = await canExtensionAccess(
          {
            kind: install.kind as Parameters<typeof canExtensionAccess>[0]["kind"],
            resourceId: install.id,
            owner: {
              ownerLevel: install.ownerLevel as Parameters<
                typeof canExtensionAccess
              >[0]["owner"]["ownerLevel"],
              ownerId: install.ownerId,
              organizationId: install.organizationId,
            },
          },
          act as Parameters<typeof canExtensionAccess>[1],
          "use",
        );
        return decision.allowed;
      },
      resolveAction: (pkg, actionId) => resolveExtensionUiAction(pkg, actionId),
      resolveVersionedAction: (pkg, version, actionId) => {
        const served = resolveVersionKeyedUiAction(pkg, version, actionId);
        return served.kind === "serve"
          ? { kind: "serve", handler: served.value.handler }
          : { kind: "refuse", code: served.code, message: served.message };
      },
    },
  );

  if (dispatch.status !== 200) {
    // The 500 arm carries the HANDLER'S thrown message — connector/provider
    // text, possibly echoing the submitted credential. Sanitize server-side;
    // this string exists ONLY in the typed result (a toast), never in a URL
    // and never in durable state.
    return {
      ok: false,
      code: dispatch.status === 404 ? "connector-unavailable" : "save-failed",
      sanitizedMessage: sanitizeReadinessMessage(
        dispatch.error ?? `Saving the ${provider} connection failed.`,
      ),
    };
  }
  return interpretActionResult(dispatch.result);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
