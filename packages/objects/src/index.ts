// Absorbed from @cinatra/object-types — verbatim surface
export { OBJECT_TYPE_NAMESPACE_RE, isNamespacedObjectTypeId } from "./namespace";

// Single code-owned taxonomy.
// (ObjectCategory + the namespace helpers are exported elsewhere in this barrel.)
export {
  OBJECT_CATEGORIES,
  UI_FAMILIES,
  ARTIFACT_STATUSES,
  WRAPPER_PRIMITIVES,
  OBJECT_RBAC_RESOURCE_TYPES,
  OBJECT_TYPE_FAMILY,
  assertDomainNamespacedTypeId,
  objectTypeIdsForFamily,
  uiFamilyForTypeId,
  isKnownObjectTypeId,
} from "./taxonomy";
export type {
  UiFamily,
  ArtifactStatus,
  WrapperPrimitive,
  RbacResourceType,
  KnownObjectTypeId,
} from "./taxonomy";

export type {
  ObjectCategory,
  RelationCardinality,
  RelationDefinition,
  ObjectLifecycle,
  RendererComponent,
  ObjectRenderers,
  ObjectTypeDefinition,
  ArtifactCapabilities,
  ArtifactDescriptor,
  SemanticArtifactManifest,
  SemanticArtifactRef,
  ArtifactRepresentationForms,
  ArtifactTemplateVariant,
  ArtifactSkillBundle,
} from "./types";
// Semantic manifest schema/parser (runtime values).
export {
  semanticArtifactManifestSchema,
  semanticProducesSchema,
  parseSemanticArtifactManifest,
  DEFAULT_ARTIFACT_EXTENSION,
  isDefaultArtifactType,
} from "./semantic-manifest";

export type {
  InputCardinality,
  OutputCardinality,
  AgentIOPort,
  AgentOutputPort,
  AgentIOSpec,
} from "./agent-io-spec";

export {
  agentIOSpecSchema,
  agentIOPortSchema,
  agentOutputPortSchema,
  inputCardinalitySchema,
  outputCardinalitySchema,
} from "./agent-io-spec";

export { objectTypeRegistry } from "./registry";
export { canCompose, findCompositionMatches } from "./compose";

// Graphiti-backed object intelligence exports.
export * as graphitiClient from "./graphiti-client";
export type * from "./graphiti-types";
export { resolveIdentity, hashIdentity } from "./identity";
export { classifyObject } from "./classifier";
export type { ClassifierOutput } from "./classifier/schema";
export {
  ensureDynamicObjectType,
  readDynamicObjectTypes,
  readActiveDynamicObjectTypes,
  readAllDynamicObjectTypes,
  approveDynamicObjectType,
  archiveDynamicObjectType,
} from "./auto-registrar";
export type { DynamicObjectTypeRecord } from "./auto-registrar";

// Object sync adapter interface + registry.
// "sync-adapter" disambiguates these adapters from transport connector
// packages, matches the LlmProviderAdapter suffix convention, and follows
// the Hexagonal Ports & Adapters pattern.
export type {
  ObjectSyncAdapter,
  StoredObject,
  ExportedEntry,
} from "./sync-adapters/adapter";
export { objectSyncAdapterRegistry } from "./sync-adapters/registry";

// Sync-adapter config store.
export {
  readActiveObjectSyncAdapterConfigs,
  readAllObjectSyncAdapterConfigs,
  upsertObjectSyncAdapterConfig,
} from "./sync-adapters/config-store";
export type { ObjectSyncAdapterConfigRow } from "./sync-adapters/config-store";
// NOTE: dispatch.ts is deferred because a BullMQ abstraction should wait until
// a real sync adapter implementation exists.

// MCP + integration surface.
export { createObjectsPrimitiveHandlers } from "./mcp/handlers";
export { registerObjectsPrimitives } from "./mcp/registry";
export type { DeterministicObjectsClient } from "./mcp/client/deterministic-client";
export { createDeterministicObjectsClient } from "./mcp/client/deterministic-client";
export { objectsClient } from "./objects-client";
export { createSessionObjectsClient } from "./objects-client";
export { createObjectsModule } from "./integration/module";
export { registerAllObjectTypes } from "./integration/register-types";
// Per-type CRUD policy + agent-output dispatcher. The dispatcher is PURE
// (decideDispatch); the in-process wrapper that performs the lookup +
// canonical write lives in app code (`src/lib/objects-automap.ts`) so this
// package stays substrate-only.
export type { AutomapCrudPolicy, AutomapOnMatch, AutomapOnNoMatch } from "./automap/policy";
export { DEFAULT_HITL_CONFIDENCE_THRESHOLD } from "./automap/policy";
export type { DispatchDecision, ExistingObject, DecideDispatchInput } from "./automap/dispatcher";
export { decideDispatch } from "./automap/dispatcher";

// Admin screens.
export { ObjectsBrowserScreen } from "./screens/objects-browser";
export { ObjectDetailPage } from "./screens/object-detail-page";

// Object Type Registry admin screen + actions.
export { ObjectTypesScreen } from "./screens/object-types-screen";
export {
  approveDynamicObjectTypeAction,
  archiveDynamicObjectTypeAction,
} from "./screens/object-type-actions";
