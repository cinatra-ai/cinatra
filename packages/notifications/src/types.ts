// ---------------------------------------------------------------------------
// Notifications — shared types for the Postgres-backed layer.
//
// Recipients are resolved at write time. Topic/admin/team/org/project
// recipients fan out to per-user rows in `cinatra.notifications`. There is
// no nullable topic row and no join table — every notification belongs to
// exactly one user.
//
// Pure types, ZERO runtime deps, no `server-only`.
// ---------------------------------------------------------------------------

// Type-only re-export so the package keeps ONE ActorContext definition (in
// the TRUE LEAF host-adapters.ts). `export type` is erased at runtime — this
// does NOT pull the host-adapters runtime onto a `/types` importer.
export type { ActorContext } from "./host-adapters";

export type NotificationKind = "success" | "error" | "warning" | "info";

export type NotificationRecipient =
  | { kind: "user"; userId: string }
  | { kind: "team"; teamId: string }
  | { kind: "organization"; organizationId: string }
  | { kind: "project"; projectId: string }
  | { kind: "admins" };

export type NotificationInput = {
  title: string;
  body?: string;
  kind?: NotificationKind;
  href?: string;
  metadata?: Record<string, unknown>;
  sourceJobId?: string;
  sourceJobName?: string;
  /**
   * Stable per-user idempotency key for one LOGICAL notification occurrence.
   *
   * When set, the INSERT dedupes on the partial unique index
   * `(user_id, dedupe_key)` via ON CONFLICT DO NOTHING — a repeat write of
   * the same logical event (double-emitting writers, retried deliveries,
   * overlapping recipient fanouts that resolve to the same user) collapses
   * to ONE row instead of rendering twice in the flyout (issue #50).
   *
   * Semantics: the key identifies an OCCURRENCE, not an event type —
   * recurring events that should notify again must mint a fresh key per
   * occurrence. When `dedupeKey` is set it is the ONLY conflict target the
   * INSERT arbitrates on (Postgres accepts a single conflict target), so a
   * caller must not rely on the legacy `(user_id, source_job_id, kind)` job
   * dedupe for the same row.
   */
  dedupeKey?: string;
};

/**
 * Row shape returned by the service. Compatible with the `AppNotification`
 * type below (extra fields are optional and ignored by the legacy renderer).
 */
export type NotificationRecord = {
  id: string;
  userId: string;
  recipientKind: NotificationRecipient["kind"];
  recipientId?: string;
  topic: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href?: string;
  metadata?: Record<string, unknown>;
  sourceJobId?: string;
  sourceJobName?: string;
  /** General per-user dedupe key — see `NotificationInput.dedupeKey`. */
  dedupeKey?: string;
  createdAt: string;
  readAt?: string;
};

/**
 * The GET /api/notifications row shape consumed by the flyout/archive UI.
 * Lives in pure package types with no cycle. The host facade
 * (`src/lib/notifications.ts`) re-exports it so every existing
 * `import { AppNotification } from "@/lib/notifications"` keeps compiling
 * unchanged.
 */
export type AppNotification = {
  id: string;
  title: string;
  body: string;
  // "info" distinguishes background-process running rows from terminal
  // success/error/warning. A discrete `info` kind lets the partial unique
  // index `(user_id, source_job_id, kind)` cohabit a running row + a
  // terminal row per job without colliding.
  kind: "success" | "error" | "warning" | "info";
  href?: string;
  createdAt: string;
  readAt?: string;
  // Job-source linkage so the flyout's `collapseByJobId` helper can merge a
  // running row + its terminal row into one.
  sourceJobId?: string;
  sourceJobName?: string;
  // General per-user dedupe key (issue #50) — server-side ON CONFLICT
  // collapse for repeated writes of the same logical event. Pass-through
  // for client visibility/debugging; the collapse itself happens at INSERT
  // time, so the flyout never receives two rows sharing one dedupeKey.
  dedupeKey?: string;
  // Arbitrary metadata pass-through. Today's only consumer is
  // `metadata.progress = { status, jobId, jobName, startedAt }` for
  // background-process rows.
  metadata?: Record<string, unknown>;
};

/**
 * Retired in-memory `BackgroundProcess[]` source type. Kept exported for
 * asset-blog's own background-process modal (`@cinatra-ai/sdk-ui`) which
 * keeps a separate, modal-only state path.
 */
export type BackgroundProcess = {
  id: string;
  title: string;
  body: string;
  href?: string;
  updatedAt: string;
};
