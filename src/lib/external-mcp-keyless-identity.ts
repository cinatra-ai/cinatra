// THE ONE LIFECYCLE of the connection IDENTITIES an external-MCP server row
// carries (cinatra#3485): the DERIVED keyless one, and, on the delete road, the
// STORED credential one that has to go with it.
//
// A server registered with the API-key field left blank stores no credential,
// so it has no connection pointer to address. Its `externalMcp` identity is
// addressed by an id DERIVED from the row id instead, and the Sharing tab draws
// a panel for every live identity row. Whoever that identity names holds the
// panel and the authority to share the connection, so the identity has to
// follow the row: its scope, its owner, its workspace, its key and its
// existence.
//
// EVERY write road that changes one of those five reconciles the identity HERE.
// Two roads reach the same rows today, the connector setup surface
// (`src/lib/mcp-server-write-actions.ts`) and the host server actions
// (`src/app/campaigns/actions.ts`), and a third road would be a third caller of
// these functions rather than a second copy of the reasoning. Each rule below
// was written for an ordering a read-only round found, and a copy would keep
// none of them.
//
// THE SHAPE OF EVERY ROAD HERE. The identity store and the row store share no
// transaction, so no ordering is race-free by construction. What holds instead:
//   * the row is re-read FRESH immediately before every read and again
//     immediately before every write, so the widest window is one store call;
//   * a save acts only on the row it WROTE, told apart from a replacement at
//     the same id by the creation and update instants its guarded write
//     returned;
//   * a retire addresses the identity ROW that was witnessed, by its own
//     primary key, so it takes away exactly that row or nothing at all;
//   * no road retires an identity naming somebody whose row this is not;
//   * every write is best-effort and idempotent, so a failure leaves a state
//     the next save or delete of that row repairs.
//
// NOT server-only by import: the host server actions that call it are already
// server modules, and the marker would pull a browser guard into their graph.

import type { ExternalMcpServerScope } from "@/lib/external-mcp-registry";

const LOG = "[external-mcp-keyless-identity]";

/** What a guarded row write hands back about the row it just wrote. */
export type ExternalMcpRowWitness = {
  createdAt: string | null;
  updatedAt: string | null;
} | null;

/** The identity a save derives for the row it wrote. */
export type KeylessIdentityDerivation = {
  ownerUserId: string;
  organizationId: string | null;
  seed: "owner" | "workspace";
};

/** The scope and owner of a row, the two fields the identity is derived from. */
type RowIdentityFields = { scope: string; userId: string | null };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reconcile the keyless identity of a row a save has just written.
 *
 * `storedCredential` is the connection the row LANDED with. A row that landed
 * without one gets its keyless identity; a row that landed with one may not
 * carry a keyless identity at all, so a live one is retired.
 */
