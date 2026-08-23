import "server-only";

// ---------------------------------------------------------------------------
// THE DURABLE DELEGATED-CHAT ADMISSION STORE (cinatra#2817 slice 2).
//
// WHAT IS PERSISTED. One record per reviewed declaration, keyed by the exact
// tuple `(owner package, resolved version, primitive name, declaration digest)`.
// The record set is the durable output of the trusted marketplace/host review —
// never an install-local self-assertion, and never anything an extension writes.
// The only writers are this module's review/revocation entry points and the
// core migration below.
//
// WHY A METADATA ROW AND NOT A NEW TABLE. The record set is small, read whole
// on every snapshot, written rarely, and needs an atomic read-modify-write —
// which the metadata store already provides (`readRawMetadataStringFromDatabase`
// + `compareAndSwapMetadataValueFromDatabase`). A dedicated table would buy row
// granularity this access pattern never uses, at the cost of a migration on a
// gated schema.
//
// EVERY FAILURE DENIES. A read that throws, a payload that is not the expected
// shape, a migration that could not land — each produces an UNAVAILABLE
// snapshot, which admits nothing. There is deliberately no last-known-good
// path: a cached admission surviving an unreadable store is precisely how a
// revocation gets ignored.
//
// THE MIGRATION IS A WRITE, not a read-time fallback. Core/bundled primitives
// get release-versioned records written into the store; the lookup that follows
// is then authoritative against the store like any other. A read-time "if it is
// core, allow" branch would have been a second admission source, which is the
// shape this whole issue removes.
// ---------------------------------------------------------------------------

import {
  createDelegatedChatAdmissionSnapshot,
  unavailableDelegatedChatAdmissionSnapshot,
  admissionKey,
  computeDeclarationDigest,
  normalizeAdmissionRecord,
  type DelegatedChatAdmissionKey,
  type DelegatedChatAdmissionRecord,
  type DelegatedChatAdmissionSnapshot,
  type DelegatedChatDeclaration,
} from "@cinatra-ai/mcp-server/delegated-chat-admission";
import {
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
  coreDelegatedChatAdmissionRecords,
} from "@cinatra-ai/mcp-server/capability-plan";
import {
  getActivationGeneration,
  bumpAdmissionPolicyGeneration,
  getAdmissionPolicyGeneration,
} from "@/lib/extension-activation-generation";

/** The metadata row the record set lives in. */
export const DELEGATED_CHAT_ADMISSION_KEY = "delegated-chat-admission/v1";

/** The persisted payload shape. */
type AdmissionStorePayload = {
  /**
   * The core-migration marker: the release version whose core records this
   * payload already holds. A release bump makes the marker stale, which is what
   * re-runs the migration and re-reviews the whole core surface at the new
   * version.
   */
  coreMigratedAtRelease?: string;
  records?: unknown[];
};

type StoreIo = {
  readRaw: (key: string) => string | null;
  read: <T>(key: string, fallback: T) => T;
  cas: (key: string, value: unknown, expectedRaw: string) => boolean;
  /**
   * INSERT ... ON CONFLICT DO NOTHING. The absent-row path needs this rather
   * than a plain write: two processes can both observe an absent row, and an
   * unconditional upsert would let the second overwrite whatever the first
   * wrote — including an extension admission that landed in between.
   */
  insertIfAbsent: (key: string, value: unknown) => void;
  write: (key: string, value: unknown) => void;
};

let ioOverride: StoreIo | null = null;

/** @internal Tests only — drive the store without a database. */
export function __setDelegatedChatAdmissionStoreIoForTests(io: StoreIo | null): void {
  ioOverride = io;
}

async function resolveIo(): Promise<StoreIo> {
  if (ioOverride) return ioOverride;
  const db = await import("@/lib/database");
  return {
    readRaw: (key) => db.readRawMetadataStringFromDatabase(key),
    read: (key, fallback) => db.readMetadataValueFromDatabase(key, fallback),
    cas: (key, value, expectedRaw) =>
      db.compareAndSwapMetadataValueFromDatabase(key, value, expectedRaw),
    insertIfAbsent: (key, value) => db.writeMetadataValueIfAbsentToDatabase(key, value),
    write: (key, value) => db.writeMetadataValueToDatabase(key, value),
  };
}

