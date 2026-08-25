// SINGLE USE (cinatra#2932, lifecycle-b W5a) — acceptance items 2 and 3.
//
//   2. "A grant is consumed by its first use."
//   3. "A replayed ... grant ... is refused."
//
// The REAL store runs against an in-memory stand-in for the ledger table that
// behaves the way Postgres does: an INSERT that loses to the unique index writes
// nothing and returns no row, and a DELETE returns a row only when one was
// really removed. Nothing about the mechanism is mocked — only the storage under
// it — so what these cases prove is the ORDER, the KEY and the atomicity, which
// is what single use IS. The same idioms are proved once for real against a live
// Postgres in `lent-action-grant-store.integration.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lent-action-store";

vi.mock("@cinatra-ai/agents/db", () => ({ agentBuilderPool: { query: vi.fn() } }));

import {
  consumeLentActionGrant,
  recordLentActionGrant,
  sweepExpiredLentActionGrants,
} from "../lent-action-grant-store";
import type { LentActionGrantClaims } from "../lent-action-grant";

type Row = {
  jti: string;
  org_id: string;
  user_id: string;
  message_id: string;
  card_ref_fp: string;
  control: string;
  message_text: string | null;
  spent_at: number | null;
  expires_at: number;
};

let ledger: Row[] = [];
/** The DATABASE's clock, unix seconds — moved independently of any codec clock. */
let dbNow = Math.floor(Date.now() / 1000);
let failNext = false;

/** The stand-in. An unrecognized statement THROWS, so a change to the store's
 *  SQL cannot silently start passing here. */
const query = (async <T,>(text: string, values: readonly unknown[]): Promise<T[]> => {
  if (failNext) throw new Error("ledger unavailable");
  if (text.includes("INSERT INTO")) {
    const [jti, orgId, userId, messageId, fp, control, messageText, expiresAt] =
      values as [string, string, string, string, string, string, string | null, number];
    // The two unique constraints: the primary key and (user_id, message_id).
    const clash = ledger.some(
      (r) => r.jti === jti || (r.user_id === userId && r.message_id === messageId),
    );
    if (clash) return [] as T[];
    ledger.push({
      jti,
      org_id: orgId,
      user_id: userId,
      message_id: messageId,
      card_ref_fp: fp,
      control,
      message_text: messageText,
      spent_at: null,
      expires_at: expiresAt,
    });
    return [{ jti }] as unknown as T[];
  }
  if (text.includes("UPDATE") && text.includes("spent_at = now()")) {
    const [jti, userId, orgId, fp, control] = values as [
      string, string, string, string, string,
    ];
    const row = ledger.find(
      (r) =>
        r.jti === jti &&
        r.user_id === userId &&
        r.org_id === orgId &&
        r.card_ref_fp === fp &&
        r.control === control &&
        r.spent_at === null &&
        r.expires_at > dbNow,
    );
    if (!row) return [] as T[];
    const words = row.message_text;
    // The tombstone: the row stays (it is the message-id witness), spent and
    // wordless, exactly as the real statement leaves it.
    row.spent_at = dbNow;
    row.message_text = null;
    return [{ jti: row.jti, message_text: words }] as unknown as T[];
  }
  if (text.includes("DELETE FROM") && text.includes("expires_at <= now()")) {
    ledger = ledger.filter((r) => r.expires_at > dbNow);
    return [] as T[];
  }
  throw new Error(`unrecognized statement: ${text.slice(0, 60)}`);
}) as never;

const CLAIMS: LentActionGrantClaims = {
  jti: "grant-1",
  userId: "usr_1",
  orgId: "org_1",
  messageId: "msg_1",
  cardRefFingerprint: "fp-alpha",
  control: "comment",
  expiresAt: dbNow + 600,
};

/** The spend, as the handler makes it: the grant's identity PLUS the card and
 *  control the CALL names, so the row itself refuses a mismatch. */
const SPEND = {
  jti: CLAIMS.jti,
  userId: CLAIMS.userId,
  orgId: CLAIMS.orgId,
  cardRefFingerprint: CLAIMS.cardRefFingerprint,
  control: CLAIMS.control,
};

beforeEach(() => {
  ledger = [];
  dbNow = Math.floor(Date.now() / 1000);
  failNext = false;
});

describe("the first use consumes the grant", () => {
  it("the SPEND leaves a TOMBSTONE, so a RESEND of the same message mints nothing", async () => {
    // convergence round 3: the row is also the (user_id, message_id) witness, so
    // deleting it on the spend would let "at most once per message" be beaten by
    // a retry.
    await recordLentActionGrant(CLAIMS, "words", { query });
    expect(await consumeLentActionGrant(SPEND, { query })).toMatchObject({
      outcome: "consumed",
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].spent_at).not.toBeNull();
    expect(ledger[0].message_text).toBeNull();
    expect(
      await recordLentActionGrant({ ...CLAIMS, jti: "grant-resend" }, "again", { query }),
    ).toBe(false);
  });

  it("records then consumes — item 2", async () => {
    expect(await recordLentActionGrant(CLAIMS, "the person's own words", { query })).toBe(true);
    const first = await consumeLentActionGrant(
      SPEND,
      { query },
    );
    expect(first).toEqual({ outcome: "consumed", messageText: "the person's own words" });
  });

  it("a SECOND use of the same grant is refused — item 3, the replay", async () => {
    await recordLentActionGrant(CLAIMS, "the person's own words", { query });
    await consumeLentActionGrant(
      SPEND,
      { query },
    );
    const second = await consumeLentActionGrant(
      SPEND,
      { query },
    );
    expect(second).toEqual({ outcome: "refused" });
  });

  it("two concurrent uses: exactly ONE wins", async () => {
    await recordLentActionGrant(CLAIMS, "the person's own words", { query });
    const spend = SPEND;
    const [a, b] = await Promise.all([
      consumeLentActionGrant(SPEND, { query }),
      consumeLentActionGrant(SPEND, { query }),
    ]);
    const wins = [a, b].filter((r) => r.outcome === "consumed");
    expect(wins).toHaveLength(1);
  });
});

