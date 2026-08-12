import "server-only";

// ---------------------------------------------------------------------------
// THE IN-PROCESS SEED DRIVERS (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
//
// Two fixtures, each one a CALL SEQUENCE OVER SHIPPED WRITERS and nothing else.
// There is no SQL in this file and there will never be one: the whole reason the
// path exists is that a row written around the writers proves nothing about the
// writers, and an earlier wave of this slice REFUSED exactly such a row (an
// event-less `change_set` would have drawn the undo chip over the restore of
// nothing).
//
//   repairVerification  createSemanticArtifact -> emitArtifactReviewGate ->
//                       recordChangesRequested -> createSemanticArtifact ->
//                       submitRepairResponse
//                       The last call's own trigger mints the
//                       `artifact_verification_records` row the verification
//                       card reads. This module never writes that row; it drives
//                       the pipeline that does, and reports what came back.
//
//   restorableChangeSet openChangeSet -> historyAwareUpsert -> closeChangeSet
//                       A real object write, so the set has REAL member events —
//                       which is what the undo chip's §VI eligibility gate reads
//                       (`bool_and(restore_eligible)` over the events, then a
//                       per-event authorization for the asking reader).
//
// THE CALLER NAMES A SUBJECT AND NOTHING ELSE — org, reader, run. Everything the
// fixture writes is PINNED HERE (codex round 0, findings 3 and 4): the artifact
// MIME and therefore its type, the reviewer's findings, the object type and the
// object payload. An earlier draft took `objectType` and `data` from the body,
// which made the change-set fixture a generic authenticated object-create
// primitive — the exact thing this file claims not to be. There is no arm that
// writes a caller-shaped row.
//
// AND THE SUBJECT IS AUTHORIZED, LIVE, BEFORE THE FIRST WRITE. Both fixtures mint
// the org-write authority through `verifySessionAuthority`, which resolves the
// membership and THROWS for a non-member; the repair fixture additionally loads
// the run, refuses one that belongs to another org, and derives its
// `reauthorized` verdict from a real `enforceReviewRunAccess(…, "read")` against
// the reader's LIVE grants — the same assembly the widget lifecycle read uses.
// The literal `reauthorized: true` an earlier draft passed was a lie about a
// check that had not happened.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import type { ChangesRequestedRequest } from "@/lib/lifecycle/lifecycle-repair";

/** The lifecycle fixture the seed drives. */
export type LifecycleSeedFixture = "repairVerification" | "restorableChangeSet";

/** The ONE subject shape either fixture accepts. */
export interface LifecycleSeedSubject {
  orgId: string;
  /** The reader the fixture is FOR — the run's reader and the row's owner. */
  actorId: string;
  /** An EXISTING agent run in that org. The seed does not create runs: the card
   *  and the chip both read the run under the reader's own standing, so a run
   *  the seed invented would be a run nobody may read. */
  runId: string;
}

/** The artifact MIME the fixture writes. PINNED — the caller does not choose a
 *  type, and this maps through the SAME resolver the upload route uses, so the
 *  artifact lands on a real installed, write-allowed type or the seed refuses. */
const FIXTURE_MIME = "text/plain";

/** The reviewer's findings. PINNED — a finding is a label on a field, not a
 *  fixture parameter, and taking them from the body only widened the input. */
const FIXTURE_FINDINGS = [
  {
    id: "f1",
    message: "state what this fixture is for, in the body",
    path: "representation.form",
  },
] as const;

export interface RepairVerificationSeedResult {
  baseGateId: string;
  baseArtifactId: string;
  baseRepresentationRevisionId: string;
  repairId: string;
  successorArtifactId: string;
  successorRepresentationRevisionId: string;
  successorGateId: string;
  successorTaskId: string;
  /** The opaque card ref for the SUCCESSOR gate — the handle the verification
   *  card is asked for. Minted by the shipped ref codec; it decodes to the same
   *  (run, task) the render primitive re-authorizes from scratch. */
  ref: string;
  /** True when `artifact_verification_records` now carries the row for this
   *  gate. Read back through the shipped read port, never assumed. */
  verificationRecordPresent: boolean;
  verificationOutcome: string | null;
}

export interface RestorableChangeSetSeedResult {
  changeSetId: string;
  objectId: string;
  objectType: string;
  eventId: string;
  /** The rollup the CLOSE computed from the member events. */
  effectRollup: string;
  restorable: boolean;
  /** How many member events the set closed over. ZERO would mean the fixture
   *  produced the very row this slice refused, so it is reported. */
  memberEventCount: number;
  closedAt: string | null;
}

