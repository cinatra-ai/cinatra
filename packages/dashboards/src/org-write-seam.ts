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
  type OrgWriteAuthority,
  type OrgWriteDb,
  type OrgWriteTx,
} from "@cinatra-ai/org-write-kernel";

import type { DashboardActor } from "./permissions";
import { getDashboardsDb } from "./store/db";

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

/** Fail-closed extraction: no authority, or an authority/actor organization
 *  mismatch, refuses before any transaction work. */
export function requireOrgWriteAuthority(actor: DashboardActor): OrgWriteAuthority {
  const authority = actor.authority;
  if (!authority) throw new DashboardOrgWriteAuthorityError("missing");
  if (authority.orgId !== actor.organizationId) {
    throw new DashboardOrgWriteAuthorityError("org-mismatch");
  }
  return authority;
}

/** The transaction shape the kernel guard hands back: the drizzle tx the
 *  writer body already uses, seen through the kernel's minimal contract. */
export type GuardedDashboardsTx = OrgWriteTx;

export interface GuardedDashboardsWriteOptions {
  /** App schema holding the kernel's lease table (lease-gated rulings during
   *  an archive transition). Writers pass their resolved schema name. */
  readonly schema: string;
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
  const authority = requireOrgWriteAuthority(actor);
  const db =
    options.db ?? (getDashboardsDb() as unknown as OrgWriteDb<OrgWriteTx>);
  return guardOrgMutation(
    db,
    {
      orgId: actor.organizationId,
      capability: "content.write",
      authority,
      schema: options.schema,
    },
    async (tx) => fn(tx),
  );
}
