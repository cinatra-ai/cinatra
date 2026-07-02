import "server-only";

// Host-side inbound-webhook registry (cinatra#340).
//
// Manifest-driven discovery of webhook handlers, exactly the posture of
// src/lib/widget-stream-agents.server.ts: the generated map
// (GENERATED_WEBHOOK_HANDLERS, keyed "<vendor>/<slug>/<hook>") carries a literal
// dynamic import of the connector's handler module + the factory export name, so
// the host's generic /webhook route serves any webhook-bearing extension WITHOUT
// importing a connector package or branching on vendor/slug.
//
// INERT until #343: no extension declares cinatra.webhooks yet, so the generated
// map is {} and `resolveWebhook` is a clean miss for everything (the route
// 404s). The empty-registry path is first-class and crash-free.
//
// FAIL LOUDLY: an entry whose loader cannot be imported or whose recorded
// factory is missing/not a function throws — exactly like the static import it
// replaces (mirrors buildWidgetChatTool).

import type {
  WebhookHandler,
  WebhookHandlerFactory,
} from "@cinatra-ai/webhooks";
import { createWebhookRegistry } from "@cinatra-ai/webhooks";
import {
  GENERATED_WEBHOOK_HANDLERS,
  type GeneratedWebhookHandlerEntry,
} from "@/lib/generated/webhooks.server";
import {
  ExtensionModuleAbsentError,
  isDegradedExtensionLoad,
} from "@/lib/extension-load-guard";

export type RegisteredWebhookEntry = GeneratedWebhookHandlerEntry;

// The registry built over the generated map (import-free dispatch shape).
const registry = createWebhookRegistry(GENERATED_WEBHOOK_HANDLERS);

/**
 * Resolve a declared webhook by (vendor, slug, hook); null = undeclared (the
 * route returns a clean 404). The returned entry carries the loader, the
 * factory name, and declared metadata (rejectStatus when present).
 */
export function resolveWebhook(
  vendor: string,
  slug: string,
  hook: string,
): RegisteredWebhookEntry | null {
  return registry.resolveWebhook(vendor, slug, hook) as RegisteredWebhookEntry | null;
}

/**
 * Import the entry's handler module and build the handler from the recorded
 * factory. FAIL-LOUD: an absent optional module throws the typed absent error
 * (the route maps it to a defined degraded status, not a generic 500); a
 * missing/non-function factory throws.
 */
export async function buildWebhookHandler(
  scope: string,
  entry: RegisteredWebhookEntry,
): Promise<WebhookHandler> {
  const loaded = await entry.load();
  if (isDegradedExtensionLoad(loaded)) {
    throw new ExtensionModuleAbsentError(loaded.specifier, loaded.reason);
  }
  const ns = loaded as Record<string, unknown>;
  const factory = ns[entry.factory];
  if (typeof factory !== "function") {
    throw new Error(
      `[webhook:${scope}] manifest factory "${entry.factory}" is not an exported function of the handler module`,
    );
  }
  const handler = (factory as WebhookHandlerFactory)();
  if (typeof handler !== "function") {
    throw new Error(
      `[webhook:${scope}] factory "${entry.factory}" did not return a handler function`,
    );
  }
  return handler;
}
