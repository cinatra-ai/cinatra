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
// ABI-evolution policy: per-port lifecycle tier metadata. These are
// author-facing POLICY values describing the frozen surface, NOT host-bus
// addressing constants, so they belong on the public root (and do not trip the
// public-surface ban, which targets `*_CAPABILITY` / `*_CAPABILITY_ID` only).
export { HOST_PORT_TIERS, HOST_PORT_TIER, RESERVED_HOST_PORTS } from "./host-context";
// ABI-evolution policy: minimum-minor ABI semantics + a
// least-privilege grant-typed ctx. Both are TYPE-LEVEL + ADDITIVE (no ABI bump):
// `AbiScopedNangoPort<Range>` makes the 2.2-added nango getters required at a
// `>= 2.2` declared floor; `GrantedHostContext<Ports, Range>` exposes only the
// granted ports (the runtime fail-loud check stays as defense-in-depth). The two
// value exports are author-facing POLICY metadata (the 2.2-added method names +
// the ambient-port list), not host-bus addressing constants.
export { NANGO_ABI_2_2_ADDED_METHODS, AMBIENT_HOST_PORTS } from "./host-context";
export type {
  HostDbPort,
  HostSettingsPort,
  HostSecretsPort,
  HostNangoPort,
  HostAuthSessionPort,
  HostMcpPort,
  HostMcpToolRegistration,
  HostObjectsPort,
  HostObjectTypeDescriptor,
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
  HostPortTier,
  AbiScopedNangoPort,
  SdkAbiRangeMeets22,
  NangoAbi220AddedMethod,
  GrantedHostContext,
  AmbientHostPort,
} from "./host-context";

