// Webhook handler registry (cinatra#340).
//
// Import-free dispatch shape mirroring `resolveWidgetStreamAgent`: the host
// injects the GENERATED map (`GENERATED_WEBHOOK_HANDLERS`, keyed
// `"<vendor>/<slug>/<hook>"`) at boot; this package resolves a hook to its
// registered entry WITHOUT naming a connector package or branching on
// vendor/slug. The empty-registry case is first-class: with no extension
// declaring `cinatra.webhooks` yet (that is #343), the map is `{}` and every
// `resolve` is a clean miss → the route 404s, never crashes.

import type { WebhookHandlerFactory } from "./types";

/**
 * One registered hook. `load` is the generated literal dynamic import of the
 * connector's handler module; `factory` is the named export the host invokes;
 * `rejectStatus` (when declared) overrides the default 204 for a `rejected`
 * outcome.
 */
export interface RegisteredWebhook {
  readonly resolution: "required" | "guardedOptional";
  readonly load: () => Promise<unknown>;
  readonly factory: string;
  readonly rejectStatus?: number;
}

/** The generated registry map shape (host-injected). */
export type GeneratedWebhookHandlers = Record<string, RegisteredWebhook>;

export interface WebhookRegistry {
  /** Resolve a hook by `(vendor, slug, hook)`; null = undeclared (clean 404). */
  resolveWebhook(vendor: string, slug: string, hook: string): RegisteredWebhook | null;
  /** The scope key for a tuple — the idempotency `scope` + the registry key. */
  scopeKey(vendor: string, slug: string, hook: string): string;
}

/** Build the scope key (also the idempotency-ledger `scope`). */
export function webhookScopeKey(vendor: string, slug: string, hook: string): string {
  return `${vendor}/${slug}/${hook}`;
}

/**
 * Create a registry over the host-injected generated handler map. Safe on an
 * EMPTY map (no hooks declared) — `resolveWebhook` returns null for everything.
 */
export function createWebhookRegistry(handlers: GeneratedWebhookHandlers): WebhookRegistry {
  return {
    resolveWebhook(vendor, slug, hook) {
      return handlers[webhookScopeKey(vendor, slug, hook)] ?? null;
    },
    scopeKey: webhookScopeKey,
  };
}

// Re-export for the host's fail-loud handler builder.
export type { WebhookHandlerFactory };
