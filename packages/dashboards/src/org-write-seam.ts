/**
 * The dashboards org-write seam — cinatra#1939 (archive epic S3, wave 1).
 *
 * ONE front door through which every dashboards writer acquires its write
 * authority from the org-write kernel. `guardOrgMutation` opens the
 * transaction itself and takes the ORGANIZATION locks before the callback
 * runs, so a writer converted onto this seam gets the org-first lock order
 * for free — its per-dashboard twin advisory locks (acquireTwinLockFirst)
 * simply become second, removing the org↔id inversion.
 *
 * DARK in this commit (twin-writer-seam precedent): no production writer
 * calls it yet. Writers convert ONE AT A TIME together with their callers
 * and test fakes (the design-of-record's per-writer ratchet on #1939) —
 * converting a writer without threading `actor.authority` from its callers
 * would fail-closed every production call, so the vertical always lands as
 * one commit per writer.
 *
 * Fail-closed by construction: no authority on the actor, or an authority
 * minted for a DIFFERENT organization than the actor's, refuses before any
 * transaction is opened. Authorities are minted HOST-side only (the
 * src/lib/org-write authority resolvers); this package never mints.
 */
import {
  guardOrgMutation,
  OrgWriteRefusedError,
  type OrgWriteAuthority,
  type OrgWriteDb,
  type OrgWriteTx,
} from "@cinatra-ai/org-write-kernel";

import type { DashboardActor } from "./permissions";
import { getDashboardsDb } from "./store/db";

/**
 * Thrown when a WORKSPACE write (cinatra#2811) has no acting user. The
 * workspace tier has no organization lifecycle to rule on, so its one
 * precondition is an identified principal; the writer's own resolver check then
 * decides whether that principal owns the row.
 */
export class DashboardWorkspaceWriteActorError extends Error {
  constructor() {
    super(
      "dashboards workspace write: no acting user; a workspace dashboard is " +
        "written only by the user who owns it (cinatra#2811).",
    );
    this.name = "DashboardWorkspaceWriteActorError";
  }
}

export class DashboardOrgWriteAuthorityError extends Error {
  constructor(reason: "missing" | "org-mismatch") {
    super(
      reason === "missing"
        ? "dashboards org-write seam: the actor carries no org-write authority — " +
          "every dashboards write requires one minted host-side (cinatra#1939 S3)."
        : "dashboards org-write seam: the actor's org-write authority was minted " +
          "for a different organization than the actor's active one.",
    );
    this.name = "DashboardOrgWriteAuthorityError";
  }
}

/**
 * True for the kernel's OWN refusal — its lifecycle ruling on a write it
 * otherwise had authority for (an archived org, a held lease).
 *
 * A PREDICATE rather than a re-exported class (cinatra#2474 PR5): a caller
 * outside this package that needed `instanceof OrgWriteRefusedError` would have
 * to reach the kernel root itself, and opaque access to that root is exactly
 * what the org-write boundary gate refuses — it reaches every kernel writer
 * without naming one. The kernel edge belongs here, in the seam that already
 * owns it; callers ask this question instead.
 */
export function isOrgWriteRefusal(e: unknown): boolean {
  return e instanceof OrgWriteRefusedError;
}

/** Fail-closed extraction: no authority, or an authority/actor organization
 *  mismatch, refuses before any transaction work. */
export function requireOrgWriteAuthority(actor: DashboardActor): OrgWriteAuthority {
  const authority = actor.authority;
  if (!authority) throw new DashboardOrgWriteAuthorityError("missing");
  if (actor.organizationId === null || authority.orgId !== actor.organizationId) {
    throw new DashboardOrgWriteAuthorityError("org-mismatch");
  }
  return authority;
}

/** The transaction shape the kernel guard hands back: the drizzle tx the
 *  writer body already uses, seen through the kernel's minimal contract. */
export type GuardedDashboardsTx = OrgWriteTx;

/**
 * Which tenancy a write runs under (cinatra#2811).
 *
 *   - "organization" (the default): every row the write touches belongs to the
 *     actor's active organization, so the org-write kernel takes that
 *     organization's locks and rules `content.write` against its lifecycle.
 *   - "workspace": the write touches ONLY org-NULL workspace rows. The workspace
 *     sits above every organization and has no lifecycle of its own, so no
 *     organization is locked or ruled on, and the active organization (or its
 *     absence) plays no part. The writer re-checks the row's org-NULL shape
 *     inside the transaction, so a workspace tenancy can never reach an
 *     organization row.
 */
export type DashboardWriteTenancy = "organization" | "workspace";

export interface GuardedDashboardsWriteOptions {
  /** App schema holding the kernel's lease table (lease-gated rulings during
   *  an archive transition). Writers pass their resolved schema name. */
  readonly schema: string;
  /** The write's tenancy; defaults to "organization" (see the type). */
  readonly tenancy?: DashboardWriteTenancy;
  /** TEST-ONLY database override (production always uses the package db). */
  readonly db?: OrgWriteDb<OrgWriteTx>;
}

/**
 * Run one dashboards write under the kernel guard: org locks → lifecycle
 * ruling for `content.write` → permit for exactly this transaction. The
 * callback receives the SAME drizzle transaction the current writers use —
 * conversion is `db.transaction(body)` → `guardedDashboardsWrite(actor, opts, body)`.
 */
export async function guardedDashboardsWrite<R>(
  actor: DashboardActor,
  options: GuardedDashboardsWriteOptions,
  fn: (tx: GuardedDashboardsTx) => Promise<R>,
): Promise<R> {
  const db =
    options.db ?? (getDashboardsDb() as unknown as OrgWriteDb<OrgWriteTx>);
  if (options.tenancy === "workspace") {
    // The org-NULL arm: no organization to lock or rule on. One precondition:
    // an identified acting user. Ownership is the writer's resolver check.
    if (typeof actor.userId !== "string" || actor.userId.length === 0) {
      throw new DashboardWorkspaceWriteActorError();
    }
    return db.transaction(async (tx) => fn(tx));
  }
  const authority = requireOrgWriteAuthority(actor);
  return guardOrgMutation(
    db,
    {
      orgId: authority.orgId,
      capability: "content.write",
      authority,
      schema: options.schema,
    },
    async (tx) => fn(tx),
  );
}
