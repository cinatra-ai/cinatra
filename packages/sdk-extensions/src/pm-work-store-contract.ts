// Provider-agnostic PM WORK-ITEM STORE contract (types only) — the "PmConnector
// v2" typed CRUD surface (cinatra#1031, EPIC #1030). Lives in the SDK so a PM
// provider extension (plane-connector today; a github/linear/jira impl later)
// and the host PM store bridge share the contract WITHOUT importing each other
// by name. Provider packages reference these via `import type { ... }` only —
// this file has NO runtime code (mirrors pm-connector-contract.ts).
//
// RELATION TO `PmConnector` (the trigger-mirror seam, this file's SIBLING):
//   - `PmConnector` (pm-connector-contract.ts) mirrors ONE schedule-defining
//     trigger to a work item. The LOCAL cinatra schedule is authoritative, so it
//     is best-effort / FAIL-OPEN: a PM outage never blocks or disables the local
//     schedule.
//   - `PmWorkStore` (this file) is the PRIMARY task store for a project agent —
//     the source of truth for its tasks. So it is deliberately FAIL-CLOSED: a
//     mutation error SURFACES (a thrown error), never a silent no-op / degrade.
//     A write is "landed" only after a read-back confirms the provider persisted
//     it (see the read-after-write rule below). The two contracts are resolved
//     through SEPARATE capabilities (`pm-provider` vs `pm-work-store`) so a
//     future CRUD-only provider need not implement trigger-mirror semantics, and
//     vice-versa.
//
// CONSUMER (cinatra#1032, W2): a generic "project manager agent" owns store
// discipline over this contract — it materializes a typed project template into
// work items, picks ready items (deps done + due + unclaimed), does status
// write-back with read-back, and escalates approvals to human-assigned items.
// The project-level LEASE and the child-dispatch idempotency LEDGER are W2's
// real claim mechanisms; `version` here is a best-effort conflict DETECTOR, NOT
// a claim primitive (see `version` below).

export type PmWorkStoreId = string;

// ---------------------------------------------------------------------------
// Provider-agnostic work-item shape
// ---------------------------------------------------------------------------

/**
 * Abstract, provider-agnostic status. Each provider maps this to/from its own
 * state vocabulary (Plane: a work-item state whose `group` is
 * backlog/unstarted/started/completed/cancelled). A github impl would map to
 * an open/closed issue plus a label/Project field. The abstract set is closed
 * so the W2 ready-predicate and the human board share ONE vocabulary:
 *   - backlog      — not yet started, not scheduled to start
 *   - todo         — ready to start
 *   - in_progress  — a worker is actively on it
 *   - blocked      — cannot proceed (unmet dependency / awaiting human approval)
 *   - done         — completed successfully (a terminal state)
 *   - cancelled    — will not be done (a terminal state)
 */
export type PmWorkItemStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";

/**
 * A work item as cinatra sees it — the provider maps this to/from its own
 * work-item shape. Dates are day-granularity ISO calendar dates (YYYY-MM-DD);
 * cinatra stays authoritative for any finer instant.
 */
