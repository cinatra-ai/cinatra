// THE DECISIONS THE SETUP AND THE TEARDOWN BOTH OBEY (chat-hitl S9k, cinatra#2824).
//
// Every rule in this file is PURE: no database client, no `server-only` import,
// no environment lookup beyond the one run token below. That is deliberate and it
// is the point of the file.
//
//   · ONE RULE, ONE SPELLING. The defects this file exists to prevent were all
//     the same shape — the write side and the restore side each deciding the same
//     question in their own words, and disagreeing on an input neither author had
//     in mind. "Does this role string carry `admin`" was spelled twice; "which row
//     is this membership" was spelled as a synthetic id on one side and as a
//     unique index on the other. A rule that lives in one place cannot drift.
//   · AND ONE THAT CAN BE RUN. `account-state.ts` and `fixtures.mts` both need a
//     live instance to say anything at all, so nothing they decide could be
//     re-run by a reader. These rules can: they are covered by
//     `__tests__/state-rules.test.ts`, which needs no database, no browser and no
//     stack.
//
// The four contracts this file owns:
//
//   1. THE ROLE PREDICATE — `roleCarriesAdmin`, plus the two SQL statements that
//      act on it, built from ONE token expression so the promote and the strip
//      can never split a role string differently.
//   2. THE MEMBERSHIP IDENTITY — `(organizationId, userId)`, which is what
//      production's `member_org_user_uniq` enforces, rather than the synthetic id
//      this fixture mints for the row it creates.
//   3. WHAT A TEARDOWN MAY TOUCH — the run-token claim on a snapshot, and the
//      revert plans that compare the LIVE state against what this fixture itself
//      wrote. A teardown reverts its own writes and nothing else, and it never
//      removes a row it cannot prove it created.
//   4. HOW MANY QUEUE JOBS NAME A RUN — the count behind the suite's headline
//      "exactly once" claim, decided over job PAYLOADS rather than over one job
//      id, so a duplicate dispatch enqueued under a different id is visible.
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. THE ROLE PREDICATE, AND THE TWO STATEMENTS BUILT ON IT
// ---------------------------------------------------------------------------

/**
 * THE ONE PREDICATE. Better Auth stores the role set as a comma-separated string
 * and its platform-admin check comma-splits and looks for `admin`.
 *
 * `null` and `""` both mean "no roles". Each token is TRIMMED before it is
 * compared, so `" admin"`, `"user, admin"` and `" admin,editor"` all carry the
 * token — the shapes on which the previous two spellings disagreed, one appending
 * a duplicate `admin` while the other recorded the role as unchanged.
 */
export function roleCarriesAdmin(role: string | null | undefined): boolean {
  if (!role) return false;
  return role.split(",").some((part) => trimRoleToken(part) === "admin");
}

/**
 * The SAME split-and-trim as `roleCarriesAdmin`, in SQL, written ONCE.
 *
 * Both statements below are built from this fragment, so the promote's
 * idempotency guard and the restore's strip cannot decide `" admin"` differently
 * from each other or from the predicate above.
 */
export const ROLE_TOKENS_SQL = `unnest(string_to_array(role, ',')) AS t`;

/**
 * THE ONE WHITESPACE SET, spelled once for both languages.
 *
 * `roleCarriesAdmin` trims a token with it, and both SQL statements trim with the
 * SAME set, so no input can be trimmed on one side and not the other. Two traps
 * live here, and both were live in an earlier draft of this file:
 *
 *   · A bare `btrim(t)` strips SPACES ONLY, so a token spelled `"\tadmin"` read as
 *     carrying `admin` in JS and as not carrying it in SQL — the comma-split
 *     defect again, one character further out.
 *   · PostgreSQL escape strings do NOT define `\v`. An unknown escape resolves to
 *     the bare character, so `E'\v'` asks Postgres to trim the LETTER `v`, which
 *     would read `"vadmin"` as `admin`. The vertical tab is written `\x0B`.
 *
 * JavaScript's own `trim` also strips Unicode spaces (U+00A0, U+2028, …) that this
 * set omits. That is deliberate: matching it would need a second spelling in SQL,
 * and this set is EXACT on both sides for every input, so the two can only agree.
 * A role padded with a Unicode space reads as "does not carry admin" on both
 * sides, which promotes and then strips — the safe direction, and a round trip.
 */
