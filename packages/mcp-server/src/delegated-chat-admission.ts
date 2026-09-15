// ---------------------------------------------------------------------------
// VERSION- AND DECLARATION-BOUND DELEGATED-CHAT ADMISSION (cinatra#2817
// slice 2).
//
// WHAT AN ADMISSION IS. The durable output of the trusted marketplace/host
// REVIEW of ONE declaration, for ONE primitive, of ONE package, at ONE exact
// version. It is not a setting, not a manifest field, and never a mutable
// install-local self-assertion: nothing an extension ships can produce one.
//
// THE KEY IS THE WHOLE POINT. An admission is stored against the exact tuple
//
//     (owner package, resolved package version, primitive name, declaration digest)
//
// so it CANNOT:
//   - apply to another version of the same package (the version is in the key);
//   - apply to another package that registers the same name (the owner is in
//     the key — which is what makes a same-name collision non-transferable);
//   - survive a change to the declaration it approved (the digest is in the
//     key, and the digest covers the class that was reviewed).
//
// AND IT CANNOT SYNTHESIZE. `admittedClass` is a record of what the reviewer
// approved, and the evaluator (slice 3) requires it to EQUAL the class the
// registration declares at request time. An admission for `read` therefore
// authorizes only a `read` declaration; a registration that later declares
// `dispatch` produces a different digest, misses the record, and is refused.
// There is no code path that turns a missing class into an admitted one.
//
// EVERY UNCERTAIN STATE DENIES. Missing, stale (wrong version), malformed
// (unreadable record), revoked and store-unavailable all resolve to a refusal
// with a distinct reason — never to a fallback, a default, or a neutral.
//
// DEPENDENCY-FREE apart from `node:crypto`, which this package already uses.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import {
  DELEGATED_CHAT_TOOL_CLASSES,
  carriesDeniedDelegatedChatVerbToken,
  declarationPermitsDelegatedChat,
  isDelegatedChatProposalOverrideName,
  isHardDeniedDelegatedChatFamily,
  type DelegatedChatToolClass,
} from "./delegated-chat-tool-policy";
// TYPE-ONLY, and it must stay that way: the plan imports the record builder
// from THIS module, so a value edge back would be a cycle. TypeScript erases
// this line, so the two modules are one-directional at runtime.
import type { PlannedPrimitive } from "./capability-plan";

/**
 * Bumped whenever the digest INPUT set changes.
 *
 * A digest is an identity, so widening what it covers must invalidate every
 * record written under the old shape rather than silently re-interpret it. The
 * version is domain-separation, mixed into the hash itself.
 */
export const DECLARATION_DIGEST_VERSION = "v1";

/** The exact tuple one admission is stored against. */
export type DelegatedChatAdmissionKey = {
  readonly ownerPackage: string;
  readonly resolvedVersion: string;
  readonly primitiveName: string;
  readonly declarationDigest: string;
};

/** The declaration a review is about. */
export type DelegatedChatDeclaration = {
  readonly ownerPackage: string;
  readonly resolvedVersion: string;
  readonly primitiveName: string;
  /** The class the registration declares. `"none"` declines chat entirely. */
  readonly declaredClass: DelegatedChatToolClass;
};

/**
 * The digest of ONE reviewed declaration.
 *
 * LENGTH-PREFIXED FIELD ENCODING, not a delimiter join: a package named
 * `a|b` and a primitive named `c` must not encode identically to a package `a`
 * and a primitive `b|c`. With a plain separator they would, and a reviewed
 * admission for one primitive would authorize a different one. SHA-256 rather
 * than a cheap hash for the same reason a MAC is not a checksum: the digest is
 * an authorization lookup key, and a value an author can steer toward a
 * collision with an admitted record would be an admission forgery.
 */