function parsePayload(raw: string | null): AdmissionStorePayload | null {
  if (raw === null) return { records: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const p = parsed as AdmissionStorePayload;
    if (p.records !== undefined && !Array.isArray(p.records)) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Ensure this release's core records are in the store.
 *
 * IDEMPOTENT and CAS-guarded: the marker names the release the payload was
 * migrated for, so a repeat call is a no-op and two concurrent callers cannot
 * clobber each other's records.
 *
 * Returns `false` when the migration was needed and could NOT be persisted. The
 * caller then treats the store as unavailable, which denies. Serving from an
 * in-memory migration the store never accepted would mean the perimeter and the
 * durable record disagreed about what had been reviewed.
 */
async function ensureCoreMigration(io: StoreIo): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = io.readRaw(DELEGATED_CHAT_ADMISSION_KEY);
    const payload = parsePayload(raw);
    if (!payload) return false;
    if (coreMigrationIsComplete(payload)) return true;

    // Records for a DIFFERENT release of the host are dropped, not merged: an
    // admission is bound to the version it reviewed, so a previous release's
    // core records are stale by construction and keeping them would leave the
    // store holding approvals for primitives this build does not serve.
    // Non-host (extension) records are untouched — their versions are their own.
    const preserved = (payload.records ?? []).filter((r) => {
      const record = normalizeAdmissionRecord(r);
      if (!record) return false;
      return record.ownerPackage !== HOST_PRIMITIVE_OWNER_PACKAGE;
    });
    const next: AdmissionStorePayload = {
      coreMigratedAtRelease: HOST_PRIMITIVE_RELEASE_VERSION,
      records: [
        ...preserved,
        ...coreDelegatedChatAdmissionRecords({ reviewedAt: new Date().toISOString() }),
      ],
    };
    if (raw === null) {
      io.insertIfAbsent(DELEGATED_CHAT_ADMISSION_KEY, next);
    } else if (io.cas(DELEGATED_CHAT_ADMISSION_KEY, next, raw)) {
      bumpAdmissionPolicyGeneration("core-migration");
      return true;
    }
    // Either an insert that may have lost to a concurrent one, or a lost CAS.
    // Both have the SAME two possible causes and they must not be conflated: a
    // concurrent writer landing first is benign (it ran the same migration), a
    // store that cannot accept writes is a fault. Reporting a fault as success
    // would produce an AVAILABLE snapshot holding no core records, and every
    // core primitive would then be refused as "unadmitted" rather than as "the
    // admission store is unavailable" — the wrong answer for an operator and
    // the wrong reason for an auditor. Re-reading settles it on the next
    // iteration, which checks COMPLETENESS, not just the marker.
  }
  return coreMigrationIsComplete(parsePayload(io.readRaw(DELEGATED_CHAT_ADMISSION_KEY)));
}

/**
 * Has this release's core migration ACTUALLY landed?
 *
 * The marker alone is not enough. A truncated write, a partially applied
 * concurrent write, or a hand-edited row can carry the current marker while
 * missing records — and trusting the marker would then serve an available
 * snapshot with core primitives silently absent. So completeness is checked
 * against the core declarations themselves: every core tuple must be PRESENT.
 *
 * PRESENT, not admitted. A core record that an operator deliberately revoked is
 * still present, so a revocation is not mistaken for a broken migration and
 * silently undone on the next read.
 */
function coreMigrationIsComplete(payload: AdmissionStorePayload | null): boolean {
  if (!payload) return false;
  if (payload.coreMigratedAtRelease !== HOST_PRIMITIVE_RELEASE_VERSION) return false;
  const present = new Set(
    (payload.records ?? [])
      .map((r) => normalizeAdmissionRecord(r))
      .filter((r): r is DelegatedChatAdmissionRecord => r !== null)
      .map((r) => admissionKey(r)),
  );
  return coreDelegatedChatAdmissionRecords().every((r) => present.has(admissionKey(r)));
}

/**
 * Load ONE immutable admission snapshot for the current request.
 *
 * The snapshot is the request's whole view of admission: catalog derivation,
 * registration filtering, call-time enforcement and the self-invoker all read
 * this same object, so a revocation landing mid-request cannot make them
 * disagree. It takes effect on the next request, where the generation + digest
 * keying makes it unmissable.
 */
export async function loadDelegatedChatAdmissionSnapshot(): Promise<DelegatedChatAdmissionSnapshot> {
  const activationGeneration = getActivationGeneration();
  let io: StoreIo;
  try {
    io = await resolveIo();
  } catch (error) {
    return unavailable(`store_io_unavailable: ${message(error)}`, activationGeneration);
  }
  try {
    if (!(await ensureCoreMigration(io))) {
      bumpAdmissionPolicyGeneration("store-fault");
      return unavailable("core_migration_failed", activationGeneration);
    }
    const payload = parsePayload(io.readRaw(DELEGATED_CHAT_ADMISSION_KEY));
    if (!payload) {
      bumpAdmissionPolicyGeneration("store-fault");
      return unavailable("admission_payload_malformed", activationGeneration);
    }
    return createDelegatedChatAdmissionSnapshot({
      rawRecords: payload.records ?? [],
      activationGeneration,
      admissionGeneration: getAdmissionPolicyGeneration(),
    });
  } catch (error) {
    bumpAdmissionPolicyGeneration("store-fault");
    return unavailable(`admission_store_read_failed: ${message(error)}`, activationGeneration);
  }
}

