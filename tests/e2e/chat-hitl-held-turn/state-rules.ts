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
//   4. WHAT COUNTS AS A QUEUE JOB THAT NAMES THE RUN — the rule behind the
//      suite's headline invariant ("nothing queued while it is held, exactly one
//      job after the decision"), separated from the Redis client so it can be
//      run and refuted without one.
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
 * IDENTITY so a row it made can always be recognized.
 *
 * BOTH HALVES IN FULL, and that is the whole change here. The earlier spelling
 * kept only the first eight characters of each identifier, which is a real
 * collision: two distinct `(organizationId, userId)` pairs that happen to share
 * those prefixes mint the SAME primary key, and the insert then fails on the id
 * — outside the `("organizationId", "userId")` conflict target it names, so the
 * do-nothing arm never runs and the setup dies on a unique violation.
 *
 * Carrying both identifiers whole removes that: two distinct pairs can only mint
 * the same id if one identifier contains the `::` separator and splits exactly
 * there. No claim is made that the id is the arbiter of anything — the unique
 * index on the PAIR is, on both the read and the insert side, and this id is
 * only ever the one this fixture MINTS for a row it is about to create.
 */
export function memberIdFor(userId: string, organizationId: string): string {
  return `chat-hitl-s9k-member-${userId}::${organizationId}`;
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
 * WHAT IT IS COMPUTED OVER, stated correctly. This function is handed whatever
 * the row holds, including a key this fixture did not write: the caller reads the
 * live row before it writes anything (`fixtures.mts`, `readNonSecretConnection`).
 * What makes that safe is not that the value is always the fixture's own — it is
 * that the derived value is a 64-bit NON-CRYPTOGRAPHIC change detector that is
 * never logged, and that the only fingerprint ever persisted into the snapshot is
 * the one taken after the fixture wrote its OWN published placeholder.
 *
 * A CHANGE DETECTOR, DELIBERATELY NOT A CRYPTOGRAPHIC HASH. The question it
 * answers is "is what is stored now byte-identical to what I wrote a few minutes
 * ago?", and both sides of that comparison are produced by this same function
 * inside one run. It is not a security control: it authenticates nothing, guards
 * no boundary, and carries no credential material — the placeholder's own
 * fingerprint is written into the snapshot file, and nothing else's ever is.
 *
 * Running a cryptographic digest over a credential field is also the shape
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

// ---------------------------------------------------------------------------
// 4. WHICH QUEUE JOBS NAME THE RUN
// ---------------------------------------------------------------------------

/**
 * THE STATES A JOB THAT NAMES THIS RUN CAN BE SITTING IN.
 *
 * A dispatch is a dispatch whatever happened to it afterwards: a duplicate that
 * already ran, or already failed, dispatched the run just as surely as one still
 * waiting. So the scan is the whole lifecycle rather than the pending states —
 * anything narrower would let the second dispatch this rule exists to catch hide
 * in `completed` a second after it was added.
 */
export const QUEUE_STATES_NAMING_A_RUN = [
  "waiting",
  "waiting-children",
  "prioritized",
  "delayed",
  "paused",
  "active",
  "completed",
  "failed",
] as const;

/** A queue job, reduced to the two fields this rule reads. */
export interface QueueJobIdentity {
  /** The job id BullMQ addresses it by. */
  id: string | null | undefined;
  /** The job's payload, as stored. */
  data: unknown;
}

/**
 * DOES THIS JOB NAME THE RUN?
 *
 * THE DEFECT THIS REPLACES: the earlier probe asked `queue.getJob(runId)` and
 * turned existence into `0 | 1`. The release path enqueues with `jobId = runId`,
 * so that answered "is there a job ADDRESSABLE BY THIS ID" — and a second job
 * added under any other id, carrying the same `runId` in its payload, is
 * invisible to it. That is precisely the duplicate dispatch a gate sold as
 * "exactly one job names this run" exists to catch, so the measurement is now the
 * sentence: the PAYLOAD is read, across every state, and the id is only one of
 * the two ways a job can name the run.
 *
 * The id arm is kept as a UNION, not a replacement: a build that enqueued with
 * `jobId = runId` and an empty payload would otherwise read as zero jobs and hang
 * the released invariant instead of failing it. Counting either way can only
 * over-count, never under-count — and over-counting is the safe direction for
 * both arms of this suite ("0 while held" gets stricter, "exactly 1 after" gets
 * stricter).
 */
export function jobNamesRun(job: QueueJobIdentity, runId: string): boolean {
  if (typeof job.id === "string" && job.id === runId) return true;
  const data = job.data;
  if (!data || typeof data !== "object") return false;
  const named = (data as { runId?: unknown }).runId;
  return typeof named === "string" && named === runId;
}

/**
 * HOW MANY DISTINCT JOBS NAME THE RUN.
 *
 * De-duplicated by job id, because a job matching on BOTH arms above is still one
 * job — and because `getJobs` over overlapping state sets can return the same job
 * twice. A job with no id at all is counted as its own, since nothing else can
 * identify it.
 */
export function countJobsNamingRun(jobs: readonly QueueJobIdentity[], runId: string): number {
  const seen = new Set<string>();
  let unidentified = 0;
  for (const job of jobs) {
    if (!jobNamesRun(job, runId)) continue;
    if (typeof job.id === "string" && job.id.length > 0) seen.add(job.id);
    else unidentified += 1;
  }
  return seen.size + unidentified;
}

/**
 * THE NEGATIVE CONTROL'S JOB NAME AND ID.
 *
 * The flow adds one job under a DIFFERENT id carrying the same `runId`, proves
 * the count moves 1 -> 2, and removes it again. Without that arm "exactly one"
 * is an assertion nobody has watched fail.
 *
 * The name is deliberately NOT a registered background-job name, and the control
 * is added with a long delay and removed inside the same step: it must be
 * COUNTABLE and never RUNNABLE, because a control job that actually executed
 * would dispatch the run a second time — the very defect being measured.
 */
export const DUPLICATE_DISPATCH_CONTROL_JOB_NAME = "chat-hitl-s9k-duplicate-dispatch-control";
/**
 * Its id — anything other than the run id, which is the whole point of the control.
 *
 * NO COLON. BullMQ refuses a custom job id containing `:` outright ("Custom Id
 * cannot contain :"), which is a runtime error, not a type error — the first
 * spelling of this control used one and the flow died on it after the release
 * invariant had already passed. The unit arm pins the constraint.
 */
export function duplicateDispatchControlJobId(runId: string): string {
  return `${DUPLICATE_DISPATCH_CONTROL_JOB_NAME}__${runId}`;
}
/** Far enough out that the control can never become runnable inside a suite run. */
export const DUPLICATE_DISPATCH_CONTROL_DELAY_MS = 60 * 60_000;