const ROLE_TOKEN_TRIM_CHARS = " \t\n\r\f\v";

/**
 * How each character of the set above is spelled inside a PostgreSQL escape
 * string. This map exists so the SQL fragment is BUILT FROM the same constant the
 * JavaScript trim uses, rather than hand-mirrored beside it: adding a character to
 * the set and forgetting the SQL half is the drift this whole file is about.
 *
 * `\v` is the trap. PostgreSQL escape strings do not define it, and an undefined
 * escape resolves to the bare character, so `E'\v'` asks Postgres to trim the
 * LETTER `v` and would read `"vadmin"` as `admin`. The vertical tab is `\x0B`.
 */
const SQL_ESCAPE_FOR: Readonly<Record<string, string>> = {
  " ": " ",
  "\t": String.raw`\t`,
  "\n": String.raw`\n`,
  "\r": String.raw`\r`,
  "\f": String.raw`\f`,
  "\v": String.raw`\x0B`,
};

/** The trim in SQL, over exactly the set above. */
export const ROLE_TOKEN_TRIMMED_SQL = `btrim(t, E'${[...ROLE_TOKEN_TRIM_CHARS]
  .map((char) => {
    const escaped = SQL_ESCAPE_FOR[char];
    if (escaped === undefined) {
      throw new Error(
        `state-rules: no PostgreSQL escape is defined for ${JSON.stringify(char)} in the role ` +
          "token trim set, so the SQL side would silently trim a different set from the JS side",
      );
    }
    return escaped;
  })
  .join("")}')`;

/** The trim in JavaScript, over the same set and nothing else. */
function trimRoleToken(token: string): string {
  const cls = `[${ROLE_TOKEN_TRIM_CHARS.replace(/[\\\]^-]/g, "\\$&")}]`;
  return token.replace(new RegExp(`^${cls}+|${cls}+$`, "g"), "");
}

/**
 * APPEND `admin`, reached ONLY when `roleCarriesAdmin` already answered "no" from
 * the pre-read — that JS answer is the decision of record and the thing
 * `roleChanged` stores. The `EXISTS` arm here is a pure idempotency belt for the
 * window between the pre-read and this write, and it uses the same token rule, so
 * it can never disagree with the answer that got it here.
 */
export const PROMOTE_ADMIN_ROLE_SQL = `UPDATE public."user"
    SET role = CASE
      WHEN role IS NULL OR btrim(role) = '' THEN 'admin'
      WHEN EXISTS (SELECT 1 FROM ${ROLE_TOKENS_SQL} WHERE ${ROLE_TOKEN_TRIMMED_SQL} = 'admin') THEN role
      ELSE role || ',admin'
    END
  WHERE id = $1`;

/**
 * REMOVE every `admin` token, computed from the column's LIVE value inside one
 * statement so there is no read-then-write window. Kept tokens are returned
 * verbatim (the trim compares, it does not rewrite), and `NULLIF` restores the
 * column's own unset state rather than `""`.
 */
export const STRIP_ADMIN_ROLE_SQL = `UPDATE public."user"
    SET role = NULLIF(
          array_to_string(
            ARRAY(SELECT t FROM ${ROLE_TOKENS_SQL} WHERE ${ROLE_TOKEN_TRIMMED_SQL} <> 'admin'), ','
          ), '')
  WHERE id = $1
RETURNING role`;

// ---------------------------------------------------------------------------
// 2. THE MEMBERSHIP IDENTITY
// ---------------------------------------------------------------------------

/**
 * WHAT IDENTIFIES A MEMBERSHIP: the pair, not the id.
 *
 * Production enforces `member_org_user_uniq ON public."member" ("organizationId",
 * "userId")` (`src/lib/drizzle-store.ts`). A pre-read or a conflict target keyed
 * on the synthetic id below therefore asks a DIFFERENT question from the one the
 * database answers: a developer already a member of that organization under a
 * normally minted id reads as "not a member", and the insert then hits the unique
 * violation instead of the do-nothing arm — or, worse, the teardown later deletes
 * a membership this fixture never created because ownership was decided against
 * the wrong key.
 *
 * So both sides ask `("organizationId", "userId")`, and the id below is only ever
 * the id this fixture MINTS for a row it is about to create.
 */
export const MEMBER_IDENTITY_SQL = `"organizationId" = $1 AND "userId" = $2`;