// Author-facing local test harness (SDK-P1). The
// runtime impl is the dependency-free ./test-host-context.mjs (shared with the
// release-tooling validator / canary). Also reachable via the
// `@cinatra-ai/sdk-extensions/test-host-context` subpath.
export {
  createTestHostContext,
  summarizeRecorder,
  sanitizeAtom,
  bindTestProviderIdentity,
  isReservedHostProviderIdentity,
  TEST_HOST_PORT_NAMES,
  TEST_AMBIENT_PORTS,
  HOST_RESERVED_PROVIDER_NAMESPACE,
} from "./test-host-context";
export type {
  TestHostRecorder,
  CreateTestHostContextOptions,
  CreateTestHostContextResult,
} from "./test-host-context";

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
  resolveExportsSubpath,
  resolveDeclaredServerEntry,
  classifyServerEntryArtifact,
  DEFAULT_PACKAGE_STORE_PATH,
} from "./runtime-loader";
export type {
  PackageStoreRecord,
  PackageStoreFs,
  RuntimeLoaderDeps,
  ServerEntryArtifactClass,
  ServerEntryResolution,
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

// PM (project-management) connector→SDK decouple (cinatra#317): provider-agnostic
// PM contract types + the host-shared provider registry, so the host PM bridge
// and PM provider extensions (plane-connector) depend only on the SDK, not on
// each other. Same shape as the CRM provider registry above.
export type {
  PmConnector,
  PmConnectorId,
  PmTriggerTask,
  PmTaskRef,
  PmTaskState,
} from "./pm-connector-contract";
export {
  registerPmProvider,
  lookupPmProvider,
  listPmProviders,
  setPmProviderExternalResolver,
  _resetPmProviderRegistry,
} from "./pm-provider-registry-contract";

// PM WORK-ITEM STORE contract (the "PmConnector v2" typed CRUD surface;
// cinatra#1031, EPIC #1030): the provider-agnostic work-item CRUD types + the
// host-shared work-store provider registry. A SEPARATE capability/registry from
// the trigger-mirror `PmConnector` above, so the two PM seams evolve
// independently and a CRUD-only provider need not implement the mirror.
export type {
  PmWorkStore,
  PmWorkStoreId,
  PmWorkItem,
  PmWorkItemStatus,
  PmWorkItemDraft,
  PmWorkItemPatch,
  PmWorkItemComment,
  PmWorkStoreError,
  PmWorkStoreErrorCode,
} from "./pm-work-store-contract";
export {
  registerPmWorkStore,
  lookupPmWorkStore,
  listPmWorkStores,
  setPmWorkStoreExternalResolver,
  _resetPmWorkStoreRegistry,
} from "./pm-work-store-registry-contract";

export {
  setExtensionConnectorConfigStore,
  getExtensionConnectorConfig,
  setExtensionConnectorConfig,
  deleteExtensionConnectorConfig,
  _resetExtensionConnectorConfigStoreForTests,
} from "./connector-config";
export type { ExtensionConnectorConfigStore } from "./connector-config";

// The opt-in setup-form hydration read-action contract (cinatra#1082 item 3;
// owner-ratified) lives behind the `@cinatra-ai/sdk-extensions/config-hydration`
// SUBPATH ONLY — deliberately NOT re-exported from this root barrel: the barrel
// sits on the reachable graph of every locked dev-perf route, and the
// route-graph ratchet forbids growing those graphs with a module none of them
// uses. Consumers (the host hydration seam; adopting connectors) import the
// subpath.

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
export type {
  UiSurfaceKind,
  ExtensionResolution,
  ConnectorVendorIdentity,
  CinatraManifest,
  NormalizedExtensionRecord,
} from "./manifest";
// Manifest-declared env-override layer (cinatra#982) — pure validation; see
// `./env-overrides` for the security-guard doctrine.
export {
  parseEnvOverrideTarget,
  envNamespaceForPackage,
  envNamespacePrefixForPackage,
  isNamespacedEnvKey,
  validateEnvOverrides,
  splitEnvOverridesByPort,
} from "./env-overrides";
export type {
  EnvOverridePort,
  EnvOverrideTarget,
  EnvOverrideMap,
  EnvOverrideRejection,
  EnvOverrideValidation,
} from "./env-overrides";
export type {
  ExtensionExternalMcpTool,
  ExtensionExternalMcpToolbox,
} from "./external-mcp-toolbox-contract";
export { parseDevFixtures, DevFixtureValidationError, DEV_FIXTURE_SURFACES } from "./dev-fixtures";
export type { DevFixture, DevFixtureFile, DevFixtureSetting, DevFixtureObject } from "./dev-fixtures";
export { isExtensionDevSetupModule } from "./dev-setup";
export type {
  ExtensionDevSetupStatus,
  ExtensionDevSetupHelpers,
  ExtensionDevSetupCapabilities,
  ExtensionDevSetupContext,
  ExtensionDevSetupModule,
} from "./dev-setup";
export {
  CONNECTOR_ACCESS_SCOPES,
  CONNECTOR_ACCESS_CONFIG_FORMAT_VERSION,
  PROTECTED_CONNECTOR_SLUGS,
  ConnectorAccessConfigError,
  connectorAccessSlugFromPackageName,
  parseConnectorAccessConfig,
  resolveAbsentConnectorAccessConfig,
  isResolvedConnectorAccessDeclaration,
} from "./access-config";
export type {
  ConnectorAccessScope,
  ConnectorAccessConfig,
  ResolvedConnectorAccessDeclaration,
} from "./access-config";

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

// `cinatra.consumes` contract (engineering#422). Only the TYPE is re-exported
// from the barrel (erased at build → no runtime module added to any host
// route's reachable graph; route-graph ratchet stays flat). The VALUE helpers
// (`parseConsumedPrimitives`, `validateConsumedPrimitiveShape`,
// `ConsumesManifestError`) live in `./consumes` and are imported DIRECTLY by
// the install/manifest path + the CI closure gate/sweep — pulling them through
// the barrel would grow every barrel-importing route's first-party graph.
export type { ConsumedPrimitive } from "./consumes";

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
  ArtifactUiRegistryItem,
  ArtifactUiRegistryItemType,
} from "./artifact-contract";