export type PmWorkItem = {
  /** The provider's stable work-item id (Plane work_item.id). */
  id: string;
  /**
   * cinatra-owned STABLE natural key — generalizes the trigger-mirror's
   * `[cinatra:<runId>]` title marker. The provider stamps it as a searchable
   * marker so a create is idempotent (find-or-create BY naturalKey) and a
   * project scan (`listWorkItems`) returns exactly the cinatra-managed items.
   * IMMUTABLE for the life of the item — a patch can never change it. Should be
   * a compact token (the W2 template composes e.g. `<projectId>/<taskId>`).
   */
  naturalKey: string;
  /** Human-facing title (the marker is appended by the provider, not by callers). */
  title: string;
  /** Human-facing description/body, or null. The provider MUST keep its own
   *  connector-owned metadata (e.g. the dependency edges it cannot store
   *  natively) in a SEPARATE, namespaced block that is stripped from this value
   *  on read — so `body` round-trips as the caller wrote it. */
  body?: string | null;
  /** Abstract status (mapped to/from the provider's state vocabulary). */
  status: PmWorkItemStatus;
  /** Planned start (YYYY-MM-DD) or null. */
  startDate?: string | null;
  /** Due date (YYYY-MM-DD) or null. NOTE for a Plane impl: this maps to Plane
   *  `target_date`, NEVER `due_date` (Plane REST silently drops due_date). */
  dueDate?: string | null;
  /** Provider-agnostic assignee identifiers (Plane: member user-ids). An empty
   *  array means unassigned. The human-vs-agent MEANING of an assignee is a W2
   *  template concern, not this contract's. */
  assigneeIds?: string[];
  /**
   * Natural keys of the items this item is BLOCKED BY (its dependency edges).
   * The W2 ready-predicate reads these to decide "deps done". A provider that
   * cannot represent edges natively MUST persist them as connector-owned
   * metadata and round-trip them faithfully (asserted by read-after-write).
   */
  dependsOn?: string[];
  /**
   * OPAQUE optimistic-concurrency token for best-effort conflict DETECTION.
   * Provider-derived (Plane: `updated_at`, else a hash of the mutable fields).
   *
   * NON-ATOMIC + NOT A CLAIM PRIMITIVE (load-bearing, codex#1031): providers
   * whose REST surface has no conditional write (Plane has no If-Match) can only
   * implement compare-and-swap as read-compare-write-verify, which has a TOCTOU
   * window. So `version` catches the COMMON lost-update, not every race — W2's
   * project lease + dispatch ledger remain the real mutual-exclusion mechanism.
   * Treat `version` as an advisory detector, never as a claim.
   */
  version: string;
};

/** CREATE input — the provider assigns `id` + `version`. */
export type PmWorkItemDraft = Omit<PmWorkItem, "id" | "version">;

/**
 * UPDATE input — every field optional; `id`, `naturalKey`, and `version` are NOT
 * patchable (id/naturalKey are immutable identity; version is provider-derived).
 * An omitted field is left unchanged; an explicit `null` clears a nullable field.
 */
export type PmWorkItemPatch = Partial<
  Omit<PmWorkItem, "id" | "naturalKey" | "version">
>;

/** A comment on a work item. */
export type PmWorkItemComment = {
  /** The provider's stable comment id. */
  id: string;
  /** The comment text (plain). */
  body: string;
  /** ISO-8601 creation instant. */
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Error discrimination (structural, by `.code`)
// ---------------------------------------------------------------------------

/**
 * The stable discriminant a `PmWorkStore` implementation stamps on the errors it
 * throws, so a consumer can classify a failure WITHOUT importing the provider's
 * concrete error class (keeping the host↔provider decouple). Discrimination is
 * STRUCTURAL — check `(err as { code?: string }).code`, never `instanceof`:
 *   - "validation"         — caller input the provider refuses to write (a
 *                            malformed date; a title/body containing a token the
 *                            provider reserves for its own metadata). Thrown
 *                            BEFORE any write.
 *   - "conflict"           — `expectedVersion` did not match the live version
 *                            (a concurrent write landed first); the caller should
 *                            re-read and retry.
 *   - "write_verification" — the post-write read-back did NOT match what was
 *                            sent (the provider silently dropped/altered a field,
 *                            e.g. the Plane due_date trap). NEVER reported as
 *                            success — the write is considered NOT landed.
 *   - "not_found"          — the addressed item/comment does not exist.
 *   - "config"             — the provider is unconfigured (no instance/creds).
 *   - "transport"          — a network/HTTP/parse failure reaching the provider.
 * A conforming error is `Error & { code: PmWorkStoreErrorCode }`.
 */
export type PmWorkStoreErrorCode =
  | "validation"
  | "conflict"
  | "write_verification"
  | "not_found"
  | "config"
  | "transport";

/** Structural shape of a `PmWorkStore` error — an `Error` carrying a `.code`. */
export type PmWorkStoreError = Error & { code: PmWorkStoreErrorCode };

// ---------------------------------------------------------------------------
// PmWorkStore — the typed work-item CRUD surface every PM store provider impl.
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic PM work-item store. A provider extension registers an impl
 * behind the `pm-work-store` capability from its own `register(ctx)`; the host
 * resolves it lazily through the SDK registry's external resolver
 * (pm-work-store-registry-contract.ts). All operations are project-scoped by the
 * provider's own configured instance (Plane: one workspace+project).
 *
 * FAIL-CLOSED, load-bearing across EVERY method (contrast the fail-open
 * trigger-mirror `PmConnector`): a mutation NEVER degrades to a silent no-op. On
 * any provider error the method THROWS a `PmWorkStoreError` (a `.code`-carrying
 * Error). This store is a project agent's SOURCE OF TRUTH, so a swallowed write
 * would lose task state.
 *
 * READ-AFTER-WRITE, load-bearing across EVERY mutation
 * (create/update/close/addComment): the write is "landed" ONLY after the impl
 * READS the item back and confirms the provider persisted what was sent. A
 * mismatch is ALWAYS surfaced as a `write_verification` error — even when no
 * `expectedVersion` was supplied — never a silent success. This generalizes the
 * trigger-mirror's `assertEchoedDate` (Plane silently drops some fields on
 * write). The read-back MUST assert the MACHINE-CRITICAL fields exactly — the
 * ones a consumer's logic depends on: `status`, `startDate`, `dueDate`,
 * `dependsOn`, `assigneeIds`, and the `naturalKey` identity. The free-text
 * `title`/`body` are best-effort (a provider may normalize rich text on store,
 * so a byte-exact echo is not guaranteed and is NOT asserted).
 */