/**
 * The id this fixture mints for the membership row it creates, derived from the
 * IDENTITY IN FULL so a row it made can always be recognized.
 *
 * BOTH HALVES ARE CARRIED WHOLE, and the length prefix makes the join injective.
 * An earlier spelling truncated each half to its first eight characters, which
 * gave the primary key a collision the unique index does not have: two DISTINCT
 * `(organizationId, userId)` pairs that merely shared those prefixes minted the
 * same id, so the insert failed on `member_pkey` instead of taking the
 * `ON CONFLICT ("organizationId", "userId") DO NOTHING` arm it arbitrates on —
 * and a conflict on a target the statement does not name is not absorbed, it
 * aborts the setup. Eight shared characters is not an exotic input: any id scheme
 * with a fixed prefix (`org_`, `user_`, a shared timestamp head) meets it
 * routinely.
 *
 * The length prefix closes the second, rarer shape: a bare `${userId}-${orgId}`
 * join reads the same for `("a-b", "c")` and `("a", "b-c")`, because the ids may
 * themselves contain the separator. `<len>-<userId><orgId>` decodes uniquely —
 * read `len`, take exactly that many characters, the rest is the organization —
 * so distinct pairs always mint distinct ids.
 *
 * Nothing is truncated for width, either: `public."member".id` is `text`
 * (`src/lib/better-auth-db.ts:748`), so the full pair costs nothing.
 */
export function memberIdFor(userId: string, organizationId: string): string {
  return `chat-hitl-s9k-member-${userId.length}-${userId}-${organizationId}`;
}

/** The membership half of the account snapshot, as the ownership rule reads it. */
export interface MembershipOwnershipInput {
  /** Read against `(organizationId, userId)` BEFORE the insert, never derived from it. */
  memberExistedBefore: boolean;
  memberId: string | null;
  memberInsert: "not_attempted" | "pending" | "inserted" | "already_present";
}

/**
 * Whether the teardown may remove the membership row.
 *
 * `pending` counts as owned because it is written immediately BEFORE the insert:
 * it is the state a crash inside the insert leaves, and a row present at that
 * point may exist because of this fixture. `already_present` and
 * `memberExistedBefore` both mean the row is somebody else's — including a row
 * that happens to carry this fixture's own derived id, which can only come from a
 * previous run whose snapshot was lost, and which this teardown still has no
 * record of having created.
 */
export function fixtureOwnsMembership(snapshot: MembershipOwnershipInput): boolean {
  return (
    !snapshot.memberExistedBefore &&
    snapshot.memberId !== null &&
    (snapshot.memberInsert === "inserted" || snapshot.memberInsert === "pending")
  );
}

// ---------------------------------------------------------------------------
// 3. WHAT A TEARDOWN MAY TOUCH
// ---------------------------------------------------------------------------

/**
 * THE RUN TOKEN, minted once per `playwright test` invocation by the config's
 * `globalSetup` and inherited by every worker and every fixture subprocess.
 *
 * WHY IT EXISTS. The snapshot's exclusive create refuses a SECOND run against the
 * same account, but Playwright still runs the refused run's teardown project. That
 * teardown used to consume the FIRST run's snapshot: it stripped the role, deleted
 * the membership, restored the connection row and then DELETED the snapshot file,
 * while the first run was still using it. The first run's own teardown then found
 * no file, read that as "nothing was ever changed", and printed a verified verdict
 * for a restore it never performed.
 *
 * So a snapshot is stamped at write and a teardown consumes ONLY a snapshot
 * carrying its own token.
 */
export const RUN_TOKEN_ENV = "CINATRA_S9K_RUN_TOKEN";

/** pid plus randomness: unique per run, and legible in the file when one is left behind. */
export function mintRunToken(): string {
  return `${process.pid}-${randomBytes(9).toString("hex")}`;
}

/** The token this process was launched under, or `null` when there is none. */
export function currentRunToken(): string | null {
  const value = process.env[RUN_TOKEN_ENV];
  return value && value.trim() ? value.trim() : null;
}

export type SnapshotClaim =
  /** Written by this run. Restore it. */
  | "own"
  /** Written by a DIFFERENT run, or by one that carried no token. Do not touch it. */
  | "foreign"
  /**
   * There is no token in this environment at all, so the caller is an operator
   * driving `fixtures.mts restore` by hand — the documented recovery route for a
   * run that was killed before its teardown. Proceed: the person asked for it.
   */
  | "untokened";

