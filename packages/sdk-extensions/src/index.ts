import type { AgentIOSpec } from "./agent-io-contract";

// AgentIOSpec is inlined in the SDK so `@cinatra-ai/sdk-extensions` is
// a true leaf — it does not import `@cinatra-ai/objects`.
export type { AgentIOSpec, AgentIOPort, AgentOutputPort, InputCardinality, OutputCardinality } from "./agent-io-contract";

// ---------------------------------------------------------------------------
// SDK ABI FROZEN. Additive;
// the existing definition exports below are unchanged. Explicit named re-exports
// (repo convention — no `export *`). See host-context.ts / register.ts /
// activate.ts / loader.ts / manifest.ts / dependencies.ts for the contract.
//
// NOTE: the host-side activation helpers (activate/loader) are exported here
// alongside the author-facing ABI; splitting them behind a dedicated host-only
// subpath is a possible future cleanup (not ABI-breaking).
// ---------------------------------------------------------------------------
export { HOST_PORT_NAMES } from "./host-context";
export type {
  HostDbPort,
  HostSettingsPort,
  HostSecretsPort,
  HostNangoPort,
  HostAuthSessionPort,
  HostMcpPort,
  HostMcpToolRegistration,
  HostObjectsPort,
  HostJobsPort,
  HostNotificationsPort,
  HostUiPort,
  HostLoggerPort,
  HostRuntimePort,
  HostCapabilitiesPort,
  HostTelemetryPort,
  HostUsageEvent,
  HostLlmUsageEvent,
  HostApolloUsageEvent,
  ExtensionHostContext,
  HostPortName,
} from "./host-context";

export {
  SDK_EXTENSIONS_ABI_VERSION,
  EXTENSION_PACKAGE_EXPORT_CONTRACTS,
  defineServerEntry,
  defineExtension,
  resolveServerEntry,
  normalizeServerModule,
  isSdkAbiRangeSatisfied,
} from "./register";
export type {
  ExtensionPackageExportContract,
  ExtensionServerEntry,
  ExtensionAdminEntry,
  ExtensionConfigEntry,
  ExtensionModule,
} from "./register";

export { activateExtensionModule, bootstrapExtensionModule, destroyExtensionModule } from "./activate";
export type { ActivationStatus, ActivationReason, ActivationResult, ActivateOptions } from "./activate";

export { runStaticBundleActivation } from "./loader";
export type { LoaderRecord, LoaderDeps } from "./loader";
export {
  runRuntimePackageActivation,
  discoverPackageStoreRecords,
  recordFromManifest,
  recordDeclaresHostMigrations,
  resolveServerEntryPath,
  DEFAULT_PACKAGE_STORE_PATH,
} from "./runtime-loader";
export type {
  PackageStoreRecord,
  PackageStoreFs,
  RuntimeLoaderDeps,
} from "./runtime-loader";

export {
  requireExtensionAction,
  setExtensionActionGuard,
  _resetExtensionActionGuardForTests,
} from "./action-guard";
export type { ExtensionActionMode, ExtensionActionGuard } from "./action-guard";

export {
  setA2AConnectionProvider,
  requireA2AConnectionProvider,
  _resetA2AConnectionProviderForTests,
} from "./a2a-connection-contract";
export type { A2AConnectionProvider } from "./a2a-connection-contract";

export {
  setGoogleOAuthConnectionProvider,
  requireGoogleOAuthConnectionProvider,
  _resetGoogleOAuthConnectionProviderForTests,
} from "./google-oauth-connection-contract";
export type { GoogleOAuthConnectionProvider } from "./google-oauth-connection-contract";

// CRM connector→SDK decouple: provider-agnostic CRM contract types, the
// host-shared provider registry, and the request-actor DI resolver — so the
// crm-connector facade and CRM provider extensions (twenty-connector) depend only
// on the SDK, not on each other or the host mcp-server.
export type {
  CrmConnector,
  CrmConnectorId,
  CrmContact,
  CrmAccount,
  CrmList,
  CrmListMembership,
} from "./crm-connector-contract";
export {
  registerCrmProvider,
  lookupCrmProvider,
  listCrmProviders,
  setCrmProviderExternalResolver,
  _resetCrmProviderRegistry,
} from "./crm-provider-registry-contract";
export {
  setCrmRequestActorResolver,
  requireCrmRequestActorResolver,
  _resetCrmRequestActorResolverForTests,
} from "./crm-request-actor-contract";
export type { CrmRequestActor, CrmRequestActorResolver } from "./crm-request-actor-contract";