// The AUTHOR-FACING artifact-renderer props contract (the `./artifact-renderer-props`
// subpath, cinatra#1629 epic #1620 S2/M1): the versioned, serializable snapshot a
// `cinatra.artifact.ui` renderer's default-export component receives. The TYPE is
// re-exported here (and at the subpath) so an extension's renderer types its props
// against the SDK — never a host-internal import. Host-neutral MIRROR of the host
// source of truth (`src/lib/artifacts/artifact-renderer-props.ts`); a host-side
// mutual-assignability test keeps the two in lockstep. TYPE-ONLY on purpose: the
// runtime `ARTIFACT_RENDERER_PROPS_API_VERSION` const lives at the subpath ONLY —
// a runtime barrel re-export would add the module to every route graph that
// reaches this barrel (route-graph-ratchet), while `export type` is erased.
export type { ArtifactRendererProps } from "./artifact-renderer-props";

// The CHAT RENDERABLE-VIEW declaration contract (the `./chat-views-contract`
// subpath, cinatra#1626 epic #1620 S9/M4): the versioned top-level
// `cinatra.views` field by which an extension ships the chat renderable-view
// component for a wire `viewType`. Its OWN ABI version, separate channel from
// `cinatra.artifact.ui` (the S1 slot enum). Tolerant parse (degrade at runtime /
// reject at publish), one effective provider per viewType.
export type {
  ChatViewsManifest,
  ChatRenderableViewEntry,
  ChatViewsParseResult,
} from "./chat-views-contract";
export {
  CHAT_VIEWS_ABI_VERSION,
  CHAT_VIEW_TYPE_RE,
  isValidChatViewType,
  parseChatViews,
  validateChatViewsForPublish,
} from "./chat-views-contract";

// The LLM-PROVIDER declaration contract (the `./llm-provider-contract` subpath,
// cinatra#1712 epic #1711 S1): the versioned top-level `cinatra.llmProvider`
// field by which an LLM connector (openai/anthropic/gemini) ships its OWN
// capability matrix (function_tools/media_input/native_mcp {status,transports?,
// approval?}) + model catalog. The PUBLIC, host-neutral MIRROR of the host
// declaration model in `@cinatra-ai/agents`'s `llm-provider-policy.ts` (a
// drift-guard coupling test in agents keeps the two byte-equivalent). Tolerant
// parse (degrade at runtime / reject at publish); the conformance gate DERIVES
// the ABI version + vocabularies from this leaf.
export {
  LLM_PROVIDER_ABI_VERSION,
  LLM_PROVIDERS,
  LLM_CAPABILITIES,
  NATIVE_MCP_STATUSES,
  MCP_APPROVAL_MODES,
  LlmProviderNativeMcpSchema,
  LlmProviderCapabilitiesSchema,
  LlmProviderModelsSchema,
  LlmProviderDeclarationSchema,
  parseLlmProvider,
  validateLlmProviderForPublish,
  declarationSatisfiesCapability,
} from "./llm-provider-contract";
export type {
  LlmProvider,
  LlmCapability,
  NativeMcpStatus,
  McpApprovalMode,
  LlmProviderNativeMcp,
  LlmProviderCapabilities,
  LlmProviderModels,
  LlmProviderDeclaration,
  LlmProviderParseResult,
} from "./llm-provider-contract";

// The versioned DASHBOARD-CONTRIBUTION manifest contract (the
// `./dashboard-contribution-contract` subpath, cinatra#1628 S11a) so a
// `kind:"agent"` extension types its `cinatra.dashboardContribution` claim
// against the SDK alone. Schema-only leaf; the host + the publish/conformance
// gate share the field-tolerant `parseDashboardContribution` validator.
export {
  DASHBOARD_CONTRIBUTION_ABI_VERSION,
  DASHBOARD_CONTRIBUTION_CARRIER_KINDS,
  DASHBOARD_CONTRIBUTION_SDK_ABI_RANGE,
  isDashboardContributionCarrierKind,
  isValidContributionKey,
  parseDashboardContribution,
  validateDashboardContributionForPublish,
} from "./dashboard-contribution-contract";
export type {
  DashboardContributionManifest,
  DashboardContributionAdoption,
  DashboardContributionCarrierKind,
  DashboardContributionParseResult,
} from "./dashboard-contribution-contract";