export async function reconcileKeylessConnectionIdentityAfterSave(input: {
  serverId: string;
  /** The row this save wrote, as it wrote it. */
  row: RowIdentityFields;
  /** The witnessed EXISTING row this save updated, or undefined for an insert. */
  guard?: RowIdentityFields;
  /** The instants the guarded write returned, or null when it returned none. */
  written: ExternalMcpRowWitness | undefined;
  /** The connection the row landed with, or null for a keyless row. */
  storedCredential: string | null;
  /** The identity this save derived for the row. */
  identity: KeylessIdentityDerivation;
  /** Whether the acting person holds platform-admin standing. */
  actorIsAdmin: boolean;
}): Promise<void> {
  const { serverId, row, guard, storedCredential, identity, actorIsAdmin } = input;
  const written = input.written ?? null;
  try {
    const {
      getExternalMcpServerByIdFresh,
      externalMcpKeylessConnectionId,
      readExternalMcpKeylessConnectionIdentity,
      registerExternalMcpKeylessConnectionIdentity,
      retireExternalMcpKeylessConnectionIdentityRow,
      normalizeExternalMcpRowStamp,
    } = await import("@/lib/external-mcp-registry");
    const keylessConnectionId = externalMcpKeylessConnectionId(serverId);

    // MAY THIS SAVE RETIRE THE KEYLESS IDENTITY IT FINDS? Only when the
    // identity names somebody this save's own row is about:
    //   * the person this save's own identity would name, so this save's road
    //     could have written the very row it is retiring;
    //   * the owner the row is moving AWAY from, which is what a promotion or a
    //     re-owning leaves standing;
    //   * for a SHARED row, which carries no owner at all, the platform admin
    //     whose row it is to reconcile.
    // An identity naming anybody else describes a row that is GONE and a person
    // whose row this is not: it is their orphan, it is repaired by their own
    // delete, and no save of somebody else's may take it away. That reading is
    // the same on the keyless road and on the keyed one, because the two roads
    // reach the same identity row and the way it was reached cannot decide who
    // owns it.
    const mayRetireIdentity = (live: { ownerUserId: string }): boolean =>
      live.ownerUserId === identity.ownerUserId ||
      (guard !== undefined &&
        (guard.scope === "user"
          ? guard.userId !== null && guard.userId === live.ownerUserId
          : actorIsAdmin));

    if (storedCredential !== null) {
      // The row landed WITH a credential of its own, so no keyless identity may
      // stand for it: retire one if it is still live. This runs on EVERY keyed
      // save, not only the first upgrade away from keyless. The retire is
      // best-effort, so a transient failure used to leave two panels for one
      // server for ever. The next save of that row now reconciles it, and so
      // does its delete. A row that never had a keyless identity reads nothing
      // and writes nothing. IDENTITY-ONLY: a keyless id addresses no credential,
      // so retiring it never asks the connection service to delete one.
      //
      // The row is read again between the identity read and the retire, and the
      // retire addresses the identity ROW that was read: a server deleted and
      // registered again keyless in that window keeps the identity its own save
      // just wrote, because the fresh row no longer carries a credential.
      const live = await readExternalMcpKeylessConnectionIdentity(keylessConnectionId);
      if (
        live &&
        mayRetireIdentity(live) &&
        (getExternalMcpServerByIdFresh(serverId)?.nangoConnectionId ?? null) !== null
      ) {
        await retireExternalMcpKeylessConnectionIdentityRow(live.id);
      }
      return;
    }

    // cinatra#3485: a row that landed with NO stored credential still gets its
    // `externalMcp` connection IDENTITY. The Sharing tab lists identity rows, so
    // without one a server registered with the optional API-key field left blank
    // drew no panel while the same server registered WITH a key drew one. The
    // identity is the one the caller derived: the row's own owner, its
    // organization, its scope's seed. NOTHING about the key changes: no
    // credential is minted, the row's connection pointer stays null (so
    // `apiKeyConfigured` stays false) and `resolveExternalMcpServerBearer` still
    // mints nothing for this row.
    //
    // BEST-EFFORT, like the host's one connector-save identity road
    // (cinatra#3460, `extension-host-context.ts`): the row write has already
    // landed, and a registration that cannot be truthful, the seam's foreign-row
    // hard-fail, must never turn a saved server into an error. The failure is
    // logged NON-SECRETLY (no key is in scope on this road at all).
    //
    // WOULD THE IDENTITY STILL BE TRUE OF THE ROW? The identity lives in a
    // different store from the row, with no shared transaction, so the only
    // honest guard is a fresh re-read that matches the row this save landed on
    // every field the identity is derived from: its scope and its owner decide
    // who the identity belongs to, and a stored credential means the keyless
    // identity may not stand at all. A save that lost the row to another request
    // must do NOTHING here, and above all must not retire an identity that
    // request just registered.
    //
    // This reading is the FLOOR. It answers "may an identity stand for this row
    // at all", and every road below asks the stricter question underneath it as
    // well, because an identity may only stand on the row it was written for.
    const describesThisSave = (
      candidate: {
        scope: string;
        userId: string | null;
        nangoConnectionId: string | null;
      } | null,
    ): boolean =>
      candidate !== null &&
      candidate.scope === row.scope &&
      candidate.userId === row.userId &&
      (candidate.nangoConnectionId ?? null) === null;
    // IS IT THE VERY ROW THIS SAVE WROTE? The question above asks whether the
    // identity would still be TRUE of whatever row stands under this id. This
    // one asks something stricter, and the registration needs it: ids are
    // supplied by the caller, so another person can delete this server and
    // register the same id again, keyless and shared, between this save's write
    // and its identity. Such a replacement answers the question above with yes
    // on every field, because a shared row carries no owner and neither row
    // carries a key, and this save would then retire the identity that person
    // just registered and put its own in its place.
    //
    // The row's own stamps settle it. A replacement is CREATED, so it carries a
    // creation instant this save never wrote, and this save's own write stamps
    // the update instant it returned. A save that cannot read both stamps holds
    // no witness and registers nothing, which is the same fail-closed direction
    // every other ordering on this road takes: the panel is missing, never owned
    // by the wrong person, and the next save of that row restores it.
    //
    // WHAT THE STAMPS CANNOT DO. They are the store's own clock, read to the
    // millisecond, so two writes are only two instants while that clock moves.
    // A replacement must be created in the same millisecond as the row it
    // replaces, which a delete and an insert on separate queries cannot do while
    // the clock advances; a clock that stands still or steps backwards removes
    // that separation, and only a generation the row itself carries would
    // replace it. That is a change to the schema and it is not made here.
    //
    // THE TWO STAMPS ANSWER TWO QUESTIONS, and the roads below need one each.
    // The CREATION instant names the ROW: an update never moves it, so a row
    // written again by somebody else is still the same row, and only a row
    // created again is a different one. The UPDATE instant names THIS WRITE:
    // any save of the row moves it, including a harmless one by the same person.
    type RowCandidate = {
      scope: string;
      userId: string | null;
      nangoConnectionId: string | null;
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    /** The same row this save wrote, however many times it has been saved since. */
    const isTheRowThisSaveWrote = (candidate: RowCandidate | null): boolean =>
      describesThisSave(candidate) &&
      written !== null &&
      written.createdAt !== null &&
      normalizeExternalMcpRowStamp(candidate?.createdAt) === written.createdAt;
    /** That row, and untouched since this save wrote it. */
    const isThisSavesOwnWrite = (candidate: RowCandidate | null): boolean =>
      isTheRowThisSaveWrote(candidate) &&
      written !== null &&
      written.updatedAt !== null &&
      normalizeExternalMcpRowStamp(candidate?.updatedAt) === written.updatedAt;
    // No witness, no write: a save that cannot tell its own row from a
    // replacement leaves the identity alone entirely.
    if (written === null || written.createdAt === null || written.updatedAt === null) return;

    // Whether the registration was reached at all. The seam writes the identity
    // row and seeds its grant as two writes, so a failure in the second leaves
    // the first standing: the compensating re-read below has to run even when
    // the registration threw.
    let registrationAttempted = false;
    // THIS SAVE PUT AN IDENTITY ON A ROW A LATER WRITE ALREADY HELD. The row is
    // re-read the instant the seam returns, because that is the last moment the
    // answer is still about THIS write: a save whose own write was already
    // superseded when its identity landed installed the panel, the workspace
    // seed and the authority to share over a configuration somebody else wrote.
    let identityLandedOnALaterWrite = false;
    /**
     * ONE PASS at the identity: read what stands at the derived id, retire it if
     * this save may supersede it, and register this save's own. Every step is
     * guarded on the row this save wrote, re-read as late as the two stores
     * allow, so a pass that lost the row writes nothing and answers false.
     */
    const attemptRegistration = async (): Promise<boolean> => {
      // GUARDED ON THE ROW IT WROTE, AS LATE AS THE TWO STORES ALLOW. The row
      // write landed, but another request can store a key on the same row, take
      // it over, delete it, or delete it and register the same id again while
      // this one is still on its way to the identity. The row is therefore
      // re-read immediately before the reads, and again immediately before the
      // writes, and this save does nothing at all unless the row that stands
      // there is the one it wrote, stamps included.
      if (!isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId))) return false;
      // RECONCILE A SUPERSEDED IDENTITY. The derived id is stable across every
      // save of the row, so a save that moved the row to a new owner (a
      // promotion to global) or to a new workspace would otherwise address an
      // identity describing the PREVIOUS one: the seam refuses it, the previous
      // owner keeps the panel and the authority to edit its sharing, and the new
      // owner gets neither. What the seam TOLERATES is left alone (a re-save
      // under the same owner, an org-less admin edit of someone else's row), so
      // a repeated save still never mints a second identity or resets a widened
      // policy.
      //
      // Read on EVERY road, not only on the one that may retire. A save that
      // CREATED the row still has to know whether its registration would PUT an
      // identity at this id or merely confirm one that already stands there,
      // because only the first is this save's to take back.
      const live = await readExternalMcpKeylessConnectionIdentity(keylessConnectionId);
      const supersededOwner = live !== null && live.ownerUserId !== identity.ownerUserId;
      const supersededOrganization =
        live !== null &&
        live.organizationId !== null &&
        identity.organizationId !== null &&
        live.organizationId !== identity.organizationId;
      const retireFirst =
        guard !== undefined &&
        live !== null &&
        (supersededOwner || supersededOrganization) &&
        mayRetireIdentity(live);
      if (!isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId))) return false;
      // Retire the row that was WITNESSED, never whatever the derived id
      // resolves to now: a request that replaced the identity between the read
      // above and this line keeps its own, and this retire passes over a row
      // that is already retired.
      if (retireFirst && live) await retireExternalMcpKeylessConnectionIdentityRow(live.id);
      // DID AN IDENTITY ALREADY STAND HERE, and is it still standing? One this
      // registration CONFIRMS (the seam tolerates an identity naming the same
      // person in the same organization) was written by an earlier save, and a
      // sharing policy hangs on that very row: it is not this save's to take
      // back, whatever happens to the row afterwards. One this registration
      // PUTS there is.
      const identityStoodBefore = live !== null && !retireFirst;
      registrationAttempted = true;
      try {
        await registerExternalMcpKeylessConnectionIdentity(keylessConnectionId, identity);
      } finally {
        // The seam writes the identity row and seeds its grant as two writes,
        // so a call that THREW may still have left the first standing: the
        // question is asked whether or not it finished.
        if (
          !identityStoodBefore &&
          !isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId))
        ) {
          identityLandedOnALaterWrite = true;
        }
      }
      return true;
    };

    try {
      await attemptRegistration();
    } catch (err) {
      // THE IDENTITY LANDED WHILE THIS SAVE WAS REGISTERING. Two people can save
      // the same row at once: the older save reads no identity, passes its
      // guards, and lands its own while the newer save is inside the very same
      // registration. The newer save then meets an identity naming somebody
      // else, and the seam refuses it. Leaving it there is fail-open: the row
      // holds the newer save's configuration while the older save's person keeps
      // the panel, the workspace seed and the authority to share it.
      //
      // ONE more pass settles it, and only one. The pass repeats every guard, so
      // it registers only while the row this save wrote is still the row that
      // stands, untouched since; it retires only an identity this save may
      // supersede; and when a THIRD save has moved the row in the meantime the
      // guard refuses and the newest write keeps what it registered. A second
      // refusal is left standing and logged, which is the fail-closed direction:
      // a missing panel the next save of that row restores.
      // Settled means the second pass REGISTERED, not merely that it did not
      // throw: a pass that finds the row moved under it registered nothing, and
      // the refusal that started this is still the honest thing to report.
      let settled = false;
      if (guard !== undefined) {
        try {
          settled = await attemptRegistration();
        } catch {
          settled = false;
        }
      }
      if (!settled) {
        console.error(`${LOG} keyless connection identity registration failed`, message(err));
      }
    }

    // TAKE IT BACK when the row changed underneath, and take back ONLY what this
    // save put there. Outside the try, because the seam writes the identity row
    // and seeds its grant as two writes: one that threw on the second still
    // leaves the first standing. The live identity is read again first and
    // retired by its OWN row id, so a save that lost the row takes away its own
    // identity and never the one the request that won just registered.
    //
    // TWO QUESTIONS, one for each stamp, and this save may have to answer
    // either of them with yes.
    //
    // THE ROW. A row somebody registered again at the same id carries the same
    // scope, the same absent owner and the same missing key, so reading those
    // three alone would leave this save's identity standing on a stranger's
    // server with the authority to share it: the CREATION instant is what takes
    // it back. A row merely SAVED again is still the row this identity was
    // written for, so that question alone leaves it alone, which is how a
    // sharing policy the owner set by hand survives a re-save: the policy
    // belongs to the identity row, and a fresh registration would seed a fresh
    // one at the scope's default.
    //
    // THE WRITE. The seventh read-only round showed where reading the creation
    // instant ALONE ends. Two saves of one admin and a later save of another
    // reach the seam together; the later save's configuration is what stands on
    // the row, and an identity the earlier admin PUT there afterwards keeps the
    // panel, the workspace seed and the authority to share it, while the later
    // save reports success. So an identity this save INSTALLED while a later
    // write already stood is taken back on the UPDATE instant as well. An
    // identity this save merely confirmed is not, because that one was not put
    // there by this write and the policy on it predates it.
    const takeBackNeeded = (): boolean => {
      const fresh = getExternalMcpServerByIdFresh(serverId);
      if (!isTheRowThisSaveWrote(fresh)) return true;
      return identityLandedOnALaterWrite && !isThisSavesOwnWrite(fresh);
    };
    if (registrationAttempted && takeBackNeeded()) {
      try {
        const live = await readExternalMcpKeylessConnectionIdentity(keylessConnectionId);
        // The row is read ONCE MORE after the identity read: the row can come
        // back, or this save's own write can stand again, and a save whose own
        // row is there again keeps what it wrote. The owner and the
        // organization are read as well, so a retire only ever takes away an
        // identity this save's own registration would have written.
        if (
          live &&
          live.ownerUserId === identity.ownerUserId &&
          live.organizationId === identity.organizationId &&
          takeBackNeeded()
        ) {
          await retireExternalMcpKeylessConnectionIdentityRow(live.id);
        }
      } catch (err) {
        console.error(`${LOG} keyless connection identity take-back failed`, message(err));
      }
    }
  } catch (err) {
    // The lifecycle is best-effort by contract: the row write has already
    // landed, and nothing here may turn a saved server into an error.
    console.error(`${LOG} keyless connection identity save reconciliation failed`, message(err));
  }
}

