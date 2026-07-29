import "server-only";

/**
 * cinatra#1941 S2 — the cross-job system-authority mint seam (D4).
 *
 * The dispatcher (`background-jobs.ts`) mints an audited System identity for
 * every `system-maintenance` job with no payload attribution
 * (`background-jobs-system-frame.ts`), but that identity carries NO org-write
 * capability by itself. THIS seam is the only point where (job, purpose, org)
 * coexist — sweeps discover orgs mid-cycle, so org-bound authority cannot be
 * pre-minted at dispatch. `mintSystemAuthorityForJob(purpose, orgId)` reads
 * the active job dispatch frame and refuses (fail-closed) unless the job's
 * OWN declared `authority` metadata sanctions that exact purpose for that
 * exact org.
 *
 * Refusal conditions (ALL of the following pass, or it refuses):
 *   - a job dispatch frame is active (the call happened during a real
 *     dispatched-job handler, threaded through `runWithJobFrame`);
 *   - the frame's `authorityKind` is `"system-maintenance"` or
 *     `"grandfathered-run"` — the only kinds whose type even carries
 *     `allowedPurposes`; every other kind is structurally excluded;
 *   - `allowedPurposes` is PRESENT on the frame's metadata and `purpose` is a
 *     member (ABSENT ⇒ deny every purpose — the fail-closed default; this is
 *     also how the non-mintable `system-maintenance` arm is refused, since
 *     its `allowedPurposes` field is `?: never` by type);
 *   - every capability the purpose actually grants is a member of the job's
 *     declared `capabilities` ceiling. `SYSTEM_PURPOSE_CAPABILITIES` is
 *     module-private to `./authority` by design (not exported), so this is
 *     checked BLACK-BOX: mint the real authority via the existing
 *     `mintSystemWriteAuthority`, then probe its `.can()` surface against
 *     every kernel capability and require every granted one to be declared —
 *     this is equivalent to the map-based subset check without reaching into
 *     the module's internals, and it can never drift from the real grants
 *     (there is nothing else to drift against);
 *   - when the frame's org binding is `{source:"payload", field}`, the
 *     requested `orgId` must match `readPayloadField(frame.payload, field)`
 *     (org-hopping defense: a payload-bound job's own declared field is the
 *     only org it may mint for). Every other org binding
 *     (`row-sweep`/`parent-ref`/`run-row`/`global-org-attributed`) has no
 *     payload field to compare against and skips this check by declaration —
 *     those jobs discover/verify their org through their own row reads.
 *
 * Dark seam day-1 (D9/§9): no production caller exists yet — the boundary
 * gate's R5-job-system-mint rule ships with an EMPTY allowlist. Wave-3
 * migrates maintenance writers onto it (ARTIFACT_REVIEW_RESUME_DELIVERY is
 * the natural first migration, replacing its direct wave-2 mint) — that is
 * explicitly wave-3/#1940-adjacent follow-up work, not this stage's.
 *
 * R2-allowlisted (`SYSTEM_MINT_ALLOWLIST`, boundary gate) as the dispatcher-
 * side consumer of `mintSystemWriteAuthority` for job contexts; this file's
 * own export `mintSystemAuthorityForJob` is further fenced by the
 * boundary gate's R5-job-system-mint named-consumer rule.
 */
import { ORG_WRITE_CAPABILITIES, type OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import {
  mintSystemWriteAuthority,
  OrgWriteAuthorityError,
  type SystemWritePurpose,
} from "./authority";
import { getActiveJobFrame, readPayloadField } from "@/lib/background-jobs-system-frame";
import { logAuditEvent } from "@/lib/authz/audit";
import { POLICY_VERSION } from "@/lib/authz/actor-context";

function auditMintDecision(params: {
  decision: "allowed" | "denied";
  purpose: string;
  orgId: string;
  jobName: string;
  jobId: string;
  reason?: string;
}): void {
  void logAuditEvent({
    decision: params.decision,
    operation: "org-write.system-mint",
    resourceType: "background-job",
    resourceId: params.jobName,
    organizationId: params.orgId,
    actorPrincipalId: `background-job:${params.jobName}:${params.jobId}`,
    actorPrincipalType: "system",
    authSource: "worker",
    policyVersion: POLICY_VERSION,
    metadata: {
      purpose: params.purpose,
      reason: params.reason,
    },
  });
}

/**
 * Mint a purpose-scoped system authority for the ACTIVE job dispatch frame.
 * Throws `OrgWriteAuthorityError` and emits a `denied` audit row on any
 * refusal condition (see the module docstring); emits an `allowed` audit row
 * and returns the minted `OrgWriteAuthority` on success.
 */
export function mintSystemAuthorityForJob(
  purpose: SystemWritePurpose,
  orgId: string,
): OrgWriteAuthority {
  const frame = getActiveJobFrame();

  const deny = (reason: string): never => {
    auditMintDecision({
      decision: "denied",
      purpose,
      orgId,
      jobName: frame?.jobName ?? "<no-active-frame>",
      jobId: frame?.jobId ?? "<no-active-frame>",
      reason,
    });
    throw new OrgWriteAuthorityError(reason);
  };

  if (!frame) {
    return deny("no active job dispatch frame");
  }

  const { authority } = frame;
  if (
    authority.authorityKind !== "system-maintenance" &&
    authority.authorityKind !== "grandfathered-run"
  ) {
    return deny(`authorityKind "${authority.authorityKind}" may never mint system authority`);
  }

  const allowedPurposes = authority.allowedPurposes;
  if (!allowedPurposes || !allowedPurposes.includes(purpose)) {
    return deny(`purpose "${purpose}" not in the job's allowedPurposes`);
  }

  if (authority.orgExtractor.source === "payload") {
    const field = authority.orgExtractor.field;
    const payloadOrgId = readPayloadField(frame.payload, field);
    if (payloadOrgId === null || payloadOrgId !== orgId) {
      return deny(`requested orgId does not match the payload-bound org field "${field}"`);
    }
  }

  // `mintSystemWriteAuthority` is a PURE closure factory (no I/O, no audit,
  // no side effects — src/lib/org-write/authority.ts) — minting a CANDIDATE
  // here to probe its grants is safe today; if that ever changes, this
  // ordering must be revisited to check-before-mint. Not returned/audited as
  // "allowed" until the overgrant check below passes.
  const candidate = mintSystemWriteAuthority(purpose, orgId);
  const overgrant = ORG_WRITE_CAPABILITIES.some(
    (cap) => candidate.can(cap) && !authority.capabilities.includes(cap),
  );
  if (overgrant) {
    return deny(`purpose "${purpose}" grants exceed the job's declared capabilities ceiling`);
  }
  const minted = candidate;

  auditMintDecision({
    decision: "allowed",
    purpose,
    orgId,
    jobName: frame.jobName,
    jobId: frame.jobId,
  });
  return minted;
}
