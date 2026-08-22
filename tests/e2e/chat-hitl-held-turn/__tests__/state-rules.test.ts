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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MEMBER_IDENTITY_SQL,
  PROMOTE_ADMIN_ROLE_SQL,
  ROLE_TOKENS_SQL,
  ROLE_TOKEN_TRIMMED_SQL,
  SNAPSHOT_SKIPPED_VERDICT,
  STRIP_ADMIN_ROLE_SQL,
  connectionRevertPlan,
  fixtureOwnsMembership,
  mcpRevertPlan,
  memberIdFor,
  mintRunToken,
  roleCarriesAdmin,
  sealedSecretFingerprint,
  snapshotClaim,
} from "../state-rules";

const SUITE_DIR = resolve(__dirname, "..");
const read = (file: string): string => readFileSync(resolve(SUITE_DIR, file), "utf-8");
/** Collapse whitespace, so a re-indent or a line wrap cannot break a shape assertion. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

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