/**
 * MAY THIS TEARDOWN CONSUME THIS SNAPSHOT? A snapshot with no token, or with
 * somebody else's, is foreign — never a thing to restore from and never a thing
 * to delete.
 */
export function snapshotClaim(
  snapshotToken: string | null | undefined,
  currentToken: string | null,
): SnapshotClaim {
  if (currentToken === null) return "untokened";
  if (!snapshotToken) return "foreign";
  return snapshotToken === currentToken ? "own" : "foreign";
}

/** The verdict a teardown prints instead of `verified` when it restored nothing. */
export const SNAPSHOT_SKIPPED_VERDICT = "skipped: not this run's snapshot";

/**
 * A stable fingerprint of a SEALED secret field, for proving that the value stored
 * now is still the exact value this fixture wrote.
 *
 * It reads the CIPHERTEXT as it was stored — nothing is ever decrypted here.
 * `null` when there is nothing stored.
 *
 * WHAT IT IS COMPUTED OVER, STATED HONESTLY: whatever the row holds. The caller
 * (`fixtures.mts:237`) fingerprints the live `apiKey` on every call, and on an
 * instance whose row already carries an OPERATOR key, that key is what this
 * function is handed — before any write (`:270`), again at teardown (`:439`), and
 * inside the compare-and-swap (`:492`). An earlier version of this comment claimed
 * the fixture's own placeholder was the only input; it never was.
 *
 * THE TRUE REASON A FOREIGN KEY IS SAFE HERE, in three checkable parts:
 *
 *   · NON-CRYPTOGRAPHIC. A pair of 32-bit FNV-1a passes is a change detector, not
 *     a CRYPTOGRAPHIC digest. It is preimage- and collision-trivial by
 *     construction, it is not a password hash, it authenticates nothing and it
 *     guards no boundary, so a foreign key passing through it is not being
 *     "hashed" in any sense a credential store would mean.
 *   · NEVER STORED. `snapshot.openAIKeyFingerprint` starts `null`
 *     (`fixtures.mts:279`) and is assigned in exactly ONE place — inside the
 *     branch that just wrote this file's own published placeholder (`:315`). The
 *     `before.keyStored` arm, the arm an operator key takes, writes nothing at all
 *     (`:301-302`). So a foreign key's fingerprint is computed, compared and
 *     discarded inside one call; it never reaches the snapshot JSON.
 *   · NEVER LOGGED. No `console.log` in `fixtures.mts` carries a fingerprint.
 *
 * The question the value answers is only "is what is stored now byte-identical to
 * what I wrote a few minutes ago?", and both sides of that comparison are produced
 * by this same function inside one run.
 *
 * Running a cryptographic digest over a credential field is the shape
 * `js/insufficient-password-hash` flags, and it flags it whatever the digest —
 * the repo carries a dismissed instance of the same rule over the production
 * credential fingerprint (`src/lib/llm-credential-fingerprint.ts`), which uses an
 * HMAC. A pair of FNV-1a passes says exactly what this needs and makes no claim it cannot
 * keep: the two inputs differ only by a whole re-sealing, so an accidental
 * collision is not a failure mode this can meet, and there is no attacker in the
 * model to engineer one — nobody can choose what this fixture wrote.
 */
