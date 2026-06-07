import type { ZodType } from "zod";

// ---------------------------------------------------------------------------
// StoredObject — canonical shape sync adapters receive on export
// ---------------------------------------------------------------------------

/**
 * Canonical shape of an object after storage. This is what sync adapters
 * receive when a save triggers outbound sync. Mirrors the row shape in
 * `cinatra.objects` table + Graphiti entity properties relevant for export.
 *
 * TODO (security): object_sync_adapter_configs.config holds third-party API
 * credentials. Encryption-at-rest is required before any credential-bearing
 * sync adapter ships.
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
 * Salesforce, etc.). The `ObjectSyncAdapter` name disambiguates this boundary
 * from transport "connector" packages (Gmail/Apify/etc.), and the suffix
 * `Adapter` matches the GoF / Hexagonal precedent used elsewhere in the
 * codebase (`LlmProviderAdapter`, `OpenAIAdapter`, …).
 *
 * Register concrete adapters from a connector package's
 * `integration/module.ts` via `objectSyncAdapterRegistry.register(adapter)`.
 *
 * CRM note (Twenty migration): the `@cinatra-ai/entity-accounts:account` and
 * `@cinatra-ai/entity-contacts:contact` object types are adapter-owned — their
 * canonical store is Twenty CRM, reached through the provider-agnostic
 * crm-connector facade, and the Graphiti projection target is wired via the
 * Twenty→Graphiti sync adapter. cinatra holds only a `cinatra.objects` pointer
 * row per record (the deprecated `@cinatra-ai/entity-{accounts,contacts}`
 * packages are type-alias stubs that merely register the object TYPE so the
 * substrate can classify those pointer rows).
 *
 * No `server-only` on this file — it is a pure-type file, safe in client
 * bundles. The sync-adapter administration UI imports this interface for form
 * rendering.
 */
export interface ObjectSyncAdapter<TConfig = Record<string, unknown>> {
  /** Unique adapter ID (namespaced: e.g. "hubspot-contacts"). */
  id: string;
  /** The external system name — "hubspot", "salesforce", "wordpress", etc. */
  targetSystem: string;
  /** Admin-UI label — "HubSpot Contacts Sync". */
  displayName: string;
  /** Object type IDs this adapter supports — e.g. ["@cinatra-ai/entity-contacts:contact"]. */
  supportedTypes: string[];
  /**
   * Zod schema for the per-adapter configuration (API keys, list IDs, etc.).
   * The admin UI renders a form from this schema.
   */
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