export {
  setExtensionConnectorConfigStore,
  getExtensionConnectorConfig,
  setExtensionConnectorConfig,
  deleteExtensionConnectorConfig,
  _resetExtensionConnectorConfigStoreForTests,
} from "./connector-config";
export type { ExtensionConnectorConfigStore } from "./connector-config";

export {
  setExtensionMcpOAuthClientStore,
  listExternalMcpOAuthClients,
  deleteExternalMcpOAuthClient,
  _resetExtensionMcpOAuthClientStoreForTests,
} from "./mcp-oauth-clients";
export type {
  ExternalMcpOAuthClient,
  ExtensionMcpOAuthClientStore,
} from "./mcp-oauth-clients";

export { UI_SURFACE_KINDS, isUiSurfaceKind, EXTENSION_RESOLUTIONS } from "./manifest";
export type { UiSurfaceKind, ExtensionResolution, CinatraManifest, NormalizedExtensionRecord } from "./manifest";
export type {
  ExtensionExternalMcpTool,
  ExtensionExternalMcpToolbox,
} from "./external-mcp-toolbox-contract";
export { parseDevFixtures, DevFixtureValidationError, DEV_FIXTURE_SURFACES } from "./dev-fixtures";
export type { DevFixture, DevFixtureFile, DevFixtureSetting, DevFixtureObject } from "./dev-fixtures";

export {
  EXTENSION_KINDS,
  DEPENDENCY_EDGE_TYPES,
  DEPENDENCY_REQUIREMENTS,
  parseVersionConstraint,
  normalizeLegacyDependencies,
  isExtensionKind,
} from "./dependencies";
export type {
  ExtensionKind,
  DependencyEdgeType,
  DependencyRequirement,
  VersionConstraint,
  ExtensionDependency,
  LegacyDependencySources,
} from "./dependencies";

export type PluginPropertyValue = string | number | boolean | null;

export type CampaignPluginTypeSeed = {
  id: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  prompt: string;
  generatedBlueprint?: string;
};

export type CampaignPluginDefinition = {
  serviceId: string;
  campaignTypeId: string;
  campaignType: CampaignPluginTypeSeed;
  agentPackageName?: string;
  dependencies?: {
    agents?: string[];
  };
};

export type AgentPluginDefinition = {
  agentId: string;
  name: string;
  slug: string;
  description: string;
  ioSpec?: AgentIOSpec;
};

export type SkillDefinition = {
  id: string;
  name: string;
  slug: string;
  description: string;
  content: string;
  sourceUrl?: string;
};

export type SkillPackageDefinition = {
  packageId: string;
  name: string;
  slug: string;
  description: string;
  sourceUrl?: string;
  repositoryUrl?: string;
  license?: string;
  authors?: string[];
  repositoryPath?: string;
  localShellSkillsPath?: string;
};

export type HostRequiredPackageDefinition = {
  packageId: string;
  name: string;
  slug: string;
  description: string;
  settingsHref?: string;
};

// The EMAIL provider contract (definition + behaviour types) now lives in
// `./email-connector-contract` so a concrete provider (resend/gmail/…) depends
// only on the SDK — never on `@cinatra-ai/email-connector`. Re-exported here for
// back-compat (and also available via the `./email-contract` subpath).
export type {
  EmailConnectorDefinition,
  EmailConnector,
  EmailConnectorId,
  EmailSystemMessage,
  EmailSendReceipt,
  EmailReplyMatch,
  EmailConnectorStatusResult,
} from "./email-connector-contract";

// The SOCIAL-MEDIA provider contract (definition + behaviour) now lives in
// `./social-media-connector-contract` (the `./social-contract` subpath) so a
// provider depends only on the SDK. Re-exported here for back-compat.
export type {
  SocialMediaConnectorDefinition,
  SocialMediaConnector,
  SocialMediaConnectorId,
  SocialMediaPost,
  SocialMediaPublishReceipt,
  SocialMediaConnectorStatusResult,
} from "./social-media-connector-contract";

// The BLOG-CONTENT provider contract now lives in `./blog-connector-contract`
// (the `./blog-contract` subpath) so a site connector depends only on the SDK.
export type {
  BlogConnectorDefinition,
  BlogConnector,
  BlogConnectorId,
  BlogDraftBuildInput,
  BlogDraftCreatePayload,
  BlogDraftPayload,
} from "./blog-connector-contract";