export function sealedSecretFingerprint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length === 0) return null;
  // Key-ORDER stable, so a row that survived a JSON round-trip with its fields in
  // a different order is not mistaken for a different stored key.
  const text = stableStringify(value);
  // Two 32-bit FNV-1a passes rather than one 64-bit: the repo's TypeScript target
  // is ES2017, which has no BigInt literals. The second pass runs the string
  // backwards from a different offset basis, so the two are not the same function
  // of the input, and the length is carried alongside both.
  const pass = (offsetBasis: number, reverse: boolean): string => {
    let hash = offsetBasis;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(reverse ? text.length - 1 - i : i);
      hash = Math.imul(hash ^ code, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  return `fnv1a:${pass(0x811c9dc5, false)}${pass(0x9e3779b9, true)}:${text.length}`;
}

export interface ConnectionRevertInput {
  /** Whether `apply` wrote the placeholder key at all. */
  fixtureWroteConnection: boolean;
  /** Whether a connection row existed BEFORE this fixture ran. */
  rowExistedBefore: boolean;
  /** The sealed key's fingerprint read back immediately AFTER the fixture's write. */
  fixtureKeyFingerprint: string | null;
  /** The sealed key's fingerprint as it reads NOW. */
  liveKeyFingerprint: string | null;
  /** The row's non-secret fields read back immediately AFTER the fixture's write. */
  fixtureWroteNonSecret: unknown;
  /** The row's non-secret fields as they read NOW. */
  liveNonSecret: unknown;
}

export type ConnectionRevertPlan =
  /** The row is still exactly the one this fixture created. Remove it. */
  | "delete-row"
  /** The placeholder is still stored but the row is not solely this fixture's. Clear the key only. */
  | "clear-secret"
  /** Nothing of this fixture's is left to revert. Touch nothing. */
  | "leave";

/**
 * WHAT MAY THE RESTORE DO TO THE CONNECTION ROW?
 *
 * The rule: revert only what this fixture itself wrote, decided by comparing the
 * LIVE row against what the fixture wrote — never by replaying a snapshot, and
 * never by deleting on the strength of "the snapshot said there was no row".
 *
 * The two holes this closes, both of which destroyed a developer's own state:
 *
 *   · the snapshot recorded NO row, so the restore deleted the row — including a
 *     connection the developer created DURING the run;
 *   · the restore cleared the secret unconditionally — including a REAL key added
 *     during the run, over the fixture's placeholder.
 *
 * Both are answered by the fingerprint. The placeholder's sealed bytes are read
 * back at write time; if what is stored now is not those exact bytes, the key is
 * somebody else's and the whole row is left alone. Only when the placeholder is
 * still there does anything happen at all, and the row is REMOVED only when its
 * non-secret fields also still read exactly as the fixture left them.
 */
export function connectionRevertPlan(input: ConnectionRevertInput): ConnectionRevertPlan {
  if (!input.fixtureWroteConnection) return "leave";
  // Nothing stored now: the row or the key is already gone by somebody else's hand.
  if (input.liveKeyFingerprint === null) return "leave";
  // The fixture never recorded what it wrote, so it cannot prove the key is its own.
  if (input.fixtureKeyFingerprint === null) return "leave";
  // A different key is stored — a real one, added during the run. Never clear it.
  if (input.liveKeyFingerprint !== input.fixtureKeyFingerprint) return "leave";
  if (!input.rowExistedBefore && sameJson(input.liveNonSecret, input.fixtureWroteNonSecret)) {
    return "delete-row";
  }
  return "clear-secret";
}

export interface McpRevertInput {
  /** Whether `apply` wrote the origin at all. */
  mcpWritten: boolean;
  /** The origin and its source read back immediately AFTER the fixture's write. */
  fixtureWrote: { publicBaseUrl: string | null; publicBaseUrlSource: string } | null;
  /** The origin and its source as they read NOW. */
  live: { publicBaseUrl: string | null; publicBaseUrlSource: string };
}

/**
 * WHAT MAY THE RESTORE DO TO THE MCP ORIGIN PAIR? The same rule: put the snapshot
 * back only while the row still holds exactly what this fixture wrote. An origin
 * changed during the run belongs to whoever changed it.
 */
export function mcpRevertPlan(input: McpRevertInput): "restore" | "leave" {
  if (!input.mcpWritten) return "leave";
  if (!input.fixtureWrote) return "leave";
  if (input.live.publicBaseUrl !== input.fixtureWrote.publicBaseUrl) return "leave";
  if (input.live.publicBaseUrlSource !== input.fixtureWrote.publicBaseUrlSource) return "leave";
  return "restore";
}

// ---------------------------------------------------------------------------
// 4. HOW MANY QUEUE JOBS NAME A RUN
// ---------------------------------------------------------------------------

/**
 * EVERY STATE BULLMQ CAN HOLD A JOB IN, so no state is a blind spot.
 *
 * This is BullMQ's own definition of "all types": it is exactly the list
 * `QueueGetters.sanitizeJobTypes()` falls back to when `getJobs()` is called with
 * no argument (`bullmq/dist/esm/classes/queue-getters.js:53-62`). It is written
 * out rather than left implicit because an implicit sweep cannot be asserted, and
 * the whole point of this rule is that the count has no hiding place.
 *
 * `repeat` and `wait` are the two `JobType`s deliberately NOT here. `repeat` names
 * the repeat-scheduler key set rather than jobs, and `wait` is BullMQ's alias for
 * `waiting`, so asking for both would fetch one list twice.
 */
export const JOB_STATES_NAMING_RUN = [
  "waiting",
  "waiting-children",
  "prioritized",
  "paused",
  "active",
  "delayed",
  "completed",
  "failed",
] as const;

export type JobStateNamingRun = (typeof JOB_STATES_NAMING_RUN)[number];

/** The only three fields of a BullMQ job this rule reads. */
export interface QueueJobNamingRun {
  id?: string | null;
  name?: string | null;
  data?: unknown;
}

/**
 * THE ONE JOB NAME THAT IS AN EXECUTION DISPATCH OF A RUN.
 *
 * Carrying `runId` in the payload is NOT the same as dispatching the run for
 * execution, and the difference decides whether "exactly one" means anything.
 * Exactly three registered job names carry a `runId`
 * (`src/lib/background-jobs-registry.ts:1358`, `:1453`, `:2025`), and only one of
 * them is the thing this invariant counts:
 *
 *   · `agent-builder-execution` — the run-lifecycle worker. THE EXECUTION
 *     DISPATCH, and what `triggerAgentRun` enqueues (`run-actions.ts:200-208`).
 *     Two of these for one run IS the duplicate dispatch #2824 is about.
 *   · `agent-run-trigger-release` — NOT counted, though it is dispatch-adjacent.
 *     It opens the gate and then enqueues the execution job itself
 *     (`trigger-release-job.ts:302`), so on the trigger path the release and the
 *     execution are TWO jobs for ONE correct dispatch. With `removeOnComplete:
 *     200` the finished release job is still retained, so counting it would read
 *     `2` on a run dispatched exactly once and turn a correct flow red.
 *   · `unbound-output-derive` — NOT counted. Post-run output derivation
 *     (`execution.ts:1874-1886`, payload `{ runId, orgId }`), which runs AFTER the
 *     run produced output and legitimately coexists with a retained execution job.
 *
 * So the rule counts EXECUTION dispatches, and the two neighbours are excluded for
 * the same reason: each can stand beside a correct single dispatch. A job whose
 * name is unknown is not counted either, which is the conservative reading for an
 * "exactly one" assertion. The arm that keeps that from becoming a new blind spot
 * is in the unit tier, where a ratchet pins BOTH this list and the registry's total
 * count of runId-bearing payload schemas — so a fourth such job turns it red and
 * forces the choice rather than silently landing in a bucket.
 */
export const RUN_DISPATCH_JOB_NAMES = ["agent-builder-execution"] as const;

/**
 * Is this job an EXECUTION DISPATCH OF THIS RUN?
 *
 * Two questions, both of which have to answer yes.
 *
 * THE RUN: read from the PAYLOAD, not from the job id. Every enqueue site that
 * dispatches a run writes `{ runId }` into `data`, and the registry's payload
 * schemas require it (`src/lib/background-jobs-registry.ts:1358`, `:1454`), while
 * the ID each site chooses varies: `runId` bare (`run-actions.ts:208`),
 * `agent-builder-${runId}` (`trigger-service.ts:400`, `trigger-release-job.ts:302`),
 * `resume-${reviewTaskId}` (`review-task-actions.ts:464`). The payload is the one
 * thing all of them agree on, so it is what the count asks about.
 *
 * THE OPERATION: read from the job NAME, because naming the run is not the same as
 * dispatching it for execution. Both `agent-run-trigger-release` and
 * `unbound-output-derive` carry this very run's id while standing beside a single
 * correct dispatch, so counting either would report a correct run as a duplicate.
 * `RUN_DISPATCH_JOB_NAMES` above names the one that qualifies, says why each
 * neighbour is excluded, and explains how the list is kept honest.
 */
export function jobDispatchesRun(
  job: QueueJobNamingRun | null | undefined,
  runId: string,
): boolean {
  if (!job || !runId) return false;
  if (!job.name || !(RUN_DISPATCH_JOB_NAMES as readonly string[]).includes(job.name)) return false;
  const data = job.data;
  if (!data || typeof data !== "object") return false;
  return (data as { runId?: unknown }).runId === runId;
}

/**
 * HOW MANY EXECUTION DISPATCHES NAME THIS RUN, the number #2824 is actually about.
 * NOT a queue total, which counts every other run on the lane and answers nothing,
 * and not every job carrying this run's id either — see `RUN_DISPATCH_JOB_NAMES`
 * for the two runId-bearing neighbours that stand beside a correct dispatch.
 *
 * WHY THIS COUNTS INSTEAD OF PROBING FOR ONE ID. The previous spelling was
 * `queue.getJob(runId)` converted to `0 | 1`. That answers "is a job addressable
 * by the run id there?", which is a DIFFERENT question from "how many jobs name
 * this run?", and the gap between them is exactly the defect this suite exists to
 * catch: a second job carrying the same `data.runId` under any other id was
 * invisible to it, so a duplicate dispatch read as the clean `1`. The enqueue
 * sites listed on `jobDispatchesRun` above show that is not hypothetical, because
 * most of them do not use the bare run id.
 *
 * DEDUPED BY JOB ID, as DEFENCE rather than as a fix for a live defect, and the
 * difference is worth stating so the next reader does not trust the wrong thing.
 * BullMQ 5.80.1 already cannot hand back one job twice: `getRanges` reads every
 * requested state in ONE atomic Lua call and returns `[...new Set(results)]`
 * (`bullmq/dist/esm/classes/queue-getters.js:356-379`), so there is no window in
 * which a job moving `waiting` to `active` is seen by two separate fetches. This
 * loop therefore never fires today.
 *
 * It is kept because the count must not INHERIT that guarantee. If a future BullMQ
 * drops the `Set` or splits the read, the raw array would report `2` for a single
 * job and turn the released invariant red on timing rather than on truth — a flake
 * introduced by this fix instead of found by it. The dedup makes the number depend
 * on the rule rather than on the client's internals.
 *
 * `Job.fromId` resolves to `undefined` for a job removed between the id read and
 * the fetch (`queue-getters.js:388-392`), so holes are dropped before counting.
 *
 * WHAT THIS STILL CANNOT SEE, stated rather than papered over: a job already
 * trimmed out of the completed or failed tails (`removeOnComplete: 200`,
 * `removeOnFail: 500`, `src/lib/background-jobs.ts:383-387`). The suite's queue is
 * its own, because `BULLMQ_QUEUE_NAME` is REQUIRED and the probes refuse a shared
 * default, so reaching either tail inside one flow's decision window is not a
 * shape this measurement meets. It is the same exposure the id probe had.
 *
 * The queue arrives as a FETCHER rather than as a client, which is what keeps this
 * file pure: no `bullmq` import, no connection, no environment. The live probe
 * (`probes.ts`) and the unit tier (`__tests__/state-rules.test.ts`) therefore run
 * this exact function over the exact same state list, and differ only in where the
 * jobs come from.
 */
export async function countJobsNamingRun(
  fetchJobs: (
    states: readonly JobStateNamingRun[],
  ) => Promise<readonly (QueueJobNamingRun | null | undefined)[]>,
  runId: string,
): Promise<number> {
  const jobs = await fetchJobs(JOB_STATES_NAMING_RUN);
  const seen = new Set<string>();
  let count = 0;
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    if (!jobDispatchesRun(job, runId)) continue;
    // A job with no id cannot be deduped against anything, so it counts once on
    // its own. BullMQ always assigns one; this is the arm that keeps a malformed
    // entry from silently collapsing two jobs into one.
    const key = job!.id == null ? `no-id:${i}` : `id:${job!.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

/**
 * What a count means for an invariant that expects EXACTLY `expected`.
 *
 * `over` is the arm worth naming separately. Both invariants are polled until they
 * hold, so a caller that waits on `over` waits out its whole timeout and then
 * reports a timeout, when what it found was a duplicate dispatch. The verdict lets
 * it say so instead.
 *
 * Not because an over-count is permanent — a job can be removed, and the completed
 * and failed tails are trimmed, so the number can fall again. Because the EVENT is:
 * a run observed with two EXECUTION jobs was dispatched for execution twice, and a
 * later reading of `1` does not undo that. The two runId-bearing neighbours that
 * could make that reading innocent are excluded by name before the count, so a `2`
 * here is two of the same operation.
 */
export function jobCountVerdict(count: number, expected: number): "ok" | "under" | "over" {
  if (count === expected) return "ok";
  return count > expected ? "over" : "under";
}

/** Structural equality over plain JSON, with object keys ordered so spelling cannot decide it. */
export function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
