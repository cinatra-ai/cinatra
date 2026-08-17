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
