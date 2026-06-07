import { pgSchema, text, timestamp, jsonb, boolean, integer, uniqueIndex, index } from "drizzle-orm/pg-core";

const cinatraSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");

export const dynamicObjectTypes = cinatraSchema.table("dynamic_object_types", {
  type: text("type").primaryKey(),
  /** DDL column: display_name — human-readable label for this dynamic type. */
  displayName: text("display_name").notNull(),
  inferredCategory: text("inferred_category").notNull(),
  slug: text("slug"),
  jsonSchema: jsonb("json_schema"),
  source: text("source"),
  confidence: text("confidence"),
  /** 'proposed' = needs admin review; 'active' = trusted/high-confidence. Default: 'proposed'. */
  status: text("status").notNull().default("proposed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by"),
  promotedToType: text("promoted_to_type"),
  // Extensible provenance (agentId, runId, clientId, ...).
  // Nullable JSONB; populated by ensureDynamicObjectType() when the caller has
  // a run context; otherwise null.
  originContext: jsonb("origin_context"),
  // Data field name to extract as Graphiti dedup key (e.g. "cinatra_agent_run_id").
  // When set, objects_save synthesizes an identityKey for this dynamic type without
  // requiring a static objectTypeRegistry entry.
  identityKey: text("identity_key"),
});

// Object sync adapter configs disambiguate object synchronization adapters
// from transport "connector" packages. Existing DBs are migrated to this
// table and column naming.
export const objectSyncAdapterConfigs = cinatraSchema.table(
  "object_sync_adapter_configs",
  {
    id: text("id").primaryKey(),
    objectType: text("object_type").notNull(),
    adapterId: text("adapter_id").notNull(),
    config: jsonb("config").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    objectTypeAdapterIdUnique: uniqueIndex("object_sync_adapter_configs_type_adapter_unique").on(
      t.objectType,
      t.adapterId,
    ),
  }),
);

// ---------------------------------------------------------------------------
// graphiti_projection_outbox
// Outbox table for durable Graphiti projection. Atomic with object writes.
// Do not add a Drizzle binding for the `objects` table: it has no existing
// binding and is read/written exclusively via raw SQL in
// `src/lib/objects-store.ts`. A partial binding for new columns only would be
// incomplete.
// ---------------------------------------------------------------------------
export const graphitiProjectionOutbox = cinatraSchema.table(
  "graphiti_projection_outbox",
  {
    id: text("id").primaryKey(),
    objectId: text("object_id").notNull(),
    objectVersion: integer("object_version").notNull(),
    orgId: text("org_id"),
    operation: text("operation").notNull(),
    status: text("status").notNull().default("pending"),
    payloadHash: text("payload_hash"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // Derived-store ownership columns mirroring source resource.
    ownerType: text("owner_type"),
    ownerId: text("owner_id"),
    visibility: text("visibility"),
  },
  (t) => ({
    pendingIdx: index("graphiti_outbox_pending_idx").on(t.status, t.createdAt),
    objectIdx: index("graphiti_outbox_object_idx").on(t.objectId),
  }),
);

export type GraphitiProjectionOutboxRow = typeof graphitiProjectionOutbox.$inferSelect;
export type GraphitiProjectionOutboxInsert = typeof graphitiProjectionOutbox.$inferInsert;