export function computeDeclarationDigest(declaration: DelegatedChatDeclaration): string {
  const parts = [
    DECLARATION_DIGEST_VERSION,
    declaration.ownerPackage,
    declaration.resolvedVersion,
    declaration.primitiveName.toLowerCase(),
    declaration.declaredClass,
  ];
  const encoded = parts.map((p) => `${p.length}:${p}`).join("");
  return createHash("sha256").update(`cinatra.delegated-chat.declaration\u0000${encoded}`, "utf8")
    .digest("hex");
}

/** One persisted admission record. */
export type DelegatedChatAdmissionRecord = {
  readonly ownerPackage: string;
  readonly resolvedVersion: string;
  readonly primitiveName: string;
  readonly declarationDigest: string;
  /**
   * The class the REVIEW approved. Never `"none"`: a review that declines is
   * recorded by there being no record (or by `revoked`), not by a record that
   * approves nothing.
   */
  readonly admittedClass: Exclude<DelegatedChatToolClass, "none">;
  /**
   * Marketplace/host revocation. A revoked record is retained rather than
   * deleted so the refusal can name revocation instead of degrading into the
   * indistinguishable "no record" case, which would make an operator unable to
   * tell a withdrawal from a store that lost a row.
   *
   * REQUIRED, and validated as a real boolean. A record that does not state its
   * revocation state is not a record this host wrote — a truncated write, a
   * downgraded writer, a hand-edited row — and reading the omission as "not
   * revoked" would turn exactly those into active admissions.
   */
  readonly revoked: boolean;
  /**
   * CANONICAL ISO-8601 UTC millisecond instant of the review — the true wall
   * clock at the moment the review was recorded.
   *
   * Never consulted to ADMIT: no admission decision reads it, and a record
   * carrying a stamp is neither more nor less admitted than one without. It IS
   * consulted to REVOKE: the uninstall path withdraws every admission reviewed
   * at or before the moment the teardown ran, and this field is what that
   * cutoff orders against. So the spelling is load-bearing rather than audit
   * decoration — `normalizeAdmissionRecord` refuses any other form of an
   * instant, because the comparison is made on the STRING and only the
   * canonical form sorts chronologically.
   */
  readonly reviewedAt?: string;
  /**
   * The tie-break for `reviewedAt`, as `<epoch>.<seq>`: which process minted
   * the moment, and its position in that process's review order.
   *
   * A millisecond wall clock cannot separate an uninstall from a reinstall's
   * re-review that lands inside the same millisecond, and the revocation used
   * to resolve that tie by WITHDRAWING the fresh review. The sequence resolves
   * it correctly for two moments from one process. Across processes there is
   * nothing to resolve it with, and the revocation revokes — the fail-closed
   * reading. Absent, unparseable, or from another epoch all mean "cannot be
   * ordered", which reads the same way.
   */
  readonly reviewedMint?: string;
};

const ADMITTABLE_CLASSES: ReadonlySet<string> = new Set(
  DELEGATED_CHAT_TOOL_CLASSES.filter((c) => c !== "none"),
);

/** The canonical, injection-proof lookup key for one tuple. */
export function admissionKey(key: DelegatedChatAdmissionKey): string {
  const parts = [
    key.ownerPackage,
    key.resolvedVersion,
    key.primitiveName.toLowerCase(),
    key.declarationDigest,
  ];
  return parts.map((p) => `${p.length}:${p}`).join("");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The exact width of `new Date(ms).toISOString()`: `YYYY-MM-DDTHH:MM:SS.sssZ`. */
const CANONICAL_REVIEW_STAMP_LENGTH = 24;

/**
 * Is this a CANONICAL ISO-8601 UTC millisecond instant?
 *
 * The uninstall revocation compares `reviewedAt` to the teardown moment as a
 * STRING. That comparison is chronological only for this one spelling: a real
 * instant written `2026-05-01T14:00:00.000+02:00`, or without milliseconds, or
 * as a bare date, sorts by its text and not by its time, so a stamp in any of
 * those forms could land on the wrong side of a cutoff. Round-tripping the
 * parsed instant back through `toISOString()` pins the one spelling; the length
 * check rejects the wider forms that would round-trip while carrying extra
 * precision.
 */
export function isCanonicalReviewStamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== CANONICAL_REVIEW_STAMP_LENGTH) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString() === value;
}

