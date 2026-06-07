import type { ZodType } from "zod";

// ---------------------------------------------------------------------------
// Object categories
// ---------------------------------------------------------------------------

/**
 * Domain category of an object type. Replaces the implicit Asset/Entity split
 * with an explicit taxonomy.
 */
export type ObjectCategory = "profile" | "content" | "project" | "idea" | "report";

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export type RelationCardinality = "one" | "many";

/**
 * Declarative relation definition. Relations use a schema-only contract;
 * runtime resolver-based relations are intentionally not part of this type.
 */
export type RelationDefinition = {
  name: string;
  targetType: string;
  cardinality: RelationCardinality;
  fkField: string;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type ObjectLifecycle = {
  sources: ("agent" | "user" | "import")[];
  mutableBy: ("agent" | "user")[];
};

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Opaque renderer slot type for the base (React-free) entry.
 * The generic parameter is intentionally absent — at this layer the slot is
 * untyped (`unknown`) so the package has zero React / JSX dependency.
 *
 * Consumers in the Next.js app should use `ObjectRendererSlots<T>` from
 * `@cinatra/object-types/renderer-types`, which narrows each slot to
 * `React.ComponentType<ObjectRendererSlotProps<T>>` for full prop inference.
 */
export type RendererComponent = unknown;

/**
 * React-free renderer bag used by `ObjectTypeDefinition`.
 * Slots are opaque (`unknown`) at this layer — no React dependency.
 *
 * For React-typed slots with full `ComponentType` inference, import
 * `ObjectRendererSlots<T>` from `@cinatra/object-types/renderer-types`.
 */
export type ObjectRenderers = {
  listRow: RendererComponent;
  card: RendererComponent;
  detail: RendererComponent;
  inline?: RendererComponent;
};

// ---------------------------------------------------------------------------
// Object type definition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Artifact descriptor
// ---------------------------------------------------------------------------

/**
 * Capability flags an artifact type exposes to the library / serving / MCP
 * layers. Consumed GENERICALLY — no layer may branch on a specific
 * `artifactType` string. A new artifact type appears in the library purely
 * by registering an `ObjectTypeDefinition` carrying this descriptor
 * delivered via a `kind:"artifact"` extension.
 */
export type ArtifactCapabilities = {
  editable?: boolean;
  downloadable?: boolean;
  publishable?: boolean;
};

/**
 * Metadata-only artifact descriptor. Serializable (no functions) so it can
 * travel from a `kind:"artifact"` extension's package.json `cinatra.artifact`
 * block through the object-registry bridge with zero React/server imports.
 *
 * - `artifactType`: the type id declared by the artifact extension
 *   (built-ins: `"file" | "dashboard" | "connector-ref"`; extensible).
 * - `viewerHint`: default render hint (for `file` it is MIME-driven at
 *   render time; the descriptor carries the fallback).
 * - `freshness`: internal capability attribute only (NOT a UI taxonomy) —
 *   `"snapshot"` (default) or `"live"` (refreshed by a recurring agent).
 * - `resolver`: optional opaque id of a connector resolver (used by the
 *   `connector-ref` type); resolved by the connector, never a function here.
 */
/**
 * Semantic artifact-extension manifest. Replaces the substrate descriptor
 * shape (`artifactType` / `viewerHint` / `freshness` / `resolver`):
 * `file`, `dashboard`, and `connector-ref` are representation forms, not
 * artifact types. A `kind:"artifact"` extension declares only a semantic
 * work-product type.
 *
 * - `accepts` — the representation FORMS this artifact's resources may take.
 * - `satisfies` — interface-style relations (`@vendor/x` satisfies
 *   `@cinatra-ai/marketing-icp-artifact`) so slots match across vendors.
 * - `templates` — per-form starter content (drives "New from template").
 * - `skills` — auditor-pattern bundle by purpose. Values are skills-CATALOG
 *   ids (NOT filesystem paths — CLAUDE.md upsertSkill doctrine; the parser
 *   rejects path-shaped refs).
 * - `agentDependencies` — agents this extension's skills may invoke (feeds
 *   the cross-kind dependency graph).
 */
export type ArtifactRepresentationForms = {
  file?: { mimeTypes: string[] };
  connectorRef?: { resolvedMimeTypes: string[] };
  dashboard?: true;
};

export type ArtifactTemplateVariant = {
  id: string;
  form: "file" | "connectorRef" | "dashboard";
  mimeType: string;
  path: string;
  default?: boolean;
};

export type ArtifactSkillBundle = {
  authoring?: string[];
  matchers?: string[];
  validators?: string[];
  enrichers?: string[];
};

export type SemanticArtifactManifest = {
  accepts: ArtifactRepresentationForms;
  satisfies?: string[];
  templates?: ArtifactTemplateVariant[];
  skills?: ArtifactSkillBundle;
  agentDependencies?: string[];
  /**
   * Per-extension matcher confidence floor (0..1). The matcher runtime
   * asserts this artifact type only when the classifier's returned
   * confidence ≥ this value. The runtime defaults to 0.7 when absent.
   */
  matcherConfidenceThreshold?: number;
};

/**
 * Counterpart on the AGENT-extension side: deterministic agents declare the
 * semantic artifact types they produce. This type is schema-only;
 * strict cross-kind validation happens outside this definition.
 */
export type SemanticArtifactRef = { extension: string };

/**
 * @deprecated Substrate descriptor name retained as an alias to the semantic
 * manifest so external type-only importers do not break; carries NO substrate
 * fields.
 */
export type ArtifactDescriptor = SemanticArtifactManifest;

// ---------------------------------------------------------------------------

export type ObjectTypeDefinition<T = unknown> = {
  type: string;
  category: ObjectCategory;
  schema: ZodType<T>;
  lifecycle: ObjectLifecycle;
  renderers: ObjectRenderers;
  relations?: RelationDefinition[];
  /**
   * When set, this object type IS an artifact and surfaces in the Artifacts
   * library / serving / MCP generically via this descriptor. Absent ⇒ data
   * object, not an artifact. Per-object-TYPE flag — never per-instance.
   */
  isArtifact?: ArtifactDescriptor;
  /**
   * Optional function returning a stable identity key for dedup lookup before
   * Graphiti writes. Return `null` when the data has no natural identifier
   * (e.g. a free-form note without email/url/slug).
   *
   * Examples:
   * - account: `(d) => d.websiteHost ?? d.website`
   * - contact: `(d) => d.email ?? d.linkedinUrl`
   * - blog-post: `(d) => slugify(d.title)`
   */
  identityKey?: (data: T) => string | null;
  /**
   * Per-type CRUD policy consumed by the agent-output dispatcher
   * (`./automap/dispatcher.ts`). Declares what to do when the dispatcher
   * observes an output: on-match (update / merge / skip), on-no-match
   * (create / hitl), and the HITL-escalation threshold for classifier
   * confidence. Without a policy the dispatcher always escalates to HITL —
   * types never auto-write by silent default.
   */
  crudPolicy?: import("./automap/policy").AutomapCrudPolicy;
};
