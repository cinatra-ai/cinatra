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

    // DOES THIS SAVE'S OWN ROW WRITE STILL STAND? Answered by the two instants
    // the guarded write returned, matched against a row read fresh at the
    // moment the question is asked. BOTH roads below need it, so it is asked
    // here rather than once per road:
    //   * the CREATION instant names the ROW. An update never moves it, so a
    //     row saved again by somebody else is still the same row, and only a
    //     row created again at this id is a different one.
    //   * the UPDATE instant names THIS WRITE. Any save of the row moves it,
    //     including a harmless one by the same person.
    // A save that read neither holds no witness, so it answers no and writes
    // nothing: the fail-closed direction every road here takes, where the
    // panel is missing rather than owned by the wrong person, and the next
    // save of that row restores it.
    type RowStamps = { createdAt?: unknown; updatedAt?: unknown };
    /** The same ROW this save wrote, however many times it has been saved since. */
    const carriesThisSavesRow = (candidate: RowStamps | null): boolean =>
      candidate !== null &&
      written !== null &&
      written.createdAt !== null &&
      normalizeExternalMcpRowStamp(candidate.createdAt) === written.createdAt;
    /** That row, and untouched since this save wrote it. */
    const carriesThisSavesWrite = (candidate: RowStamps | null): boolean =>
      carriesThisSavesRow(candidate) &&
      written !== null &&
      written.updatedAt !== null &&
      normalizeExternalMcpRowStamp(candidate?.updatedAt) === written.updatedAt;
    /** Asked at the write, against the row that stands at this very moment. */
    const thisSavesWriteStillStands = (): boolean =>
      carriesThisSavesWrite(getExternalMcpServerByIdFresh(serverId));

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
      // ONLY WHILE THIS SAVE IS STILL THE WRITE THAT STANDS (cinatra#3485 fix
      // leg 6). This save did not insert the identity it is about to take away,
      // so its whole authority to take it away is that the row it wrote is the
      // row standing there, keyed, right now. Reading that the row carries SOME
      // stored key is not that authority: a keyless save can write the row and
      // CONFIRM this very identity while this retire is still on its way to the
      // store, and the retire would then take away the panel that save just
      // confirmed and the sharing policy hanging on it. The condition therefore
      // travels down to the write, where the store asks it once more with its
      // query prepared, exactly as every other retire on these roads does.
      //
      // The same question is asked once cheaply before the call, so a save that
      // has plainly lost its row makes no store call at all: that read replaces
      // the weaker "some keyed row stands" one and adds no round trip.
      const live = await readExternalMcpKeylessConnectionIdentity(keylessConnectionId);
      if (live && mayRetireIdentity(live) && thisSavesWriteStillStands()) {
        await retireExternalMcpKeylessConnectionIdentityRow(live.id, thisSavesWriteStillStands);
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
    // THE TWO STAMPS ANSWER TWO QUESTIONS, and `carriesThisSavesWrite` above
    // asks both: the CREATION instant names the ROW, so a row saved again by
    // somebody else is still the same row and only a row created again is a
    // different one, and the UPDATE instant names THIS WRITE, which any save of
    // the row moves. This road adds the identity floor underneath them.
    type RowCandidate = {
      scope: string;
      userId: string | null;
      nangoConnectionId: string | null;
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    /** The row this save wrote, still describing what an identity needs of it. */
    const isThisSavesOwnWrite = (candidate: RowCandidate | null): boolean =>
      describesThisSave(candidate) && carriesThisSavesWrite(candidate);
    // No witness, no write: a save that cannot tell its own row from a
    // replacement leaves the identity alone entirely.
    if (written === null || written.createdAt === null || written.updatedAt === null) return;

    // WHAT THIS SAVE PUT THERE, answered by the registration itself. An
    // identity the seam INSERTED on this call is this save's to take back; one
    // it merely CONFIRMED was written by an earlier save and carries that
    // save's sharing policy, so it is not this save's at all. The ninth
    // read-only round showed why a read taken BEFORE the registration cannot
    // answer it: another request can insert between the two, and the save then
    // takes away a row it never wrote and strands the policy hanging on it.
    //
    // The answer arrives through a callback, not the return value alone: the
    // seam writes the identity row and seeds its grant as two writes, so a
    // call that threw on the second has still left the first standing.
    let insertedIdentityId: string | null = null;
    // WAS THE ROW ALREADY SOMEBODY ELSE'S WHEN THIS IDENTITY LANDED? Sampled in
    // the callback, at the INSERT (cinatra#3485 fix leg 6). The seam hands the
    // row over the moment its insert returns and before it seeds the grant, and
    // the seeding is a second store call another request can run right through.
    // A reading taken when the whole registration returns is therefore a
    // reading about a later moment: a perfectly ordinary next save of the same
    // person can write the row and CONFIRM this identity inside the seeding,
    // and the take-back would then delete an identity that landed while this
    // save's own write stood and that the next save is relying on, costing that
    // save its panel and the sharing policy on it. Sampled at the insert, a
    // save whose identity landed while its write stood never takes it back on
    // account of a write that came later.
    //
    // WHAT THIS STILL CANNOT SEE. The callback reads the store's answer, not
    // the instant inside the store where the row became visible; closing that
    // last gap needs the row write and the identity write under one
    // coordination point, which these two stores do not share.
    let identityLandedOnALaterWrite = false;
    const noteRegistration = (reported: { identityId: string; created: boolean }): void => {
      if (!reported.created) return;
      insertedIdentityId = reported.identityId;
      // The very question the retire asks below, so the two moments are read
      // the same way: is the row that stands right now still this save's own.
      if (!isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId))) {
        identityLandedOnALaterWrite = true;
      }
    };

    /** What one pass at the identity did. */
    type Pass =
      /** the row this save wrote is not the row that stands: nothing written */
      | "row-moved"
      /** a live identity stands that this save may neither supersede nor be confirmed against */
      | "blocked"
      /** the registration ran */
      | "registered";

    /**
     * ONE PASS at the identity: read what stands at the derived id, retire it if
     * this save may supersede it, and register this save's own. Every step is
     * guarded on the row this save wrote, re-read as late as the two stores
     * allow, so a pass that lost the row writes nothing.
     */
    const attemptRegistration = async (): Promise<Pass> => {
      // GUARDED ON THE ROW IT WROTE, AS LATE AS THE TWO STORES ALLOW. The row
      // write landed, but another request can store a key on the same row, take
      // it over, delete it, or delete it and register the same id again while
      // this one is still on its way to the identity. The row is therefore
      // re-read immediately before the reads, and again immediately before the
      // writes, and this save does nothing at all unless the row that stands
      // there is the one it wrote, stamps included.
      if (!isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId))) return "row-moved";
      // RECONCILE A SUPERSEDED IDENTITY. The derived id is stable across every
      // save of the row, so a save that moved the row to a new owner (a
      // promotion to global) or to a new workspace would otherwise address an
      // identity describing the PREVIOUS one: the seam refuses it, the previous
      // owner keeps the panel and the authority to edit its sharing, and the new
      // owner gets neither. What the seam TOLERATES is left alone (a re-save
      // under the same owner, an org-less admin edit of someone else's row), so
      // a repeated save still never mints a second identity or resets a widened
      // policy.
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
      // WOULD THE SEAM TOLERATE WHAT STANDS? It confirms an identity naming the
      // same person in a workspace that does not contradict this one, and
      // hard-fails on everything else. An identity this save may neither
      // supersede nor be confirmed against is a STANDING refusal, not a race:
      // another pass would only repeat a write that cannot succeed. The pass
      // says so instead of making the call.
      const wouldBeConfirmed = live !== null && !supersededOwner && !supersededOrganization;
      if (live !== null && !retireFirst && !wouldBeConfirmed) return "blocked";
      if (!isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId))) return "row-moved";
      // Retire the row that was WITNESSED, never whatever the derived id
      // resolves to now: a request that replaced the identity between the read
      // above and this line keeps its own, and this retire passes over a row
      // that is already retired.
      if (retireFirst && live) {
        // ONLY WHILE THIS SAVE IS STILL THE WRITE THAT STANDS. The supersede is
        // the standing write's own reconciliation, so a save that lost the row
        // between the guard above and this write has no supersede left to make:
        // the row belongs to the request that won it, and the identity on it is
        // that request's to reconcile.
        await retireExternalMcpKeylessConnectionIdentityRow(live.id, () =>
          isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId)),
        );
      }
      // The callback carries BOTH answers out of this call, whether or not the
      // seam finishes: it writes the identity row and seeds its grant as two
      // writes, so a call that threw on the second has still left the first
      // standing, already reported and already sampled.
      await registerExternalMcpKeylessConnectionIdentity(
        keylessConnectionId,
        identity,
        noteRegistration,
      );
      return "registered";
    };

    // HOW MANY PASSES. A refusal the seam throws is a RACE: an identity landed
    // at this id between this save's read and its write. Two people can save
    // the same row at once, and the older save lands its own identity while the
    // newer is inside the very same registration; leaving that there is
    // fail-open, because the row then holds the newer save's configuration
    // while the older save's person keeps the panel, the workspace seed and the
    // authority to share it.
    //
    // ONE retry could be outlasted: the ninth round placed a foreign insert
    // after it and the newer save reported success over somebody else's panel.
    // So the passes REPEAT against the CURRENT state until the registration
    // stands or the row stops being this save's. Every pass repeats every
    // guard, so a pass writes only while the row this save wrote is still the
    // row that stands, untouched since; a pass that finds the row moved stops,
    // because the identity is then the standing write's to reconcile, not this
    // one's. The bound is small because the contention is bounded: every save
    // now takes back what it installed once its own write is superseded, so a
    // pass has to outlast the savers in flight rather than an open queue.
    const REGISTRATION_PASSES = 4;
    let settled = false;
    let blocked = false;
    let refusal: unknown = null;
    for (let pass = 0; pass < REGISTRATION_PASSES; pass += 1) {
      let outcome: Pass | null = null;
      try {
        outcome = await attemptRegistration();
      } catch (err) {
        refusal = err;
      }
      if (outcome === "registered") {
        settled = true;
        refusal = null;
        break;
      }
      if (outcome === "row-moved") break;
      if (outcome === "blocked") {
        blocked = true;
        break;
      }
      // A CREATE has no supersede road: its id was answered free before the row
      // was written, and an identity that landed since belongs to the request
      // that won it. Only an update retries.
      //
      // THE PRICE, stated plainly and pinned by its own case. A save of the
      // PREVIOUS row at this id, paused on the doorstep of its insert, can
      // write its identity after the create's question was answered and after
      // the create's row landed. The create may not take that identity away,
      // because it names another person, so it reports success with that
      // person's panel on its row.
      //
      // The state settles when that save finishes and its take-back lands. Both
      // are best-effort: a save that stops inside its registration, or whose
      // take-back fails, leaves its identity on the new row, and neither the
      // new owner's next save nor the orphan road may take it away while the
      // new row stands. Its own person's delete repairs it. Repairing the
      // INSTANT, and making the settling unconditional, both need one
      // coordination point across the two stores.
      if (guard === undefined) break;
    }
    if (!settled && (blocked || refusal !== null)) {
      console.error(
        `${LOG} keyless connection identity registration failed`,
        blocked
          ? "another person's connection identity stands at this id"
          : message(refusal),
      );
    }

    // NOTHING FOREIGN MAY STAND ON A ROW THIS SAVE STILL HOLDS. The passes can
    // be outlasted in principle: another save inserts its own identity inside
    // the window of every one of them. Where this save's own write is STILL the
    // row that stands and the identity in the way is one this save may
    // supersede, that identity goes, so the save reports success over NO
    // identity rather than over another person's panel and sharing authority.
    // A missing panel is the fail-closed direction this branch takes
    // everywhere, and the next save of the row draws it again.
    //
    // A BLOCKED pass is not this: the identity there is one this save may NOT
    // retire, it belongs to its own person, and their own delete is what
    // repairs it. That ruling is untouched.
    if (!settled && !blocked && refusal !== null && guard !== undefined) {
      try {
        const live = await readExternalMcpKeylessConnectionIdentity(keylessConnectionId);
        if (
          live !== null &&
          live.ownerUserId !== identity.ownerUserId &&
          mayRetireIdentity(live)
        ) {
          await retireExternalMcpKeylessConnectionIdentityRow(live.id, () =>
            isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId)),
          );
        }
      } catch (err) {
        console.error(`${LOG} keyless connection identity refusal cleanup failed`, message(err));
      }
    }

    // TAKE IT BACK when this save's own write no longer stands, and take back
    // ONLY what this very call INSERTED. Outside the passes, because the seam
    // writes the identity row and seeds its grant as two writes: one that threw
    // on the second still leaves the first standing.
    //
    // TWO MOMENTS, and the take-back needs a yes at both. At the INSERT, this
    // save's write must already have been superseded: that is what makes the
    // identity one that was put on a configuration somebody else wrote. At the
    // instant of the RETIRE, it must still be superseded: a row that came back
    // to this save's own write is a row this identity is the right one to draw
    // a panel for. Asking only the first would take back an identity the row
    // still needs; asking only the second would take back one that landed
    // correctly and was merely CONFIRMED by an ordinary next save of the same
    // row, costing that save its panel.
    //
    // The FIRST moment is the insert itself, never the seam's return: the grant
    // seed runs between the two and another save can confirm this identity
    // inside it, which is why the reading is taken in the callback above.
    //
    // Both stamps carry each question. The CREATION instant tells a row
    // somebody registered again at this id from the row this save wrote: a
    // replacement carries the same scope, the same absent owner and the same
    // missing key, so reading those three alone would leave this save's
    // identity standing on a stranger's server with the authority to share it.
    // The UPDATE instant tells a row still holding this save's own write from
    // one a later save has moved.
    //
    // An identity this save merely CONFIRMED is never taken back, whatever
    // became of the row. It was written by an earlier save, the sharing policy
    // on it predates this one, and taking it away would strand that policy on a
    // retired row while the next save seeded a fresh one at the scope's
    // default. That is the ninth round's first finding.
    //
    // AND NOTHING TO TAKE BACK AT ALL when THE SAME ROW, saved again since,
    // would derive THIS VERY IDENTITY for itself (cinatra#3485 fix leg 6).
    // Every save of a PERSONAL row derives the identity from the row's own
    // owner, so an identity naming that owner is the right identity for
    // whoever holds the row, and the save holding it has either confirmed this
    // one already or is about to. Taking it back there would delete a panel
    // the standing save reported success on, with the sharing policy it seeded
    // hanging on it.
    //
    // THE SAME ROW, by its creation instant, and nothing weaker. A row
    // REGISTERED AGAIN at this id is a different server, even under the same
    // owner: the identity would carry the DELETED server's sharing policy on
    // to it, which its owner never chose for it. That take-back stands, and
    // its price is pinned by its own test: the panel is missing until the next
    // save of the new row draws it again.
    //
    // A SHARED row cannot be read this way, and the residue is stated rather
    // than hidden: its identity names the administrator whose save installed
    // it, which the row itself does not record, so a save that lost a shared
    // row cannot tell an administrator who adopted its identity from one who
    // gave up on registering. Closing that needs the row to carry the person
    // its identity names, which is a change to the schema and is not made here.
    const standingRowWouldDeriveThisIdentity = (): boolean => {
      const standing = getExternalMcpServerByIdFresh(serverId);
      return (
        standing !== null &&
        carriesThisSavesRow(standing) &&
        standing.scope === "user" &&
        standing.userId !== null &&
        standing.userId === identity.ownerUserId &&
        (standing.nangoConnectionId ?? null) === null
      );
    };
    if (insertedIdentityId !== null && identityLandedOnALaterWrite) {
      try {
        // Both questions are asked ONE LAST TIME at the write, because this
        // save's own write can stand again by then, and because the row that
        // stands can have become one this identity is exactly right for. The
        // retire addresses the id the registration itself reported, so it takes
        // away exactly the row this call inserted or nothing at all, and the
        // store's soft delete passes over a row that is already retired.
        await retireExternalMcpKeylessConnectionIdentityRow(
          insertedIdentityId,
          () =>
            !isThisSavesOwnWrite(getExternalMcpServerByIdFresh(serverId)) &&
            !standingRowWouldDeriveThisIdentity(),
        );
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
    // THE ROW MUST STILL BE ABSENT AT THE MOMENT OF THE RETIRE, not merely at
    // an earlier read (cinatra#3485 fix leg 5). The id can be registered again
    // between the two, and that save's own registration CONFIRMS the identity
    // this line is about to take away: the new row would then stand with no
    // panel at all, and the sharing policy on the retired identity would govern
    // nothing. The absence therefore travels as a condition ON the retire,
    // asked once more with the store's query prepared.
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
        (deletedRow.scope !== "user" && actorIsAdmin))
    ) {
      await retireExternalMcpKeylessConnectionIdentityRow(
        live.id,
        () => getExternalMcpServerByIdFresh(serverId) === null,
      );
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
 *   0. re-read the row FRESH and refuse unless it still matches what this
 *      delete authorized against (see the interval below);
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
 *
 * THE REFERENCED-BUT-REVOKED INTERVAL, stated plainly (cinatra#3485 fix leg 5).
 * Step 1 runs before step 2, so between them the row still stands and the key
 * it points at is already gone. A row whose scope or owner changed in that
 * interval fails the guard in step 2 and SURVIVES with a key that no longer
 * works, which its owner repairs by deleting it again or by saving a new key.
 *
 * The order is kept rather than reversed because reversing it trades that
 * interval for a worse one: the use-gate reads the identity row, so deleting
 * the server row first would leave the credential MINTABLE from a cached copy
 * of a row the person was told is gone, on EVERY keyed delete rather than on a
 * raced one. Step 0 is what narrows the remaining interval: a change that lands
 * before the delete step begins is met by a refusal with nothing taken away.
 * A change that lands after that read and before the guarded delete is the
 * residue, and the fail-closed guard in step 2 keeps it to an unusable row
 * rather than a usable key for a deleted server.
 */
export async function deleteExternalMcpServerRowWithIdentities(input: {
  serverId: string;
  /** The row this delete authorized against, as it was witnessed. */
  row: { scope: ExternalMcpServerScope; userId: string | null; nangoConnectionId: string | null };
  actorUserId: string;
  actorIsAdmin: boolean;
}): Promise<void> {
  const { serverId, row, actorUserId, actorIsAdmin } = input;
  const {
    deleteExternalMcpServerGuarded,
    revokeExternalMcpApiKeyConnection,
    getExternalMcpServerByIdFresh,
    ExternalMcpServerWriteConflictError,
  } = await import("@/lib/external-mcp-registry");
  // STEP 0. The row this delete authorized against, read again as late as a
  // read can be taken before the first write. The credential goes first, so a
  // change that lands before it would otherwise take the key away and then
  // fail the row delete, leaving a server standing that nobody can use. This
  // refuses instead, with nothing taken away at all.
  const standing = getExternalMcpServerByIdFresh(serverId);
  if (
    standing === null ||
    standing.scope !== row.scope ||
    standing.userId !== row.userId ||
    (standing.nangoConnectionId ?? null) !== (row.nangoConnectionId ?? null)
  ) {
    throw new ExternalMcpServerWriteConflictError();
  }
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
    // flight, and that registration's identity is not an orphan at all. The
    // question is carried down to the write, for the same reason the delete
    // road carries it: an answer read earlier is an answer about an earlier
    // moment.
    if (orphan && (orphan.ownerUserId === actorUserId || actorIsAdmin)) {
      await retireExternalMcpKeylessConnectionIdentityRow(
        orphan.id,
        () => getExternalMcpServerByIdFresh(serverId) === null,
      );
    }
  } catch (err) {
    console.warn(`${LOG} orphan keyless identity reconciliation failed`, message(err));
  }
}