// The extensible-shadcn-registry author-facing CONTRACT (the `./registry-contract`
// subpath, cinatra#1623 epic #1620 S5): vendor identity grammar, tombstone
// contract, serving-URL grammar, and publish-time dependency-graph validation.
// Schema-only leaf, consumed by the publish pipeline + registry host (owned by
// the publishing infrastructure) — the extension's DECLARATION surface is
// `cinatra.artifact.ui.registryItems` in `./artifact-contract`.
export type {
  RegistryItemIdentity,
  BuiltRegistryItem,
  RegistryDependencyGraphResult,
  PinnedRegistryClosure,
} from "./registry-contract";
export {
  REGISTRY_NAMESPACE_RE,
  HOST_NAMESPACE,
  RESERVED_NAMESPACES,
  REGISTRY_HOST,
  isValidRegistryNamespace,
  isReservedNamespace,
  isHostNamespace,
  canonicalNamespaceToken,
  canOnboardNamespace,
  formatRegistryItemIdentity,
  parseRegistryItemIdentity,
  registryItemPath,
  namespaceTombstoneKey,
  identityTombstoneKey,
  isNamespaceTombstoned,
  isIdentityTombstoned,
  flatHostRosterUrl,
  immutableDigestUrl,
  stableAliasUrl,
  servingUrls,
  isValidRegistryDigest,
  formatRegistryDigest,
  validateRegistryDependencyGraph,
  freezeDependencyClosure,
} from "./registry-contract";

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
// registration via capabilities). Type-only for extensions: an extension types
// the capability `impl` it resolves from `ctx.capabilities` against these shapes
// and INLINES the capability-id string literal. The host value-imports the
// capability-id CONSTANTS from the host-only `@cinatra-ai/sdk-extensions/internal`
// subpath (src/internal.ts) — they are deliberately NOT re-exported here so the
// public root carries no host service-bus addressing scheme (enforced by
// scripts/audit/sdk-public-surface-ban.mjs + src/__tests__/public-surface.test.ts).
export type {
  HostConnectorConfigService,
  HostMcpPaginationService,
  HostContentEditorDispatchService,
  WidgetActorContext,
  WidgetActorOverride,
  HostDrupalMcpService,
  HostDrupalWidgetAuthService,
  HostWordPressMcpService,
  HostWordPressContentService,
  HostInstanceWriteAuthorityService,
  InstanceWriteConnectorKind,
  HostWordPressWidgetAuthService,
  WordPressInstanceRowShape,
  HostGitHubConnectionService,
  HostLinkedInConnectionService,
  LinkedInAccountRowShape,
  HostYouTubeConnectionService,
  HostInstanceConnectionGateService,
  ExternalMcpServerRowShape,
  HostRuntimeModeService,
  HostNotificationsService,
  HostSkillsCatalogService,
  HostOpenAIConnectionService,
  HostAnthropicConnectionService,
  HostGoogleOAuthService,
  HostSecretsCodecService,
  HostExternalMcpRegistryService,
  HostMcpSelfClientService,
  HostInstanceIdentityService,
  HostEmailRoutingService,
  HostBlogRoutingService,
  NangoConnectionSavedHook,
  NangoConnectionMaterializer,
  NangoConnectionMaterializerInput,
  LlmToolboxProvider,
  HostObjectsIntegrationService,
  ObjectTypeRegistrarProvider,
  CrmSyncBootstrapProvider,
  CrmPointerWritePayload,
  CrmPointerWriterProvider,
  DevTunnelStatusProvider,
  HostBlogProjectSummary,
  HostBlogProjectStore,
  BlogImageMaterializeInputShape,
  BlogImageMaterializeResultShape,
  WordPressContentConverterInputShape,
  WordPressContentConverterOutputShape,
  BlogSystemProvider,
  SocialMediaSystemProvider,
  EmailSystemProvider,
  EmailTransportCorrelation,
  HostExtensionActionGuardService,
  LlmProviderSurface,
  LlmProviderAdapterSurface,
} from "./host-connector-services-contract";

// LLM provider ADAPTER surface version (llm-providers S4 — cinatra#1715). The
// capability-id constant stays host-fenced (./internal); this VERSION literal is
// author-facing (a connector sets its `abiVersion` against it) — a
// non-capability value, like `LLM_PROVIDER_ABI_VERSION` and
// `SDK_EXTENSIONS_ABI_VERSION`.
export { LLM_PROVIDER_ADAPTER_ABI_VERSION } from "./host-connector-services-contract";

