// THE RULES, RE-RUNNABLE BY A READER (chat-hitl S9k, cinatra#2824).
//
// The held-turn flow itself needs a live stack, so nothing it decides can be
// re-run from a checkout. The DECISIONS behind its setup and its teardown do not:
// they live in `state-rules.ts`, they are pure, and this file runs them. It needs
// no database, no browser, no Playwright and no stack, and it rides the root
// vitest suite (`pnpm test:root`), which is the gate of record.
//
// WHAT IS COVERED HERE, AND WHAT IS NOT. Two kinds of arm, kept apart on purpose:
//
//   · BEHAVIOURAL — the pure rules are called and their answers asserted. Every
//     hazard the 2026-08-22 review named is expressed as an input that used to
//     produce the destructive answer.
//   · TEXT-LEVEL DRIFT RATCHETS — three of the defects were in SQL, and no unit
//     test can execute SQL without a Postgres. Those arms read the suite's own
//     source and pin the shape of the statement (the conflict target, the
//     identity predicate, the absence of a second `admin` spelling). They are
//     ratchets against a regression, NOT proof that the statement runs — that
//     proof is the suite itself, against a live instance.
//
// THE QUEUE COUNT IS BEHAVIOURAL HERE TOO, and that is worth being precise about,
// because "exactly one queue job names this run" sounds like it needs a Redis.
// It does not: `countJobsNamingRun` takes the queue as a FETCHER, so the live
// probe and the arms below run the SAME function over the SAME state list and
// differ only in where the jobs come from. The negative control — a second job
// enqueued under a different id, carrying the same `data.runId` — therefore
// exercises the shipped decision itself rather than a re-implementation of it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  JOB_STATES_NAMING_RUN,
  MEMBER_IDENTITY_SQL,
  RUN_DISPATCH_JOB_NAMES,
  PROMOTE_ADMIN_ROLE_SQL,
  ROLE_TOKENS_SQL,
  ROLE_TOKEN_TRIMMED_SQL,
  SNAPSHOT_SKIPPED_VERDICT,
  STRIP_ADMIN_ROLE_SQL,
  connectionRevertPlan,
  countJobsNamingRun,
  fixtureOwnsMembership,
  jobCountVerdict,
  mcpRevertPlan,
  memberIdFor,
  mintRunToken,
  roleCarriesAdmin,
  sealedSecretFingerprint,
  snapshotClaim,
} from "../state-rules";
import type { JobStateNamingRun, QueueJobNamingRun } from "../state-rules";

const SUITE_DIR = resolve(__dirname, "..");
const read = (file: string): string => readFileSync(resolve(SUITE_DIR, file), "utf-8");
/** Collapse whitespace, so a re-indent or a line wrap cannot break a shape assertion. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

/**
 * The same source with its COMMENTS removed.
 *
 * A ratchet that forbids a call has to read code, not prose. These files document
 * the defects they were fixed for by NAMING the old spelling — `probes.ts` says in
 * so many words that it used to ask `queue.getJob(runId)` — and that sentence is
 * the most useful line in the file for the next reader. Matching it as though it
 * were a live call would force the fix and its own explanation to be mutually
 * exclusive, so the reader would lose.
 *
 * Block comments go whole; only WHOLE-LINE `//` comments go, which leaves a `//`
 * inside a string literal (a URL, say) alone.
 */
const code = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

// ---------------------------------------------------------------------------
// Finding 2 — ONE predicate decides "does this account already carry admin"
// ---------------------------------------------------------------------------

