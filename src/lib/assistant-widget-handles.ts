// ---------------------------------------------------------------------------
// OQ2 (S5 design §7) — the CLOSED, host-side assistant-handle ↔ widget-stream
// binding table. NEVER caller-derived.
//
// The `/api/assistants/chat` broker-auth branch receives `body.assistant`
// ("wordpress" | "drupal") and a site `cit_` token minted for a widget-stream
// agentSlug ("wordpress-content-editor" | "drupal-content-editor"). To port the
// stream route's dual-token sequence, the route must resolve — from the CALLER's
// requested handle — the widget-stream agentSlug (to consume the `cit_`/`cwu_`
// tokens against, so a wordpress token can never ride an `assistant:"drupal"`
// turn: G9), the instances-config key (for the canonical origin re-pin), and the
// connector KIND minted into the widget OBO token's `knd` claim.
//
// This table is the single host-side source of that mapping. It is intentionally
// a fixed literal (not derived from the caller, the token, or a mutable config)
// so a forged/confused `body.assistant` cannot retarget a different connector.
// The agentSlug + instancesConfigKey values MUST match the generated
// `cinatra.widgetStream` declarations (src/lib/generated/extensions.server.ts);
// the parity test asserts they do.
// ---------------------------------------------------------------------------

export type AssistantWidgetHandle = "wordpress" | "drupal";

export type AssistantWidgetBinding = {
  /** The assistant mention handle == `body.assistant` == connector KIND. */
  handle: AssistantWidgetHandle;
  /** The widget-stream agentSlug the cit_/cwu_ tokens are bound to. */
  agentSlug: string;
  /** The instances-config key for the canonical origin re-pin. */
  instancesConfigKey: string;
};

const ASSISTANT_WIDGET_BINDINGS: Record<
  AssistantWidgetHandle,
  AssistantWidgetBinding
> = {
  wordpress: {
    handle: "wordpress",
    agentSlug: "wordpress-content-editor",
    instancesConfigKey: "wordpress",
  },
  drupal: {
    handle: "drupal",
    agentSlug: "drupal-content-editor",
    instancesConfigKey: "drupal",
  },
};

/**
 * Resolve the CLOSED widget binding for a caller-supplied assistant handle.
 * Returns `null` for any handle that is not a public-site widget assistant
 * (e.g. the built-in "cinatra" handle, or an unknown/forged value) — the caller
 * fails CLOSED (the broker-auth branch is only reachable for a bound handle).
 */
export function resolveAssistantWidgetBinding(
  handle: string,
): AssistantWidgetBinding | null {
  if (handle === "wordpress" || handle === "drupal") {
    return ASSISTANT_WIDGET_BINDINGS[handle];
  }
  return null;
}

/** The full closed table (test/introspection only). */
export function listAssistantWidgetBindings(): AssistantWidgetBinding[] {
  return Object.values(ASSISTANT_WIDGET_BINDINGS);
}