// Chat user-context contribution: a connector contributes pre-formatted chat
// system-prompt sections through the generic capability registry (see the
// trust-boundary note in the contract module) instead of the chat runner
// importing the connector package by name. The capability-id CONSTANT is
// host-only (resolved via `@cinatra-ai/sdk-extensions/internal`); only the
// contributor TYPES are public.
export type {
  ChatUserContextContributor,
  ChatUserContextProviderRecord,
} from "./chat-user-context-contract";

// Structured per-connector contribution surfaces (cinatra#151 Stage 4): the
// packages/agents consumers resolve these capability ids instead of
// value-importing crm/gmail/google-calendar connector packages by name. The
// capability-id CONSTANTS are host-only (`@cinatra-ai/sdk-extensions/internal`);
// only the provider/reader TYPES are public.
export type { CrmListReader } from "./crm-list-reader-contract";
export type {
  EmailSenderIdentity,
  EmailSenderIdentitiesProvider,
} from "./email-sender-identities-contract";
export type {
  AppointmentScheduleEntry,
  AppointmentSchedulesProvider,
} from "./appointment-schedules-contract";

// The nango-system capability contract (the nango serverEntry cutover): the
// nango gateway registers its full host-facing surface from `register(ctx)`;
// the host resolver (src/lib/nango-system.ts) imports the id CONSTANT from the
// host-only `@cinatra-ai/sdk-extensions/internal` subpath + the TYPES from here
// — extensions keep this surface TYPE-ONLY (host-peer-value-import ban).
export type {
  NangoConnectorKey,
  ConnectorVendorKey,
  NangoConnectionIdKey,
  NangoSettings,
  NangoFrontendConfig,
  SavedNangoConnection,
  NangoConnectorDefinition,
  NangoConfigStore,
  NangoConnectionScopeOptions,
  NangoOAuth2IntegrationCredentials,
  NangoConnectionDetails,
  NangoRouteResult,
  NangoSystemSurface,
} from "./nango-system-contract";

// `asConnectorVendorKey` is a PURE (non-validating) brand cast — zero runtime
// footprint, no roster, no membership gate (vendor-identity validation lives at
// the host manifest/gate boundary, not the SDK). It is NOT a host capability-id
// constant, so it is a legitimate value export on the types-first public root.
export { asConnectorVendorKey } from "./nango-system-contract";

// The typed capability-id -> contract-surface map: compile-time ergonomics for
// `ctx.capabilities.resolveProviders(<known-id>)` (the `impl` narrows to the
// mapped surface). TYPE-ONLY and ADDITIVE — the capabilities port keeps its open
// `string` signature, the registry still stores `unknown`, and the host's
// structural guards remain the runtime trust boundary. The capability-id
// CONSTANTS stay fenced behind `@cinatra-ai/sdk-extensions/internal`; only this
// type map is public.
export type {
  CapabilityContractMap,
  KnownCapabilityId,
  ResolvedCapabilityProvider,
} from "./capability-contract-map";

// L1 declared-environment leaf (exec-plane S3, cinatra#1708; epic #1705): the
// CANONICAL internal env-spec type + the fail-closed parser + canonicalization
// shared by BOTH declaration sources (packaged-agent manifests and project-
// agent config) and consumed by the trusted environment builder
// (@cinatra-ai/execution-plane). Pure data/validation — nothing here executes.
export {
  EXECUTION_ENVIRONMENT_MANAGERS,
  EXECUTION_ENVIRONMENT_MAX_ENTRIES_PER_MANAGER,
  EXECUTION_ENVIRONMENT_MAX_ENTRY_LENGTH,
  EXECUTION_ENVIRONMENT_CARRIER_KIND,
  EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY,
  parseExecutionEnvironment,
  isEmptyExecutionEnvironment,
  canonicalExecutionEnvironmentJson,
  resolveExecutionEnvironmentClaim,
  type ExecutionEnvironmentSpec,
  type ExecutionEnvironmentManager,
  type ParseExecutionEnvironmentResult,
} from "./execution-environment";
