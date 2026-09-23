// THE ONE LIFECYCLE of the connection IDENTITY a KEYLESS external-MCP server
// row carries (cinatra#3485).
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
      const live = guard
        ? await readExternalMcpKeylessConnectionIdentity(keylessConnectionId)
        : null;
      const supersededOwner = live !== null && live.ownerUserId !== identity.ownerUserId;
      const supersededOrganization =
        live !== null &&
        live.organizationId !== null &&
        identity.organizationId !== null &&
        live.organizationId !== identity.organizationId;
      const retireFirst =
        live !== null && (supersededOwner || supersededOrganization) && mayRetireIdentity(live);
      if (!isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId))) return false;
      // Retire the row that was WITNESSED, never whatever the derived id
      // resolves to now: a request that replaced the identity between the read
      // above and this line keeps its own, and this retire passes over a row
      // that is already retired.
      if (retireFirst && live) await retireExternalMcpKeylessConnectionIdentityRow(live.id);
      registrationAttempted = true;
      await registerExternalMcpKeylessConnectionIdentity(keylessConnectionId, identity);
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
    // It asks about the ROW, not about this write. A row somebody registered
    // again at the same id carries the same scope, the same absent owner and the
    // same missing key, so reading those three alone would leave this save's
    // identity standing on a stranger's server with the authority to share it:
    // the creation instant is what takes it back. A row merely SAVED again, by
    // this person or another one, is still the row this identity was written
    // for, and retiring it there would throw away a sharing policy the owner set
    // by hand, because the policy belongs to the identity row and a fresh
    // registration seeds a fresh one at the scope's default. So the update
    // instant is deliberately not read here.
    if (registrationAttempted && !isTheRowThisSaveWrote(getExternalMcpServerByIdFresh(serverId))) {
      try {
        const live = await readExternalMcpKeylessConnectionIdentity(keylessConnectionId);
        // The row is read ONCE MORE after the identity read: the row can come
        // back in that window, and a save whose own row is there again keeps
        // what it wrote.
        if (
          live &&
          live.ownerUserId === identity.ownerUserId &&
          live.organizationId === identity.organizationId &&
          !isTheRowThisSaveWrote(getExternalMcpServerByIdFresh(serverId))
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