function unavailable(reason: string, activationGeneration: number): DelegatedChatAdmissionSnapshot {
  return unavailableDelegatedChatAdmissionSnapshot({
    reason,
    activationGeneration,
    admissionGeneration: getAdmissionPolicyGeneration(),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mutate(
  apply: (records: DelegatedChatAdmissionRecord[]) => DelegatedChatAdmissionRecord[],
): Promise<boolean> {
  const io = await resolveIo();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = io.readRaw(DELEGATED_CHAT_ADMISSION_KEY);
    const payload = parsePayload(raw);
    if (!payload) return false;
    const current = (payload.records ?? [])
      .map((r) => normalizeAdmissionRecord(r))
      .filter((r): r is DelegatedChatAdmissionRecord => r !== null);
    const next: AdmissionStorePayload = { ...payload, records: apply(current) };
    if (raw === null) {
      // Insert-if-absent, then loop: if a concurrent writer created the row
      // first, the next iteration re-reads and CASes on top of THEIR value
      // instead of overwriting it.
      io.insertIfAbsent(DELEGATED_CHAT_ADMISSION_KEY, next);
      if (io.readRaw(DELEGATED_CHAT_ADMISSION_KEY) === JSON.stringify(next)) return true;
      continue;
    }
    if (io.cas(DELEGATED_CHAT_ADMISSION_KEY, next, raw)) return true;
  }
  return false;
}

/**
 * Record the marketplace/host review that ADMITS one declaration.
 *
 * The record is minted from the declaration itself, so the digest is over what
 * was actually reviewed and the admitted class IS the declared class. There is
 * no parameter by which a caller could approve a class the declaration did not
 * request; an admission cannot synthesize one.
 */
export async function admitDelegatedChatDeclaration(
  declaration: DelegatedChatDeclaration & { declaredClass: "read" | "discovery" | "dispatch" },
): Promise<boolean> {
  const digest = computeDeclarationDigest(declaration);
  const record: DelegatedChatAdmissionRecord = {
    ownerPackage: declaration.ownerPackage,
    resolvedVersion: declaration.resolvedVersion,
    primitiveName: declaration.primitiveName.toLowerCase(),
    declarationDigest: digest,
    admittedClass: declaration.declaredClass,
    revoked: false,
    reviewedAt: new Date().toISOString(),
  };
  const key = admissionKey(record);
  const ok = await mutate((records) => [
    ...records.filter((r) => admissionKey(r) !== key),
    record,
  ]);
  if (ok) bumpAdmissionPolicyGeneration("admit", declaration.ownerPackage);
  return ok;
}

/**
 * Revoke one admission.
 *
 * The record is MARKED revoked rather than deleted, so the refusal can name
 * revocation. A deletion would collapse "the marketplace withdrew this" into
 * "no record exists", and an operator would have no way to tell a withdrawal
 * from a store that lost a row.
 */
export async function revokeDelegatedChatAdmission(
  key: DelegatedChatAdmissionKey,
): Promise<boolean> {
  const target = admissionKey(key);
  const ok = await mutate((records) =>
    records.map((r) => (admissionKey(r) === target ? { ...r, revoked: true } : r)),
  );
  if (ok) bumpAdmissionPolicyGeneration("revoke", key.ownerPackage);
  return ok;
}

/**
 * Revoke every admission a package holds — the uninstall / marketplace-pull
 * path. Version-agnostic on purpose: pulling a package withdraws every version
 * of it, not just the one currently installed.
 */
export async function revokeDelegatedChatAdmissionsForPackage(
  ownerPackage: string,
  options?: {
    /**
     * Revoke only admissions reviewed AT OR BEFORE this ISO-8601 instant.
     *
     * The uninstall path passes the moment the teardown ran. Without it, a
     * teardown whose durable write lands late could revoke a FRESH review of a
     * reinstalled package — the write would arrive after the new admission and
     * silently withdraw it. A record carrying no `reviewedAt` predates the
     * stamping and is revoked, which is the fail-closed reading.
     */
    reviewedNotAfter?: string;
  },
): Promise<boolean> {
  const cutoff = options?.reviewedNotAfter;
  const ok = await mutate((records) =>
    records.map((r) => {
      if (r.ownerPackage !== ownerPackage) return r;
      if (cutoff !== undefined && r.reviewedAt !== undefined && r.reviewedAt > cutoff) return r;
      return { ...r, revoked: true };
    }),
  );
  if (ok) bumpAdmissionPolicyGeneration("revoke", ownerPackage);
  return ok;
}

/**
 * Signal that a registration's DECLARATION changed.
 *
 * No record is edited: the old admission stays bound to the old digest, which
 * the new declaration no longer produces, so it simply stops matching. The bump
 * is what stops a cache from answering from the pre-change snapshot.
 */
export function noteDelegatedChatDeclarationChanged(ownerPackage: string): void {
  bumpAdmissionPolicyGeneration("declaration-change", ownerPackage);
}