// The MCP tool/primitive STRUCTURAL contract (the `./mcp-contract` subpath) so a
// connector registering MCP tools or invoking host primitives depends only on the
// SDK — never `@cinatra-ai/mcp-server` / `@cinatra-ai/mcp-client`.
export type {
  ExtensionMcpToolServer,
  ExtensionMcpToolResult,
  ExtensionMcpContentBlock,
  ExtensionMcpToolConfig,
  ExtensionPrimitiveRequest,
} from "./mcp-connector-contract";

// The SEMANTIC-ARTIFACT manifest contract (the `./artifact-contract` subpath) so
// an `kind:"artifact"` extension depends only on the SDK — never `@cinatra-ai/objects`.
export type {
  SemanticArtifactManifest,
  ArtifactRepresentationForms,
  ArtifactTemplateVariant,
  ArtifactSkillBundle,
  SemanticArtifactRef,
} from "./artifact-contract";

// The OBJECT contract (the `./objects-contract` subpath) — the React-free base
// object-type / sync-adapter shapes — plus the host-injected OBJECTS provider DI
// slot (the `./objects-provider` subpath) so a connector that owns object types
// (crm-connector) depends only on the SDK, never `@cinatra-ai/objects`. The
// concrete registries + objects store + graphiti client stay host-side; the host
// binds the provider at boot (src/lib/register-objects-provider.ts).
export type {
  ObjectCategory,
  RelationCardinality,
  RelationDefinition,
  ObjectLifecycle,
  RendererComponent,
  ObjectRenderers,
  AutomapOnMatch,
  AutomapOnNoMatch,
  AutomapCrudPolicy,
  ObjectTypeDefinition,
  StoredObject,
  ExportedEntry,
  ObjectSyncAdapter,
} from "./objects-contract";
export {
  setObjectsProvider,
  requireObjectsProvider,
  getObjectsProviderOrNull,
  _resetObjectsProviderForTests,
} from "./objects-provider-contract";
export type { ObjectsProvider, ObjectsSaveResult } from "./objects-provider-contract";
export {
  setBlogConnectorProvider,
  registerBlogConnectorViaProvider,
  getBlogConnectorProviderOrNull,
  _resetBlogConnectorProviderForTests,
} from "./blog-connector-provider-contract";
export type { BlogConnectorProvider } from "./blog-connector-provider-contract";

// Host connector-services capability contracts (the transport-registration cutover — transport/provider
// registration via capabilities). Type-only for extensions; the host imports
// the capability-id constants as values when registering the per-concern impls.
export {
  HOST_CONNECTOR_SERVICE_CAPABILITIES,
  NANGO_CONNECTION_SAVED_CAPABILITY,
  LLM_TOOLBOX_CAPABILITY,
  SOCIAL_POST_CAPABILITY,
  CRM_PROVIDER_CAPABILITY,
  EMAIL_SEND_CAPABILITY,
  OBJECT_TYPE_REGISTRAR_CAPABILITY,
  CRM_SYNC_BOOTSTRAP_CAPABILITY,
  CRM_POINTER_WRITER_CAPABILITY,
  DEV_TUNNEL_STATUS_CAPABILITY,
} from "./host-connector-services-contract";
export type {
  HostConnectorConfigService,
  HostNangoConnectionStorageService,
  HostGoogleOAuthService,
  HostSecretsCodecService,
  HostExternalMcpRegistryService,
  HostMcpSelfClientService,
  HostInstanceIdentityService,
  HostEmailRoutingService,
  HostBlogRoutingService,
  NangoConnectionSavedHook,
  LlmToolboxProvider,
  HostObjectsIntegrationService,
  ObjectTypeRegistrarProvider,
  CrmSyncBootstrapProvider,
  CrmPointerWritePayload,
  CrmPointerWriterProvider,
  DevTunnelStatusProvider,
} from "./host-connector-services-contract";

// Chat user-context contribution: a connector contributes pre-formatted chat
// system-prompt sections through the generic capability registry (see the
// trust-boundary note in the contract module) instead of the chat runner
// importing the connector package by name.
export { CHAT_USER_CONTEXT_CAPABILITY_ID } from "./chat-user-context-contract";
export type {
  ChatUserContextContributor,
  ChatUserContextProviderRecord,
} from "./chat-user-context-contract";