describe("roleCarriesAdmin — the one predicate", () => {
  // THE PINNED SHAPES. `" admin"` and `" admin,editor"` are the exact strings on
  // which the two previous spellings disagreed: the write side's comma-split saw
  // no `admin` and appended a duplicate token, while the restore side's
  // trim-each-token saw one and recorded `roleChanged: false`, so the restore
  // never ran and never asserted. The account kept a permanently duplicated token
  // on a run reported as having changed nothing.
  it.each([
    [null, false],
    [undefined, false],
    ["", false],
    ["   ", false],
    ["admin", true],
    ["user,admin", true],
    ["user, admin", true],
    [" admin", true],
    ["admin ", true],
    [" admin,editor", true],
    ["editor, admin ,user", true],
    ["administrator", false],
    ["adminx", false],
    ["superadmin", false],
    ["user,editor", false],
    // The vertical tab is trimmed on BOTH sides; the LETTER `v` never is. An
    // earlier draft spelled the SQL set `E'…\v'`, and PostgreSQL escape strings
    // do not define `\v` — an unknown escape resolves to the bare character, so
    // that asked Postgres to trim `v` and would have read `"vadmin"` as `admin`.
    ["\u000badmin", true],
    ["vadmin", false],
    ["admin\u000b", true],
    // JS `trim()` also strips Unicode spaces; this set deliberately does not, so
    // the two languages agree exactly. A Unicode-padded token reads as "no admin"
    // on both sides, which promotes and then strips — a clean round trip.
    ["\u00a0admin", false],
  ])("%o carries admin: %s", (role, expected) => {
    expect(roleCarriesAdmin(role as string | null | undefined)).toBe(expected);
  });

  it("the promote and the strip are built from the SAME token expression", () => {
    // One fragment, used by both statements: they cannot split a role string
    // differently from each other, or from `roleCarriesAdmin` above.
    expect(PROMOTE_ADMIN_ROLE_SQL).toContain(ROLE_TOKENS_SQL);
    expect(STRIP_ADMIN_ROLE_SQL).toContain(ROLE_TOKENS_SQL);
    expect(PROMOTE_ADMIN_ROLE_SQL).toContain(`${ROLE_TOKEN_TRIMMED_SQL} = 'admin'`);
    expect(STRIP_ADMIN_ROLE_SQL).toContain(`${ROLE_TOKEN_TRIMMED_SQL} <> 'admin'`);
    // A bare `btrim(t)` strips spaces only, so it disagreed with JS `trim()` on a
    // tab-padded token. Neither statement may fall back to it.
    expect(PROMOTE_ADMIN_ROLE_SQL).not.toContain("btrim(t)");
    expect(STRIP_ADMIN_ROLE_SQL).not.toContain("btrim(t)");
    // The vertical tab must be a hex escape. `E'\v'` is an UNDEFINED PostgreSQL
    // escape and resolves to the letter `v`, which would trim `"vadmin"`.
    // Built from the same character set the JS trim uses, so the two cannot be
    // extended apart. Pinned byte-exact: this string is what Postgres parses.
    expect(ROLE_TOKEN_TRIMMED_SQL).toBe(String.raw`btrim(t, E' \t\n\r\f\x0B')`);
    expect(ROLE_TOKEN_TRIMMED_SQL).not.toContain(String.raw`\v`);
  });

  it("no second spelling of the admin token survives anywhere in the suite", () => {
    // The two spellings the review found, both from the promote statement. A
    // `string_to_array` compared with `= ANY` does not trim its tokens, and a
    // `regexp_split_to_array` on `\s*,\s*` only trims whitespace ADJACENT TO A
    // COMMA — which is precisely why `" admin"` fell between them.
    for (const file of ["auth.setup.ts", "account-state.ts", "state-rules.ts"]) {
      expect(read(file), `${file} re-spells the admin check`).not.toContain(
        "regexp_split_to_array",
      );
      expect(read(file), `${file} re-spells the admin check`).not.toContain(
        "= ANY (string_to_array",
      );
    }
  });

  it("the setup no longer decides the admin question itself", () => {
    // The decision of record is `roleChanged`, taken from the pre-read. The setup
    // writes only when that says the promotion changes something.
    expect(flat(read("auth.setup.ts"))).toContain("if (!snapshot.roleChanged) return;");
  });
});

// ---------------------------------------------------------------------------
// A — the membership is identified by (organizationId, userId)
// ---------------------------------------------------------------------------