/**
 * Structurally validate ONE stored record.
 *
 * `null` means the record is unusable. A dropped record does not degrade into
 * a permissive default: the lookup for that tuple then misses, and a missed
 * lookup denies. The count of dropped records rides the snapshot so an operator
 * can see a store that is quietly rotting instead of only seeing tools vanish.
 */
export function normalizeAdmissionRecord(raw: unknown): DelegatedChatAdmissionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(r.ownerPackage) ||
    !isNonEmptyString(r.resolvedVersion) ||
    !isNonEmptyString(r.primitiveName) ||
    !isNonEmptyString(r.declarationDigest) ||
    typeof r.admittedClass !== "string" ||
    !ADMITTABLE_CLASSES.has(r.admittedClass) ||
    // The revocation state must be STATED, as a real boolean. An absent or
    // non-boolean flag makes the record unusable — never "not revoked".
    typeof r.revoked !== "boolean" ||
    // A stamp that is PRESENT but not a canonical instant makes the record
    // unusable rather than un-stamped. The revocation cutoff orders by this
    // field, so a value the cutoff cannot order is not audit noise: it is a
    // record whose withdrawal cannot be reasoned about, and dropping it denies.
    // Silently discarding just the field would be worse than either — it would
    // turn an unorderable stamp into "predates the stamping", which every
    // cutoff revokes, so a garbled value would decide the record's fate by
    // accident. The mint token is NOT validated here on purpose: an
    // unparseable one already reads as "cannot be ordered", which revokes.
    (r.reviewedAt !== undefined && !isCanonicalReviewStamp(r.reviewedAt))
  ) {
    return null;
  }
  const revoked = r.revoked;
  return {
    ownerPackage: r.ownerPackage,
    resolvedVersion: r.resolvedVersion,
    primitiveName: r.primitiveName.toLowerCase(),
    declarationDigest: r.declarationDigest,
    admittedClass: r.admittedClass as Exclude<DelegatedChatToolClass, "none">,
    revoked,
    ...(r.reviewedAt !== undefined ? { reviewedAt: r.reviewedAt as string } : {}),
    ...(isNonEmptyString(r.reviewedMint) ? { reviewedMint: r.reviewedMint } : {}),
  };
}

/**
 * ONE immutable admission snapshot, valid for the whole of ONE request.
 *
 * IMMUTABLE ON PURPOSE. Catalog derivation, registration filtering, call-time
 * enforcement and the self-invoker all read the SAME snapshot object for a
 * request, so a revocation that lands mid-request cannot make those four
 * surfaces disagree about one primitive within one request. The revocation
 * takes effect on the next request, which is where the generation keying below
 * makes it unmissable.
 */
export type DelegatedChatAdmissionSnapshot = {
  /**
   * `false` when the admission state could not be read. An unavailable snapshot
   * admits NOTHING; the perimeter is closed, not open.
   */
  readonly available: boolean;
  /** Why the snapshot is unavailable, when it is. */
  readonly unavailableReason?: string;
  /** The extension control-plane generation the snapshot was built at. */
  readonly activationGeneration: number;
  /** The admission-policy generation the snapshot was built at. */
  readonly admissionGeneration: number;
  /**
   * A digest over the RECORD SET. Together with the two generations this is the
   * cache key every plan/handler/catalog/decision cache must use: a generation
   * bump alone can be missed by a process that never saw the bump, whereas a
   * content digest cannot silently match a different record set.
   */
  readonly policyDigest: string;
  /** How many stored records were unusable. Diagnostics only. */
  readonly malformedRecordCount: number;
  /** Point lookup. Never enumerates; never falls back to a looser key. */
  readonly lookup: (key: DelegatedChatAdmissionKey) => DelegatedChatAdmissionRecord | undefined;
  /**
   * Every record for one primitive NAME, whatever its owner or version.
   *
   * DIAGNOSTIC ONLY, and the evaluator uses it only AFTER `lookup` has already
   * missed — to tell the operator WHY it missed (a stale version, an admission
   * belonging to a different owner, or nothing reviewed at all). It can never
   * turn a miss into a hit: a looser key that admitted would be exactly the
   * version-crossing and collision-transferring this design forbids.
   */
  readonly recordsForPrimitive: (primitiveName: string) => readonly DelegatedChatAdmissionRecord[];
  /** Every usable record, for migration/diagnostics. Never a decision input. */
  readonly records: readonly DelegatedChatAdmissionRecord[];
};