export interface PmWorkStore {
  /** Stable provider id, e.g. "plane". */
  providerId: string;

  /**
   * Idempotent CREATE by natural key (find-or-create). Re-running a create for
   * the same `item.naturalKey` MUST converge on the SAME item — it finds the
   * existing one (by the stamped marker) and returns it (patched to the draft),
   * never blind-creating a duplicate (generalizes the trigger-mirror natural-key
   * idempotency). Returns the LANDED item (read-after-write verified).
   */
  createWorkItem(input: { item: PmWorkItemDraft }): Promise<PmWorkItem>;

  /** Find a work item by its cinatra natural key, or null if none exists. */
  getWorkItemByKey(input: { naturalKey: string }): Promise<PmWorkItem | null>;

  /** Read a work item by the provider's id, or null if it does not exist. */
  getWorkItem(input: { id: string }): Promise<PmWorkItem | null>;

  /**
   * List EVERY cinatra-managed work item in the provider's project scope (those
   * carrying the cinatra marker namespace) — the input to the W2 ready scan.
   * The impl MUST internally EXHAUST provider pagination (codex#1031): returning
   * only the first provider page would silently drop ready items from the scan.
   */
  listWorkItems(): Promise<PmWorkItem[]>;

  /**
   * PATCH a work item. Best-effort optimistic concurrency: when `expectedVersion`
   * is supplied and the live version differs, THROW a `conflict` error (the
   * caller re-reads + retries) — the write is NOT applied. Read-after-write
   * verified; returns the LANDED item with its new `version`. See the
   * NON-ATOMIC caveat on `PmWorkItem.version` — this detects the common
   * lost-update, it is not a lock.
   */
  updateWorkItem(input: {
    id: string;
    patch: PmWorkItemPatch;
    expectedVersion?: string;
  }): Promise<PmWorkItem>;

  /**
   * Transition a work item to a terminal status (default "done"). Convenience
   * over `updateWorkItem` with the same optimistic-concurrency + read-after-write
   * guarantees. Returns the LANDED item.
   */
  closeWorkItem(input: {
    id: string;
    status?: "done" | "cancelled";
    expectedVersion?: string;
  }): Promise<PmWorkItem>;

  /**
   * Append a comment to a work item. Read-after-write verified: the impl
   * confirms the comment landed (e.g. by reading it back) before returning its
   * ref. Used by W2 to record worker-agent results + approval escalations.
   */
  addComment(input: { id: string; body: string }): Promise<PmWorkItemComment>;

  /** List a work item's comments (newest-or-oldest order is provider-defined). */
  listComments(input: { id: string }): Promise<PmWorkItemComment[]>;
}