describe("membership identity", () => {
  it("the identity is the pair the unique index enforces", () => {
    expect(MEMBER_IDENTITY_SQL).toBe(`"organizationId" = $1 AND "userId" = $2`);
  });

  it("the minted id is derived from BOTH halves of the identity", () => {
    // Keyed on the user alone, the same person in two organizations minted the
    // same primary key, so a conflict could fire on the id independently of the
    // index the insert arbitrates on.
    const a = memberIdFor("user-aaaaaaaa-1111", "org-11111111-x");
    const b = memberIdFor("user-aaaaaaaa-1111", "org-22222222-y");
    expect(a).not.toBe(b);
    expect(memberIdFor("user-aaaaaaaa-1111", "org-11111111-x")).toBe(a);
  });

  it("carries both halves WHOLE — an eight-character shared prefix is not a collision", () => {
    // RED before this round: each half was truncated to `slice(0, 8)`, so these
    // two DISTINCT pairs minted one id. The insert then failed on `member_pkey`
    // rather than taking the `ON CONFLICT ("organizationId", "userId")` arm it
    // arbitrates on — and a conflict on a target the statement does not name is
    // not absorbed, it aborts the setup.
    //
    // The shape is ordinary, not exotic: any id scheme with a fixed prefix meets
    // eight shared characters routinely.
    const a = memberIdFor("user_abc_alice", "org_2024_engineering");
    const b = memberIdFor("user_abc_bob", "org_2024_marketing");
    expect("user_abc_alice".slice(0, 8)).toBe("user_abc_bob".slice(0, 8));
    expect("org_2024_engineering".slice(0, 8)).toBe("org_2024_marketing".slice(0, 8));
    expect(a).not.toBe(b);
    // And the full identifiers are actually present, not re-truncated.
    expect(a).toContain("user_abc_alice");
    expect(a).toContain("org_2024_engineering");
  });

  it("the join is injective even when an identifier contains the separator", () => {
    // Without the length prefix, `${userId}-${orgId}` reads the same for these two
    // pairs, because the ids may themselves contain a `-`.
    expect(memberIdFor("a-b", "c")).not.toBe(memberIdFor("a", "b-c"));
    expect(memberIdFor("", "x")).not.toBe(memberIdFor("x", ""));
  });

  it("the pre-read asks the identity, not the synthetic id", () => {
    // RED before this round: the pre-read was `WHERE id = $1` with
    // `memberIdFor(userId)`, so an account already a member under a normally
    // minted id read as "not a member".
    const source = flat(read("account-state.ts"));
    expect(source).toContain('SELECT id FROM public."member" WHERE ${MEMBER_IDENTITY_SQL}');
    expect(source).not.toContain('SELECT 1 FROM public."member" WHERE id = $1');
  });

  it("the insert arbitrates on the identity, not the synthetic id", () => {
    // RED before this round: `ON CONFLICT (id) DO NOTHING` against production's
    // `member_org_user_uniq ON ("organizationId", "userId")` — the do-nothing arm
    // was unreachable for exactly the account the review named, which took the
    // INSERT arm and hit the unique violation instead.
    const source = flat(read("auth.setup.ts"));
    expect(source).toContain('ON CONFLICT ("organizationId", "userId") DO NOTHING');
    expect(source).not.toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("the delete is keyed on the identity AND on this fixture's own minted id", () => {
    expect(flat(read("account-state.ts"))).toContain(
      'DELETE FROM public."member" WHERE ${MEMBER_IDENTITY_SQL} AND id = $3',
    );
  });

  it.each([
    // [memberExistedBefore, memberInsert, memberId, mayDelete]
    [false, "inserted", "chat-hitl-s9k-member-a-b", true],
    [false, "pending", "chat-hitl-s9k-member-a-b", true],
    [false, "already_present", "chat-hitl-s9k-member-a-b", false],
    [false, "not_attempted", "chat-hitl-s9k-member-a-b", false],
    [false, "inserted", null, false],
    // A row that was already there is NEVER removed — including one carrying this
    // fixture's own derived id. The review's own proposed cleanup for that case
    // was withdrawn as unsafe; identity is the answer, not a delete.
    [true, "inserted", "chat-hitl-s9k-member-a-b", false],
    [true, "pending", "chat-hitl-s9k-member-a-b", false],
    [true, "already_present", "chat-hitl-s9k-member-a-b", false],
  ])(
    "existedBefore=%s insert=%s id=%o -> teardown may delete: %s",
    (memberExistedBefore, memberInsert, memberId, mayDelete) => {
      expect(
        fixtureOwnsMembership({
          memberExistedBefore: memberExistedBefore as boolean,
          memberId: memberId as string | null,
          memberInsert: memberInsert as "not_attempted" | "pending" | "inserted" | "already_present",
        }),
      ).toBe(mayDelete);
    },
  );
});

// ---------------------------------------------------------------------------
// Teardown verification — a snapshot belongs to exactly one run
// ---------------------------------------------------------------------------

describe("snapshotClaim — a teardown consumes only its own snapshot", () => {
  it("its own token is its own snapshot", () => {
    expect(snapshotClaim("pid-abc", "pid-abc")).toBe("own");
  });

  it("another run's token is foreign, so nothing is restored and nothing deleted", () => {
    // THE HAZARD: the exclusive create refused the second run's SETUP, but its
    // TEARDOWN still ran, consumed the first run's snapshot, restored from it and
    // deleted it — and the first run's own teardown then found no file and printed
    // `account restore verified` for a restore it never performed.
    expect(snapshotClaim("pid-aaa", "pid-bbb")).toBe("foreign");
  });

  it("a snapshot carrying no token is foreign to a tokened run", () => {
    expect(snapshotClaim(null, "pid-bbb")).toBe("foreign");
    expect(snapshotClaim(undefined, "pid-bbb")).toBe("foreign");
    expect(snapshotClaim("", "pid-bbb")).toBe("foreign");
  });

  it("an environment with no token at all is the documented manual recovery route", () => {
    // `node … fixtures.mts restore` run by hand, to undo a run that was killed
    // before its teardown. The operator asked for it explicitly.
    expect(snapshotClaim("pid-aaa", null)).toBe("untokened");
    expect(snapshotClaim(null, null)).toBe("untokened");
  });

  it("two tokens minted in a row differ", () => {
    expect(mintRunToken()).not.toBe(mintRunToken());
    expect(mintRunToken().startsWith(`${process.pid}-`)).toBe(true);
  });

  it("both teardown halves print an explicit skipped verdict, never verified", () => {
    // RED before this round: the missing-snapshot path returned
    // "account restore verified", and there was no foreign-snapshot path at all.
    const account = read("account-state.ts");
    expect(account).toContain("SNAPSHOT_SKIPPED_VERDICT");
    expect(account).not.toContain(
      "nothing to restore\\naccount restore verified",
    );
    const fixtures = read("fixtures.mts");
    expect(fixtures).toContain("restore ${SNAPSHOT_SKIPPED_VERDICT}");
    // The foreign arm must not delete the other run's snapshot.
    expect(flat(fixtures)).toContain("snapshotClaim(snapshot.runToken, currentRunToken()) === \"foreign\"");
    expect(flat(account)).toContain("snapshotClaim(snapshot.runToken, currentRunToken())");
  });

  it("the teardown accepts either verdict and nothing else", () => {
    const teardown = flat(read("restore.teardown.ts"));
    expect(teardown).toContain("SNAPSHOT_SKIPPED_VERDICT");
    expect(teardown).toContain("verified !== skipped");
  });

  it("the verdict string is the one the review asked for", () => {
    expect(SNAPSHOT_SKIPPED_VERDICT).toBe("skipped: not this run's snapshot");
  });
});

// ---------------------------------------------------------------------------
// B — the restore reverts only its own writes, and never deletes blindly
// ---------------------------------------------------------------------------

const PLACEHOLDER = sealedSecretFingerprint({ ciphertext: "sealed-placeholder", v: 1 });
const REAL_KEY = sealedSecretFingerprint({ ciphertext: "sealed-real-operator-key", v: 1 });
const FIXTURE_ROW = { defaultModel: "gpt-5", availableModels: [] };

describe("connectionRevertPlan — never remove or clear what this fixture did not write", () => {
  it("removes the row only when it is still exactly the row the fixture created", () => {
    expect(
      connectionRevertPlan({
        fixtureWroteConnection: true,
        rowExistedBefore: false,
        fixtureKeyFingerprint: PLACEHOLDER,
        liveKeyFingerprint: PLACEHOLDER,
        fixtureWroteNonSecret: FIXTURE_ROW,
        liveNonSecret: { availableModels: [], defaultModel: "gpt-5" },
      }),
    ).toBe("delete-row");
  });

  it("NEVER deletes a connection somebody stored during the run", () => {
    // THE HAZARD: the snapshot recorded no row, so the restore called
    // `deleteMetadataValueInternal(OPENAI_CONNECTION_METADATA_KEY)` — deleting the
    // connection a developer created while the suite ran.
    expect(
      connectionRevertPlan({
        fixtureWroteConnection: true,
        rowExistedBefore: false,
        fixtureKeyFingerprint: PLACEHOLDER,
        liveKeyFingerprint: REAL_KEY,
        fixtureWroteNonSecret: FIXTURE_ROW,
        liveNonSecret: FIXTURE_ROW,
      }),
    ).toBe("leave");
  });

  it("NEVER clears a real key added over the placeholder", () => {
    // THE HAZARD: `clearSecret: true` fired unconditionally, so a key stored
    // during the run was wiped under a passing "restore verified".
    expect(
      connectionRevertPlan({
        fixtureWroteConnection: true,
        rowExistedBefore: true,
        fixtureKeyFingerprint: PLACEHOLDER,
        liveKeyFingerprint: REAL_KEY,
        fixtureWroteNonSecret: FIXTURE_ROW,
        liveNonSecret: FIXTURE_ROW,
      }),
    ).toBe("leave");
  });

  it("clears only the placeholder when the row pre-existed", () => {
    expect(
      connectionRevertPlan({
        fixtureWroteConnection: true,
        rowExistedBefore: true,
        fixtureKeyFingerprint: PLACEHOLDER,
        liveKeyFingerprint: PLACEHOLDER,
        fixtureWroteNonSecret: FIXTURE_ROW,
        liveNonSecret: FIXTURE_ROW,
      }),
    ).toBe("clear-secret");
  });

  it("does not delete a row it created once somebody has edited it", () => {
    // The key is still the placeholder, so it goes; the row stays, because the
    // developer's edit to it is not this fixture's to throw away.
    expect(
      connectionRevertPlan({
        fixtureWroteConnection: true,
        rowExistedBefore: false,
        fixtureKeyFingerprint: PLACEHOLDER,
        liveKeyFingerprint: PLACEHOLDER,
        fixtureWroteNonSecret: FIXTURE_ROW,
        liveNonSecret: { ...FIXTURE_ROW, defaultModel: "the-developer-changed-this" },
      }),
    ).toBe("clear-secret");
  });

  it("touches nothing when the fixture never wrote, or nothing is stored now", () => {
    const base = {
      rowExistedBefore: false,
      fixtureKeyFingerprint: PLACEHOLDER,
      liveKeyFingerprint: PLACEHOLDER,
      fixtureWroteNonSecret: FIXTURE_ROW,
      liveNonSecret: FIXTURE_ROW,
    };
    expect(connectionRevertPlan({ ...base, fixtureWroteConnection: false })).toBe("leave");
    expect(
      connectionRevertPlan({ ...base, fixtureWroteConnection: true, liveKeyFingerprint: null }),
    ).toBe("leave");
    expect(
      connectionRevertPlan({ ...base, fixtureWroteConnection: true, fixtureKeyFingerprint: null }),
    ).toBe("leave");
  });

  it("the fingerprint identifies a stored value without carrying it", () => {
    expect(sealedSecretFingerprint(null)).toBeNull();
    expect(sealedSecretFingerprint(undefined)).toBeNull();
    expect(sealedSecretFingerprint("")).toBeNull();
    expect(PLACEHOLDER).not.toBe(REAL_KEY);
    expect(PLACEHOLDER).toBe(sealedSecretFingerprint({ v: 1, ciphertext: "sealed-placeholder" }));
    expect(PLACEHOLDER).not.toContain("sealed-placeholder");
  });

  it("the delete is reached only through the plan", () => {
    // RED before this round: `deleteMetadataValueInternal` fired inside
    // `if (snapshot.openAIConnection === null)`, on the snapshot alone.
    const source = flat(read("fixtures.mts"));
    expect(source).toContain('if (connectionPlan === "delete-row") {');
    expect(source).not.toContain(
      "if (snapshot.openAIConnection === null) { deleteMetadataValueInternal(",
    );
  });
});

describe("mcpRevertPlan — the same rule for the origin pair", () => {
  const wrote = { publicBaseUrl: "http://localhost:3126", publicBaseUrlSource: "manual" };

  it("puts the origin back while the row still holds what the fixture wrote", () => {
    expect(mcpRevertPlan({ mcpWritten: true, fixtureWrote: wrote, live: { ...wrote } })).toBe(
      "restore",
    );
  });

  it("leaves an origin somebody changed during the run", () => {
    expect(
      mcpRevertPlan({
        mcpWritten: true,
        fixtureWrote: wrote,
        live: { publicBaseUrl: "https://the-developers-funnel.ts.net", publicBaseUrlSource: "manual" },
      }),
    ).toBe("leave");
  });

  it("leaves a provenance somebody changed during the run", () => {
    expect(
      mcpRevertPlan({
        mcpWritten: true,
        fixtureWrote: wrote,
        live: { ...wrote, publicBaseUrlSource: "tailscale-funnel" },
      }),
    ).toBe("leave");
  });

  it("touches nothing when the fixture never wrote it", () => {
    expect(mcpRevertPlan({ mcpWritten: false, fixtureWrote: wrote, live: { ...wrote } })).toBe(
      "leave",
    );
    expect(mcpRevertPlan({ mcpWritten: true, fixtureWrote: null, live: { ...wrote } })).toBe(
      "leave",
    );
  });
});

// ---------------------------------------------------------------------------
// Blocking finding (2026-08-22 re-review) — "exactly one queue job names this
// run" must be a COUNT, not a probe for one job id
// ---------------------------------------------------------------------------

/**
 * A QUEUE STUB, DRIVING THE LIVE PROBE'S OWN FUNCTION.
 *
 * This is the whole reason the control is executable here rather than only
 * against a live Redis. `countJobsNamingRun` takes the queue as a FETCHER, so
 * `probes.ts` and this file call the SAME function over the SAME state list and
 * differ only in where the jobs come from — the stub cannot drift into testing a
 * different shape from the one that ships, because there is only one shape.
 *
 * `seenStates` records what the rule asked for, so the sweep itself can be
 * asserted rather than assumed.
 */
function queueStub(byState: Partial<Record<JobStateNamingRun, (QueueJobNamingRun | undefined)[]>>): {
  fetch: (
    states: readonly JobStateNamingRun[],
  ) => Promise<readonly (QueueJobNamingRun | undefined)[]>;
  seenStates: JobStateNamingRun[][];
} {
  const seenStates: JobStateNamingRun[][] = [];
  return {
    seenStates,
    fetch: async (states) => {
      seenStates.push([...states]);
      return states.flatMap((state) => byState[state] ?? []);
    },
  };
}

/** The run under test, and the two jobs the blocking finding is about. */
const RUN = "run-2824-s9k-held-turn";
/** What the decision path actually enqueues: `jobId === runId` (`run-actions.ts:208`). */
const DISPATCHED: QueueJobNamingRun = {
  id: RUN,
  name: "agent-builder-execution",
  data: { runId: RUN },
};
/**
 * The DUPLICATE. Same run in the payload, a different id — and not an invented
 * shape: `agent-builder-${runId}` is what `trigger-service.ts:400` and
 * `trigger-release-job.ts:302` enqueue for the very same run.
 */
const DUPLICATE: QueueJobNamingRun = {
  id: `agent-builder-${RUN}`,
  name: "agent-builder-execution",
  data: { runId: RUN },
};
/**
 * NAMES THE RUN, BUT IS NOT AN EXECUTION DISPATCH. Post-run output derivation
 * carries `{ runId, orgId }` for this very run (`execution.ts:1874-1886`).
 */
const DERIVE: QueueJobNamingRun = {
  id: `unbound-output-derive__${RUN}`,
  name: "unbound-output-derive",
  data: { runId: RUN, orgId: "org-1" },
};
/**
 * ALSO NAMES THE RUN, ALSO NOT A SECOND DISPATCH. The trigger path runs the release
 * job, which then enqueues the execution job itself (`trigger-release-job.ts:302`),
 * so the two stand together for ONE correct dispatch — and `removeOnComplete: 200`
 * keeps the finished release job around to be counted.
 */
const RELEASE: QueueJobNamingRun = {
  id: `trigger-release-${RUN}`,
  name: "agent-run-trigger-release",
  data: { runId: RUN },
};

describe("countJobsNamingRun — the exactly-once count", () => {
  it("counts the single dispatch as 1", async () => {
    await expect(countJobsNamingRun(queueStub({ waiting: [DISPATCHED] }).fetch, RUN)).resolves.toBe(
      1,
    );
  });

  it("counts 0 while the run is genuinely held", async () => {
    await expect(countJobsNamingRun(queueStub({}).fetch, RUN)).resolves.toBe(0);
  });

  it("NEGATIVE CONTROL — a second job under a DIFFERENT id makes the arm red", async () => {
    // THE CONTROL THE RE-REVIEW ASKED FOR. A duplicate dispatch is enqueued under
    // another id while carrying the same `data.runId`, and the count has to see
    // it: the released invariant asserts EXACTLY one, so 2 can never satisfy it.
    const count = await countJobsNamingRun(
      queueStub({ waiting: [DISPATCHED], active: [DUPLICATE] }).fetch,
      RUN,
    );
    expect(count).toBe(2);
    expect(count).not.toBe(1);
    expect(jobCountVerdict(count, 1)).toBe("over");
  });

  it("FAIL-FIRST — the OLD probe shape reads that same duplicate as a clean 1", () => {
    // The shipped probe was `queue.getJob(runId)` converted to `0 | 1`. Modelled
    // here over the EXACT two jobs the control above counts as 2, because a
    // deleted defect leaves no failing test behind and the claim "this used to be
    // wrong" is otherwise unverifiable by a reader.
    //
    // This is the arm that would have been GREEN on the duplicate — which is the
    // defect: green is the wrong colour for two dispatches of one run.
    const oldProbeShape = (jobs: QueueJobNamingRun[], runId: string): number =>
      jobs.some((job) => job.id === runId) ? 1 : 0;

    expect(oldProbeShape([DISPATCHED, DUPLICATE], RUN)).toBe(1);
    expect(oldProbeShape([DISPATCHED], RUN)).toBe(1);
    // It cannot even tell the duplicate-only case from the clean one.
    expect(oldProbeShape([DUPLICATE], RUN)).toBe(0);
  });

  it("a duplicate is caught in EVERY state a job can sit in, not just one", async () => {
    // The old probe's blindness was not specific to a state, so neither is the
    // control. Each swept state is exercised as the duplicate's hiding place.
    //
    // The map is MERGED rather than spread with a computed key: `{ waiting: [a],
    // [state]: [b] }` silently drops the dispatch when `state` is `waiting`, which
    // made this arm assert 2 against a queue holding one job.
    for (const state of JOB_STATES_NAMING_RUN) {
      const byState: Partial<Record<JobStateNamingRun, QueueJobNamingRun[]>> = {
        waiting: [DISPATCHED],
      };
      byState[state] = [...(byState[state] ?? []), DUPLICATE];
      const count = await countJobsNamingRun(queueStub(byState).fetch, RUN);
      expect(count, `duplicate hidden in "${state}"`).toBe(2);
    }
  });

  it("sweeps every state BullMQ can hold a job in", () => {
    // Pinned against BullMQ's own fallback list for `getJobs()` with no argument
    // (`queue-getters.js:53-62`), so a state cannot quietly become a blind spot.
    expect([...JOB_STATES_NAMING_RUN].sort()).toEqual(
      [
        "active",
        "completed",
        "delayed",
        "failed",
        "paused",
        "prioritized",
        "waiting",
        "waiting-children",
      ].sort(),
    );
    // `repeat` names scheduler keys and `wait` is BullMQ's alias for `waiting`;
    // sweeping either would double-count or fetch non-jobs.
    expect(JOB_STATES_NAMING_RUN).not.toContain("repeat");
    expect(JOB_STATES_NAMING_RUN).not.toContain("wait");
  });

  it("asks the queue for that whole list, in one call", async () => {
    const stub = queueStub({ waiting: [DISPATCHED] });
    await countJobsNamingRun(stub.fetch, RUN);
    expect(stub.seenStates).toHaveLength(1);
    expect(stub.seenStates[0]).toEqual([...JOB_STATES_NAMING_RUN]);
  });

  it("counts ONE job seen in two states once, not twice", async () => {
    // BullMQ already dedupes ids inside `getRanges`, so this shape does not reach
    // the rule from a real queue today. The arm pins the rule's OWN behaviour, so
    // the count stays correct without inheriting that guarantee: a repeated
    // representation of one job must never read as a second dispatch.
    const count = await countJobsNamingRun(
      queueStub({ waiting: [DISPATCHED], active: [{ ...DISPATCHED }] }).fetch,
      RUN,
    );
    expect(count).toBe(1);
  });

  it("drops the holes `Job.fromId` leaves for a job removed mid-sweep", async () => {
    const count = await countJobsNamingRun(
      queueStub({ waiting: [undefined, DISPATCHED, undefined] }).fetch,
      RUN,
    );
    expect(count).toBe(1);
  });

  it("two id-less jobs count as two, never collapsing into one", async () => {
    // BullMQ always assigns an id; this is the arm that keeps a malformed entry
    // from hiding a second dispatch behind a shared empty key.
    const count = await countJobsNamingRun(
      queueStub({
        waiting: [
          { name: "agent-builder-execution", data: { runId: RUN } },
          { name: "agent-builder-execution", data: { runId: RUN } },
        ],
      }).fetch,
      RUN,
    );
    expect(count).toBe(2);
  });

  it("ignores every job that does not name THIS run", async () => {
    const stub = queueStub({
      waiting: [
        { id: "other", data: { runId: "some-other-run" } },
        { id: "no-data", data: undefined },
        { id: "not-an-object", data: "run-2824-s9k-held-turn" },
        { id: "no-run-field", data: { skillIds: ["a"] } },
        // The run id appearing as some OTHER field is not this run being named.
        { id: "wrong-field", name: "agent-builder-execution", data: { sourceRunId: RUN } },
        // Both name the run; neither is an execution dispatch.
        DERIVE,
        RELEASE,
        // A dispatch name this suite does not know is NOT counted — the
        // conservative reading for an "exactly one" assertion.
        { id: "unknown", name: "some-future-job", data: { runId: RUN } },
        { id: "nameless", data: { runId: RUN } },
      ],
    });
    await expect(countJobsNamingRun(stub.fetch, RUN)).resolves.toBe(0);
  });

  it("a correct run with BOTH runId-bearing neighbours alongside it still counts 1", async () => {
    // THE FALSE POSITIVES THIS NARROWING PREVENTS, and they are not hypothetical:
    // on the trigger path the release job enqueues the execution job, and after the
    // run produces output the derive job is enqueued for the same run. With
    // `removeOnComplete: 200` both are retained. A count over every runId-bearing
    // payload would read 3 here and report a duplicate dispatch against a run that
    // was dispatched for execution exactly once.
    await expect(
      countJobsNamingRun(
        queueStub({ completed: [RELEASE, DISPATCHED], waiting: [DERIVE] }).fetch,
        RUN,
      ),
    ).resolves.toBe(1);
  });

  it("the dispatch-name list matches the registry's runId-bearing set", () => {
    // RATCHET, and the reason the name filter is not a new blind spot. Exactly
    // three registered jobs carry a `runId` payload; ONE is the execution dispatch
    // and the other two can stand beside a correct one. A FOURTH turns this red and
    // forces the choice, instead of silently landing in whichever bucket the filter
    // happens to give it.
    //
    // Pinned TWO ways on purpose. The block scan below attributes each schema to a
    // job name but depends on a bounded text window; the total count does not
    // depend on attribution at all, so a fourth runId payload schema turns this arm
    // red even if the window drifts and mis-attributes it.
    //
    // A RATCHET, NOT A PROOF, and the limit is worth stating rather than trusting:
    // both reads match the LITERAL `runId: z.string()` spelling, so a schema that
    // is imported, composed from another object, or spelled differently would slip
    // past. It catches the shape every runId payload in this registry is written
    // in today, which is what a ratchet is for; it is not a guarantee that no
    // fourth runId job can ever exist unnoticed.
    const registry = read("../../../src/lib/background-jobs-registry.ts");
    const names = read("../../../src/lib/background-jobs-names.ts");
    expect(registry.match(/runId: z\.string\(\)/g)).toHaveLength(3);
    const carriesRunId = [...registry.matchAll(/\[BACKGROUND_JOB_NAMES\.(\w+)\]:\s*\{/g)]
      .filter((m) => {
        const block = registry.slice(m.index ?? 0, (m.index ?? 0) + 2500);
        const schema = /payloadSchema:\s*([\s\S]{0,400})/.exec(block);
        return Boolean(schema && schema[1]!.includes("runId"));
      })
      .map((m) => m[1]!)
      .sort();

    expect(carriesRunId).toEqual([
      "AGENT_BUILDER_EXECUTION",
      "AGENT_RUN_TRIGGER_RELEASE",
      "UNBOUND_OUTPUT_DERIVE",
    ]);

    // And the two the count accepts are those constants' actual string values.
    expect(names).toContain('AGENT_BUILDER_EXECUTION: "agent-builder-execution"');
    expect(names).toContain('AGENT_RUN_TRIGGER_RELEASE: "agent-run-trigger-release"');
    expect(names).toContain('UNBOUND_OUTPUT_DERIVE: "unbound-output-derive"');
    // Only the EXECUTION dispatch is counted. The release job is dispatch-adjacent
    // but precedes the execution job it enqueues, so counting it would read 2 for
    // one correct trigger-path dispatch.
    expect([...RUN_DISPATCH_JOB_NAMES]).toEqual(["agent-builder-execution"]);
  });

  it("a queue busy with other runs still answers about this one", async () => {
    // The number is a count of jobs NAMING THE RUN, never a queue total — a queue
    // total counts every other run on the lane and answers nothing.
    const noise = Array.from({ length: 40 }, (_, i) => ({
      id: `noise-${i}`,
      name: "agent-builder-execution",
      data: { runId: `run-${i}` },
    }));
    await expect(
      countJobsNamingRun(queueStub({ waiting: [...noise, DISPATCHED] }).fetch, RUN),
    ).resolves.toBe(1);
  });

  it.each([
    // [count, expected, verdict]
    [0, 0, "ok"],
    [1, 1, "ok"],
    [0, 1, "under"],
    [1, 0, "over"],
    [2, 1, "over"],
    [7, 0, "over"],
  ])("jobCountVerdict(%i, %i) is %s", (count, expected, verdict) => {
    expect(jobCountVerdict(count as number, expected as number)).toBe(verdict);
  });

  it("the live probe counts payloads and no longer probes for one job id", () => {
    // RATCHET. `queue.getJob(runId)` is the exact call the re-review named: it
    // proves a job addressable by the run id exists, which is a different question
    // from how many jobs name the run.
    //
    // Read as CODE. The probe's own doc block names the old call so the next reader
    // knows what was wrong with it, and that sentence must not read as a relapse.
    const source = flat(code("probes.ts"));
    expect(source).not.toContain("queue.getJob(runId)");
    expect(source).toContain("countJobsNamingRun(() => queue.getJobs(SWEPT_STATES), runId)");
    expect(source).toContain("const SWEPT_STATES: JobType[] = [...JOB_STATES_NAMING_RUN];");
    // The old spelling IS still described in prose — deliberately, and this pins
    // that the explanation was not deleted along with the defect.
    expect(flat(read("probes.ts"))).toContain("queue.getJob(runId)");
  });

  it("the released invariant still demands EXACTLY one, and the held one zero", () => {
    const source = flat(code("held-turn.spec.ts"));
    expect(source).toContain('park === "released" && facts.status !== "pending_input" && jobs === 1');
    expect(source).toContain("jobs === 0");
    // An over-count is reported as a duplicate dispatch rather than as a timeout,
    // because waiting can only ever fix a count that is too low.
    expect(source).toContain("DUPLICATE DISPATCH:");
  });
});
