// THE ACCOUNT CHANGES, SNAPSHOTTED AND PUT BACK (chat-hitl S9k, cinatra#2824).
//
// `auth.setup.ts` does two things to an IDENTITY so the dispatch can happen at
// all: it appends `admin` to the account's Better Auth role string, and it makes
// that account an `owner` of the organization that owns the agent. Both are
// PERMANENT PRIVILEGE GRANTS on a row this suite did not create the meaning of.
//
// WHY THAT MATTERS MORE THAN AN ORDINARY FIXTURE. The account is chosen by
// `E2E_CHAT_HITL_USER_EMAIL`, so a developer who points this suite at an account
// they already use gets, permanently and silently, a platform admin and an owner
// membership they never asked for. The instance CONFIGURATION this suite touches
// is already snapshotted and restored (`fixtures.mts`); the identity was not.
//
// So the same discipline applies here, for the same reasons:
//
//   · READ FIRST, WRITE SECOND. The snapshot is persisted BEFORE the first
//     mutation, so a crash halfway through setup still leaves the teardown
//     something to put back.
//   · UNDO THE CHANGE, DO NOT REPLAY THE ROW. The role string is recorded
//     VERBATIM, and the restore strips `admin` from whatever the column holds at
//     teardown time rather than writing the snapshot back over it. That leaves a
//     role somebody else granted mid-run standing; a verbatim replay would
//     silently revoke it under a passing verdict. With no concurrent write the two
//     agree exactly. An account that ALREADY carried `admin` recorded
//     `roleChanged: false` and is not written at all — blindly stripping `admin`
//     on the reuse path would remove a grant this suite never made. Where the two
//     readings of "undo" diverge — a concurrent grant of `admin` ITSELF — the
//     restore strips it anyway; see the rationale at the write.
//   · ONLY WHAT THIS FIXTURE CHANGED IS RESTORED, AND ONLY THAT IS ASSERTED. A
//     membership row that was already there is neither deleted nor compared: this
//     suite neither created nor moved it, and asserting a value for somebody
//     else's row would red on their concurrent write.
//   · READ IT BACK. Calling the writers proves the calls were made, not that the
//     account is back where it started — which is the whole claim.
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "pg";

import { DATABASE_URL } from "./probes";

/** Beside the storage state, under the suite's own `.auth/`, which `.gitignore` covers. */
export const ACCOUNT_SNAPSHOT_PATH = resolve(
  __dirname,
  ".auth",
  "account-state.snapshot.json",
);

/**
 * The membership row id `auth.setup.ts` inserts, derived ONCE here so the setup
 * that creates it and the teardown that removes it can never spell it differently.
 */
export function memberIdFor(userId: string): string {
  return `chat-hitl-s9k-member-${userId.slice(0, 8)}`;
}

export interface AccountSnapshot {
  userId: string;
  email: string;
  /** The role string EXACTLY as stored before the promotion, `null` included. */
  role: string | null;
  /**
   * Whether the promotion actually changes it. Decided from the PRE-READ rather
   * than from the update's outcome, so there is no window: an account that
   * already carries `admin` records `false` here and is never written or restored.
   */
  roleChanged: boolean;
  /** Filled in once the agent's owning organization is known. */
  organizationId: string | null;
  memberId: string | null;
  /**
   * Whether the membership row was ALREADY there — read BEFORE the insert, not
   * derived from it. Deriving it afterwards would leave a window in which a crash
   * strands a row the teardown believes it never created.
   */
  memberExistedBefore: boolean;
  /**
   * HOW FAR THE INSERT GOT, as an explicit state rather than an inference. Each
   * value answers "may this teardown delete the row?" on its own — the same
   * ownership question, and the same answer shape, `fixtures.mts` records for the
   * assigned-skill row:
   *
   *   not_attempted   — never reached. Any row present now is somebody else's.
   *   pending         — written immediately BEFORE the insert, so it is the state
   *                     a crash inside the insert leaves. The row may exist
   *                     because of this fixture, so delete it.
   *   inserted        — this fixture created the row. Delete.
   *   already_present — the conflict arm took it. Never delete.
   */
  memberInsert: "not_attempted" | "pending" | "inserted" | "already_present";
}

