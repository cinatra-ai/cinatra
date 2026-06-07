/**
 * Generic config handler registry for the wizard system.
 * Each resource type registers a handler that knows how to build responses,
 * apply patches, and activate (persist) staged resources.
 *
 * Uses globalThis to survive Next.js dev-mode hot reloads.
 */

export type ResourceConfigHandler = {
  /** Build the response JSON from a staged config + context data. */
  buildStagedResponse(
    resourceId: string,
    config: Record<string, unknown>,
    userId?: string,
  ): Promise<Record<string, unknown>>;

  /** Build the response JSON from a real (DB) resource. */
  buildRealResponse(
    resourceId: string,
    userId?: string,
  ): Promise<Record<string, unknown> | null>;

  /** Apply a PATCH to a real (DB) resource and return the updated response. */
  applyRealPatch(
    resourceId: string,
    body: Record<string, unknown>,
    userId?: string,
  ): Promise<Record<string, unknown> | null>;

  /** Persist a staged resource to the real store. Returns the real resource ID. */
  activate(
    resourceId: string,
    config: Record<string, unknown>,
  ): Promise<string>;
};

const GLOBAL_KEY = "__cinatra_wizard_config_handlers__" as const;

function getHandlers(): Record<string, ResourceConfigHandler> {
  const g = globalThis as unknown as Record<string, Record<string, ResourceConfigHandler> | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {};
  }
  return g[GLOBAL_KEY];
}

export function registerConfigHandler(resourceType: string, handler: ResourceConfigHandler) {
  getHandlers()[resourceType] = handler;
}

export function getConfigHandler(resourceType: string): ResourceConfigHandler | undefined {
  return getHandlers()[resourceType];
}
