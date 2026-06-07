// PRIMITIVE_TO_CONNECTOR_OVERRIDES maps facade primitive names to providers.
//
// Most agent -> connector dependency inference works from `mcpPrimitivePrefixes`
// (e.g. `apollo_company_search` -> `apollo_` -> `@cinatra-ai/apollo-connector`).
// But a handful of primitives are facade names that don't carry the prefix of the
// connector that actually owns the runtime path. This map handles those.
//
// `@cinatra-ai/email-connector` is not in the catalog. Agents calling
// `email_send` resolve through this map directly to the concrete provider
// (`@cinatra-ai/gmail-connector` today; a future SMTP connector could be a
// runtime-selectable variant).

/** @type {Record<string, string>} */
export const PRIMITIVE_TO_CONNECTOR_OVERRIDES = {
  email_send: "@cinatra-ai/gmail-connector",
};

/** @returns {string | undefined} */
export function lookupPrimitiveOverride(primitiveName) {
  return PRIMITIVE_TO_CONNECTOR_OVERRIDES[primitiveName];
}