describe("a grant that is not this caller's is not spendable", () => {
  it("refuses a spend by another person — item 3, the foreign grant", async () => {
    await recordLentActionGrant(CLAIMS, "the person's own words", { query });
    expect(
      await consumeLentActionGrant({ ...SPEND, userId: "usr_2" }, { query }),
    ).toEqual({ outcome: "refused" });
    // And the grant is still there for its real owner — a foreign attempt never
    // burns somebody else's authority.
    expect(
      await consumeLentActionGrant(SPEND, { query }),
    ).toMatchObject({ outcome: "consumed" });
  });

  it("refuses a grant this server never minted", async () => {
    expect(
      await consumeLentActionGrant(
        { ...SPEND, jti: "never-minted" },
        { query },
      ),
    ).toEqual({ outcome: "refused" });
  });
});

describe("the life is honoured at the DATABASE's clock", () => {
  it("an expired grant is refused even though its row is still there", async () => {
    await recordLentActionGrant(CLAIMS, "the person's own words", { query });
    dbNow = CLAIMS.expiresAt + 1;
    expect(
      await consumeLentActionGrant(
        SPEND,
        { query },
      ),
    ).toEqual({ outcome: "refused" });
  });

  it("the sweep collects what has expired and leaves what has not", async () => {
    await recordLentActionGrant(CLAIMS, "the person's own words", { query });
    await recordLentActionGrant(
      { ...CLAIMS, jti: "grant-2", messageId: "msg_2", expiresAt: dbNow + 10_000 },
      "another message",
      { query },
    );
    dbNow = CLAIMS.expiresAt + 1;
    await sweepExpiredLentActionGrants({ query });
    expect(ledger.map((r) => r.jti)).toEqual(["grant-2"]);
  });
});

describe("one message lends one control", () => {
  it("a second mint for the same message adds NO second spendable row", async () => {
    expect(await recordLentActionGrant(CLAIMS, "the person's own words", { query })).toBe(true);
    expect(
      await recordLentActionGrant({ ...CLAIMS, jti: "grant-2" }, "a second mint", { query }),
    ).toBe(false);
    expect(ledger).toHaveLength(1);
  });
});

describe("a store that cannot answer refuses — never fails open", () => {
  it("an unreachable ledger is a refusal, not a free pass", async () => {
    await recordLentActionGrant(CLAIMS, "the person's own words", { query });
    failNext = true;
    expect(
      await consumeLentActionGrant(
        SPEND,
        { query },
      ),
    ).toEqual({ outcome: "refused" });
  });
});

describe("the row is the second lock on WHAT may be pressed", () => {
  it("refuses a spend naming ANOTHER CARD, even with the right identity — convergence round 1, finding 2/3 depth", async () => {
    await recordLentActionGrant(CLAIMS, "words", { query });
    expect(
      await consumeLentActionGrant(
        { ...SPEND, cardRefFingerprint: "fp-other" },
        { query },
      ),
    ).toEqual({ outcome: "refused" });
  });

  it("refuses a spend naming ANOTHER CONTROL", async () => {
    await recordLentActionGrant(CLAIMS, "words", { query });
    expect(
      await consumeLentActionGrant({ ...SPEND, control: "approve" }, { query }),
    ).toEqual({ outcome: "refused" });
  });
});

describe("the person's own words travel with the grant", () => {
  it("the spend hands back the message the MINT captured — not a caller's argument", async () => {
    await recordLentActionGrant(CLAIMS, "tighten the opening paragraph", { query });
    expect(await consumeLentActionGrant(SPEND, { query })).toEqual({
      outcome: "consumed",
      messageText: "tighten the opening paragraph",
    });
  });

  it("a turn with no message text lands NOTHING rather than something invented", async () => {
    await recordLentActionGrant(CLAIMS, null, { query });
    expect(await consumeLentActionGrant(SPEND, { query })).toEqual({
      outcome: "consumed",
      messageText: null,
    });
  });

  it("the store NEVER truncates — the caller refuses an over-long message instead", async () => {
    // AMENDED by convergence round 2. An earlier draft sliced the text here, which
    // would have turned "your words, word for word" into "the first ten thousand
    // characters of your words" with nothing saying so. The bound belongs at the
    // MINT, which declines to lend anything for a message the card's own path
    // would refuse; the store's job is to carry what it was given, whole.
    const long = "x".repeat(20_000);
    await recordLentActionGrant(CLAIMS, long, { query });
    const spent = await consumeLentActionGrant(SPEND, { query });
    expect((spent as { messageText: string }).messageText).toBe(long);
  });
});
