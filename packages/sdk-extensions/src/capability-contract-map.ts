// ---------------------------------------------------------------------------
// CapabilityContractMap — the typed capability-id -> contract-surface map.
//
// WHAT IT IS: a single, authoritative COMPILE-TIME map from a TYPED first-party
// capability-id string LITERAL (`"nango-system"`, `"email-send"`, …) to the
// SURFACE/PROVIDER TYPE a provider registered under that id is expected to
// expose. It covers the ids whose resolvers resolve a single provider SURFACE
// and benefit from a typed `impl`; it is NOT exhaustive over every fenced
// capability id (e.g. the hook/multi-step-resolver ids like
// `nango-connection-saved`, `nango-connection-materializer` are deliberately
// omitted — adding one here is purely additive). The `social-post` and
// `crm-provider` provider-registry ids ARE mapped: each resolves to one typed
// provider surface (`SocialMediaConnector` / `CrmConnector`), so the host's
// external-resolver bridges (`register-crm-providers.ts`, the social facade)
// get the typed `impl` for free instead of hand-casting before the structural
// `isXConnector` guard.
// It is the type-level companion to the host-owned capability registry
// (`ctx.capabilities` / the host's `resolveCapabilityProviders`): the registry
// stores `impl: unknown`; this map says what that `unknown` is SUPPOSED to be
// for a known id, so resolvers stop hand-writing the `impl as Partial<TSurface>`
// cast at every call site.
//
// WHAT IT IS NOT — three load-bearing non-goals:
//   1. NOT a runtime validator. The backing registry stores `unknown`; this map
//      changes NOTHING at runtime. The host's structural `isXSurface(impl)`
//      guards REMAIN the runtime trust boundary — a typed resolve narrows the
//      compile-time type, the guard still proves the shape before it is trusted.
//   2. NOT a closed enum / authoritative capability roster. The capabilities
//      port keeps its OPEN `string` signature (see the additive overload on
//      `HostCapabilitiesPort.resolveProviders` in `host-context.ts`); a third
//      party may register and resolve ANY capability id and gets the generic
//      `unknown` impl — exactly as before. This map only adds typed ergonomics
//      for the FIRST-PARTY ids the host already knows.
//   3. NOT a value surface. The capability-id CONSTANTS stay fenced behind the
//      host-only `./internal` subpath (SDK-P2 / #242); this module reads them
//      ONLY through `typeof` to derive the key literals — no constant is
//      re-exported as a value, so the public-surface ban stays satisfied.
//
// Keys are derived from `typeof <CONST>` rather than re-typed literals so the
// id strings have ONE source of truth (the per-concern contract module) and can
// never silently drift from the constants the host registers/resolves under.
// ---------------------------------------------------------------------------

import type {
  EMAIL_SEND_CAPABILITY,
  LLM_TOOLBOX_CAPABILITY,
  OBJECT_TYPE_REGISTRAR_CAPABILITY,
  CRM_SYNC_BOOTSTRAP_CAPABILITY,
  CRM_POINTER_WRITER_CAPABILITY,
  CRM_PROVIDER_CAPABILITY,
  SOCIAL_POST_CAPABILITY,
  DEV_TUNNEL_STATUS_CAPABILITY,
  BLOG_SYSTEM_CAPABILITY,
  SOCIAL_MEDIA_SYSTEM_CAPABILITY,
  LLM_PROVIDER_SURFACE_CAPABILITY,
  EMAIL_SYSTEM_CAPABILITY,
} from "./host-connector-services-contract";
import type { NANGO_SYSTEM_CAPABILITY } from "./nango-system-contract";
import type { CHAT_USER_CONTEXT_CAPABILITY_ID } from "./chat-user-context-contract";
import type { CRM_LIST_READER_CAPABILITY_ID } from "./crm-list-reader-contract";
import type { EMAIL_SENDER_IDENTITIES_CAPABILITY_ID } from "./email-sender-identities-contract";
import type { APPOINTMENT_SCHEDULES_CAPABILITY_ID } from "./appointment-schedules-contract";

import type {
  LlmToolboxProvider,
  ObjectTypeRegistrarProvider,
  CrmSyncBootstrapProvider,
  CrmPointerWriterProvider,
  DevTunnelStatusProvider,
  BlogSystemProvider,
  SocialMediaSystemProvider,
  LlmProviderSurface,
  EmailSystemProvider,
} from "./host-connector-services-contract";
import type { EmailConnector } from "./email-connector-contract";
import type { CrmConnector } from "./crm-connector-contract";
import type { SocialMediaConnector } from "./social-media-connector-contract";
import type { CrmListReader } from "./crm-list-reader-contract";
import type { NangoSystemSurface } from "./nango-system-contract";
import type { ChatUserContextContributor } from "./chat-user-context-contract";
import type { EmailSenderIdentitiesProvider } from "./email-sender-identities-contract";
import type { AppointmentSchedulesProvider } from "./appointment-schedules-contract";

/**
 * The typed capability-id -> contract-surface map. Each property key is the
 * capability-id string LITERAL (read via `typeof <CONST>` so it tracks the one
 * authoritative constant), and the value type is the surface/provider a
 * provider registered under that id exposes as its `impl`.
 *
 * Add a new first-party capability id here when you add its constant + surface
 * type; resolvers of that id then get the typed `impl` for free, and the
 * generic open-`string` path is unaffected.
 */
export type CapabilityContractMap = {
  [NANGO_SYSTEM_CAPABILITY]: NangoSystemSurface;
  [EMAIL_SEND_CAPABILITY]: EmailConnector;
  [EMAIL_SYSTEM_CAPABILITY]: EmailSystemProvider;
  [EMAIL_SENDER_IDENTITIES_CAPABILITY_ID]: EmailSenderIdentitiesProvider;
  [LLM_TOOLBOX_CAPABILITY]: LlmToolboxProvider;
  [LLM_PROVIDER_SURFACE_CAPABILITY]: LlmProviderSurface;
  [BLOG_SYSTEM_CAPABILITY]: BlogSystemProvider;
  [SOCIAL_MEDIA_SYSTEM_CAPABILITY]: SocialMediaSystemProvider;
  [SOCIAL_POST_CAPABILITY]: SocialMediaConnector;
  [CRM_SYNC_BOOTSTRAP_CAPABILITY]: CrmSyncBootstrapProvider;
  [CRM_POINTER_WRITER_CAPABILITY]: CrmPointerWriterProvider;
  [CRM_PROVIDER_CAPABILITY]: CrmConnector;
  [CRM_LIST_READER_CAPABILITY_ID]: CrmListReader;
  [OBJECT_TYPE_REGISTRAR_CAPABILITY]: ObjectTypeRegistrarProvider;
  [DEV_TUNNEL_STATUS_CAPABILITY]: DevTunnelStatusProvider;
  [APPOINTMENT_SCHEDULES_CAPABILITY_ID]: AppointmentSchedulesProvider;
  [CHAT_USER_CONTEXT_CAPABILITY_ID]: ChatUserContextContributor;
};

/** A first-party capability id that has a TYPED contract in the map above
 * (the subset of fenced ids with a single-surface resolver; not exhaustive). */
export type KnownCapabilityId = keyof CapabilityContractMap;

/**
 * The resolved-provider record shape for a capability id. For a KNOWN id the
 * `impl` is typed to the mapped surface; for any other `string` it stays
 * `unknown` (the open path). This is the return-element type the typed
 * `resolveProviders` overload yields.
 */
export type ResolvedCapabilityProvider<Id extends string> = {
  packageName: string;
  impl: Id extends KnownCapabilityId ? CapabilityContractMap[Id] : unknown;
};
