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
//
// `builtinPackageName` pins each handle to its FIRST-PARTY boot-seeded built-in
// assistant's reserved package name (`ensureBuiltInWordpressAssistantAgent` /
// `ensureBuiltInDrupalAssistantAgent`, cinatra#1823). The WordPress/Drupal
// assistants are boot-seeded sibling built-ins (like the @cinatra built-in) —
// they carry NO `assistant_audience` rows and have NO `installed_extension` row,
// so the W1 registry reader (which lists installed-extension assistants + the
// single @cinatra builtin) never returns them. The widget branch uses THIS
// pinned package name to recognize the bound built-in as always-available to its
// widget principal, without widening any assistant's audience globally. The
// literals mirror `@cinatra-ai/agents`' reserved-name constants (inlined so this
// broadly-imported host leaf stays import-light); the parity test asserts they
// equal `BUILT_IN_{WORDPRESS,DRUPAL}_ASSISTANT_PACKAGE_NAME`.
// ---------------------------------------------------------------------------

export type AssistantWidgetHandle = "wordpress" | "drupal";

export type AssistantWidgetBinding = {
  /** The assistant mention handle == `body.assistant` == connector KIND. */
  handle: AssistantWidgetHandle;
  /** The widget-stream agentSlug the cit_/cwu_ tokens are bound to. */
  agentSlug: string;
  /** The instances-config key for the canonical origin re-pin. */
  instancesConfigKey: string;
  /** The reserved package name of the FIRST-PARTY boot-seeded built-in assistant
   *  registered under this handle (== `@cinatra-ai/agents`'
   *  `BUILT_IN_{WORDPRESS,DRUPAL}_ASSISTANT_PACKAGE_NAME`). Used to recognize the
   *  bound built-in in the audience closure (it is not an installed extension and
   *  the W1 reader never lists it). Fixed literal — never caller-derived. */
  builtinPackageName: string;
};

const ASSISTANT_WIDGET_BINDINGS: Record<
  AssistantWidgetHandle,
  AssistantWidgetBinding
> = {
  wordpress: {
    handle: "wordpress",
    agentSlug: "wordpress-content-editor",
    instancesConfigKey: "wordpress",
    builtinPackageName: "@cinatra-ai/wordpress-assistant",
  },
  drupal: {
    handle: "drupal",
    agentSlug: "drupal-content-editor",
    instancesConfigKey: "drupal",
    builtinPackageName: "@cinatra-ai/drupal-assistant",
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
