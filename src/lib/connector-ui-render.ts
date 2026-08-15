// The pure, host-side decision for HOW to render a connector's setup surface.
//
// A `schema-config` connector ships NO React (model B): it declares its setup
// surface as DATA (`cinatra.configSchema`) and the host renders it from its
// single `sdk-ui` instance via `<SchemaConfigConnectorForm>`. Every other
// connector (`bundled-react`, or legacy `uiSurface: null` with a base-image
// setup-page module) keeps the existing `loadSetupPage()` dispatch path.
//
// This module is PURE + IO-free (no `server-only`, no DB, no React) so the
// branch logic is exhaustively unit-testable apart from the route. The dispatch
// route consumes the decision and performs the IO (install-row resolution,
// React import) the decision does not.

import {
  parseSchemaConfig,
  type SchemaConfigSurface,
} from "@/lib/extension-schema-config";

/** The minimal manifest fields the render decision reads. */
export type ConnectorUiManifest = {
  uiSurface?: "schema-config" | "bundled-react" | null;
  configSchema?: Record<string, unknown> | null;
};

export type ConnectorUiRenderDecision =
  /** Render `<SchemaConfigConnectorForm>` from the validated surface (no React import). */
  | { kind: "schema-config"; surface: SchemaConfigSurface }
  /**
   * The connector declares `schema-config` but its `configSchema` is missing or
   * fails the fail-closed parser — render an error state, NEVER fall back to the
   * bundled-react importer (which would throw an opaque placeholder).
   */
  | { kind: "invalid-schema-config"; errors: string[] }
  /**
   * The existing dispatch path: import + render the connector's base-image
   * React setup page via `entry.loadSetupPage()`. Covers declared
   * `bundled-react` AND legacy `uiSurface: null` connectors that still ship a
   * setup-page module. The route surfaces a "requires rebuild" Alert if the
   * module cannot be loaded (i.e. it is not in the base image).
   */
  | { kind: "bundled-react" };

/**
 * Decide how to render a connector's setup surface from its manifest. Only a
 * `schema-config` connector branches away from the legacy React path; the parse
 * verdict is fail-closed so a malformed declared schema never reaches the
 * renderer.
 */
export function chooseConnectorUiRender(
  manifest: ConnectorUiManifest | null | undefined,
): ConnectorUiRenderDecision {
  if (manifest?.uiSurface === "schema-config") {
    const parsed = parseSchemaConfig(manifest.configSchema ?? null);
    if (parsed.ok) return { kind: "schema-config", surface: parsed.surface };
    return { kind: "invalid-schema-config", errors: parsed.errors };
  }
  return { kind: "bundled-react" };
}

// ---------------------------------------------------------------------------
// NOT-YET-ACTIVE detection (cinatra#2762).
//
// A live canonical install row makes a connector's setup page addressable, but
// the package only SERVES its named actions once it has registered in this
// process. An install can commit and stay un-activated until the next restart
// (the runtime loader refused its anchor), and in that state every action POST
// 404s: option lists cannot load, record lists cannot load, saves cannot run.
//
// Without an explicit statement the page reads as broken. These two pure
// helpers give the route the signal it needs, and they read the SAME registry
// the action route reads, so the banner can never disagree with the 404s.
// ---------------------------------------------------------------------------

/**
 * Every action id the declared surface can dispatch: the record list + delete,
 * the dynamic-option loaders, the named actions, the status probes and the
 * advisory readiness probes, across the flat fields and every tab panel.
 * Duplicates collapse; order follows first appearance.
 */
export function collectDeclaredActionIds(surface: SchemaConfigSurface): string[] {
  const ids = new Set<string>();
  const scan = (fields: SchemaConfigSurface["fields"]) => {
    for (const field of fields) {
      const candidates = [
        (field as { listActionId?: string }).listActionId,
        (field as { deleteActionId?: string }).deleteActionId,
        (field as { optionsAction?: string }).optionsAction,
        (field as { actionId?: string }).actionId,
        (field as { probeActionId?: string }).probeActionId,
        (field as { hydrateAction?: string }).hydrateAction,
      ];
      for (const id of candidates) if (typeof id === "string" && id) ids.add(id);
    }
  };
  scan(surface.fields);
  for (const tab of surface.tabs ?? []) scan(tab.fields);
  return [...ids];
}

/**
 * Whether the addressed install is present but its package registered NOTHING
 * in this process.
 *
 * FAIL-QUIET in both directions that matter:
 *  - no install row: the route already renders its Install/Activate CTA, so
 *    this is never the not-yet-active state;
 *  - a surface that declares NO actions: nothing can 404, so a connector that
 *    simply has no actions is never flagged;
 *  - ANY declared action resolving: the package IS registered here, so a single
 *    missing action id is a surface/package mismatch, not an inactive package,
 *    and it must not be reported as one.
 */
export function isInstalledButNotActive(input: {
  installId: string | null;
  packageName: string;
  declaredActionIds: readonly string[];
  resolveAction: (packageName: string, actionId: string) => unknown;
}): boolean {
  if (input.installId === null) return false;
  if (input.declaredActionIds.length === 0) return false;
  return input.declaredActionIds.every(
    (id) => input.resolveAction(input.packageName, id) == null,
  );
}
