// ---------------------------------------------------------------------------
// HOST-INTERNAL capability-id surface — NOT part of the public author ABI.
//
// These are the host service-bus ADDRESSING CONSTANTS (the `@cinatra-ai/host:*`
// capability ids the host registers per-concern service impls under). They are
// value-imported ONLY by host modules (src/lib/*, src/app/api/*) when wiring the
// capability registry — never by an extension. An extension that needs to type a
// capability `impl` resolved from `ctx.capabilities` imports the corresponding
// `Host*Service` / provider TYPE from the public root (`@cinatra-ai/sdk-extensions`);
// it inlines the capability-id string literal (the host-peer value-import ban
// forbids value-importing a host-provided constant from a runtime-loaded package).
//
// This subpath (`@cinatra-ai/sdk-extensions/internal`) exists so the host can
// share the single authoritative definition of those ids without RE-DECLARING
// the literals (which would silently drift), while the public root stays
// constant-free. A leak of any of these back into the public root
// (`src/index.ts`) is caught by:
//   - scripts/audit/sdk-public-surface-ban.mjs   (static source-text gate), and
//   - src/__tests__/public-surface.test.ts        (runtime reachability gate).
//
// The constants stay PHYSICALLY DEFINED in their per-concern contract modules
// (host-connector-services-contract.ts, chat-user-context-contract.ts, …) — this
// file only re-exports them through the internal-only subpath. The TYPE exports
// from those same modules continue to flow through the public root unchanged.
// ---------------------------------------------------------------------------

export {
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  NANGO_CONNECTION_SAVED_CAPABILITY,
  NANGO_CONNECTION_MATERIALIZER_CAPABILITY,
  LLM_TOOLBOX_CAPABILITY,
  SOCIAL_POST_CAPABILITY,
  CRM_PROVIDER_CAPABILITY,
  PM_PROVIDER_CAPABILITY,
  EMAIL_SEND_CAPABILITY,
  OBJECT_TYPE_REGISTRAR_CAPABILITY,
  CRM_SYNC_BOOTSTRAP_CAPABILITY,
  CRM_POINTER_WRITER_CAPABILITY,
  DEV_TUNNEL_STATUS_CAPABILITY,
  BLOG_SYSTEM_CAPABILITY,
  SOCIAL_MEDIA_SYSTEM_CAPABILITY,
  EMAIL_SYSTEM_CAPABILITY,
  LLM_PROVIDER_SURFACE_CAPABILITY,
} from "./host-connector-services-contract";

export { CHAT_USER_CONTEXT_CAPABILITY_ID } from "./chat-user-context-contract";
export { CRM_LIST_READER_CAPABILITY_ID } from "./crm-list-reader-contract";
export { EMAIL_SENDER_IDENTITIES_CAPABILITY_ID } from "./email-sender-identities-contract";
export { APPOINTMENT_SCHEDULES_CAPABILITY_ID } from "./appointment-schedules-contract";
export { NANGO_SYSTEM_CAPABILITY } from "./nango-system-contract";