/**
 * IS THIS ID FREE TO REGISTER A NEW SERVER AT? Answers with the live keyless
 * identity standing in the way, or null.
 *
 * Server ids are supplied by the caller, so a person can register a server at
 * an id whose row is gone while its identity is not: the retire after a delete
 * is best-effort, and one that failed leaves its owner's identity behind. The
 * row then lands, and the registration that follows meets an identity naming
 * somebody else, which the seam refuses. Before fix leg 4 the save was reported
 * as SAVED anyway: the person owned the configuration while the panel, the
 * workspace seed and the authority to share it stayed with the other person,
 * and no later save of their own row could repair it, because no save of theirs
 * may retire an identity that is not theirs.
 *
 * Refusing BEFORE the row is written is the fail-closed answer, and it keeps
 * the earlier ruling whole: the orphan of a deleted server belongs to its
 * owner, whose own delete of the absent id takes it away, and a platform admin
 * may take it away on the same road. Neither of them registers over it.
 *
 * Only a CREATE asks this. A save of a row that stands is an update, and the
 * identity on it is reconciled by the save road above on its own terms.
 */
export async function keylessIdentityCollisionAtCreate(input: {
  serverId: string;
  /** The person this save's own identity would name. */
  identityOwnerUserId: string;
}): Promise<{ ownerUserId: string } | null> {
  const { externalMcpKeylessConnectionId, readExternalMcpKeylessConnectionIdentity } = await import(
    "@/lib/external-mcp-registry"
  );
  const live = await readExternalMcpKeylessConnectionIdentity(
    externalMcpKeylessConnectionId(input.serverId),
  );
  return live !== null && live.ownerUserId !== input.identityOwnerUserId
    ? { ownerUserId: live.ownerUserId }
    : null;
}