/** Bytes for the seeded artifact revision. An async iterable because that is
 *  what `createSemanticArtifact` takes — the same shape the upload route hands
 *  it, so the blob store, the MIME detection and the type's accepts check all
 *  run exactly as they do for a real upload. */
async function* bytes(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** The installed artifact type the fixture writes under, resolved through the
 *  upload route's own MIME map. Refuses rather than inventing a type the write
 *  boundary would have rejected. */
async function pinnedObjectType(): Promise<string> {
  const { resolveUploadArtifactType } = await import("@/lib/artifacts/upload-artifact-type-map");
  const verdict = resolveUploadArtifactType(FIXTURE_MIME);
  if (!verdict.ok) {
    throw new Error(
      `[lifecycle-seed] ${FIXTURE_MIME} maps to no installed artifact type on this host ` +
        `(${verdict.kind}: ${verdict.reason}) — the fixture refuses rather than inventing ` +
        `a type the write boundary would have rejected`,
    );
  }
  return verdict.objectTypeId;
}

/**
 * The reader's LIVE standing, and the run they are being seeded against.
 *
 * Every check here is the one the READ path will run again when the card or the
 * chip is drawn — membership, org role, teams, project grants, then run access.
 * Doing it first means the seed cannot attribute rows to a subject who could not
 * have produced them, and it makes `reauthorized` a measured verdict instead of
 * a literal.
 */
async function authorizeSubjectForRun(subject: LifecycleSeedSubject): Promise<{
  actor: import("@cinatra-ai/mcp-client").PrimitiveActorContext;
  roleHints: import("@/lib/authz/build-actor-context").ActorRoleHints | undefined;
  runReadOk: boolean;
  runDecideOk: boolean;
}> {
  const { readAgentRunById } = await import("@cinatra-ai/agents/store");
  const { enforceReviewRunAccess } = await import(
    "@cinatra-ai/agents/artifact-review-gate-store"
  );
  const { resolveActorGrantsForUserInOrg } = await import("@/lib/auth-session");
  const { buildWidgetLifecycleRoleHints } = await import(
    "@/lib/lifecycle/widget-lifecycle-frame-actor"
  );

  const run = await readAgentRunById(subject.runId);
  if (!run) {
    throw new Error(`[lifecycle-seed] run ${subject.runId} does not exist`);
  }
  if (run.orgId !== subject.orgId) {
    throw new Error(
      `[lifecycle-seed] run ${subject.runId} belongs to another org — refused`,
    );
  }

  const grants = await resolveActorGrantsForUserInOrg(subject.actorId, subject.orgId);
  if (!grants.orgRole) {
    throw new Error(
      `[lifecycle-seed] ${subject.actorId} is not a member of ${subject.orgId}`,
    );
  }
  const actor = {
    actorType: "human" as const,
    source: "route" as const,
    userId: subject.actorId,
    orgId: subject.orgId,
  };
  const roleHints = buildWidgetLifecycleRoleHints({
    orgId: subject.orgId,
    orgRole: grants.orgRole,
    teamIds: grants.teamIds,
    teamRoles: grants.teamRoles,
    projectGrants: grants.projectGrants,
  });
  // BOTH axes, because the fixture uses both (codex round 1, H3 residual). READ
  // is what the card and the chip will run when they are drawn. `approveHitl` is
  // what `changes_requested` actually is: a TERMINAL decision, recorded with this
  // subject as `decidedBy`. Attributing a terminal decision to somebody who could
  // not have made it is exactly the kind of fabricated record this slice refuses,
  // so it is checked rather than assumed from the read.
  const [read, decide] = await Promise.all([
    enforceReviewRunAccess(subject.runId, actor, "read", roleHints),
    enforceReviewRunAccess(subject.runId, actor, "approveHitl", roleHints),
  ]);
  return { actor, roleHints, runReadOk: read.ok, runDecideOk: decide.ok };
}

/**
 * Drive the repair pipeline end to end and return what the writers returned.
 *
 * Every step is the shipped call. The two `createSemanticArtifact` calls make the
 * REVIEWED revision and the REPAIRED one; between them the gate is emitted and
 * the reviewer's `changes_requested` closes it and opens the repair; the response
 * pins the successor and, in its own trigger, mints the verification record.
 */
export async function seedRepairVerification(
  subject: LifecycleSeedSubject,
): Promise<RepairVerificationSeedResult> {
  const objectType = await pinnedObjectType();
  const authorized = await authorizeSubjectForRun(subject);
  if (!authorized.runReadOk) {
    throw new Error(
      `[lifecycle-seed] ${subject.actorId} may not read run ${subject.runId} — ` +
        `seeding a card they could never open is refused`,
    );
  }
  if (!authorized.runDecideOk) {
    throw new Error(
      `[lifecycle-seed] ${subject.actorId} may not decide on run ${subject.runId} — ` +
        `changes_requested is a TERMINAL decision and would be recorded as theirs`,
    );
  }

  const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");
  const { emitArtifactReviewGate, readReviewGate } = await import(
    "@cinatra-ai/agents/artifact-review-gate-store"
  );
  const { recordChangesRequested, submitRepairResponse } = await import(
    "@cinatra-ai/agents/lifecycle-repair-store"
  );
  const { readVerificationRecordForGate } = await import(
    "@cinatra-ai/agents/lifecycle-verification-store"
  );
  const { encodeLifecycleGateRef } = await import("@/lib/lifecycle/lifecycle-card-ref");

  const ownership = {
    orgId: subject.orgId,
    objectType,
    createdBy: subject.actorId,
    ownerLevel: "user" as const,
    ownerId: subject.actorId,
    visibility: "private" as const,
    declaredMime: FIXTURE_MIME,
    createdByRunId: subject.runId,
  };

  // 1. THE REVIEWED REVISION.
  const base = await createSemanticArtifact({
    ...ownership,
    title: "S8f parity fixture — the reviewed revision",
    stream: bytes(
      "cinatra#2683 S8f parity fixture.\nThis is the revision the reviewer saw.\n",
    ),
  });

  // 2. THE GATE that pins it.
  const reviewTaskId = `s8f-seed-review-${randomUUID()}`;
  const emitted = await emitArtifactReviewGate({
    runId: subject.runId,
    orgId: subject.orgId,
    reviewTaskId,
    targets: [
      {
        artifactId: base.artifactId,
        representationRevisionId: base.representationRevisionId,
      },
    ],
  });

  // 3. THE REVIEWER'S DECISION — `changes_requested`, which RESOLVES the gate and
  //    OPENS the repair. The base CAS is satisfied by the revision step 1 just
  //    returned, which IS the live one.
  const findings = FIXTURE_FINDINGS.map((f) => ({
    id: f.id,
    message: f.message,
    path: f.path,
  }));

  const request: ChangesRequestedRequest = {
    gateId: emitted.gateId,
    decisionId: `s8f-seed-decision-${randomUUID()}`,
    idempotencyKey: `s8f-seed-idem-${randomUUID()}`,
    baseTarget: {
      artifactId: base.artifactId,
      representationRevisionId: base.representationRevisionId,
    },
    expectedBaseRevisionId: base.representationRevisionId,
    findings,
    continuationMode: "async_effects_gated",
    continuationAddress: null,
  };
  const requested = await recordChangesRequested({
    runId: subject.runId,
    reviewTaskId,
    orgId: subject.orgId,
    request,
    repairCapable: true,
    producerRunId: subject.runId,
    currentBaseRevisionId: base.representationRevisionId,
    decidedBy: subject.actorId,
  });
  if (!requested.ok) {
    throw new Error(
      `[lifecycle-seed] recordChangesRequested refused (${requested.code}): ${requested.error}`,
    );
  }

  // 4. THE REPAIRED REVISION — a second real artifact write, so the verification
  //    has two genuinely different revisions to project and diff.
  const successor = await createSemanticArtifact({
    ...ownership,
    title: "S8f parity fixture — the repaired revision",
    stream: bytes(
      "cinatra#2683 S8f parity fixture.\nThis is the revision the producer repaired.\n" +
        "It says what the fixture is for, which is what the review asked for.\n",
    ),
  });

  // 5. THE REPAIR RESPONSE — pins the successor in a NEW gate and, in its own
  //    trigger, writes the verification record. `reauthorized` is the verdict the
  //    live run-read check above produced, not a literal.
  const responded = await submitRepairResponse({
    repairId: requested.repairId,
    currentBaseRevisionId: base.representationRevisionId,
    reauthorized: authorized.runReadOk,
    response: {
      gateId: emitted.gateId,
      baseTarget: request.baseTarget,
      successorTarget: {
        artifactId: successor.artifactId,
        representationRevisionId: successor.representationRevisionId,
      },
      findingOutcomes: findings.map((f) => ({ findingId: f.id, applied: true })),
      changeSummary: "the fixture states its purpose",
      producerProvenance: { runId: subject.runId, agentId: null },
    },
  });
  if (!responded.ok) {
    throw new Error(
      `[lifecycle-seed] submitRepairResponse refused (${responded.code}): ${responded.error}`,
    );
  }

  // READ BACK through the shipped read port. The trigger is best-effort by
  // design (a verification failure must never fail a repair), so "the pipeline
  // returned ok" is NOT evidence the record exists — only this read is.
  const record = await readVerificationRecordForGate(responded.successorGateId);

  const successorGate = await readReviewGate(subject.runId, responded.successorTaskId);
  const ref = encodeLifecycleGateRef({
    runId: subject.runId,
    reviewTaskId: responded.successorTaskId,
  });
  if (!successorGate || !ref) {
    throw new Error(
      "[lifecycle-seed] the successor gate could not be read back / minted as a ref",
    );
  }

  return {
    baseGateId: emitted.gateId,
    baseArtifactId: base.artifactId,
    baseRepresentationRevisionId: base.representationRevisionId,
    repairId: requested.repairId,
    successorArtifactId: successor.artifactId,
    successorRepresentationRevisionId: successor.representationRevisionId,
    successorGateId: responded.successorGateId,
    successorTaskId: responded.successorTaskId,
    ref,
    verificationRecordPresent: record !== null,
    verificationOutcome: record?.outcome ?? null,
  };
}

/**
 * Drive one atomic mutation under an EXPLICIT change-set, then close it.
 *
 * The explicit open/close is the point: the auto-open path would produce the same
 * row, but the undo chip's product path is a RUN that rolls several mutations up
 * under one set, and this fixture stands where that run stands.
 */
export async function seedRestorableChangeSet(
  subject: LifecycleSeedSubject,
): Promise<RestorableChangeSetSeedResult> {
  const objectType = await pinnedObjectType();

  // THE RUN IS AUTHORIZED HERE TOO (codex round 1, new HIGH). An earlier draft
  // checked the run only in the repair fixture, so this one would stamp any
  // caller-named run id — a foreign org's, or one that never existed — onto the
  // change_set and its event. Both are the reader's own run or the seed refuses.
  const authorized = await authorizeSubjectForRun(subject);
  if (!authorized.runReadOk) {
    throw new Error(
      `[lifecycle-seed] ${subject.actorId} may not read run ${subject.runId} — ` +
        `seeding a chip they could never see is refused`,
    );
  }

  const { openChangeSet, closeChangeSet, loadChangeSet } = await import(
    "@/lib/object-history"
  );
  const { historyAwareUpsert } = await import("@/lib/object-history/canonical-writer");
  const { verifySessionAuthority } = await import("@/lib/org-write/authority");

  // The org-write authority is MINTED from a LIVE membership read. A caller that
  // names a user who is not a member of the named org gets a throw here, before
  // a single statement runs — so the fixture cannot write into an org its subject
  // does not belong to.
  const authority = await verifySessionAuthority(subject.actorId, subject.orgId);

  const actor = {
    actorId: subject.actorId,
    actorKind: "user" as const,
    orgId: subject.orgId,
    runId: subject.runId,
  };

  const handle = openChangeSet({ actor });

  const written = historyAwareUpsert(
    {
      type: objectType,
      data: {
        title: "S8f parity fixture — the change this run made",
        body: "cinatra#2683: a real object write, so the change-set closes over a real member event.",
      },
      orgId: subject.orgId,
      createdBy: subject.actorId,
      runId: subject.runId,
      ownerLevel: "user",
      ownerId: subject.actorId,
      visibility: "private",
      source: "s8f-parity-seed",
    },
    {
      // create-only: the writer asserts the row does not yet exist.
      expectedBaseVersion: null,
      // The reversible class — the ONLY one that yields a restorable event, and
      // the class an ordinary content write actually carries.
      historyEffect: "reversible-internal",
      changeSet: handle,
      actor,
      authority,
    },
  );

  const closed = closeChangeSet(handle, {
    closureReason: "cinatra#2683 S8f parity fixture — one mutation, closed",
  });

  // READ BACK the set WITH its events, through the same loader the eligibility
  // gate uses. The member-event count is reported because zero is precisely the
  // state this slice refused to photograph.
  const loaded = loadChangeSet(handle.changeSetId, { orgId: subject.orgId });

  return {
    changeSetId: handle.changeSetId,
    objectId: written.objectId,
    objectType,
    eventId: written.event.id,
    effectRollup: closed.effectRollup,
    restorable: closed.restorable,
    memberEventCount: loaded?.events.length ?? 0,
    closedAt: closed.closedAt ?? null,
  };
}
