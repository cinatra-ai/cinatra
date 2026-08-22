// ---------------------------------------------------------------------------
// THE SHARED DELEGATED-CHAT EVALUATOR (cinatra#2817 slice 3).
//
// ONE pure function, four surfaces. Registration filtering, catalog derivation,
// call-time enforcement and delegated-restricted self-invocation all call THIS,
// with the SAME planned primitive identity and the SAME immutable request
// snapshot. Four surfaces that each re-derived the answer is how a catalog
// comes to advertise what a call refuses, and how a call comes to reach what a
// catalog never offered.
//
// THE ORDER IS THE POLICY, and it is deliberate:
//
//   1. HARD FAMILY DENIES        unconditional. No declaration, admission or
//                                override reaches past them.
//   2. THE PROPOSAL OVERRIDE     the existing, separately audited exception.
//                                It bypasses ONLY the verb backstop, exactly as
//                                before. It does NOT bypass admission — the
//                                seven override names carry migrated core
//                                admissions like every other core primitive, so
//                                the behaviour is preserved while the rule
//                                "nothing outside the exactly admitted set is
//                                callable" stays true without an exception.
//   3. DESTRUCTIVE-VERB BACKSTOP unconditional except for (2).
//   4. EXACT ADMISSION           the version- and declaration-bound record.
//
// WHAT REPLACED WHAT. Step 4 used to be `ALLOWED_EXACT.has(name)` — roughly 110
// hand-listed names, and a core-file edit plus a release for every connector
// primitive that wanted to be reachable. It is now a lookup on
// `(owner package, resolved version, primitive name, declaration digest)`.
// Steps 1–3 are byte-for-byte the same rules, moved behind named helpers so
// they read as the backstops they always were.
//
// EVERY REFUSAL IS NAMED. A primitive that does not appear is a support ticket;
// a primitive that does not appear WITH A REASON is a five-minute fix. The
// reasons partition the space: undeclared, malformed, self-classified-only,
// unadmitted, stale-version, revoked, collision-losing, store-unavailable.
// ---------------------------------------------------------------------------

import type { PlannedPrimitive } from "./capability-plan";
import {
  computeDeclarationDigest,
  type DelegatedChatAdmissionSnapshot,
} from "./delegated-chat-admission";
import {
  carriesDeniedDelegatedChatVerbToken,
  declarationPermitsDelegatedChat,
  isDelegatedChatProposalOverrideName,
  isHardDeniedDelegatedChatFamily,
  type DelegatedChatToolClass,
} from "./delegated-chat-tool-policy";

/** Why a planned primitive is not reachable from delegated chat. */
export type DelegatedChatDenyReason =
  /** A privilege / system / job-control namespace. Unconditional. */
  | "denied_family"
  /** A mutating / destructive verb token, and no proposal override. */
  | "denied_verb_token"
  /** The registration declared nothing, so nothing was reviewable. */
  | "undeclared"
  /** The registration declared something unreadable. */
  | "malformed_declaration"
  /** The registration declared `none` — it declines the chat surface. */
  | "declaration_declines_chat"
  /** The host could not state which package at which version owns this. */
  | "identity_unresolved"
  /** Declared, but NOTHING has ever been reviewed for this primitive name. */
  | "self_classified_only"
  /** Reviewed for this owner + name, but at a DIFFERENT version. */
  | "stale_version"
  /** Reviewed for this name, but owned by a DIFFERENT package. */
  | "collision_lost"
  /** Reviewed for this exact owner + version + name, but a different declaration. */
  | "unadmitted"
  /** The marketplace/host withdrew the admission. */
  | "revoked"
  /**
   * The admission record and the live declaration disagree about the class.
   *
   * Unreachable while the digest covers the class — a mismatch would have
   * produced a different digest and missed the lookup. Kept as a defence in
   * depth against a future digest input change that forgot this invariant.
   */
  | "class_mismatch"
  /** The admission state could not be read. Refuse, never assume. */
  | "admission_store_unavailable";