/** What a caller tells a person whose supplied id is not free. */
export function keylessIdentityCollisionMessage(serverId: string): string {
  return (
    `The server id "${serverId}" still carries another person's saved connection. ` +
    `Its owner, or a platform admin, has to delete that server id first; then this ` +
    `id is free to register.`
  );
}

/**
 * Reconcile the keyless identity of a row a delete has just removed.
 *
 * AFTER the row is gone, not before: a save racing this delete re-reads the row
 * to decide whether its own registration may stand, so retiring while the row
 * is still there lets that save see a live row, keep its identity and leave a
 * panel for a server that is about to vanish. Retiring last means the save
 * either sees the row gone and takes its own identity back, or registers before
 * this line and has its identity retired here. It also means a delete that then
 * CONFLICTS leaves the surviving row its panel instead of stripping it.
 *
 * IDENTITY-ONLY: the derived id addresses no vault entry, so this asks the
 * connection service for NOTHING, and a keyed row's delete still makes exactly
 * the ONE credential call it made before. A no-op for a row that never had one.
 */
export async function reconcileKeylessConnectionIdentityAfterDelete(input: {
  serverId: string;
  /** The row this delete removed, as it was witnessed. */
  deletedRow: RowIdentityFields;
  actorUserId: string;
  actorIsAdmin: boolean;
}): Promise<void> {
  const { serverId, deletedRow, actorUserId, actorIsAdmin } = input;
  try {
    const {
      getExternalMcpServerByIdFresh,
      externalMcpKeylessConnectionId,
      readExternalMcpKeylessConnectionIdentity,
      retireExternalMcpKeylessConnectionIdentityRow,
    } = await import("@/lib/external-mcp-registry");
    const live = await readExternalMcpKeylessConnectionIdentity(
      externalMcpKeylessConnectionId(serverId),
    );
    // The row is read once more between the identity read and the retire, so a
    // save that registered the same id again in that window keeps its identity.
    //
    // WHOSE IDENTITY MAY THIS DELETE TAKE AWAY? The one the row it removed would
    // have carried: its own owner's, or, for a shared row, one the platform
    // admin who deleted it may reconcile. A delete also takes away the acting
    // person's OWN identity, which is the road an owner repairs their orphan on.
    // An identity naming anybody else was left by a row that stood at this id
    // BEFORE, and it is not this delete's to retire: the same refusal the save
    // road makes.
    if (
      live &&
      (live.ownerUserId === actorUserId ||
        (deletedRow.userId !== null && deletedRow.userId === live.ownerUserId) ||
        (deletedRow.scope !== "user" && actorIsAdmin)) &&
      getExternalMcpServerByIdFresh(serverId) === null
    ) {
      await retireExternalMcpKeylessConnectionIdentityRow(live.id);
    }
  } catch (err) {
    console.warn(`${LOG} keyless identity retire after delete failed`, message(err));
  }
}

