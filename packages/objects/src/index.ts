// Absorbed from @cinatra/object-types — verbatim surface
export { OBJECT_TYPE_NAMESPACE_RE, isNamespacedObjectTypeId } from "./namespace";
// Reserved `@dynamic` scope for LLM-minted dynamic-type ids (cinatra#1425);
// legacy `@cinatra-ai/dynamic:` ids stay valid on READ via the catalog.
export {
  DYNAMIC_TYPE_ID_PREFIX,
  LEGACY_DYNAMIC_TYPE_ID_PREFIX,
  DYNAMIC_TYPE_ID_RE,
  LEGACY_DYNAMIC_TYPE_ID_RE,
  isDynamicObjectTypeId,
  mintDynamicObjectTypeId,
} from "./namespace";

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
  validateSemanticArtifactManifestForPublish,
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

// Artifact-type claims — pure policy leaf (cinatra#1425, epic #1424): the
// status/kind vocabulary, the dispositions union validator, and kind-over-
// scope arbitration. DB state lives in the host claim store
// (src/lib/objects/artifact-claim-store.ts). DELIBERATELY NOT re-exported
// from this barrel: consumers import the `@cinatra-ai/objects/claims`
// subpath (the classifier-signals leaf pattern) so the leaf never joins the
// barrel's route-reachable module graph (route-graph ratchet).

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
// Agent-memory concept envelope (cinatra#1376, epic #1373): the static type
// id, the enforced envelope schema, and the deterministic external-identity
// derivation — consumed by the memory sync path (epic S5) and tests. These
// live inline in register-types.ts (route-graph budget: no new sibling
// module on the locked routes).
export {
  registerAllObjectTypes,
  registerMemoryConceptType,
  MEMORY_CONCEPT_TYPE_ID,
  MEMORY_CONCEPT_BODY_MAX_BYTES,
  computeMemoryConceptExternalId,
  isValidMemoryConceptId,
  memoryConceptEnvelopeSchema,
} from "./integration/register-types";
export type { MemoryConceptEnvelope } from "./integration/register-types";
// Per-type CRUD policy + agent-output dispatcher. The dispatcher is PURE
// (decideDispatch); the in-process wrapper that performs the lookup +
// canonical write lives in app code (`src/lib/objects-automap.ts`) so this
// package stays substrate-only.
export type { AutomapCrudPolicy, AutomapOnMatch, AutomapOnNoMatch } from "./automap/policy";
export { DEFAULT_HITL_CONFIDENCE_THRESHOLD } from "./automap/policy";
export type { DispatchDecision, ExistingObject, DecideDispatchInput } from "./automap/dispatcher";
export { decideDispatch } from "./automap/dispatcher";

// Object Type Registry admin actions. The registry screen, the raw objects
// browser and the raw object-detail screen were consolidated into the
// `/artifacts` surface (Types & approvals / Raw objects modes) and their route
// trees retired (cinatra#1431 §IV/§V/§VII); the lifecycle actions remain and
// are now driven from the Types & approvals mode.
export {
  approveDynamicObjectTypeAction,
  archiveDynamicObjectTypeAction,
} from "./screens/object-type-actions";