export type DelegatedChatDecision =
  | { readonly allowed: true; readonly admittedClass: Exclude<DelegatedChatToolClass, "none"> }
  | { readonly allowed: false; readonly reason: DelegatedChatDenyReason };

const DENY = (reason: DelegatedChatDenyReason): DelegatedChatDecision => ({
  allowed: false,
  reason,
});

/**
 * Decide whether ONE planned primitive is reachable from delegated chat under
 * ONE admission snapshot.
 *
 * PURE. No I/O, no clock, no ambient state — so the same planned identity and
 * the same snapshot always produce the same answer, which is exactly what makes
 * the four surfaces agree.
 */
export function evaluateDelegatedChatAdmission(
  planned: PlannedPrimitive,
  snapshot: DelegatedChatAdmissionSnapshot,
): DelegatedChatDecision {
  const name = planned.name;

  // 1. HARD FAMILY DENIES — unconditional, first, and nothing below can undo
  //    them. A denied-family name loses regardless of declaration, admission or
  //    proposal override.
  if (isHardDeniedDelegatedChatFamily(name)) return DENY("denied_family");

  // 2/3. THE PROPOSAL OVERRIDE, then the DESTRUCTIVE-VERB BACKSTOP. The
  //    override sits between the family denies and the verb check and bypasses
  //    ONLY the verb check — its position and its effect are unchanged from the
  //    name-only predicate this replaced.
  const overridden = isDelegatedChatProposalOverrideName(name);
  if (!overridden && carriesDeniedDelegatedChatVerbToken(name)) {
    return DENY("denied_verb_token");
  }

  // The DECLARATION must exist and must be readable before anything can have
  // been reviewed about it. Malformed and declines-chat are the same OUTCOME
  // and different bugs, so they are named apart.
  if (planned.declarationMalformed) return DENY("malformed_declaration");
  if (planned.declaredClass === undefined) return DENY("undeclared");
  if (!declarationPermitsDelegatedChat(planned.declaredClass)) {
    return DENY("declaration_declines_chat");
  }
  const declaredClass = planned.declaredClass;

  // The IDENTITY must be resolvable, or there is no tuple to look up. This is
  // where a broken provenance stamp lands — it is never allowed to degrade into
  // the host identity and inherit the host's admissions.
  if (planned.identityFailure !== null) return DENY("identity_unresolved");
  const ownerPackage = planned.ownerPackage;
  const resolvedVersion = planned.resolvedVersion;
  if (!ownerPackage || !resolvedVersion) return DENY("identity_unresolved");

  // The STORE must be readable. Assuming anything about admission when the
  // record set is unavailable is the failure mode this whole design exists to
  // remove.
  if (!snapshot.available) return DENY("admission_store_unavailable");

  // 4. EXACT VERSION- AND DECLARATION-BOUND ADMISSION.
  const record = snapshot.lookup({
    ownerPackage,
    resolvedVersion,
    primitiveName: name,
    declarationDigest: computeDeclarationDigest({
      ownerPackage,
      resolvedVersion,
      primitiveName: name,
      declaredClass,
    }),
  });

  if (!record) {
    // The refusal is the same either way; only the REASON differs. Nothing
    // below can turn a miss into a hit — a looser key that admitted would be
    // the version-crossing and collision-transferring this design forbids.
    const forName = snapshot.recordsForPrimitive(name);
    if (forName.length === 0) return DENY("self_classified_only");
    if (forName.some((r) => r.ownerPackage === ownerPackage && r.resolvedVersion === resolvedVersion)) {
      return DENY("unadmitted");
    }
    if (forName.some((r) => r.ownerPackage === ownerPackage)) return DENY("stale_version");
    return DENY("collision_lost");
  }

  if (record.revoked) return DENY("revoked");
  if (record.admittedClass !== declaredClass) return DENY("class_mismatch");

  return { allowed: true, admittedClass: record.admittedClass };
}

/** Is this planned primitive reachable from delegated chat? */
export function isDelegatedChatAdmitted(
  planned: PlannedPrimitive,
  snapshot: DelegatedChatAdmissionSnapshot,
): boolean {
  return evaluateDelegatedChatAdmission(planned, snapshot).allowed;
}