/**
 * THE ONE DELETE STEP of an external-MCP server row: the stored credential, the
 * row, and the derived keyless identity, in the order the three of them have to
 * go in.
 *
 * A row carries at most one of the two identities. A row that stored a
 * credential has that credential's identity, which is what mints its bearer; a
 * row that stored none has the derived keyless identity, which is what draws
 * its panel. The connector setup road has always revoked the first. The host
 * server actions removed the row and reconciled only the second, so deleting a
 * keyed server through them left the credential in the vault and its identity
 * live: the panel survived a delete the person was told had succeeded, and a
 * stale cached copy of the row could still pass the use-gate. Both roads travel
 * this step now, so there is one answer rather than two.
 *
 * THE ORDER IS THE CONTRACT:
 *   1. revoke the stored credential FIRST: the identity is soft-deleted before
 *      the row goes, so a cross-worker cached copy of the row cannot mint the
 *      bearer during the delete window, and a crash inside it fails closed;
 *   2. delete the row under a guard that WITNESSES its connection as well, so a
 *      concurrent re-key that installed a new credential fails the delete
 *      closed (the row keeps its new, live connection) instead of removing the
 *      row and leaving that credential with nothing pointing at it;
 *   3. retire the keyless identity LAST, after the row is gone, which is the
 *      ordering `reconcileKeylessConnectionIdentityAfterDelete` owns.
 *
 * A guard miss throws the registry's write-conflict error, which each road maps
 * to its own fail-closed refusal.
 */
