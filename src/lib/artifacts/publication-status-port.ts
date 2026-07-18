// Publication status port — the seam between the publication-operation ledger
// (cinatra#1450) and the mutability-disposition trusted commands (cinatra#1449).
//
// The mutability sub-issue owns the commands that flip a draftable artifact's
// `scheduled`/`published`/editable status (they live on the claim-disposition
// surface #1449 registers). This ledger's transitions are the ONLY thing
// allowed to invoke them (issue #1450: the artifact's scheduled/published
// status and receipts are "written only via this ledger's transitions").
//
// Because #1449 lands on a sibling branch, this substrate must NOT import its
// unmerged surface. So the ledger depends on this small INJECTED port instead;
// #1449 (or the integration lane that wires the two) provides the concrete
// adapter that calls its trusted commands. Until then the ledger runs against
// the NO-OP adapter (production callers that have not wired status yet) or the
// RECORDING adapter (tests assert the exact trusted-command sequence).
//
// Authority / recovery contract: the ledger ROW is the source of truth; the
// artifact status is a projection of it. A transition commits its ledger row
// first, then invokes the port. If a port write is interrupted after the row
// commits, reconciliation re-derives the status from the ledger — the artifact
// is never left in a status the ledger does not justify. A real #1449 adapter
// MAY instead compose its status write into the ledger transition's transaction
// for single-commit atomicity; the port shape is deliberately compatible with
// both (each method is invoked exactly once per matched transition).

import type { PublicationReceipt } from "./publication-ledger-types";

/** Context handed to every trusted-command invocation. */
export type PublicationStatusContext = {
  orgId: string;
  artifactId: string;
  /** The publication operation driving the status change (provenance). */
  operationId: string;
  /** The exact pinned representation revision the operation published/holds. */
  pinnedRepresentationRevisionId: string;
  /** The actor the transition was performed as, when known. */
  actor: string | null;
};

/**
 * The trusted-command surface the ledger drives. Every method corresponds to a
 * `PublicationStatusEffect`. Implementations MUST be idempotent (a transition
 * may be re-driven after a crash between the row commit and the status write).
 */
export interface PublicationStatusPort {
  /** `lock` — schedule pinned a revision: mark the artifact `scheduled` and
   * lock it to edits. */
  onScheduled(ctx: PublicationStatusContext): Promise<void>;
  /** `publish` — the operation succeeded: mark the artifact `published` and
   * record the receipt. */
  onPublished(ctx: PublicationStatusContext, receipt: PublicationReceipt): Promise<void>;
  /** `unlock` — the operation was cancelled (unscheduled): return the artifact
   * to editable so an edit-after-unschedule is allowed. */
  onUnscheduled(ctx: PublicationStatusContext): Promise<void>;
}

/** No-op port: the ledger row is authoritative and status is not yet wired.
 * The default for callers that have not adopted the #1449 trusted commands. */
export const NOOP_PUBLICATION_STATUS_PORT: PublicationStatusPort = {
  async onScheduled() {},
  async onPublished() {},
  async onUnscheduled() {},
};

export type RecordedStatusCall =
  | { effect: "lock"; ctx: PublicationStatusContext }
  | { effect: "publish"; ctx: PublicationStatusContext; receipt: PublicationReceipt }
  | { effect: "unlock"; ctx: PublicationStatusContext };

/** A recording port for tests: captures the ordered trusted-command sequence so
 * a test can assert, e.g., that a failed publish emitted NO `unlock` (the
 * artifact stays locked). */
export class RecordingPublicationStatusPort implements PublicationStatusPort {
  readonly calls: RecordedStatusCall[] = [];
  async onScheduled(ctx: PublicationStatusContext): Promise<void> {
    this.calls.push({ effect: "lock", ctx });
  }
  async onPublished(ctx: PublicationStatusContext, receipt: PublicationReceipt): Promise<void> {
    this.calls.push({ effect: "publish", ctx, receipt });
  }
  async onUnscheduled(ctx: PublicationStatusContext): Promise<void> {
    this.calls.push({ effect: "unlock", ctx });
  }
  /** The ordered list of effects, for concise assertions. */
  effects(): Array<RecordedStatusCall["effect"]> {
    return this.calls.map((c) => c.effect);
  }
}