/**
 * Write the snapshot. `claim` makes it an EXCLUSIVE CREATE.
 *
 * The first write is the one that claims the account, and it uses the `wx` flag —
 * `O_CREAT | O_EXCL`, which the kernel decides atomically. A "does it exist?" check
 * followed by a write would leave a window in which two runs both see no file and
 * then overwrite each other, which is the exact race the claim exists to stop. The
 * later writes are the SAME run refining its own record, so they overwrite.
 */
function persist(snapshot: AccountSnapshot, { claim = false } = {}): void {
  mkdirSync(dirname(ACCOUNT_SNAPSHOT_PATH), { recursive: true });
  writeFileSync(ACCOUNT_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, {
    flag: claim ? "wx" : "w",
  });
}

function newClient(): Client {
  return new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
}

/** Better Auth comma-splits the role string; the platform-admin check looks for `admin`. */
function carriesAdmin(role: string | null): boolean {
  if (!role) return false;
  return role.split(",").some((part) => part.trim() === "admin");
}

/** `null` and `""` both mean "no roles"; a restore must not red on the difference. */
function sameRole(a: string | null, b: string | null): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

/**
 * Record the account's PRE-MUTATION state and persist it, BEFORE the first write.
 *
 * Called with the user row already created by the shipped sign-up and the role
 * still untouched. The membership half is not known yet — the organization is
 * looked up from the template afterwards — so it is recorded by
 * `recordMemberInsert` below, which persists again each time it learns more.
 *
 * AN EXISTING SNAPSHOT IS A HARD STOP, NEVER A THING TO OVERWRITE. The file is
 * the ONLY record of some other run's pre-mutation state, and that run's grants
 * are still live until its teardown consumes it. Clobbering it stranded the
 * grants permanently, by a route with no red anywhere:
 *
 *   run A snapshots `role = "user"` and promotes the account;
 *   run B snapshots the ALREADY-promoted account, records `roleChanged: false`,
 *     restores nothing (correctly), and deletes the shared file;
 *   run A's teardown finds no file, reads that as "never changed", and prints
 *     `account restore verified` over an account that is still an admin.
 *
 * So a snapshot that is already there fails LOUDLY and names the file. Both
 * causes are worth stopping for: a concurrent run against the same account, or a
 * previous run that was killed before its teardown — and in the second case the
 * file is exactly the thing needed to put that account back, so destroying it is
 * the one move that cannot be undone.
 */
