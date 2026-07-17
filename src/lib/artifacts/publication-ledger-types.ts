// Shared, I/O-free types for the publication-operation ledger (cinatra#1450).
// Kept separate from the DB module so the status port and tests import the row
// / receipt shapes without pulling in `server-only` DB code, and separate from
// the pure state machine so that module stays a minimal guard specification.

import type {
  PublicationDestination,
  PublicationOperationState,
} from "./publication-operation-state";

/** The receipt an external publish returns — the provider's durable pointer to
 * the created content. Soft, provider-shaped provenance (epic #1448: correlation
 * keys are soft provenance only, never acquire FK/cascade/lifecycle authority).
 */
export type PublicationReceipt = {
  /** The provider's id for the created post/entity. */
  externalId?: string;
  /** The public URL of the published content, when the provider returns one. */
  url?: string;
  /** Provider-specific extras (never interpreted by the ledger). */
  [key: string]: unknown;
};

/** A publication-operation ledger row, mapped from `artifact_publication_operations`. */
export type PublicationOperationRow = {
  id: string;
  orgId: string;
  /** The draftable artifact being published. */
  artifactId: string;
  /** The artifact's object type id (for indexed per-type / per-campaign rollup). */
  objectTypeId: string;
  /** The exact pinned representation revision — the bytes that will be published. */
  pinnedRepresentationRevisionId: string;
  destination: PublicationDestination;
  /** When the operation becomes due. "Publish now" = an immediately-due operation. */
  dueAt: string;
  state: PublicationOperationState;
  attempt: number;
  /** Deterministic key handed VERBATIM to the delivery/connector call so a
   * redelivery cannot double-publish. */
  idempotencyKey: string;
  /** The fence: bumped on cancel; a stale delivery for a prior generation is
   * rejected at the pending→running claim. */
  cancellationGeneration: number;
  /** The publish receipt on success, else null. */
  receipt: PublicationReceipt | null;
  /** The failure reason when `state = 'failed'`, else null. */
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  settledAt: string | null;
};
