// Shared OBJECT contract — the React-free base object-type / sync-adapter shapes.
//
// Lives in the SDK so a connector that registers object types, registers a sync
// adapter, or writes objects depends ONLY on `@cinatra-ai/sdk-extensions` and never
// imports the internal host package `@cinatra-ai/objects`. The concrete registries +
// the objects store + the graphiti client stay host-side in `@cinatra-ai/objects`;
// this module is the schema-only, host-neutral contract those values implement, and
// `@cinatra-ai/objects` re-exports these types as its source of truth (same direction
// as the SEMANTIC-ARTIFACT manifest contract in `./artifact-contract`).
//
// Consumed by crm-connector via the
// `requireObjectsProvider()` DI slot (see `./objects-provider-contract`). The base
// renderer slot stays opaque here (`RendererComponent = unknown`) so the SDK carries
// ZERO React/JSX dependency; the React-typed refinement
// (`ObjectTypeDefinitionWithReactRenderers`) stays host-side in
// `@cinatra-ai/objects/renderer-types`.

import type { ZodType } from "zod";
import type { SemanticArtifactManifest } from "./artifact-contract";

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
// Renderers (React-free base — opaque slots)
// ---------------------------------------------------------------------------

/**
 * Opaque renderer slot type for the base (React-free) entry.
 * The generic parameter is intentionally absent — at this layer the slot is
 * untyped (`unknown`) so the SDK has zero React / JSX dependency.
 *
 * Consumers in the Next.js app should use `ObjectRendererSlots<T>` from
 * `@cinatra-ai/objects/renderer-types`, which narrows each slot to
 * `React.ComponentType<ObjectRendererSlotProps<T>>` for full prop inference.
 */
export type RendererComponent = unknown;

/**
 * React-free renderer bag used by `ObjectTypeDefinition`.
 * Slots are opaque (`unknown`) at this layer — no React dependency.
 */
export type ObjectRenderers = {
  listRow: RendererComponent;
  card: RendererComponent;
  detail: RendererComponent;
  inline?: RendererComponent;
};

// ---------------------------------------------------------------------------
// Per-type CRUD (automap) policy
// ---------------------------------------------------------------------------

/** What to do when `identityKey(data)` resolves AND a matching object exists. */
export type AutomapOnMatch = "update" | "merge" | "skip";

/** What to do when no existing object matches (or `identityKey` returns null). */
export type AutomapOnNoMatch = "create" | "hitl";

/**
 * Per-type CRUD policy consumed by the agent-output dispatcher. Declares what to
 * do when the dispatcher observes an output: on-match (update / merge / skip),
 * on-no-match (create / hitl), and the HITL-escalation threshold for classifier
 * confidence. The `DEFAULT_HITL_CONFIDENCE_THRESHOLD` runtime constant stays in
 * `@cinatra-ai/objects` (this contract is schema-only).
 */
export type AutomapCrudPolicy = {
  /** Operation to use when an existing object matches the `identityKey`. */
  onMatch: AutomapOnMatch;
  /**
   * Operation to use when no existing object matches OR the data has no
   * resolvable identity. `hitl` surfaces the ambiguity rather than guessing.
   */
  onNoMatch: AutomapOnNoMatch;
  /**
   * For `onMatch: "merge"`: the data field paths that may be combined on the
   * merged record (non-listed fields fall back to `update` semantics).
   */
  mergeableFields?: readonly string[];
  /**
   * For `onMatch: "update"`: the field paths intentionally preserved on the
   * existing record even if the incoming output sets them (e.g. `createdAt`).
   */
  preserveOnUpdate?: readonly string[];
  /**
   * Minimum classifier confidence (0..1) required to auto-route. Below this
   * threshold the dispatcher emits a `hitl` event. Default 0.6 when omitted.
   */
  hitlConfidenceThreshold?: number;
  /**
   * Fields the output MUST carry for the dispatcher to write — missing any one
   * routes to `hitl`.
   */
  requiredFields?: readonly string[];
};

// ---------------------------------------------------------------------------
// Object type definition
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
  isArtifact?: SemanticArtifactManifest;
  /**
   * Optional function returning a stable identity key for dedup lookup before
   * Graphiti writes. Return `null` when the data has no natural identifier.
   */
  identityKey?: (data: T) => string | null;
  /**
   * Per-type CRUD policy consumed by the agent-output dispatcher. Without a
   * policy the dispatcher always escalates to HITL — types never auto-write by
   * silent default.
   */
  crudPolicy?: AutomapCrudPolicy;
};

// ---------------------------------------------------------------------------
// StoredObject — canonical shape sync adapters receive on export
// ---------------------------------------------------------------------------

/**
 * Canonical shape of an object after storage. This is what sync adapters receive
 * when a save triggers outbound sync. Mirrors the `cinatra.objects` row + the
 * Graphiti entity properties relevant for export.
 */
export type StoredObject = {
  id: string; // Graphiti UUID / objects.id
  type: string; // e.g. "@cinatra-ai/entity-contacts:contact"
  data: Record<string, unknown>; // normalized data matching type schema
  parentId: string | null;
  orgId: string | null;
  createdAt: string; // ISO timestamp
  createdBy: string | null;
  agentId: string | null; // actor context
  runId: string | null;
  source: "ui" | "route" | "worker" | "scheduler" | "agent" | null;
  classificationConfidence: number | null;
  exportedTo: Record<string, ExportedEntry>;
  deletedAt: string | null;
};

export type ExportedEntry = {
  externalId?: string;
  status: "pending" | "synced" | "error";
  syncedAt?: string;
  retriedAt?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// ObjectSyncAdapter — plugin interface for outbound object sync to external systems
// ---------------------------------------------------------------------------

/**
 * Plugin interface for mirroring Cinatra objects to external systems (HubSpot,
 * Salesforce, Graphiti, etc.). Register concrete adapters via the host-bound
 * `requireObjectsProvider().registerSyncAdapter(adapter)`.
 *
 * No `server-only` — pure-type contract, safe in client bundles.
 */
export interface ObjectSyncAdapter<TConfig = Record<string, unknown>> {
  /** Unique adapter ID (namespaced: e.g. "hubspot-contacts"). */
  id: string;
  /** The external system name — "hubspot", "salesforce", "graphiti", etc. */
  targetSystem: string;
  /** Admin-UI label — "HubSpot Contacts Sync". */
  displayName: string;
  /** Object type IDs this adapter supports. */
  supportedTypes: string[];
  /** Zod schema for the per-adapter configuration (API keys, list IDs, etc.). */
  configSchema: ZodType<TConfig>;

  /** Outbound: Cinatra object → external system. */
  export(
    object: StoredObject,
    config: TConfig,
  ): Promise<{
    ok: boolean;
    externalId?: string;
    error?: string;
  }>;

  /** Optional inbound: external system → update Cinatra object. */
  importUpdate?(externalId: string, config: TConfig): Promise<Partial<StoredObject>>;

  /** Optional: propagate delete to the external system. */
  delete?(externalId: string, config: TConfig): Promise<{ ok: boolean }>;
}