export async function snapshotAccountState(
  c: Client,
  userId: string,
  email: string,
): Promise<AccountSnapshot> {
  const r = await c.query<{ role: string | null }>(
    `SELECT role FROM public."user" WHERE id = $1 LIMIT 1`,
    [userId],
  );
  if (!r.rowCount) throw new Error(`account-state: no user row to snapshot for ${email}`);
  const role = r.rows[0]!.role;
  const snapshot: AccountSnapshot = {
    userId,
    email,
    role,
    roleChanged: !carriesAdmin(role),
    organizationId: null,
    memberId: null,
    memberExistedBefore: false,
    memberInsert: "not_attempted",
  };
  try {
    persist(snapshot, { claim: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(
        `account-state: a snapshot is already present at ${ACCOUNT_SNAPSHOT_PATH}, so this run ` +
          "will not start. It records an account this suite has ALREADY escalated and not yet " +
          "put back — either another run is in flight against the same account, or a previous " +
          "run was killed before its teardown. Overwriting it would strand the platform-admin " +
          "role and the owner membership it describes, with nothing left to restore them from. " +
          "Run the restore teardown, or inspect that file and undo the grants it names, then " +
          "delete it.",
      );
    }
    throw err;
  }
  return snapshot;
}

/** Claim the insert's crash window BEFORE entering it, then persist. */
export async function markMemberInsertPending(
  c: Client,
  snapshot: AccountSnapshot,
  organizationId: string,
): Promise<void> {
  const memberId = memberIdFor(snapshot.userId);
  const existing = await c.query(`SELECT 1 FROM public."member" WHERE id = $1 LIMIT 1`, [
    memberId,
  ]);
  snapshot.organizationId = organizationId;
  snapshot.memberId = memberId;
  snapshot.memberExistedBefore = (existing.rowCount ?? 0) > 0;
  snapshot.memberInsert = "pending";
  persist(snapshot);
}

/** Record what the insert actually did, then persist. */
export function recordMemberInsert(
  snapshot: AccountSnapshot,
  outcome: "inserted" | "already_present",
): void {
  snapshot.memberInsert = outcome;
  persist(snapshot);
}

/** Whether the teardown may remove the membership row — see `memberInsert`. */
function fixtureOwnsMembership(snapshot: AccountSnapshot): boolean {
  return (
    !snapshot.memberExistedBefore &&
    snapshot.memberId !== null &&
    (snapshot.memberInsert === "inserted" || snapshot.memberInsert === "pending")
  );
}

/**
 * PUT THE ACCOUNT BACK, AND PROVE IT.
 *
 * Restores only what the snapshot recorded as CHANGED, re-reads both halves, and
 * names every mismatch. Prints `account restore verified` only when the read-back
 * matched — the same contract `fixtures.mts restore` holds for the instance
 * configuration, so `restore.teardown.ts` can assert a verdict rather than an
 * exit code.
 *
 * A MISSING SNAPSHOT IS BENIGN, and only because the snapshot is written before
 * the first mutation: no file means the account was never touched. Any OTHER read
 * or parse failure means a snapshot exists and cannot be read, so the account may
 * still carry the grants with nothing to guide the restore — that fails loudly
 * rather than printing a verdict it did not earn.
 */
export async function restoreAccountState(): Promise<string> {
  const lines: string[] = [];
  let snapshot: AccountSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(ACCOUNT_SNAPSHOT_PATH, "utf-8")) as AccountSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "[account] no snapshot — the account was never changed, nothing to restore\naccount restore verified";
    }
    throw new Error(
      `account-state: the snapshot at ${ACCOUNT_SNAPSHOT_PATH} exists but could not be read — ` +
        "the account may still carry the platform-admin role and the owner membership this " +
        `suite granted, and this teardown cannot undo them: ${String(err)}`,
    );
  }

  const owns = fixtureOwnsMembership(snapshot);
  const c = newClient();
  await c.connect();
  const mismatches: string[] = [];
  /**
   * What the role column SHOULD read after the restore: the live value with this
   * suite's one `admin` token dropped. Computed by the write below so the
   * read-back asserts what was actually asked for, not the snapshot — those differ
   * exactly when somebody else changed the role mid-run, which is the case the
   * restore is deliberately carrying forward rather than erasing.
   */
  let expectedRole: string | null = snapshot.role;
  try {
    // (1) THE ROLE STRING. Only when this suite moved it: an account that already
    //     carried `admin` recorded `roleChanged: false`, and stripping it here
    //     would revoke a grant this suite never made.
    //
    //     The write REMOVES THE `admin` TOKEN, computed from the value the column
    //     holds NOW rather than replaying the snapshot over it. A role granted by
    //     somebody else while the suite ran survives; with no concurrent write the
    //     result is the snapshot exactly.
    //
    //     IT REMOVES EVERY `admin` TOKEN, NOT "the one this suite added", and that
    //     is deliberate. The two differ only if somebody ALSO granted `admin`
    //     during the run, and then no rule can tell the tokens apart. The snapshot
    //     proves the account did not carry `admin` before this suite ran, so the
    //     choice is between possibly dropping a grant made in that window and
    //     possibly leaving a platform admin this suite created. This suite exists
    //     to guarantee the second never happens, so it takes the first. The
    //     read-back asserts no `admin` survives, which is that guarantee.
    if (snapshot.roleChanged) {
      // ONE STATEMENT, so there is no read-then-write window for a concurrent
      // role edit to fall into: the new value is computed FROM the column inside
      // the same UPDATE, and `RETURNING` hands back exactly what was stored.
      //
      // Kept tokens are returned VERBATIM — `btrim` is used only to compare, so a
      // role somebody else spelled `" editor"` is not silently reformatted.
      // `NULLIF(..., '')` restores the column's own unset state rather than `""`.
      const updated = await c.query<{ role: string | null }>(
        `UPDATE public."user"
            SET role = NULLIF(
                  array_to_string(
                    ARRAY(
                      SELECT t FROM unnest(string_to_array(role, ',')) AS t
                       WHERE btrim(t) <> 'admin'
                    ), ','
                  ), '')
          WHERE id = $1
        RETURNING role`,
        [snapshot.userId],
      );
      if (updated.rowCount) expectedRole = updated.rows[0]!.role;
    }

    // (2) THE MEMBERSHIP, removed ONLY when this fixture is the reason it is
    //     there. Every other state belongs to somebody else.
    if (owns) {
      await c.query(`DELETE FROM public."member" WHERE id = $1`, [snapshot.memberId]);
    }

    // (3) READ BOTH BACK. Only the halves the snapshot recorded as CHANGED are
    //     asserted: a role this suite never wrote, or a membership row it never
    //     created, would otherwise red on somebody else's concurrent write.
    if (snapshot.roleChanged) {
      const r = await c.query<{ role: string | null }>(
        `SELECT role FROM public."user" WHERE id = $1 LIMIT 1`,
        [snapshot.userId],
      );
      if (!r.rowCount) {
        mismatches.push(
          `public."user" row ${snapshot.userId} (${snapshot.email}) is gone, so this teardown ` +
            "cannot prove it put back the role string it changed",
        );
      } else if (!sameRole(r.rows[0]!.role, expectedRole)) {
        mismatches.push(
          `public."user".role for ${snapshot.email}: expected ${JSON.stringify(expectedRole)}, ` +
            `read ${JSON.stringify(r.rows[0]!.role)}`,
        );
      } else if (carriesAdmin(r.rows[0]!.role)) {
        // The token this suite added must be GONE, whatever else the string now
        // holds. Belt and braces: it catches a promotion that appended `admin`
        // more than once, which the expected-value compare alone would accept.
        mismatches.push(
          `public."user".role for ${snapshot.email} still carries admin after the restore: ` +
            `${JSON.stringify(r.rows[0]!.role)}`,
        );
      }
    }
    if (owns) {
      const m = await c.query(`SELECT 1 FROM public."member" WHERE id = $1 LIMIT 1`, [
        snapshot.memberId,
      ]);
      if ((m.rowCount ?? 0) > 0) {
        mismatches.push(
          `public."member" row ${snapshot.memberId} is still present although this fixture ` +
            "created it",
        );
      }
    }
  } finally {
    await c.end();
  }

  if (mismatches.length > 0) {
    throw new Error(
      "account-state: the account was NOT restored to the state the suite found it in — " +
        mismatches.join("; "),
    );
  }

  lines.push(
    `[account] restored: role=${
      snapshot.roleChanged
        ? `admin token removed -> ${JSON.stringify(expectedRole)}${
            sameRole(expectedRole, snapshot.role)
              ? ""
              : ` (snapshot was ${JSON.stringify(snapshot.role)}; a concurrent role change was carried forward)`
          }`
        : "never changed"
    }, membership=${owns ? "removed" : "not this fixture's, kept"}`,
  );
  rmSync(ACCOUNT_SNAPSHOT_PATH, { force: true });
  lines.push("account restore verified");
  return lines.join("\n");
}