/**
 * The composite cache key for anything derived from one snapshot.
 *
 * NOTHING CACHES TODAY, AND THAT IS THE DESIGN.
 * The capability plan is rebuilt from scratch on every request that needs it,
 * so there is no derived state to invalidate and no production consumer of this
 * function. It is not dead code and it is not an unused key backing a cache
 * that exists somewhere: it is the CONTRACT any future cache must key on, kept
 * beside the snapshot it describes so the two cannot drift apart.
 *
 * Why the contract has to be stated even with no cache: a plan is only valid
 * for the pair of generations it was built under. `activationGeneration` moves
 * when the set of installed/activated packages changes, `admissionGeneration`
 * when a review is recorded or withdrawn, and either one can change what the
 * SAME primitive name resolves to. A memo keyed on anything narrower (the name,
 * the owner, one generation) would serve a decision that was made against a
 * policy no longer in force. The digest and the availability bit are in the key
 * for the same reason: a snapshot that could not be read is not interchangeable
 * with one that could.
 *
 * See `resolveChatMcpCatalogState` (src/lib/assistant-runtime/runtime.ts) for
 * the per-turn rebuild this replaces a cache with.
 */
export function admissionSnapshotCacheKey(snapshot: DelegatedChatAdmissionSnapshot): string {
  return `${snapshot.activationGeneration}:${snapshot.admissionGeneration}:${snapshot.policyDigest}:${snapshot.available ? "1" : "0"}`;
}