export async function deleteExternalMcpServerRowWithIdentities(input: {
  serverId: string;
  /** The row this delete authorized against, as it was witnessed. */
  row: { scope: ExternalMcpServerScope; userId: string | null; nangoConnectionId: string | null };
  actorUserId: string;
  actorIsAdmin: boolean;
}): Promise<void> {
  const { serverId, row, actorUserId, actorIsAdmin } = input;
  const { deleteExternalMcpServerGuarded, revokeExternalMcpApiKeyConnection } = await import(
    "@/lib/external-mcp-registry"
  );
  // Exactly ONE credential call, and none at all for a row that stored none:
  // the helper is a no-op on an empty connection id.
  await revokeExternalMcpApiKeyConnection(row.nangoConnectionId);
  deleteExternalMcpServerGuarded(serverId, {
    scope: row.scope,
    userId: row.userId,
    nangoConnectionId: row.nangoConnectionId,
  });
  await reconcileKeylessConnectionIdentityAfterDelete({
    serverId,
    deletedRow: { scope: row.scope, userId: row.userId },
    actorUserId,
    actorIsAdmin,
  });
}

/**
 * Reconcile an ORPHAN keyless identity at an id whose row is already gone.
 *
 * The retire on the delete road is best-effort, so a delete whose retire failed
 * once used to leave a panel for a server nobody can reach any more, and no
 * later delete could repair it: that road returned without looking. It looks
 * now. The identity is retired only for the person it belongs to, or by a
 * platform admin, so a guessed id can never take a panel away from anyone else,
 * and an id that never had a keyless identity reads nothing and writes nothing.
 */
export async function reconcileOrphanKeylessConnectionIdentity(input: {
  serverId: string;
  actorUserId: string;
  actorIsAdmin: boolean;
}): Promise<void> {
  const { serverId, actorUserId, actorIsAdmin } = input;
  try {
    const {
      getExternalMcpServerByIdFresh,
      externalMcpKeylessConnectionId,
      readExternalMcpKeylessConnectionIdentity,
      retireExternalMcpKeylessConnectionIdentityRow,
    } = await import("@/lib/external-mcp-registry");
    const orphan = await readExternalMcpKeylessConnectionIdentity(
      externalMcpKeylessConnectionId(serverId),
    );
    // Still an orphan? The id can be registered again while this read is in
    // flight, and that registration's identity is not an orphan at all.
    if (
      orphan &&
      getExternalMcpServerByIdFresh(serverId) === null &&
      (orphan.ownerUserId === actorUserId || actorIsAdmin)
    ) {
      await retireExternalMcpKeylessConnectionIdentityRow(orphan.id);
    }
  } catch (err) {
    console.warn(`${LOG} orphan keyless identity reconciliation failed`, message(err));
  }
}
