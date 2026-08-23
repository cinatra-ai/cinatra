// ---------------------------------------------------------------------------
// THE CORE DELEGATED-CHAT SURFACE, PROJECTED (cinatra#2817 slice 3).
//
// WHAT THIS IS FOR. Admission is a decision about a PLANNED PRIMITIVE under a
// REQUEST SNAPSHOT — an owner at a version with a reviewed declaration — so
// "is this name reachable?" no longer has an answer in the abstract. But a
// large class of checks legitimately asks a narrower question: *given only the
// core/bundled surface this build ships, and its migrated release-versioned
// admissions, would this primitive be reachable?* That is what a gate asserting
// "this new primitive must not be chat-callable" means, and what a serializer
// gate needs to know about the names it must never flatten.
//
// So this module answers exactly that, by running the REAL evaluator over the
// REAL core admission records — never by consulting a list. A projection built
// from the same decision path cannot drift from it, which is the property the
// deleted `delegatedChatAllowedToolNames()` accessor used to provide and which
// its callers still need.
//
// WHAT THIS IS NOT. It is not authorization, and production never calls it: a
// live request decides against ITS OWN snapshot, which includes extension
// admissions this projection deliberately knows nothing about. Using it to
// decide a real call would reintroduce exactly the name-only perimeter #2817
// removed.
// ---------------------------------------------------------------------------

import {
  type PlannedPrimitive,
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
  HOST_PRIMITIVE_DECLARATIONS,
  coreDelegatedChatAdmissionRecords,
} from "./capability-plan";
import {
  createDelegatedChatAdmissionSnapshot,
  type DelegatedChatAdmissionSnapshot,
  evaluateDelegatedChatAdmission,
} from "./delegated-chat-admission";

let cachedSnapshot: DelegatedChatAdmissionSnapshot | null = null;

/**
 * An available snapshot holding exactly this build's migrated core admissions.
 *
 * Generations are `0`: this projection is not request-scoped and has no
 * lifecycle to track. It is deliberately not the object a request decides
 * against — that one comes from the durable store.
 */
export function coreDelegatedChatAdmissionSnapshot(): DelegatedChatAdmissionSnapshot {
  cachedSnapshot ??= createDelegatedChatAdmissionSnapshot({
    rawRecords: coreDelegatedChatAdmissionRecords(),
    activationGeneration: 0,
    admissionGeneration: 0,
  });
  return cachedSnapshot;
}

/**
 * The planned primitive a core registration of `name` would produce: owned by
 * the host, at the release version, carrying the host's own declaration.
 *
 * A name the host does not declare for produces an UNDECLARED entry, which the
 * evaluator refuses — the correct answer for "would a core primitive by this
 * name be reachable?" when there is no such core primitive.
 */
export function plannedCorePrimitive(name: string): PlannedPrimitive {
  const normalized = name.toLowerCase();
  return {
    name: normalized,
    registeredName: normalized,
    order: 0,
    declaredClass: HOST_PRIMITIVE_DECLARATIONS[normalized],
    declarationMalformed: false,
    ownerPackage: HOST_PRIMITIVE_OWNER_PACKAGE,
    resolvedVersion: HOST_PRIMITIVE_RELEASE_VERSION,
    capabilityKey: null,
    dispatchTarget: {
      kind: "host",
      packageName: HOST_PRIMITIVE_OWNER_PACKAGE,
      version: HOST_PRIMITIVE_RELEASE_VERSION,
      name: normalized,
    },
    identityFailure: null,
    reserved: false,
  };
}

/**
 * Would a CORE primitive by this name be reachable from delegated chat on this
 * build? Decided by the real evaluator over the real core admissions.
 *
 * Never an authorization decision for a live call — see the module header.
 */
export function isCoreDelegatedChatAdmitted(name: string): boolean {
  return evaluateDelegatedChatAdmission(
    plannedCorePrimitive(name),
    coreDelegatedChatAdmissionSnapshot(),
  ).allowed;
}

/**
 * Every core primitive name this build admits to delegated chat, sorted.
 *
 * Derived by running each host declaration BACK through the evaluator, so the
 * family denies and the verb backstop apply to the projection exactly as they
 * apply to a live decision: a name the evaluator would refuse can never appear
 * here, however the declarations are edited.
 */
export function coreDelegatedChatAdmittedNames(): readonly string[] {
  return Object.keys(HOST_PRIMITIVE_DECLARATIONS)
    .filter((name) => isCoreDelegatedChatAdmitted(name))
    .sort();
}