function computePolicyDigest(records: readonly DelegatedChatAdmissionRecord[]): string {
  // Sorted so the digest is a function of the SET, not of the row order the
  // store happened to return.
  const lines = records
    .map((r) =>
      [r.ownerPackage, r.resolvedVersion, r.primitiveName, r.declarationDigest, r.admittedClass, r.revoked ? "1" : "0"]
        .map((p) => `${String(p).length}:${p}`)
        .join(""),
    )
    .sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/**
 * Build one immutable snapshot from raw stored records.
 *
 * DUPLICATE TUPLES FAIL TOWARD REVOKED. Two records for the same key mean the
 * store is in a state no single review produced; picking either one would be a
 * guess about which review is current. The merged entry is marked revoked, so
 * the primitive is refused with an explicit reason until the store is repaired.
 */
export function createDelegatedChatAdmissionSnapshot(input: {
  readonly rawRecords: readonly unknown[];
  readonly activationGeneration: number;
  readonly admissionGeneration: number;
}): DelegatedChatAdmissionSnapshot {
  const byKey = new Map<string, DelegatedChatAdmissionRecord>();
  let malformedRecordCount = 0;
  for (const raw of input.rawRecords) {
    const record = normalizeAdmissionRecord(raw);
    if (!record) {
      malformedRecordCount += 1;
      continue;
    }
    const key = admissionKey(record);
    const existing = byKey.get(key);
    // EACH RECORD IS FROZEN, not just the array holding them (codex whole-diff
    // round #1). The array being immutable says nothing about the objects in it,
    // and the SAME objects back `lookup()`, `recordsForPrimitive()` and
    // `records`. Since the snapshot now rides the request context so the
    // self-invoker can inherit it, an unfrozen record was reachable from inside
    // a delegated handler — and flipping one `revoked` field back to `false`
    // would have re-admitted a withdrawn primitive for the rest of the request.
    // "Immutable snapshot" has to mean the records too, or it means nothing.
    byKey.set(key, Object.freeze(existing ? { ...record, revoked: true } : record));
  }
  const records = Object.freeze([...byKey.values()]);
  const byPrimitive = new Map<string, readonly DelegatedChatAdmissionRecord[]>();
  for (const record of records) {
    const bucket = byPrimitive.get(record.primitiveName);
    byPrimitive.set(record.primitiveName, bucket ? [...bucket, record] : [record]);
  }
  // The per-primitive buckets are handed out by `recordsForPrimitive`, so they
  // are frozen for the same reason.
  for (const [name, bucket] of byPrimitive) byPrimitive.set(name, Object.freeze(bucket));
  return Object.freeze({
    available: true,
    activationGeneration: input.activationGeneration,
    admissionGeneration: input.admissionGeneration,
    policyDigest: computePolicyDigest(records),
    malformedRecordCount,
    lookup: (key: DelegatedChatAdmissionKey) => byKey.get(admissionKey(key)),
    recordsForPrimitive: (primitiveName: string) =>
      byPrimitive.get(primitiveName.toLowerCase()) ?? EMPTY_RECORDS,
    records,
  });
}

const EMPTY_RECORDS: readonly DelegatedChatAdmissionRecord[] = Object.freeze([]);

/**
 * The snapshot a caller gets when the admission state cannot be read.
 *
 * AUTHORITATIVELY CLOSED: `lookup` answers `undefined` for everything and
 * `available` is false, so slice 3's evaluator refuses every primitive with the
 * store-unavailable reason. There is deliberately no "last known good" path — a
 * cached admission surviving an unreadable store is exactly how a revocation
 * gets ignored.
 */
export function unavailableDelegatedChatAdmissionSnapshot(input: {
  readonly reason: string;
  readonly activationGeneration: number;
  readonly admissionGeneration: number;
}): DelegatedChatAdmissionSnapshot {
  return Object.freeze({
    available: false,
    unavailableReason: input.reason,
    activationGeneration: input.activationGeneration,
    admissionGeneration: input.admissionGeneration,
    policyDigest: "unavailable",
    malformedRecordCount: 0,
    lookup: () => undefined,
    recordsForPrimitive: () => EMPTY_RECORDS,
    records: EMPTY_RECORDS,
  });
}

/** Mint the admission record a review of `declaration` produces. */
export function admissionRecordFor(
  declaration: DelegatedChatDeclaration & { declaredClass: Exclude<DelegatedChatToolClass, "none"> },
  options?: { reviewedAt?: string; reviewedMint?: string },
): DelegatedChatAdmissionRecord {
  return {
    ownerPackage: declaration.ownerPackage,
    resolvedVersion: declaration.resolvedVersion,
    primitiveName: declaration.primitiveName.toLowerCase(),
    declarationDigest: computeDeclarationDigest(declaration),
    admittedClass: declaration.declaredClass,
    revoked: false,
    ...(options?.reviewedAt ? { reviewedAt: options.reviewedAt } : {}),
    ...(options?.reviewedMint ? { reviewedMint: options.reviewedMint } : {}),
  };
}

// ---------------------------------------------------------------------------
// THE SHARED DELEGATED-CHAT EVALUATOR (cinatra#2817 slice 3).
//
// Lives in this file, beside the record and digest it evaluates against:
// the evaluator is the ONLY reader of the admission key, and the two were
// one unit split across two modules. Every route that reaches the admission
// types reached the evaluator too, so the split cost a module on all of them
// and bought no independent reuse.
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
