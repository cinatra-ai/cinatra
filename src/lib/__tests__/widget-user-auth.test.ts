import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// cinatra#407 — hosted /widget-auth PKCE login + user-scoped widget token.
//
// The three short-lived tables (widget_auth_transactions / widget_auth_codes /
// widget_user_tokens) are mocked as in-memory row stores so the REAL
// create→issue→redeem→verify lifecycle, single-use consume, PKCE check,
// cross-site binding rejection, strict instance resolution, and the live
// site/origin re-checks run against synthetic rows. connect-site lookups +
// connector_config instance reads are mocked as data. The module's own
// SHA-256-at-rest, prefix, and TTL constants are exercised end-to-end (a raw
// code/token is NEVER stored).

const {
  runPostgresQueriesSyncMock,
  readConnectorConfigMock,
  readMetadataValueMock,
  ensureSchemaMock,
  validateConnectServerCredentialMock,
  getActiveConnectSiteByIdMock,
  listActiveConnectSiteOriginsMock,
  readInstanceIdentityMock,
} = vi.hoisted(() => ({
  runPostgresQueriesSyncMock: vi.fn(),
  readConnectorConfigMock: vi.fn(),
  readMetadataValueMock: vi.fn(),
  ensureSchemaMock: vi.fn(),
  validateConnectServerCredentialMock: vi.fn(),
  getActiveConnectSiteByIdMock: vi.fn(),
  listActiveConnectSiteOriginsMock: vi.fn(),
  readInstanceIdentityMock: vi.fn(),
}));

vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "test_schema",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: ensureSchemaMock,
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPostgresQueriesSyncMock,
  quotePostgresIdentifier: (v: string) => `"${v.replaceAll('"', '""')}"`,
}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: readConnectorConfigMock,
  readMetadataValueFromDatabase: readMetadataValueMock,
}));
// widget-stream-auth pulls in heavy deps; mock the two symbols we use. The
// origin-matching is implemented faithfully so the strict instance resolver and
// cross-site checks behave like production.
vi.mock("@/lib/widget-stream-auth", () => ({
  validateConnectServerCredential: validateConnectServerCredentialMock,
  originMatchesSiteUrl: (origin: string | null | undefined, siteUrl: string | null | undefined) => {
    const norm = (v: unknown) => {
      const t = String(v ?? "").trim();
      if (!t) return "";
      const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`;
      try {
        return new URL(withProto).origin.toLowerCase();
      } catch {
        return "";
      }
    };
    const a = norm(origin);
    const b = norm(siteUrl);
    return a.length > 0 && a === b;
  },
}));
vi.mock("@/lib/connect-sites-store", () => ({
  getActiveConnectSiteById: getActiveConnectSiteByIdMock,
  // cinatra#3715 — the handshake road's site read (the frame gate's rule).
  listActiveConnectSiteOrigins: listActiveConnectSiteOriginsMock,
}));
// cinatra#3715 — the application's own instance identity, the value the
// handshake hands every site. Stubbed as data, like the connector config.
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentityRequiringInstanceId: readInstanceIdentityMock,
}));

import {
  createAuthTransaction,
  loadActiveTransaction,
  mintWidgetScreenNonce,
  recordDisplayedScopesForTransaction,
  sessionRowPredatesTransaction,
  widgetScreenNonceHash,
  widgetSessionFingerprint,
  issueUserAuthCode,
  redeemUserAuthCode,
  consumeUserWidgetToken,
  resolveCanonicalInstanceForOrigin,
  resolveVerifiedSiteFromCredential,
  isValidState,
  type VerifiedSiteContext,
  __testing,
} from "@/lib/widget-user-auth";
import * as widgetUserAuth from "@/lib/widget-user-auth";
import {
  WIDGET_SIGNIN_GRANTED_SCOPES,
  WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
  WIDGET_CHAT_THREADS_ROUTE_PATH,
  WIDGET_CONVERSATION_READ_SCOPE,
  WIDGET_CONVERSATION_WRITE_SCOPE,
  displayedScopesAgree,
  screenRecordAdmitsArrival,
  widgetDisplayedScopesToken,
  widgetNoSignInScreenToken,
  type WidgetExtensionScope,
} from "@/lib/widget-lifecycle-scope";
import { resolveInstanceFrameAncestor } from "@/lib/embed/frame-ancestors.server";

// ---------------------------------------------------------------------------
// In-memory store + a focused SQL interpreter for the three tables.
// ---------------------------------------------------------------------------
type AnyRow = Record<string, unknown> & { expires_at_ms: number; consumed: boolean };
let txnStore: Map<string, AnyRow>; // key = txn_id
let codeStore: Map<string, AnyRow>; // key = code_hash
let tokenStore: Map<string, AnyRow>; // key = token_hash
let nowMs: number;
// Better Auth session rows, carrying ONLY what the widget reads off them: the
// database's own record of when each row was INSERTED (`cinatra_db_created_at`,
// a column DEFAULT, so an UPDATE never moves it). cinatra#2631, rework rounds
// 4 and 6.
let sessionRows: Map<string, number>; // session id -> cinatra_db_created_at (ms)
// cinatra#2684 — which Better Auth session rows are STILL SIGNED IN. Deleting an
// id from this set is exactly what a sign-out or a revoke does to the row, and
// it is the only thing the widget flow ever learns about a session.
let liveSessionIds: Set<string>;
/** The session the hosted sign-in ran under, unless a test says otherwise. */
const SESSION_A = "sess-A";
/** A SECOND live session of the SAME person — the per-session negative control. */
const SESSION_B = "sess-B";

function tableOf(sql: string): "txn" | "code" | "token" | null {
  if (sql.includes("widget_auth_transactions")) return "txn";
  if (sql.includes("widget_auth_codes")) return "code";
  if (sql.includes("widget_user_tokens")) return "token";
  return null;
}
function storeOf(t: "txn" | "code" | "token") {
  return t === "txn" ? txnStore : t === "code" ? codeStore : tokenStore;
}

// Split a SQL list at its top-level commas (a LEAST(a, b) stays one entry).
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Called once, at the start of the renewal statement, between the verifier's own
// read and the claim: a test moves the clock here to prove the claim's guards are
// the DATABASE's, not the verifier's.
let renewClaimHook: (() => void) | null = null;
// cinatra#4217 r4 — how much EARLIER than the clock `now()` reads inside the
// renewal statement. In Postgres `now()` is the time the transaction BEGAN,
// while `clock_timestamp()` is the clock as the statement runs. A test sets this
// to model a renewal whose transaction began before another renewal committed
// (READ COMMITTED still lets its statement see that commit). 0 = the same time.
let renewTxnStartLagMs = 0;
// cinatra#4217 r6 — how long the renewal statement pauses AFTER its guards are
// decided and before its writes read the clock. In Postgres every
// clock_timestamp() call reads the clock anew, so the writes may read a later
// instant than the guards did. 0 = one instant for the whole statement.
let renewStatementPauseMs = 0;

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("renewal double: unbalanced statement");
}

function renewalStatement(
  sql: string,
  values: unknown[],
  store: Map<string, AnyRow>,
): { rows: Record<string, unknown>[] } {
  const at = (n: string) => values[Number(n) - 1];
  // WITH claimed AS ( DELETE ... )
  const open = "WITH claimed AS (".length - 1;
  const close = matchingParen(sql, open);
  const del = sql.slice(open + 1, close);
  const dm = del.match(/^DELETE FROM \S+ WHERE (.*) RETURNING (.*)$/);
  if (!dm) throw new Error("renewal double: unsupported claim");
  const returned = splitTopLevel(dm[2]);
  // The writes that follow: zero or more `, name AS (INSERT ...)`, then the main INSERT.
  const inserts: string[] = [];
  let rest = sql.slice(close + 1);
  while (rest.startsWith(", ")) {
    const named = rest.match(/^, (\w+) AS \(/);
    if (!named) throw new Error("renewal double: unsupported CTE");
    const o = named[0].length - 1;
    const c = matchingParen(rest, o);
    inserts.push(rest.slice(o + 1, c));
    rest = rest.slice(c + 1);
  }
  if (!rest.startsWith(" INSERT INTO ")) throw new Error("renewal double: no main INSERT");
  const mainAt = rest.indexOf(" RETURNING ", rest.indexOf(" FROM claimed"));
  inserts.push(rest.slice(1, mainAt));
  const mainReturning = splitTopLevel(rest.slice(mainAt + " RETURNING ".length));

  const conds = dm[1].split(" AND ").map((c) => c.trim());
  if (conds[0] !== "token_hash = $1") throw new Error("renewal double: the claim is not keyed on $1");
  const claimed = store.get(String(at("1")));
  let statementClockMs = nowMs; // clock_timestamp(): the guards' instant, then the writes'
  const timeOf = (expr: string): number => {
    const e = expr.trim();
    const least = e.match(/^LEAST\((.*)\)$/);
    if (least) return Math.min(...splitTopLevel(least[1]).map(timeOf));
    const plus = e.match(/^(now\(\)|clock_timestamp\(\)|created_at) \+ make_interval\(secs => \$(\d+)\)$/);
    if (plus) {
      const secs = Number(at(plus[2]));
      if (!Number.isFinite(secs)) throw new Error(`renewal double: $${plus[2]} is not a number`);
      return timeOf(plus[1]) + secs * 1000;
    }
    if (e === "now()") return nowMs - renewTxnStartLagMs;
    if (e === "clock_timestamp()") return statementClockMs;
    if (e === "created_at" || e === "expires_at") {
      const v = Number(claimed?.[`${e}_ms`]);
      if (!Number.isFinite(v)) throw new Error(`renewal double: the row has no ${e}`);
      return v;
    }
    throw new Error(`renewal double: unsupported time expression ${e}`);
  };
  if (!claimed) return { rows: [] };
  for (const cond of conds.slice(1)) {
    const gt = cond.split(" > ");
    if (gt.length !== 2) throw new Error(`renewal double: unsupported guard ${cond}`);
    if (!(timeOf(gt[0]) > timeOf(gt[1]))) return { rows: [] };
  }
  statementClockMs = nowMs + renewStatementPauseMs;
  // The presented row is spent by this statement, so its key is free to be
  // written again (the grace write-back); every other existing key is not.
  const key = String(at("1"));
  const written: AnyRow[] = [];
  for (const ins of inserts) {
    const im = ins.match(/^INSERT INTO \S+ \(/);
    if (!im) throw new Error("renewal double: unsupported write");
    const colsOpen = im[0].length - 1;
    const colsClose = matchingParen(ins, colsOpen);
    const cols = ins.slice(colsOpen + 1, colsClose).split(",").map((c) => c.trim());
    const tail = ins.slice(colsClose + 1);
    const sm = tail.match(/^ SELECT (.*) FROM claimed$/);
    if (!sm) throw new Error("renewal double: a write that does not read the claim");
    const exprs = splitTopLevel(sm[1]);
    if (cols.length !== exprs.length) throw new Error("renewal double: column/value count differs");
    const row: AnyRow = { expires_at_ms: 0, consumed: false };
    cols.forEach((col, i) => {
      const expr = exprs[i];
      if (col === "expires_at" || col === "created_at") {
        row[`${col}_ms`] = timeOf(expr);
        return;
      }
      const param = expr.match(/^\$(\d+)$/);
      if (col === "token_hash") {
        if (!param) throw new Error("renewal double: token_hash must be bound");
        row.token_hash = at(param[1]);
        return;
      }
      if (expr !== col || !returned.includes(col)) {
        throw new Error(`renewal double: ${col} must be a same-named copy of the claim, got ${expr}`);
      }
      if (claimed[col] === undefined) throw new Error(`renewal double: the claim has no ${col}`);
      row[col] = claimed[col];
    });
    if (typeof row.token_hash !== "string" || row.token_hash === "") {
      throw new Error("renewal double: a write without a token_hash");
    }
    const taken =
      (store.has(row.token_hash) && row.token_hash !== key) ||
      written.some((w) => w.token_hash === row.token_hash);
    if (taken) {
      throw new Error("renewal double: duplicate key value violates widget_user_tokens_pkey");
    }
    written.push(row);
  }
  // All or nothing, as one statement is: nothing is changed until every write
  // has been read without an error.
  store.delete(key);
  for (const row of written) store.set(String(row.token_hash), row);
  const successor = written[written.length - 1];
  const out: Record<string, unknown> = {};
  for (const r of mainReturning) {
    if (r === "jti" || r === "scope") out[r] = successor[r];
    else {
      // The advertised life, reckoned from whichever clock the statement names.
      const life = r.match(/^CEIL\(EXTRACT\(EPOCH FROM \(expires_at - (now\(\)|clock_timestamp\(\))\)\)\)::int AS expires_in$/);
      if (!life) throw new Error(`renewal double: unsupported RETURNING ${r}`);
      out.expires_in = Math.ceil((successor.expires_at_ms - timeOf(life[1])) / 1000);
    }
  }
  return { rows: [out] };
}

// Interpret one SQL statement against the in-memory stores. Supports the exact
// shapes the module emits: INSERT (...) VALUES (... make_interval(secs=>$N)),
// SELECT ... WHERE <key>=$1 [AND consumed_at IS NULL] [AND expires_at>now()],
// UPDATE ... SET consumed_at=now() ... RETURNING, DELETE ... WHERE key=$1 ...
// RETURNING, and the unconditional "DELETE ... WHERE expires_at < now()" sweep.
function exec(sql: string, values: unknown[] = []): { rows: Record<string, unknown>[] } {
  // cinatra#2684 — the parent-session liveness read (widget-session-binding.ts).
  // It is the ONE question every widget verifier asks about a session, and it
  // hits Better Auth's own table, not one of the three widget tables. A row is
  // returned only while the id is in the live set; a sign-out removes it, which
  // is exactly what deleting the session row does in production.
  if (sql.includes('"public"."session"') && sql.includes("AS alive")) {
    return { rows: liveSessionIds.has(String(values[0])) ? [{ alive: 1 }] : [] };
  }
  // The sign-out cascade: delete every widget row bound to ONE session id. Keyed
  // equality, so a row bound to another session is untouched (AC-5).
  if (sql.startsWith("DELETE") && sql.includes("auth_session_id = $1")) {
    const target = String(values[0]);
    const t2 = tableOf(sql);
    if (!t2) return { rows: [] };
    const store2 = storeOf(t2);
    for (const [k, r] of store2) if (r.auth_session_id === target) store2.delete(k);
    return { rows: [] };
  }

  const t = tableOf(sql);
  if (!t) return { rows: [] };
  const store = storeOf(t);

  // cinatra#4217 — the RENEWAL: one statement claims the presented row, writes
  // the spent bearer back for its grace window and writes the successor
  // (`WITH claimed AS (DELETE ... RETURNING ...), grace AS (INSERT ... SELECT ...
  // FROM claimed) INSERT ... SELECT ... FROM claimed RETURNING ...`). Interpreted
  // from the statement's own text and FAIL-CLOSED: every guard is evaluated
  // against the row; a time column takes exactly its expression; every other
  // column must be a same-named copy of a column the DELETE returned, with a
  // value; anything else throws. A dropped guard, a fresh jti, a mistyped copy
  // or an uncapped expiry is therefore behaviour or an error, never a quiet pass.
  if (sql.startsWith("WITH claimed AS (DELETE FROM")) {
    renewClaimHook?.();
    return renewalStatement(sql, values, store);
  }

  // Sweep
  if (sql.includes("DELETE FROM") && sql.includes("expires_at < now()") && !sql.includes("RETURNING")) {
    for (const [k, r] of store) if (r.expires_at_ms < nowMs) store.delete(k);
    return { rows: [] };
  }

  if (sql.startsWith("INSERT INTO")) {
    // Parse the column list and VALUES order from the statement (positional).
    const cols = sql
      .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
      .split(",")
      .map((c) => c.trim());
    const row: AnyRow = { expires_at_ms: 0, consumed: false };
    let secsInterval = 0;
    // The make_interval(secs => $N) is the LAST positional value; everything
    // before maps 1:1 to cols (the trailing now() defaults are not bound).
    cols.forEach((col, i) => {
      row[col] = values[i];
    });
    // The interval seconds is the value at the index used by make_interval.
    const m = sql.match(/make_interval\(secs => \$(\d+)\)/);
    if (m) {
      secsInterval = Number(values[Number(m[1]) - 1] ?? 0);
    }
    row.expires_at_ms = nowMs + secsInterval * 1000;
    // `created_at` is a trailing now() DEFAULT — the DATABASE clock writes it,
    // so it is not among the bound values. Synthesized here for the same reason
    // expires_at is: it is one half of the ordering proof (transactions), and the
    // anchor of a renewed session's maximum lifetime (tokens, cinatra#4217).
    if (t === "txn" || t === "token") row.created_at_ms = nowMs;
    const key = t === "txn" ? String(row.txn_id) : t === "code" ? String(row.code_hash) : String(row.token_hash);
    store.set(key, row);
    return { rows: [] };
  }

  // cinatra#2631 (rework rounds 4 + 6) — the DATABASE compares its own two
  // insert-time stamps. Interpreted faithfully, INCLUDING SQL's NULL semantics:
  // a missing row on either side makes the comparison NULL, which is not `true`
  // and therefore proves nothing.
  if (sql.includes("session_predates")) {
    const sessionCreatedMs = sessionRows.get(String(values[0]));
    const txnRow = txnStore.get(String(values[1]));
    const txnCreatedMs = txnRow ? Number(txnRow.created_at_ms) : undefined;
    return {
      rows: [
        {
          session_predates:
            sessionCreatedMs === undefined || txnCreatedMs === undefined
              ? null
              : sessionCreatedMs < txnCreatedMs,
        },
      ],
    };
  }

  if (sql.startsWith("SELECT")) {
    const key = String(values[0]);
    const r = store.get(key);
    if (!r) return { rows: [] };
    const requireUnconsumed = sql.includes("consumed_at IS NULL");
    // A WHERE-clause expiry filter ("AND expires_at > now()") drops an expired
    // row from the result set; the COMPUTED column "(expires_at > now()) AS
    // not_expired" does NOT — it returns the row carrying the flag. Distinguish.
    const requireUnexpired =
      sql.includes("AND expires_at > now()") || sql.includes("WHERE expires_at > now()");
    if (requireUnconsumed && r.consumed) return { rows: [] };
    if (requireUnexpired && r.expires_at_ms <= nowMs) return { rows: [] };
    const out: Record<string, unknown> = { ...r };
    if (sql.includes("(expires_at > now()) AS not_expired")) {
      out.not_expired = r.expires_at_ms > nowMs;
    }
    return { rows: [out] };
  }

  // cinatra#2631 — the write-once record of what was displayed AND whose arrival
  // it belongs to. Interpreted faithfully, INCLUDING both halves of the guard,
  // so the first-write-wins property is exercised rather than assumed.
  if (sql.startsWith("UPDATE") && sql.includes("displayed_scopes = $2")) {
    const r = store.get(String(values[0]));
    if (!r || r.consumed || r.expires_at_ms <= nowMs) return { rows: [] };
    // The write-once guard: it may only replace the UNCLASSIFIED value. Note
    // SQL's NULL semantics — a legacy row's NULL matches no equality guard, so
    // it can never be claimed either (`NULL = '(unclassified)'` is UNKNOWN).
    if (sql.includes("displayed_scopes = $3") && r.displayed_scopes !== values[2]) {
      return { rows: [] };
    }
    // ...and the arrival half (rework round 7, finding 1): a record that already
    // names an arrival may not have a second one attached to it.
    if (
      sql.includes("screen_nonce_hash IS NULL") &&
      r.screen_nonce_hash !== undefined &&
      r.screen_nonce_hash !== null
    ) {
      return { rows: [] };
    }
    r.displayed_scopes = values[1];
    if (sql.includes("screen_nonce_hash = $4")) r.screen_nonce_hash = values[3];
    return { rows: [] };
  }

  if (sql.startsWith("UPDATE") && sql.includes("consumed_at = now()") && sql.includes("RETURNING")) {
    const key = String(values[0]);
    const r = store.get(key);
    if (!r || r.consumed || r.expires_at_ms <= nowMs) return { rows: [] };
    r.consumed = true;
    return { rows: [{ ...r }] };
  }

  if (sql.startsWith("DELETE") && sql.includes("RETURNING")) {
    const key = String(values[0]);
    const r = store.get(key);
    if (!r || r.expires_at_ms <= nowMs) return { rows: [] };
    store.delete(key);
    return { rows: [{ ...r }] };
  }

  if (sql.startsWith("DELETE")) {
    const key = String(values[0]);
    store.delete(key);
    return { rows: [] };
  }

  return { rows: [] };
}

beforeEach(() => {
  txnStore = new Map();
  codeStore = new Map();
  tokenStore = new Map();
  sessionRows = new Map();
  // Both sessions start signed in; a test that wants a sign-out deletes one.
  liveSessionIds = new Set([SESSION_A, SESSION_B]);
  nowMs = Date.UTC(2026, 5, 21, 12, 0, 0);
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);

  runPostgresQueriesSyncMock.mockImplementation(
    (input: { queries: { text: string; values?: unknown[] }[] }) =>
      input.queries.map((q) => exec(q.text, q.values ?? [])),
  );
  // Default: a single WordPress instance bound to the verified origin.
  readConnectorConfigMock.mockImplementation((key: string, fallback: unknown) => {
    if (key === "wordpress") {
      return { instances: [{ id: "inst-1", siteUrl: "https://wp.test" }] };
    }
    return fallback;
  });
  // cinatra#3715 — by default no handshake identity and no connect-site origin,
  // so every pre-existing case runs on the connector road alone.
  readInstanceIdentityMock.mockReturnValue(null);
  listActiveConnectSiteOriginsMock.mockReturnValue([]);
});

// PKCE: derive an S256 challenge from a verifier (mirrors verifyPkceS256).
function pkce(verifier: string) {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
// A valid 43..128-char verifier.
const VERIFIER = "a".repeat(64);
const { challenge: CHALLENGE } = pkce(VERIFIER);

const SITE_A: VerifiedSiteContext = {
  siteId: "11111111-1111-1111-1111-111111111111",
  client: "wordpress",
  orgId: "org-A",
  siteOrigin: "https://wp.test",
  credentialVersion: 1,
};
const SITE_B: VerifiedSiteContext = {
  siteId: "22222222-2222-2222-2222-222222222222",
  client: "wordpress",
  orgId: "org-B",
  siteOrigin: "https://other.test",
  credentialVersion: 1,
};

const STATE = "state-abcdefgh-123456";

function newTxn(site = SITE_A, overrides: Partial<Parameters<typeof createAuthTransaction>[0]> = {}) {
  return createAuthTransaction({
    site,
    agentSlug: "wordpress-content-editor",
    instancesConfigKey: "wordpress",
    codeChallenge: CHALLENGE,
    state: STATE,
    ...overrides,
  });
}

describe("isValidState", () => {
  it("accepts base64url-ish 8..256, rejects too-short / bad chars", () => {
    expect(isValidState("abcdefgh")).toBe(true);
    expect(isValidState("a".repeat(256))).toBe(true);
    expect(isValidState("short")).toBe(false); // < 8
    expect(isValidState("a".repeat(257))).toBe(false); // > 256
    expect(isValidState("has space!!")).toBe(false);
    expect(isValidState(123)).toBe(false);
  });
});

describe("resolveCanonicalInstanceForOrigin (strict)", () => {
  it("pins the single origin-matched instance", () => {
    expect(
      resolveCanonicalInstanceForOrigin({ instancesConfigKey: "wordpress", origin: "https://wp.test" }),
    ).toBe("inst-1");
  });
  it("denies (null) when zero rows match the origin", () => {
    expect(
      resolveCanonicalInstanceForOrigin({ instancesConfigKey: "wordpress", origin: "https://nope.test" }),
    ).toBeNull();
  });
  it("denies (null) when multiple rows match and no claim disambiguates", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [
        { id: "inst-1", siteUrl: "https://wp.test" },
        { id: "inst-2", siteUrl: "https://wp.test" },
      ],
    });
    expect(
      resolveCanonicalInstanceForOrigin({ instancesConfigKey: "wordpress", origin: "https://wp.test" }),
    ).toBeNull();
  });
  it("a claim may DISAMBIGUATE among origin-matched rows", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [
        { id: "inst-1", siteUrl: "https://wp.test" },
        { id: "inst-2", siteUrl: "https://wp.test" },
      ],
    });
    expect(
      resolveCanonicalInstanceForOrigin({
        instancesConfigKey: "wordpress",
        origin: "https://wp.test",
        claimedInstanceId: "inst-2",
      }),
    ).toBe("inst-2");
  });
  it("a claim naming a row OUTSIDE the origin set is denied (forged target)", () => {
    readConnectorConfigMock.mockReturnValue({
      instances: [
        { id: "inst-1", siteUrl: "https://wp.test" },
        { id: "inst-evil", siteUrl: "https://other.test" },
      ],
    });
    expect(
      resolveCanonicalInstanceForOrigin({
        instancesConfigKey: "wordpress",
        origin: "https://wp.test",
        claimedInstanceId: "inst-evil",
      }),
    ).toBeNull();
  });
});

describe("createAuthTransaction", () => {
  it("rejects a non-S256 / malformed code_challenge", () => {
    const r = newTxn(SITE_A, { codeChallenge: "too-short" });
    expect(r).toEqual({ ok: false, reason: "invalid_code_challenge" });
  });
  it("rejects an invalid state", () => {
    const r = newTxn(SITE_A, { state: "bad" });
    expect(r).toEqual({ ok: false, reason: "invalid_state" });
  });
  it("denies when the verified origin has no single canonical instance", () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    const r = newTxn(SITE_A);
    expect(r).toEqual({ ok: false, reason: "instance_unresolved" });
  });
  it("pins the verified context + server-derived instance and is loadable", () => {
    const r = newTxn(SITE_A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.instanceId).toBe("inst-1");
    const loaded = loadActiveTransaction(r.txnId);
    expect(loaded).toMatchObject({
      siteId: SITE_A.siteId,
      orgId: SITE_A.orgId,
      siteOrigin: SITE_A.siteOrigin,
      client: "wordpress",
      agentSlug: "wordpress-content-editor",
      instanceId: "inst-1",
      codeChallenge: CHALLENGE,
      state: STATE,
    });
  });
});

// ---------------------------------------------------------------------------
// cinatra#3715 — THE SIGN-IN ACCEPTS THE IDENTITY THE HANDSHAKE GAVE THE SITE.
//
// The handshake hands every site THIS APPLICATION'S OWN instance identity; the
// connector's "Connect site" mints a different id and nothing copies it back.
// The frame gate accepts the handshake's identity (cinatra#3328), so the sign-in
// must answer the same question the same way: the REAL resolver and the REAL
// frame-gate helper run here against stubbed stores, and every case compares
// the transaction's answer with the gate's own answer for the same inputs.
// ---------------------------------------------------------------------------
describe("cinatra#3715 — the transaction for a site connected through the handshake", () => {
  const OWN_ID = "11111111-2222-4333-8444-555555555555";
  const gateAnswer = (instanceId: string) =>
    resolveInstanceFrameAncestor({
      instancesConfigKey: "wordpress",
      instanceId,
      connectSiteFallbackClient: "wordpress",
    });

  beforeEach(() => {
    // The measured state: ONE active connect_sites row for the client, NO
    // connector_config:wordpress instance at all.
    readConnectorConfigMock.mockImplementation((key: string, fallback: unknown) =>
      key === "wordpress" ? { instances: [] } : fallback,
    );
    readInstanceIdentityMock.mockReturnValue({ instanceId: OWN_ID });
    listActiveConnectSiteOriginsMock.mockReturnValue(["https://wp.test"]);
  });

  it("pins a site that holds only its connect_sites row to the application's own identity (was instance_unresolved)", () => {
    const r = newTxn(SITE_A, { claimedInstanceId: OWN_ID });
    expect(r).toEqual({ ok: true, txnId: expect.any(String), instanceId: OWN_ID });
    if (!r.ok) return;
    expect(loadActiveTransaction(r.txnId)).toMatchObject({
      siteId: SITE_A.siteId,
      orgId: SITE_A.orgId,
      siteOrigin: SITE_A.siteOrigin,
      client: "wordpress",
      instanceId: OWN_ID,
    });
    // The gate frames the same identity on the same origin.
    expect(gateAnswer(OWN_ID)).toBe(SITE_A.siteOrigin);
  });

  it("the pinned instance is the server's own identity read, and only a sign-in caller opts in", () => {
    expect(
      resolveCanonicalInstanceForOrigin({
        instancesConfigKey: "wordpress",
        origin: "https://wp.test",
        claimedInstanceId: OWN_ID,
        connectSiteFallbackClient: "wordpress",
      }),
    ).toBe(OWN_ID);
    // A caller that names no connect client keeps the connector-only answer.
    expect(
      resolveCanonicalInstanceForOrigin({
        instancesConfigKey: "wordpress",
        origin: "https://wp.test",
        claimedInstanceId: OWN_ID,
      }),
    ).toBeNull();
  });

  it("REFUSES a caller-chosen id that is not the application's own identity (forged or foreign)", () => {
    expect(newTxn(SITE_A, { claimedInstanceId: "caller-chosen" })).toEqual({
      ok: false,
      reason: "instance_unresolved",
    });
    expect(gateAnswer("caller-chosen")).toBeNull();
  });

  it("REFUSES without a claim — the handshake road never picks an identity on its own", () => {
    expect(newTxn(SITE_A)).toEqual({ ok: false, reason: "instance_unresolved" });
  });

  it("the same site after it was added under the connector, presenting the connector's id, pins it exactly as before", () => {
    readConnectorConfigMock.mockImplementation((key: string, fallback: unknown) =>
      key === "wordpress"
        ? { instances: [{ id: "connector-minted-id", siteUrl: "https://wp.test" }] }
        : fallback,
    );
    const r = newTxn(SITE_A, { claimedInstanceId: "connector-minted-id" });
    expect(r).toEqual({ ok: true, txnId: expect.any(String), instanceId: "connector-minted-id" });
    // The connector road answered on its own; the handshake road was not asked.
    expect(readInstanceIdentityMock).not.toHaveBeenCalled();
    expect(listActiveConnectSiteOriginsMock).not.toHaveBeenCalled();
  });

  it("the same site after it was added under the connector, presenting the handshake's id, pins the handshake's id — the gate's answer", () => {
    readConnectorConfigMock.mockImplementation((key: string, fallback: unknown) =>
      key === "wordpress"
        ? { instances: [{ id: "connector-minted-id", siteUrl: "https://wp.test" }] }
        : fallback,
    );
    const r = newTxn(SITE_A, { claimedInstanceId: OWN_ID });
    expect(r).toEqual({ ok: true, txnId: expect.any(String), instanceId: OWN_ID });
    expect(gateAnswer(OWN_ID)).toBe(SITE_A.siteOrigin);
  });

  it("REFUSES zero or several distinct active site origins for the client, as the gate does", () => {
    for (const origins of [[], ["https://wp.test", "https://other.test"]]) {
      listActiveConnectSiteOriginsMock.mockReturnValue(origins);
      expect(newTxn(SITE_A, { claimedInstanceId: OWN_ID })).toEqual({
        ok: false,
        reason: "instance_unresolved",
      });
      expect(gateAnswer(OWN_ID)).toBeNull();
    }
  });

  it("REFUSES a site whose origin is not the one the handshake road derived", () => {
    // The client's single active origin is wp.test; a transaction for a site on
    // another origin can never be pinned to the handshake's identity.
    expect(newTxn(SITE_B, { claimedInstanceId: OWN_ID })).toEqual({
      ok: false,
      reason: "instance_unresolved",
    });
    expect(gateAnswer(OWN_ID)).not.toBe(SITE_B.siteOrigin);
  });

  it("REFUSES when the connector holds rows carrying the presented id — duplicate or elsewhere, never rescued", () => {
    for (const instances of [
      [
        { id: OWN_ID, siteUrl: "https://a.example" },
        { id: OWN_ID, siteUrl: "https://b.example" },
      ],
      [{ id: OWN_ID, siteUrl: "https://elsewhere.example" }],
    ]) {
      readConnectorConfigMock.mockImplementation((key: string, fallback: unknown) =>
        key === "wordpress" ? { instances } : fallback,
      );
      expect(newTxn(SITE_A, { claimedInstanceId: OWN_ID })).toEqual({
        ok: false,
        reason: "instance_unresolved",
      });
      expect(gateAnswer(OWN_ID)).not.toBe(SITE_A.siteOrigin);
    }
  });

  it("REFUSES when the application's identity is missing or its read throws (fail closed)", () => {
    readInstanceIdentityMock.mockReturnValue(null);
    expect(newTxn(SITE_A, { claimedInstanceId: OWN_ID })).toEqual({
      ok: false,
      reason: "instance_unresolved",
    });
    expect(gateAnswer(OWN_ID)).toBeNull();
    readInstanceIdentityMock.mockImplementation(() => {
      throw new Error("identity row corrupt");
    });
    expect(newTxn(SITE_A, { claimedInstanceId: OWN_ID })).toEqual({
      ok: false,
      reason: "instance_unresolved",
    });
    expect(gateAnswer(OWN_ID)).toBeNull();
  });

  it("the visitor completes it: the code redeems, the token carries the pinned identity and the first turn's re-pin confirms it", () => {
    getActiveConnectSiteByIdMock.mockImplementation((siteId: string) =>
      siteId === SITE_A.siteId
        ? {
            siteId: SITE_A.siteId,
            client: "wordpress",
            widgetOrigin: SITE_A.siteOrigin,
            orgId: SITE_A.orgId,
            credentialVersion: SITE_A.credentialVersion,
          }
        : null,
    );
    const t = newTxn(SITE_A, { claimedInstanceId: OWN_ID });
    if (!t.ok) throw new Error("txn");
    const issued = issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" });
    if (!issued.ok) throw new Error("issue");
    const redeemed = redeemUserAuthCode({
      code: issued.code,
      codeVerifier: VERIFIER,
      site: SITE_A,
      issuerBaseUrl: "https://cinatra.test",
    });
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    const consumed = consumeUserWidgetToken({
      token: redeemed.token,
      agentSlug: "wordpress-content-editor",
      routePath: "/api/assistants/chat",
      requestOrigin: SITE_A.siteOrigin,
    });
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    expect(consumed.claims.instanceId).toBe(OWN_ID);
    // The chat route's per-turn re-pin (same inputs, same opt-in) confirms it;
    // without the opt-in it would refuse.
    expect(
      resolveCanonicalInstanceForOrigin({
        instancesConfigKey: "wordpress",
        origin: SITE_A.siteOrigin,
        claimedInstanceId: consumed.claims.instanceId,
        connectSiteFallbackClient: "wordpress",
      }),
    ).toBe(OWN_ID);
    expect(
      resolveCanonicalInstanceForOrigin({
        instancesConfigKey: "wordpress",
        origin: SITE_A.siteOrigin,
        claimedInstanceId: consumed.claims.instanceId,
      }),
    ).toBeNull();
  });
});

describe("issueUserAuthCode — single-use transaction consume", () => {
  it("issues a code carrying the txn binding + the userId", () => {
    const t = newTxn(SITE_A);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const issued = issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.siteOrigin).toBe(SITE_A.siteOrigin);
    expect(issued.state).toBe(STATE);
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url

    // The stored row is keyed by the HASH of the code; the plaintext is never stored.
    const codeHash = __testing.sha256Base64Url(issued.code);
    expect(codeStore.has(codeHash)).toBe(true);
    expect([...codeStore.values()].some((r) => r.user_id === "user-1")).toBe(true);
  });
  it("a second issue for the same (already-consumed) txn fails", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) return;
    expect(issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" }).ok).toBe(true);
    const second = issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" });
    expect(second).toEqual({ ok: false, reason: "txn_not_found" });
  });
  it("an expired txn cannot issue a code", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) return;
    nowMs += (__testing.TRANSACTION_TTL_SECONDS + 1) * 1000;
    expect(issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" })).toEqual({
      ok: false,
      reason: "txn_not_found",
    });
  });
});

describe("redeemUserAuthCode — PKCE + single-use + cross-site binding", () => {
  function issueCodeFor(site = SITE_A) {
    const t = newTxn(site);
    if (!t.ok) throw new Error("txn failed");
    const issued = issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" });
    if (!issued.ok) throw new Error("issue failed");
    return issued.code;
  }

  it("happy path: redeems for an opaque cwu_ token, hash-at-rest", () => {
    const code = issueCodeFor(SITE_A);
    const r = redeemUserAuthCode({
      code,
      codeVerifier: VERIFIER,
      site: SITE_A,
      issuerBaseUrl: "https://cinatra.test",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token).toMatch(/^cwu_[A-Za-z0-9_-]{43}$/);
    expect(r.scope).toBe("wordpress-content-editor.user");
    expect(r.expiresIn).toBe(__testing.USER_TOKEN_TTL_SECONDS);
    // Only the hash is stored.
    const tokenHash = __testing.sha256Hex(r.token);
    expect(tokenStore.has(tokenHash)).toBe(true);
    expect([...tokenStore.values()].some((row) => row.token === r.token)).toBe(false);
  });

  it("rejects a wrong PKCE verifier (invalid_grant)", () => {
    const code = issueCodeFor(SITE_A);
    const r = redeemUserAuthCode({
      code,
      codeVerifier: "b".repeat(64),
      site: SITE_A,
      issuerBaseUrl: "https://cinatra.test",
    });
    expect(r).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("a code minted for site A CANNOT be redeemed via site B's credential (site_mismatch)", () => {
    const code = issueCodeFor(SITE_A);
    const r = redeemUserAuthCode({
      code,
      codeVerifier: VERIFIER,
      site: SITE_B, // different site presenting its own cnx_
      issuerBaseUrl: "https://cinatra.test",
    });
    expect(r).toEqual({ ok: false, reason: "site_mismatch" });
  });

  it("a code is single-use: a replay fails (invalid_grant)", () => {
    const code = issueCodeFor(SITE_A);
    expect(
      redeemUserAuthCode({ code, codeVerifier: VERIFIER, site: SITE_A, issuerBaseUrl: "https://cinatra.test" }).ok,
    ).toBe(true);
    const replay = redeemUserAuthCode({
      code,
      codeVerifier: VERIFIER,
      site: SITE_A,
      issuerBaseUrl: "https://cinatra.test",
    });
    expect(replay).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("an expired code cannot be redeemed", () => {
    const code = issueCodeFor(SITE_A);
    nowMs += (__testing.CODE_TTL_SECONDS + 1) * 1000;
    expect(
      redeemUserAuthCode({ code, codeVerifier: VERIFIER, site: SITE_A, issuerBaseUrl: "https://cinatra.test" }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
  });
});

describe("consumeUserWidgetToken — live binding re-checks (CHILD 3 surface)", () => {
  // cinatra#1221 S5 AUDIENCE RE-SCOPE — the cwu_ token's aud is now the UNIFIED
  // assistant chat route; consume authorizes against it.
  const STREAM_PATH = "/api/assistants/chat";

  function mintToken(site = SITE_A) {
    const t = newTxn(site);
    if (!t.ok) throw new Error("txn");
    const issued = issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" });
    if (!issued.ok) throw new Error("issue");
    const r = redeemUserAuthCode({
      code: issued.code,
      codeVerifier: VERIFIER,
      site,
      issuerBaseUrl: "https://cinatra.test",
    });
    if (!r.ok) throw new Error("redeem");
    return r.token;
  }

  beforeEach(() => {
    // The live connect-site re-check: site A is active with its org/origin and
    // the SAME credential generation the token was minted against.
    getActiveConnectSiteByIdMock.mockImplementation((siteId: string) => {
      if (siteId === SITE_A.siteId) {
        return {
          siteId: SITE_A.siteId,
          client: "wordpress",
          widgetOrigin: SITE_A.siteOrigin,
          orgId: SITE_A.orgId,
          credentialVersion: SITE_A.credentialVersion,
        };
      }
      return null;
    });
  });

  it("rejects a non-cwu_ token", () => {
    const r = consumeUserWidgetToken({
      token: "cit_notours",
      agentSlug: "wordpress-content-editor",
      routePath: STREAM_PATH,
      requestOrigin: SITE_A.siteOrigin,
    });
    expect(r).toEqual({ ok: false, reason: "not_cwu_token" });
  });

  it("happy path: returns the bound user claims", () => {
    const token = mintToken(SITE_A);
    const r = consumeUserWidgetToken({
      token,
      agentSlug: "wordpress-content-editor",
      routePath: STREAM_PATH,
      requestOrigin: SITE_A.siteOrigin,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claims).toMatchObject({
      userId: "user-1",
      orgId: SITE_A.orgId,
      siteId: SITE_A.siteId,
      siteOrigin: SITE_A.siteOrigin,
      agentSlug: "wordpress-content-editor",
      instanceId: "inst-1",
    });
  });

  it("rejects when the request Origin != the token's bound origin", () => {
    const token = mintToken(SITE_A);
    const r = consumeUserWidgetToken({
      token,
      agentSlug: "wordpress-content-editor",
      routePath: STREAM_PATH,
      requestOrigin: "https://evil.test",
    });
    expect(r).toEqual({ ok: false, reason: "origin_mismatch" });
  });

  it("rejects on agent mismatch and aud mismatch", () => {
    const token = mintToken(SITE_A);
    expect(
      consumeUserWidgetToken({
        token,
        agentSlug: "drupal-content-editor",
        routePath: "/api/agents/drupal-content-editor/stream",
        requestOrigin: SITE_A.siteOrigin,
      }),
    ).toEqual({ ok: false, reason: "agent_mismatch" });

    expect(
      consumeUserWidgetToken({
        token,
        agentSlug: "wordpress-content-editor",
        routePath: "/api/agents/wordpress-content-editor/WRONG",
        requestOrigin: SITE_A.siteOrigin,
      }),
    ).toEqual({ ok: false, reason: "aud_mismatch" });
  });

  it("rejects when the connect-site was revoked / re-bound (site_revoked)", () => {
    const token = mintToken(SITE_A);
    getActiveConnectSiteByIdMock.mockReturnValue(null); // site revoked
    expect(
      consumeUserWidgetToken({
        token,
        agentSlug: "wordpress-content-editor",
        routePath: STREAM_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }),
    ).toEqual({ ok: false, reason: "site_revoked" });
  });

  it("rejects after the site credential is ROTATED (reconnect bumps credential_version; site stays active)", () => {
    // codex convergence: a reconnect ROTATES the same active connect_sites row
    // (credential_version++) WITHOUT revoking it — same org/origin/client. The
    // token was minted against version 1; the live row is now version 2, so the
    // outstanding `cwu_` must die immediately (mirrors the site-scoped broker's
    // token_key_fingerprint rotation gate), not survive until its TTL.
    const token = mintToken(SITE_A);
    getActiveConnectSiteByIdMock.mockReturnValue({
      siteId: SITE_A.siteId,
      client: "wordpress",
      widgetOrigin: SITE_A.siteOrigin,
      orgId: SITE_A.orgId,
      credentialVersion: SITE_A.credentialVersion + 1, // rotated
    });
    expect(
      consumeUserWidgetToken({
        token,
        agentSlug: "wordpress-content-editor",
        routePath: STREAM_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }),
    ).toEqual({ ok: false, reason: "site_revoked" });
  });

  it("rejects an expired token", () => {
    const token = mintToken(SITE_A);
    nowMs += (__testing.USER_TOKEN_TTL_SECONDS + 1) * 1000;
    expect(
      consumeUserWidgetToken({
        token,
        agentSlug: "wordpress-content-editor",
        routePath: STREAM_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });
});

// ---------------------------------------------------------------------------
// cinatra#2574 (epic #2564 S8a) — the LIFECYCLE-READ grant.
//
// AC-1 in full: a widget session minted before the scope extension existed
// cannot read lifecycle data until a NEW authorization carrying the grant is
// issued. The whole create→issue→redeem→verify lifecycle runs against the same
// in-memory tables the rest of this file uses, so "predates" is a real code with
// no recorded grant redeemed into a real token, not a hand-written row.
//
// WHAT THIS HARNESS DOES NOT RUN, stated so the names below cannot mislead
// (codex rework round 0, finding 3): it calls the token engine directly. It does
// not authenticate anyone and it does not go through the hosted page or its
// server action, so it proves what the ENGINE guarantees — a grant reaches a
// token only by riding a fresh authorization code, and an already-minted token
// never acquires one — not that a human re-entered a password. cinatra#2631
// makes the hosted flow record the grant at sign-in; who is asked to sign in is
// the page's business, and `src/app/widget-auth/__tests__` covers it.
// ---------------------------------------------------------------------------
describe("lifecycle-read scope + audience (cinatra#2574)", () => {
  const CHAT_PATH = "/api/assistants/chat";

  function mintTokenWithGrant(grantedScopes?: readonly WidgetExtensionScope[]) {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const issued = issueUserAuthCode({ authSessionId: SESSION_A,
      txnId: t.txnId,
      userId: "user-1",
      ...(grantedScopes ? { grantedScopes } : {}),
    });
    if (!issued.ok) throw new Error("issue");
    const r = redeemUserAuthCode({
      code: issued.code,
      codeVerifier: VERIFIER,
      site: SITE_A,
      issuerBaseUrl: "https://cinatra.test",
    });
    if (!r.ok) throw new Error("redeem");
    return r;
  }

  beforeEach(() => {
    getActiveConnectSiteByIdMock.mockImplementation((siteId: string) =>
      siteId === SITE_A.siteId
        ? {
            siteId: SITE_A.siteId,
            client: "wordpress",
            widgetOrigin: SITE_A.siteOrigin,
            orgId: SITE_A.orgId,
            credentialVersion: SITE_A.credentialVersion,
          }
        : null,
    );
  });

  it("AC-1: a token from a PRE-EXTENSION authorization cannot read lifecycle data", () => {
    // An authorization recorded before the grant existed carries no granted_scopes.
    const minted = mintTokenWithGrant(undefined);
    // Its scope + audience are byte-identical to the pre-#2574 mint.
    expect(minted.scope).toBe("wordpress-content-editor.user");

    // The lifecycle audience is not in its audience set...
    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
        requestOrigin: SITE_A.siteOrigin,
        requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
      }),
    ).toEqual({ ok: false, reason: "aud_mismatch" });

    // ...and the scope gate refuses it independently, so neither gate is
    // load-bearing alone (checked at the chat audience, which it DOES hold).
    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: CHAT_PATH,
        requestOrigin: SITE_A.siteOrigin,
        requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
      }),
    ).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("AC-1: the SAME session keeps working for chat — the grant is additive, not a cutover", () => {
    const minted = mintTokenWithGrant(undefined);
    const r = consumeUserWidgetToken({
      token: minted.token,
      agentSlug: "wordpress-content-editor",
      routePath: CHAT_PATH,
      requestOrigin: SITE_A.siteOrigin,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claims.grantedScopes).toEqual([]);
  });

  it("AC-1: only a NEW authorization carrying the grant lets the lifecycle read pass", () => {
    const minted = mintTokenWithGrant(WIDGET_SIGNIN_GRANTED_SCOPES);
    // A sign-in grants BOTH lifecycle scopes as of cinatra#2575's correction —
    // reading work and deciding it, exactly as inside Cinatra. Asserted as set
    // membership so the assertion is about the grant, not about ordering.
    expect(minted.scope.split(" ").sort()).toEqual(
      ["wordpress-content-editor.user", ...WIDGET_SIGNIN_GRANTED_SCOPES].sort(),
    );

    const r = consumeUserWidgetToken({
      token: minted.token,
      agentSlug: "wordpress-content-editor",
      routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
      requestOrigin: SITE_A.siteOrigin,
      requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.claims.grantedScopes].sort()).toEqual(
      [...WIDGET_SIGNIN_GRANTED_SCOPES].sort(),
    );

    // The extended token still takes chat turns — the base scope and the chat
    // audience are unchanged members of their sets.
    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: CHAT_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }).ok,
    ).toBe(true);
  });

  it("every other binding still gates the extended token (origin, agent, revoke)", () => {
    const minted = mintTokenWithGrant(WIDGET_SIGNIN_GRANTED_SCOPES);
    const lifecycleRead = (over: Record<string, unknown>) =>
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
        requestOrigin: SITE_A.siteOrigin,
        requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
        ...over,
      });

    expect(lifecycleRead({ requestOrigin: "https://evil.test" })).toEqual({
      ok: false,
      reason: "origin_mismatch",
    });
    expect(lifecycleRead({ agentSlug: "drupal-content-editor" })).toEqual({
      ok: false,
      reason: "agent_mismatch",
    });
    getActiveConnectSiteByIdMock.mockReturnValue(null);
    expect(lifecycleRead({})).toEqual({ ok: false, reason: "site_revoked" });
  });

  it("an UNKNOWN granted scope is dropped at the code — it can never reach a token", () => {
    const minted = mintTokenWithGrant([
      "lifecycle.decide-everything",
    ] as unknown as readonly WidgetExtensionScope[]);
    expect(minted.scope).toBe("wordpress-content-editor.user");
    // And it unlocks no audience of its own.
    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }),
    ).toEqual({ ok: false, reason: "aud_mismatch" });
  });

  it("a tampered scope column cannot mint authority the vocabulary does not know", () => {
    // Simulate a row edited under the app: an unknown scope entry sits beside
    // the base scope. It is INERT — the base scope still admits a chat turn, the
    // unknown entry grants nothing, and the required lifecycle scope is absent.
    const minted = mintTokenWithGrant(undefined);
    const tokenHash = __testing.sha256Hex(minted.token);
    const row = tokenStore.get(tokenHash)!;
    row.scope = "wordpress-content-editor.user superuser";

    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: CHAT_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }).ok,
    ).toBe(true);
    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: CHAT_PATH,
        requestOrigin: SITE_A.siteOrigin,
        requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
      }),
    ).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("the audience is DERIVED from the grant — a stored audience alone buys nothing", () => {
    // Mint with the grant, then strip the SCOPE from the stored row, leaving the
    // lifecycle route sitting in the audience column. The consume re-derives the
    // admissible surfaces from the scopes the token still demonstrably carries
    // (codex round 0, finding 4), so the orphaned audience entry is refused —
    // and refused at the AUDIENCE gate, before the scope gate is even reached.
    const minted = mintTokenWithGrant(WIDGET_SIGNIN_GRANTED_SCOPES);
    const row = tokenStore.get(__testing.sha256Hex(minted.token))!;
    row.scope = "wordpress-content-editor.user";
    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
        requestOrigin: SITE_A.siteOrigin,
        requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
      }),
    ).toEqual({ ok: false, reason: "aud_mismatch" });
    // The same token still takes chat turns — the base scope and the chat
    // audience are untouched.
    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: CHAT_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }).ok,
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // THE WRITE HALF's grant control (cinatra#2683 item 1). ONE audience, two
  // verbs, two scopes — so "granted the read, not the write" is a state the
  // system can actually be in, and this is it.
  // -------------------------------------------------------------------------
  it("a session granted only conversation.READ can restore a transcript and cannot append to one", () => {
    const minted = mintTokenWithGrant([WIDGET_CONVERSATION_READ_SCOPE]);
    const ask = (requiredScopes: readonly WidgetExtensionScope[]) =>
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: WIDGET_CHAT_THREADS_ROUTE_PATH,
        requestOrigin: SITE_A.siteOrigin,
        requiredScopes,
      });
    // POSITIVE CONTROL: the READ at this audience is admitted, so the refusal
    // below is attributable to the SCOPE and to nothing else — not to the
    // audience, not to the origin, not to the token.
    expect(ask([WIDGET_CONVERSATION_READ_SCOPE]).ok).toBe(true);
    // ...and the WRITE at the SAME audience, with the SAME token, is refused.
    expect(ask([WIDGET_CONVERSATION_WRITE_SCOPE])).toEqual({
      ok: false,
      reason: "scope_mismatch",
    });
  });

  it("the write scope admits the threads audience — a full grant reaches both verbs", () => {
    // The other direction of the same pair: a session granted the whole set
    // (what a sign-in mints today) reaches the write, so the refusal above is a
    // property of the GRANT rather than of an audience nobody can ever reach.
    const minted = mintTokenWithGrant(WIDGET_SIGNIN_GRANTED_SCOPES);
    const bothVerbs: readonly WidgetExtensionScope[] = [
      WIDGET_CONVERSATION_READ_SCOPE,
      WIDGET_CONVERSATION_WRITE_SCOPE,
    ];
    for (const scope of bothVerbs) {
      expect(
        consumeUserWidgetToken({
          token: minted.token,
          agentSlug: "wordpress-content-editor",
          routePath: WIDGET_CHAT_THREADS_ROUTE_PATH,
          requestOrigin: SITE_A.siteOrigin,
          requiredScopes: [scope],
        }).ok,
      ).toBe(true);
    }
  });

  it("a PRE-EXTENSION token reaches neither verb of the threads audience", () => {
    // AC-1 for this pair: an authorization recorded before the conversation
    // grants existed keeps behaving exactly as it did — the widget writes
    // nothing and restores nothing until the person signs in again.
    const minted = mintTokenWithGrant(undefined);
    const bothVerbs: readonly WidgetExtensionScope[] = [
      WIDGET_CONVERSATION_READ_SCOPE,
      WIDGET_CONVERSATION_WRITE_SCOPE,
    ];
    for (const scope of bothVerbs) {
      expect(
        consumeUserWidgetToken({
          token: minted.token,
          agentSlug: "wordpress-content-editor",
          routePath: WIDGET_CHAT_THREADS_ROUTE_PATH,
          requestOrigin: SITE_A.siteOrigin,
          requiredScopes: [scope],
        }).ok,
      ).toBe(false);
    }
  });

  it("a required scope this build does not define is REFUSED, not matched", () => {
    // codex round 0, finding 4: `requiredScopes` is only TypeScript-constrained
    // at the call site. At runtime an unrecognized requirement must fail closed
    // rather than be compared against a raw column — otherwise a stale caller
    // and a tampered row could meet on a name neither side understands.
    const minted = mintTokenWithGrant(WIDGET_SIGNIN_GRANTED_SCOPES);
    const row = tokenStore.get(__testing.sha256Hex(minted.token))!;
    row.scope = `wordpress-content-editor.user ${WIDGET_LIFECYCLE_READ_SCOPE} future.scope`;
    expect(
      consumeUserWidgetToken({
        token: minted.token,
        agentSlug: "wordpress-content-editor",
        routePath: CHAT_PATH,
        requestOrigin: SITE_A.siteOrigin,
        requiredScopes: ["future.scope"] as unknown as readonly WidgetExtensionScope[],
      }),
    ).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("the schema is ensured BEFORE any statement naming the new column", () => {
    // codex round 0, finding 6 — this repo's migration mechanism is boot-time
    // idempotent DDL (`ensurePostgresSchema`, which runs the CREATE ... IF NOT
    // EXISTS plus the ADD COLUMN IF NOT EXISTS), not a separate migration lane.
    // The safety of naming `granted_scopes` in an INSERT and in a RETURNING
    // therefore rests on that call happening FIRST on every entry point. Pin it,
    // because the failure if it ever stopped is total: every widget login breaks.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    ensureSchemaMock.mockClear();
    runPostgresQueriesSyncMock.mockClear();
    const issued = issueUserAuthCode({ authSessionId: SESSION_A,
      txnId: t.txnId,
      userId: "user-1",
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
    });
    if (!issued.ok) throw new Error("issue");
    expect(ensureSchemaMock.mock.invocationCallOrder[0]).toBeLessThan(
      runPostgresQueriesSyncMock.mock.invocationCallOrder[0]!,
    );

    ensureSchemaMock.mockClear();
    runPostgresQueriesSyncMock.mockClear();
    redeemUserAuthCode({
      code: issued.code,
      codeVerifier: VERIFIER,
      site: SITE_A,
      issuerBaseUrl: "https://cinatra.test",
    });
    expect(ensureSchemaMock.mock.invocationCallOrder[0]).toBeLessThan(
      runPostgresQueriesSyncMock.mock.invocationCallOrder[0]!,
    );
  });

  it("an agent slug that is not one scope member cannot mint a token at all", () => {
    // codex round 0, finding 3. The redeem refuses generically rather than
    // encoding a scope column whose second member is a capability.
    const t = createAuthTransaction({
      site: SITE_A,
      agentSlug: "wordpress lifecycle.read",
      instancesConfigKey: "wordpress",
      codeChallenge: CHALLENGE,
      state: STATE,
    });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const issued = issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(
      redeemUserAuthCode({
        code: issued.code,
        codeVerifier: VERIFIER,
        site: SITE_A,
        issuerBaseUrl: "https://cinatra.test",
      }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
  });
});

describe("rotation TOCTOU regression (cinatra#407 merge-time codex finding)", () => {
  // The headline invariant: a `cnx_` rotation invalidates outstanding user
  // tokens immediately. The TOCTOU was: resolveVerifiedSiteFromCredential
  // hash-checked the credential against row read #1 but pinned the
  // credentialVersion from a SECOND read — so an OLD credential validating in
  // the rotation race window inherited the NEW version, and the minted `cwu_`
  // then survived the rotation. The fix derives the version from the SAME row
  // the credential was hash-checked against (single read in
  // validateConnectServerCredential), so the minted token carries the OLD
  // (pre-rotation) version and dies at the consume-time live re-check.

  // cinatra#1221 S5 AUDIENCE RE-SCOPE — the cwu_ token binds the unified chat aud.
  const STREAM_PATH = "/api/assistants/chat";

  // Mint a cwu_ exactly as the token route would: resolve the verified site
  // from the presented cnx_ (real resolveVerifiedSiteFromCredential, fed by the
  // mocked validator returning the SAME-ROW binding), then redeem an auth code
  // against that resolved context.
  function mintViaCredential(validatorBinding: Record<string, unknown>) {
    validateConnectServerCredentialMock.mockReturnValue(validatorBinding);
    const site = resolveVerifiedSiteFromCredential({
      credential: "cnx_presented",
      requestOrigin: SITE_A.siteOrigin,
      expectedClient: "wordpress",
    });
    if (!site) throw new Error("resolve failed");
    const t = createAuthTransaction({
      site,
      agentSlug: "wordpress-content-editor",
      instancesConfigKey: "wordpress",
      codeChallenge: CHALLENGE,
      state: STATE,
    });
    if (!t.ok) throw new Error("txn failed");
    const issued = issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" });
    if (!issued.ok) throw new Error("issue failed");
    const r = redeemUserAuthCode({
      code: issued.code,
      codeVerifier: VERIFIER,
      site,
      issuerBaseUrl: "https://cinatra.test",
    });
    if (!r.ok) throw new Error("redeem failed");
    return r.token;
  }

  it("an OLD credential validating in the rotation window pins the OLD version → its cwu_ is rejected after rotation", () => {
    // The presented credential authenticated against the row at generation 1
    // (validateConnectServerCredential hash-checked THAT row and returns
    // credentialVersion: 1 — the fix). Even though a concurrent rotation is
    // about to bump the live row to generation 2, the minted token is bound to
    // version 1.
    const token = mintViaCredential({
      siteId: SITE_A.siteId,
      client: "wordpress",
      orgId: SITE_A.orgId,
      widgetOrigin: SITE_A.siteOrigin,
      credentialVersion: 1, // bound to the hash-checked (old) credential
    });

    // Now the cnx_ is ROTATED: the live connect-site row advances to generation
    // 2 (reconnect bumps credential_version WITHOUT revoking — same org/origin).
    getActiveConnectSiteByIdMock.mockReturnValue({
      siteId: SITE_A.siteId,
      client: "wordpress",
      widgetOrigin: SITE_A.siteOrigin,
      orgId: SITE_A.orgId,
      credentialVersion: 2, // rotated
    });

    // The outstanding cwu_ (pinned to version 1) must die immediately at the
    // stream-route consume — the rotation invariant holds.
    expect(
      consumeUserWidgetToken({
        token,
        agentSlug: "wordpress-content-editor",
        routePath: STREAM_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }),
    ).toEqual({ ok: false, reason: "site_revoked" });
  });

  it("REGRESSION GUARD: if the version were taken from a fresher (rotated) read, the token would WRONGLY survive — assert it does NOT", () => {
    // Demonstrate the bug shape and that the fix defeats it: had the version
    // been read post-rotation (generation 2), the minted token would carry 2 and
    // PASS the consume-time equality against the rotated live row. With the fix,
    // the token carries 1 (the hash-checked credential's generation) and FAILS.
    const token = mintViaCredential({
      siteId: SITE_A.siteId,
      client: "wordpress",
      orgId: SITE_A.orgId,
      widgetOrigin: SITE_A.siteOrigin,
      credentialVersion: 1,
    });
    getActiveConnectSiteByIdMock.mockReturnValue({
      siteId: SITE_A.siteId,
      client: "wordpress",
      widgetOrigin: SITE_A.siteOrigin,
      orgId: SITE_A.orgId,
      credentialVersion: 2,
    });
    const result = consumeUserWidgetToken({
      token,
      agentSlug: "wordpress-content-editor",
      routePath: STREAM_PATH,
      requestOrigin: SITE_A.siteOrigin,
    });
    // MUST be rejected — a stale-but-bumped version must never be accepted.
    expect(result.ok).toBe(false);
  });

  it("a token minted at the CURRENT (un-rotated) generation still consumes (no false rejection)", () => {
    const token = mintViaCredential({
      siteId: SITE_A.siteId,
      client: "wordpress",
      orgId: SITE_A.orgId,
      widgetOrigin: SITE_A.siteOrigin,
      credentialVersion: 1,
    });
    getActiveConnectSiteByIdMock.mockReturnValue({
      siteId: SITE_A.siteId,
      client: "wordpress",
      widgetOrigin: SITE_A.siteOrigin,
      orgId: SITE_A.orgId,
      credentialVersion: 1, // no rotation
    });
    expect(
      consumeUserWidgetToken({
        token,
        agentSlug: "wordpress-content-editor",
        routePath: STREAM_PATH,
        requestOrigin: SITE_A.siteOrigin,
      }).ok,
    ).toBe(true);
  });
});

describe("resolveVerifiedSiteFromCredential", () => {
  // cinatra#407 rotation TOCTOU fix: the verified context is built from the
  // SINGLE row that validateConnectServerCredential hash-checked. That validator
  // now returns the binding fields (siteId/client/orgId/widgetOrigin/
  // credentialVersion) of THAT row; resolveVerifiedSiteFromCredential does NOT
  // perform a second getActiveConnectSiteById read (which a concurrent rotation
  // could have advanced). The validator mock therefore carries the full binding.
  function validatedBinding(overrides: Record<string, unknown> = {}) {
    return {
      siteId: SITE_A.siteId,
      client: "wordpress",
      orgId: SITE_A.orgId,
      widgetOrigin: SITE_A.siteOrigin,
      credentialVersion: SITE_A.credentialVersion,
      ...overrides,
    };
  }

  it("returns the fully-bound site context on a valid cnx_", () => {
    validateConnectServerCredentialMock.mockReturnValue(validatedBinding());
    const ctx = resolveVerifiedSiteFromCredential({
      credential: "cnx_x",
      requestOrigin: SITE_A.siteOrigin,
      expectedClient: "wordpress",
    });
    expect(ctx).toEqual(SITE_A);
    // The fix MUST NOT do a second connect_sites read for the version — the
    // version is bound to the hash-checked credential, not a fresher row.
    expect(getActiveConnectSiteByIdMock).not.toHaveBeenCalled();
  });
  it("returns null when the credential is invalid", () => {
    validateConnectServerCredentialMock.mockReturnValue(null);
    expect(
      resolveVerifiedSiteFromCredential({
        credential: "bad",
        requestOrigin: SITE_A.siteOrigin,
        expectedClient: "wordpress",
      }),
    ).toBeNull();
  });
  it("returns null when the validated binding has no bound org", () => {
    validateConnectServerCredentialMock.mockReturnValue(validatedBinding({ orgId: null }));
    expect(
      resolveVerifiedSiteFromCredential({
        credential: "cnx_x",
        requestOrigin: SITE_A.siteOrigin,
        expectedClient: "wordpress",
      }),
    ).toBeNull();
  });
  it("returns null when the validated binding has a non-finite credentialVersion", () => {
    validateConnectServerCredentialMock.mockReturnValue(validatedBinding({ credentialVersion: Number.NaN }));
    expect(
      resolveVerifiedSiteFromCredential({
        credential: "cnx_x",
        requestOrigin: SITE_A.siteOrigin,
        expectedClient: "wordpress",
      }),
    ).toBeNull();
  });
  it("pins the credentialVersion of the hash-checked credential (a rotation cannot lift the bound version)", () => {
    // The credential authenticated at generation 3 (its hash matched a row at
    // version 3). Even if the live row is concurrently rotated to a higher
    // generation, the validator returns version 3 because it is bound to the row
    // it hash-checked — so the context the redeem path pins is 3, not the bumped
    // version. (The validator's same-row guarantee is covered in the stream-auth
    // suite; here we assert resolveVerifiedSiteFromCredential propagates it.)
    validateConnectServerCredentialMock.mockReturnValue(validatedBinding({ credentialVersion: 3 }));
    const ctx = resolveVerifiedSiteFromCredential({
      credential: "cnx_old",
      requestOrigin: SITE_A.siteOrigin,
      expectedClient: "wordpress",
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.credentialVersion).toBe(3);
    expect(getActiveConnectSiteByIdMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2631 — WHAT THE SIGN-IN SCREEN SHOWED, ON THE TRANSACTION.
//
// The hosted flow has no consent screen: signing in records the grant. The one
// thing that could then go wrong quietly is a person reading one list of
// sentences and a different set being recorded, which is exactly what a rolling
// deploy can produce. The server writes what it displayed onto the transaction
// so the two can be compared — and it lives there, not in the popup's URL,
// because a URL marker can be stripped and an absent marker must be admitted.
// ---------------------------------------------------------------------------
/** The no-screen token one session would earn. */
function noScreenTokenFor(sessionId: string): string {
  return widgetNoSignInScreenToken(
    widgetSessionFingerprint(sessionId),
    WIDGET_SIGNIN_GRANTED_SCOPES,
  );
}

/** Insert a Better Auth session ROW; the DATABASE stamps when it did so. */
function mintSessionRow(sessionId: string): void {
  sessionRows.set(sessionId, nowMs);
}

/**
 * Better Auth refreshes a session row (its `updateAge`, and an org switch). The
 * UPDATE rewrites `updatedAt`/`expiresAt` — and, if the proof read the row's
 * WRITE ID instead of a column, it would rewrite the proof too. Here it changes
 * nothing, which is the property under test (rework round 6).
 */
function refreshSessionRow(sessionId: string): void {
  // Deliberately a no-op on cinatra_db_created_at: an UPDATE cannot move a
  // column Better Auth does not write. The row must still BE there afterwards.
  if (!sessionRows.has(sessionId)) throw new Error("no such session row");
}

/**
 * Turn a stored transaction row into one an OLDER build created: the column
 * exists (the deploy added it) but nothing ever wrote it, which is SQL NULL.
 * Reaches into the in-memory store because no production path can produce this
 * — that is the point of the state.
 */
function legacyTxnRow(txnId: string): void {
  const row = txnStore.get(txnId);
  if (!row) throw new Error("no such txn");
  row.displayed_scopes = null;
  row.screen_nonce_hash = null;
}

/**
 * A record left by a node that predates the ARRIVAL binding: the displayed set
 * is there, the nonce hash is not (rework round 7, finding 1). The other half of
 * the mixed-version window this mechanism introduces — reached the same way
 * `legacyTxnRow` is, because no production path can produce it.
 */
function recordWithoutArrival(txnId: string, displayedScopes: string): void {
  const row = txnStore.get(txnId);
  if (!row) throw new Error("no such txn");
  row.displayed_scopes = displayedScopes;
  row.screen_nonce_hash = null;
}

/** One arrival's nonce, and the hash the transaction stores for it. */
function arrival(): { nonce: string; hash: string } {
  const nonce = mintWidgetScreenNonce();
  return { nonce, hash: widgetScreenNonceHash(nonce) };
}

describe("the displayed-scope record on the transaction (cinatra#2631)", () => {
  it("starts UNCLASSIFIED — a creation-time claim about what will render is not knowledge", () => {
    // codex rework round 3, finding 1. The column used to be created carrying
    // the NO-SCREEN sentinel, which is a statement about the FUTURE: a new node
    // created the transaction, an OLDER node then rendered its legacy signed-out
    // page recording nothing, and after the login a new node read back a
    // sentinel it had written itself and granted a set nobody displayed. So
    // creation asserts nothing, and the sentinel is written only where it can be
    // proved.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBe(
      WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
    );
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).not.toBe(
      noScreenTokenFor("sess-1"),
    );
    // ...and the value refuses the grant on its own, so a transaction nobody
    // accounted for cannot pass the action's check.
    expect(
      displayedScopesAgree(
        loadActiveTransaction(t.txnId)?.displayedScopes,
        WIDGET_SIGNIN_GRANTED_SCOPES,
        noScreenTokenFor("sess-1"),
      ),
    ).toBe(false);
  });

  it("records what the screen displayed, WHOSE arrival it was, and returns the STORED record", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const a = arrival();
    expect(recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", a.hash)).toEqual(
      { displayedScopes: "lifecycle.read", screenNonceHash: a.hash },
    );
    const loaded = loadActiveTransaction(t.txnId);
    expect(loaded?.displayedScopes).toBe("lifecycle.read");
    expect(loaded?.screenNonceHash).toBe(a.hash);
    // The NONCE ITSELF is never stored — only what it hashes to (round 7).
    expect(JSON.stringify([...txnStore.values()])).not.toContain(a.nonce);
  });

  it("writes NOTHING for a caller that cannot name its arrival", () => {
    // A record with no nonce is one any arrival could redeem, which is the hole.
    // Refusing to write is the only honest answer — there is no weaker record.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    for (const bad of ["", "not-hex", "abc", "A".repeat(64)]) {
      expect(recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", bad)).toBeNull();
    }
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBe(
      WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
    );
  });

  it("FIRST write wins, and the loser is TOLD it lost", () => {
    // Returning the offered value would let a second build render its own list
    // of sentences over a record that says something else (round 2, finding 1).
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const first = arrival();
    const second = arrival();
    recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", first.hash);
    expect(
      recordDisplayedScopesForTransaction(
        t.txnId,
        "lifecycle.read lifecycle.decide",
        second.hash,
      ),
    ).toEqual({ displayedScopes: "lifecycle.read", screenNonceHash: first.hash });
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBe("lifecycle.read");
  });

  it("a SECOND arrival cannot attach itself to a record that already names one", () => {
    // rework round 7, finding 1 — the write-once guard names BOTH columns, so an
    // arrival offering the same displayed set as the record still cannot make
    // that record its own.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const a = arrival();
    const b = arrival();
    recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", a.hash);
    expect(
      recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", b.hash),
    ).toEqual({ displayedScopes: "lifecycle.read", screenNonceHash: a.hash });
  });

  it("persists an EMPTY displayed set as a real value", () => {
    // A screen that named no extra grants is a screen. Collapsing it back to the
    // sentinel would let a later, wider build admit it (round 2, finding 3).
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const a = arrival();
    expect(recordDisplayedScopesForTransaction(t.txnId, "", a.hash)).toEqual({
      displayedScopes: "",
      screenNonceHash: a.hash,
    });
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBe("");
  });

  it("never consumes the transaction — the login screen may render twice", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const a = arrival();
    recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", a.hash);
    recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", a.hash);
    expect(loadActiveTransaction(t.txnId)).not.toBeNull();
    expect(issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" }).ok).toBe(true);
  });

  it("returns null for a transaction that is gone", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    expect(issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" }).ok).toBe(true);
    expect(
      recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", arrival().hash),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // codex rework round 3, finding 1 — WRITE-ONCE ACROSS THE NEW STATES. Two
  // writers now share this column (a screen that rendered, and a node that
  // proved none did), so the property that matters is that neither can paint
  // over the other: the FIRST thing known about a transaction is the record.
  // -------------------------------------------------------------------------
  it("a proved NO-SCREEN claim can never paint over a screen that really rendered", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const screen = arrival();
    expect(
      recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", screen.hash),
    ).toEqual({ displayedScopes: "lifecycle.read", screenNonceHash: screen.hash });
    // The observing node offers the sentinel; the record stands and it is TOLD.
    expect(
      recordDisplayedScopesForTransaction(
        t.txnId,
        noScreenTokenFor("sess-1"),
        arrival().hash,
      ),
    ).toEqual({ displayedScopes: "lifecycle.read", screenNonceHash: screen.hash });
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBe("lifecycle.read");
  });

  it("a screen rendering later can never paint over a proved NO-SCREEN claim", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const observer = arrival();
    expect(
      recordDisplayedScopesForTransaction(
        t.txnId,
        noScreenTokenFor("sess-1"),
        observer.hash,
      ),
    ).toEqual({
      displayedScopes: noScreenTokenFor("sess-1"),
      screenNonceHash: observer.hash,
    });
    expect(
      recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", arrival().hash),
    ).toEqual({
      displayedScopes: noScreenTokenFor("sess-1"),
      screenNonceHash: observer.hash,
    });
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBe(noScreenTokenFor("sess-1"));
  });

  it("the UNCLASSIFIED value is claimable exactly ONCE, by whichever writer knows something first", () => {
    const byScreen = newTxn(SITE_A);
    const byObserver = newTxn(SITE_A);
    if (!byScreen.ok || !byObserver.ok) throw new Error("txn");
    expect(
      recordDisplayedScopesForTransaction(byScreen.txnId, "lifecycle.read", arrival().hash)
        ?.displayedScopes,
    ).toBe("lifecycle.read");
    expect(
      recordDisplayedScopesForTransaction(
        byObserver.txnId,
        noScreenTokenFor("sess-1"),
        arrival().hash,
      )?.displayedScopes,
    ).toBe(noScreenTokenFor("sess-1"));
    // Neither transaction can be returned to "nothing is known" by offering the
    // unclassified value back — that would re-arm the claim for a later writer.
    for (const t of [byScreen, byObserver]) {
      if (!t.ok) throw new Error("txn");
      const before = loadActiveTransaction(t.txnId)?.displayedScopes;
      expect(
        recordDisplayedScopesForTransaction(
          t.txnId,
          WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
          arrival().hash,
        )?.displayedScopes,
      ).toBe(before);
      expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBe(before);
    }
  });

  it("a LEGACY transaction (NULL — created before the column) is claimable by NOBODY", () => {
    // The mixed-version window in the other direction: an older node created the
    // transaction, so the column carries SQL NULL, which matches no equality
    // guard. Neither writer can claim it, and the grant refuses it — the person
    // opens the assistant login again rather than being granted on a record
    // nothing wrote.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    legacyTxnRow(t.txnId);
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBeNull();
    // The write matches no row, so what comes back is the row as it stands:
    // nothing recorded, nobody's arrival. (A null RETURN means the transaction
    // itself is gone — a different fact, and the caller distinguishes them by
    // comparing what it offered.)
    const nothingKnown = { displayedScopes: null, screenNonceHash: null };
    expect(
      recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", arrival().hash),
    ).toEqual(nothingKnown);
    expect(
      recordDisplayedScopesForTransaction(
        t.txnId,
        noScreenTokenFor("sess-1"),
        arrival().hash,
      ),
    ).toEqual(nothingKnown);
    expect(loadActiveTransaction(t.txnId)?.displayedScopes).toBeNull();
    expect(
      screenRecordAdmitsArrival(nothingKnown, WIDGET_SIGNIN_GRANTED_SCOPES, {
        presentedNonceHash: arrival().hash,
        expectedNoScreenToken: noScreenTokenFor("sess-1"),
      }),
    ).toBe(false);
    expect(
      displayedScopesAgree(null, WIDGET_SIGNIN_GRANTED_SCOPES, noScreenTokenFor("sess-1")),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // codex rework round 7, finding 1 — THE RECORD BELONGS TO AN ARRIVAL. The
  // displayed set says WHAT was shown; the nonce says TO WHOM. Everything below
  // is about the second question, at the store seam.
  // -------------------------------------------------------------------------
  it("a record left WITHOUT an arrival (this mechanism's own mixed-version window) admits nobody", () => {
    // A node running the build before this one wrote a perfectly good displayed
    // set and no nonce. It reads exactly like the legacy NULL: not claimable by a
    // later arrival wanting to attach itself, and not redeemable by anyone.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    recordWithoutArrival(t.txnId, "lifecycle.read");
    const loaded = loadActiveTransaction(t.txnId);
    expect(loaded?.displayedScopes).toBe("lifecycle.read");
    expect(loaded?.screenNonceHash).toBeNull();
    expect(
      screenRecordAdmitsArrival(loaded, WIDGET_SIGNIN_GRANTED_SCOPES, {
        presentedNonceHash: arrival().hash,
      }),
    ).toBe(false);
    // ...and no later arrival can adopt it, because the write-once guard demands
    // the unclassified value, which this row no longer carries.
    expect(
      recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read", arrival().hash)
        ?.screenNonceHash,
    ).toBeNull();
  });

  it("admits the arrival that recorded the set, and only it", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const a = arrival();
    const b = arrival();
    recordDisplayedScopesForTransaction(
      t.txnId,
      widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES),
      a.hash,
    );
    const loaded = loadActiveTransaction(t.txnId);
    expect(
      screenRecordAdmitsArrival(loaded, WIDGET_SIGNIN_GRANTED_SCOPES, {
        presentedNonceHash: widgetScreenNonceHash(a.nonce),
      }),
    ).toBe(true);
    for (const wrong of [b.hash, "", "not-a-hash", a.nonce]) {
      expect(
        screenRecordAdmitsArrival(loaded, WIDGET_SIGNIN_GRANTED_SCOPES, {
          presentedNonceHash: wrong,
        }),
      ).toBe(false);
    }
  });

  it("the right arrival still cannot redeem the WRONG set", () => {
    // The two halves are independent: holding the nonce proves who you are, not
    // that what you read is what this build grants.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const a = arrival();
    recordDisplayedScopesForTransaction(t.txnId, "lifecycle.read lifecycle.decide", a.hash);
    expect(
      screenRecordAdmitsArrival(
        loadActiveTransaction(t.txnId),
        WIDGET_SIGNIN_GRANTED_SCOPES,
        { presentedNonceHash: a.hash },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2631 (codex rework round 4, finding 1) — THE PROOF, ORDERED BY THE
// DATABASE. "No sign-in screen rendered" is only ever written when the session
// ROW was already there when the transaction row was inserted. The ordering is
// the database's own write sequence (age(xmin)), NOT a timestamp: a session's
// createdAt is written by whichever node minted it, and the node that matters
// here — an old one still serving the legacy sign-in screen — has a clock this
// build does not control.
// ---------------------------------------------------------------------------
describe("sessionRowPredatesTransaction — one clock, and it is the database's", () => {
  it("a session row inserted BEFORE the transaction proves no screen rendered", () => {
    mintSessionRow("sess-old");
    nowMs += 60_000;
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    expect(sessionRowPredatesTransaction("sess-old", t.txnId)).toBe(true);
  });

  it("a session row inserted AFTER the transaction proves nothing — the mixed-version window", () => {
    // The person signed in during this flow. If it was on this build's screen,
    // the displayed set is already recorded; if it was an older node's legacy
    // page, nothing is recorded and the grant must refuse. Either way the
    // sentinel must not be written here.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    nowMs += 30_000;
    mintSessionRow("sess-new");
    expect(sessionRowPredatesTransaction("sess-new", t.txnId)).toBe(false);
  });

  it("a REFRESHED session keeps its proof — the ordinary already-signed-in path", () => {
    // codex rework round 6. Better Auth updates a session row once it is older
    // than its updateAge, and an org switch rewrites it too. Both happen on the
    // very request that renders this page. A proof read off the row's WRITE ID
    // would be destroyed by that update and the person — who genuinely held the
    // session for a day before the transaction existed — would be told to open
    // the assistant login again. The proof is a column Better Auth never writes,
    // so the refresh changes nothing.
    mintSessionRow("sess-day-old");
    nowMs += 25 * 60 * 60 * 1000;
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    refreshSessionRow("sess-day-old");
    expect(sessionRowPredatesTransaction("sess-day-old", t.txnId)).toBe(true);
  });

  it("NO node clock participates — a lagging signer cannot change the answer", () => {
    // The session is inserted while the fake clock reads far in the PAST of the
    // transaction that preceded it, which is the shape an old node with a
    // lagging clock produces. The DATABASE stamped both rows, so the answer is
    // unchanged: the session came second.
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const dbNow = nowMs;
    nowMs -= 60 * 60 * 1000; // the signing node's clock is an hour behind
    mintSessionRow("sess-skewed");
    nowMs = dbNow;
    // The fake stamps rows from the same clock the transaction used, exactly as
    // a DEFAULT does — so the skew never reaches the column at all.
    sessionRows.set("sess-skewed", dbNow + 1);
    expect(sessionRowPredatesTransaction("sess-skewed", t.txnId)).toBe(false);
  });

  it("fails closed on a session row that is not there", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    expect(sessionRowPredatesTransaction("sess-missing", t.txnId)).toBe(false);
  });

  it("fails closed on a transaction that is not there, and on empty ids", () => {
    mintSessionRow("sess-old");
    expect(sessionRowPredatesTransaction("sess-old", "no-such-txn")).toBe(false);
    expect(sessionRowPredatesTransaction("", "no-such-txn")).toBe(false);
    expect(sessionRowPredatesTransaction("sess-old", "")).toBe(false);
  });

  it("fails closed when the database itself raises", () => {
    // A deployment whose auth tables are not in `public` would. Proving nothing
    // must never grant, so the error is swallowed into a refusal rather than a
    // 500 on the person's screen.
    mintSessionRow("sess-old");
    nowMs += 1000;
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    runPostgresQueriesSyncMock.mockImplementationOnce(() => {
      throw new Error("relation \"public.session\" does not exist");
    });
    expect(sessionRowPredatesTransaction("sess-old", t.txnId)).toBe(false);
  });

  it("lets the DATABASE compare, in ONE statement, over the two insert-time columns", () => {
    mintSessionRow("sess-old");
    nowMs += 1000;
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    runPostgresQueriesSyncMock.mockClear();
    sessionRowPredatesTransaction("sess-old", t.txnId);
    const calls = runPostgresQueriesSyncMock.mock.calls.filter((c: unknown[]) =>
      String((c[0] as { queries: { text: string }[] }).queries[0].text).includes(
        "session_predates",
      ),
    );
    expect(calls).toHaveLength(1);
    const queries = (calls[0][0] as { queries: { text: string }[] }).queries;
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain('"public"."session"');
    expect(queries[0].text).toContain("cinatra_db_created_at");
    expect(queries[0].text).toContain("widget_auth_transactions");
    // Better Auth's own createdAt is a NODE's clock and is deliberately unread.
    expect(queries[0].text).not.toContain('"createdAt"');
    expect(queries[0].text).not.toContain("xmin");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2631 (codex rework round 5, finding 1) — the no-screen sentinel NAMES
// the session it was earned by, so it cannot stand for whoever comes next.
// ---------------------------------------------------------------------------
describe("widgetSessionFingerprint — one session, one name", () => {
  it("is stable, distinct per session, and never the session id itself", () => {
    const a = widgetSessionFingerprint("sess-A");
    expect(a).toBe(widgetSessionFingerprint("sess-A"));
    expect(a).not.toBe(widgetSessionFingerprint("sess-B"));
    expect(a).not.toContain("sess-A");
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it("names nothing for an unusable id, so no token can be built from one", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}]) {
      expect(widgetSessionFingerprint(bad)).toBe("");
      expect(
        widgetNoSignInScreenToken(widgetSessionFingerprint(bad), WIDGET_SIGNIN_GRANTED_SCOPES),
      ).toBe("");
    }
  });

  it("a sentinel earned by one session is refused for another", () => {
    const mine = noScreenTokenFor("sess-A");
    const theirs = noScreenTokenFor("sess-B");
    expect(displayedScopesAgree(theirs, WIDGET_SIGNIN_GRANTED_SCOPES, mine)).toBe(false);
    expect(displayedScopesAgree(mine, WIDGET_SIGNIN_GRANTED_SCOPES, mine)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2684 — SIGN-OUT MEANS SIGNED OUT, EVERYWHERE, AT ONCE.
//
// A `cwu_` widget row is now bound to the exact Better Auth session whose
// sign-in authorized it, and every verification re-asks whether that session is
// still there. These are the issue's acceptance criteria, each paired with the
// control that must still pass — a rejection nobody can distinguish from a
// broken flow proves nothing, so every "refused" case below sits next to the
// same call under a live session.
// ---------------------------------------------------------------------------
describe("the widget token dies with the session that authorized it (cinatra#2684)", () => {
  const CHAT_PATH = "/api/assistants/chat";

  beforeEach(() => {
    getActiveConnectSiteByIdMock.mockImplementation((siteId: string) =>
      siteId === SITE_A.siteId
        ? {
            siteId: SITE_A.siteId,
            client: "wordpress",
            widgetOrigin: SITE_A.siteOrigin,
            orgId: SITE_A.orgId,
            credentialVersion: SITE_A.credentialVersion,
          }
        : null,
    );
  });

  /** Run the whole hosted flow under ONE named session and return the bearer. */
  function mintTokenUnder(authSessionId: string, site = SITE_A): string {
    const t = newTxn(site);
    if (!t.ok) throw new Error("txn");
    const issued = issueUserAuthCode({ authSessionId, txnId: t.txnId, userId: "user-1" });
    if (!issued.ok) throw new Error(`issue: ${issued.reason}`);
    const r = redeemUserAuthCode({
      code: issued.code,
      codeVerifier: VERIFIER,
      site,
      issuerBaseUrl: "https://cinatra.test",
    });
    if (!r.ok) throw new Error(`redeem: ${r.reason}`);
    return r.token;
  }

  function turn(token: string) {
    return consumeUserWidgetToken({
      token,
      agentSlug: "wordpress-content-editor",
      routePath: CHAT_PATH,
      requestOrigin: SITE_A.siteOrigin,
    });
  }

  // AC-1. The regression test: a widget turn under a signed-out session refuses.
  // Its control is the SAME token one line earlier, while the session was live —
  // which is precisely what fails when the binding or the liveness check is
  // reverted, because then the token is accepted after the sign-out too.
  it("AC-1 after sign-out a widget turn with that session's token is refused", () => {
    const token = mintTokenUnder(SESSION_A);
    expect(turn(token).ok).toBe(true); // control: live session, same token

    liveSessionIds.delete(SESSION_A); // the sign-out

    expect(turn(token)).toEqual({ ok: false, reason: "session_revoked" });
  });

  it("the refused row is DELETED, so a second turn cannot even find it", () => {
    const token = mintTokenUnder(SESSION_A);
    liveSessionIds.delete(SESSION_A);
    expect(turn(token)).toEqual({ ok: false, reason: "session_revoked" });
    // The row is gone now — the reason changes from "your session ended" to
    // "there is no such token", which is what a swept row answers.
    expect(turn(token)).toEqual({ ok: false, reason: "not_found" });
  });

  // AC-4, first half. Revoking one exact session invalidates its bound rows.
  it("AC-4 revoking the exact session invalidates the rows bound to it", () => {
    const token = mintTokenUnder(SESSION_A);
    liveSessionIds.delete(SESSION_A);
    expect(turn(token).ok).toBe(false);
  });

  // AC-5 — THE PRECISION CONTROL. One person, two live sessions, two widget
  // tokens. Ending one must not touch the other. A cascade keyed on the USER
  // rather than the SESSION passes every other test on this page and fails only
  // this one, which is why it is here.
  it("AC-5 revoking ONE session leaves another live session's token working", () => {
    const tokenA = mintTokenUnder(SESSION_A);
    const tokenB = mintTokenUnder(SESSION_B);
    expect(turn(tokenA).ok).toBe(true);
    expect(turn(tokenB).ok).toBe(true);

    liveSessionIds.delete(SESSION_A); // sign out of ONE of them

    expect(turn(tokenA)).toEqual({ ok: false, reason: "session_revoked" });
    expect(turn(tokenB).ok).toBe(true); // …and the other is untouched
  });

  // AC-4, second half. Revoking ALL of a user's sessions kills every bound row,
  // because each session is asked about independently.
  it("AC-4 revoking every session of the user invalidates every bound row", () => {
    const tokenA = mintTokenUnder(SESSION_A);
    const tokenB = mintTokenUnder(SESSION_B);

    liveSessionIds.clear();

    expect(turn(tokenA).ok).toBe(false);
    expect(turn(tokenB).ok).toBe(false);
  });

  // AC-6 — the PRE-REDEMPTION revocation. The code is already issued and the CMS
  // backend still holds it; the person signs out before it is exchanged. No live
  // token may come out of that exchange.
  it("AC-6 a code whose session is revoked BEFORE redemption mints no token", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const issued = issueUserAuthCode({
      authSessionId: SESSION_A,
      txnId: t.txnId,
      userId: "user-1",
    });
    if (!issued.ok) throw new Error("issue");

    liveSessionIds.delete(SESSION_A); // signed out between issue and redeem

    expect(
      redeemUserAuthCode({
        code: issued.code,
        codeVerifier: VERIFIER,
        site: SITE_A,
        issuerBaseUrl: "https://cinatra.test",
      }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("AC-6 control: the same exchange under a LIVE session still mints a token", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const issued = issueUserAuthCode({
      authSessionId: SESSION_A,
      txnId: t.txnId,
      userId: "user-1",
    });
    if (!issued.ok) throw new Error("issue");
    const redeemed = redeemUserAuthCode({
      code: issued.code,
      codeVerifier: VERIFIER,
      site: SITE_A,
      issuerBaseUrl: "https://cinatra.test",
    });
    expect(redeemed.ok).toBe(true);
  });

  // AC-7. Nothing about a LIVE session's token changed: the TTL is the same
  // fifteen minutes, and every pre-existing liveness check still decides.
  it("AC-7 TTL and the existing live re-checks are unchanged for a live session", () => {
    const token = mintTokenUnder(SESSION_A);
    expect(turn(token).ok).toBe(true);

    // Same TTL boundary as before this slice.
    nowMs += (__testing.USER_TOKEN_TTL_SECONDS - 1) * 1000;
    expect(turn(token).ok).toBe(true);
    nowMs += 2000;
    expect(turn(token)).toEqual({ ok: false, reason: "expired" });

    // …and the site re-check still fires first-class on a fresh token.
    const token2 = mintTokenUnder(SESSION_A);
    getActiveConnectSiteByIdMock.mockReturnValue(null);
    expect(turn(token2)).toEqual({ ok: false, reason: "site_revoked" });
  });

  // The binding is only trustworthy if it can never be absent. An authorization
  // the server cannot attribute to a session is refused at the source, BEFORE
  // the single-use transaction is burned.
  it("an authorization with no nameable session issues nothing, and spares the transaction", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    expect(issueUserAuthCode({ authSessionId: "  ", txnId: t.txnId, userId: "user-1" })).toEqual({
      ok: false,
      reason: "no_auth_session",
    });
    // The transaction was NOT consumed — the person can still complete the flow.
    expect(
      issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" }).ok,
    ).toBe(true);
  });

  // A row minted before this slice names no parent. It cannot prove one is
  // alive, so it fails closed — bounded entirely by its own 15-minute TTL.
  it("a pre-binding token row (no session named) fails closed at the next turn", () => {
    const token = mintTokenUnder(SESSION_A);
    for (const row of tokenStore.values()) row.auth_session_id = null;
    expect(turn(token)).toEqual({ ok: false, reason: "session_revoked" });
  });

  // codex round 0, finding 4. Refusing is right; DESTROYING is only right when
  // the answer was a fact. A store that could not answer must not turn a blip
  // into a forced re-login for a token that was still perfectly good.
  it("an UNANSWERABLE liveness read refuses the turn but does NOT destroy the token", () => {
    const token = mintTokenUnder(SESSION_A);
    const before = tokenStore.size;

    // The session read throws — everything else still works.
    const realImpl = runPostgresQueriesSyncMock.getMockImplementation()!;
    runPostgresQueriesSyncMock.mockImplementation(
      (input: { queries: { text: string; values?: unknown[] }[] }) => {
        if (input.queries.some((q) => q.text.includes('"public"."session"'))) {
          throw new Error("connection terminated unexpectedly");
        }
        return realImpl(input);
      },
    );
    expect(turn(token)).toEqual({ ok: false, reason: "session_revoked" });
    expect(tokenStore.size, "the row survives an outage").toBe(before);

    // …and once the store answers again, the still-live session works.
    runPostgresQueriesSyncMock.mockImplementation(realImpl);
    expect(turn(token).ok).toBe(true);
  });

  it("a DEFINITELY dead session still reaps the row (the difference is the point)", () => {
    const token = mintTokenUnder(SESSION_A);
    liveSessionIds.delete(SESSION_A);
    turn(token);
    expect(tokenStore.size).toBe(0);
  });

  it("the token row records the session it was minted under, and only that one", () => {
    mintTokenUnder(SESSION_A);
    mintTokenUnder(SESSION_B);
    const bound = [...tokenStore.values()].map((r) => r.auth_session_id).sort();
    expect(bound).toEqual([SESSION_A, SESSION_B]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4217 — THE FRAME'S SIGN-IN TOKEN IS RENEWED, NEVER STRETCHED FOREVER.
// A renewal spends the presented `cwu_` and writes its successor in ONE
// statement: a fresh bearer, the SAME jti (so every jti-sealed capability the
// frame already holds keeps working), a fresh life capped at the session's
// maximum, measured from the original sign-in. The presented bearer keeps at
// most the grace window, so a request already sent with it still lands, and it
// is never renewable again.
//
// RED ON MAIN: main has no renewal at all — widget-user-auth.ts:100-102 ("NO
// refresh — re-login on expiry") and no such export in :1001-1214. The module is
// read through a namespace import, so this file still loads on main; each case
// then fails its first assertion, `typeof renewUserWidgetToken === "function"`
// (or, for the cap and the double's own case, the absent `__testing` member).
// ---------------------------------------------------------------------------
type RenewResult =
  | { ok: true; token: string; tokenType: "Bearer"; expiresIn: number; scope: string; userId?: string }
  | { ok: false; reason: string };
type RenewFn = (input: { token: string; agentSlug: string; site: VerifiedSiteContext }) => RenewResult;

describe("renewUserWidgetToken — the frame's token renewal (cinatra#4217)", () => {
  const CHAT_PATH = "/api/assistants/chat";
  const AGENT = "wordpress-content-editor";
  const TTL = __testing.USER_TOKEN_TTL_SECONDS;
  const testing = __testing as unknown as Record<string, unknown>;
  const GRACE = testing.USER_TOKEN_RENEW_GRACE_SECONDS as number;
  const MAX = testing.USER_TOKEN_MAX_SESSION_SECONDS as number;

  function siteLive(credentialVersion = SITE_A.credentialVersion) {
    getActiveConnectSiteByIdMock.mockImplementation((siteId: string) =>
      siteId === SITE_A.siteId
        ? {
            siteId: SITE_A.siteId,
            client: "wordpress",
            widgetOrigin: SITE_A.siteOrigin,
            orgId: SITE_A.orgId,
            credentialVersion,
          }
        : null,
    );
  }

  beforeEach(() => {
    siteLive();
    renewClaimHook = null;
    renewTxnStartLagMs = 0;
    renewStatementPauseMs = 0;
  });
  afterEach(() => {
    renewClaimHook = null;
    renewTxnStartLagMs = 0;
    renewStatementPauseMs = 0;
  });

  function signIn(): string {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    const issued = issueUserAuthCode({ authSessionId: SESSION_A, txnId: t.txnId, userId: "user-1" });
    if (!issued.ok) throw new Error(`issue: ${issued.reason}`);
    const r = redeemUserAuthCode({
      code: issued.code,
      codeVerifier: VERIFIER,
      site: SITE_A,
      issuerBaseUrl: "https://cinatra.test",
    });
    if (!r.ok) throw new Error(`redeem: ${r.reason}`);
    return r.token;
  }

  function use(token: string) {
    return consumeUserWidgetToken({
      token,
      agentSlug: AGENT,
      routePath: CHAT_PATH,
      requestOrigin: SITE_A.siteOrigin,
    });
  }

  function renew(token: string, site: VerifiedSiteContext = SITE_A): RenewResult {
    const fn = (widgetUserAuth as unknown as Record<string, unknown>).renewUserWidgetToken;
    expect(typeof fn, "widget-user-auth exports renewUserWidgetToken").toBe("function");
    return (fn as RenewFn)({ token, agentSlug: AGENT, site });
  }

  function advance(seconds: number) {
    nowMs += seconds * 1000;
  }

  function liveRows(): number {
    return [...tokenStore.values()].filter((r) => r.expires_at_ms > nowMs).length;
  }

  // (a) Acceptance 2, first item.
  it("a token close to its expiry is renewed", () => {
    const first = signIn();
    const before = use(first);
    expect(before.ok, "control: the fresh token is good").toBe(true);

    advance(TTL - 60); // one minute of life left
    const renewed = renew(first);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.token).toMatch(/^cwu_/);
    expect(renewed.token).not.toBe(first);
    expect(renewed.expiresIn, "a full life again").toBe(TTL);

    // A request the frame sent with the presented bearer just before the answer
    // still lands IF the server verifies it inside the grace window; the bearer
    // is never renewed again. (One verified later is refused: see §3 of the spec.)
    expect(Number.isFinite(GRACE) && GRACE > 0 && GRACE < 60, "a short grace window is defined").toBe(true);
    expect(use(first).ok, "the presented bearer serves its grace window").toBe(true);
    expect(renew(first), "a spent bearer is never renewed twice").toEqual({
      ok: false,
      reason: "not_renewable",
    });
    advance(GRACE);
    expect(use(first), "and is refused once the grace window ends").toEqual({ ok: false, reason: "expired" });

    advance(120 - GRACE); // past the FIRST token's own end
    const after = use(renewed.token);
    expect(after.ok, "the renewed token outlives the first one").toBe(true);
    if (!after.ok || !before.ok) return;
    // Same person, site, grant AND jti: the review island, capture and resume
    // capabilities sealed on the jti keep working across the renewal.
    expect(after.claims).toEqual(before.claims);
    expect(liveRows(), "exactly one live row per frame").toBe(1);
  });

  // (b) Acceptance 2, second item.
  it("an expired or revoked token is refused and cannot be renewed", () => {
    function refusedWithoutWrite(
      label: string,
      token: string,
      reason: string,
      site: VerifiedSiteContext = SITE_A,
    ) {
      const keys = new Set(tokenStore.keys());
      expect(renew(token, site), label).toEqual({ ok: false, reason });
      expect(
        [...tokenStore.keys()].filter((k) => !keys.has(k)),
        `${label}: no successor is written`,
      ).toEqual([]);
    }

    const expired = signIn();
    advance(TTL + 1);
    refusedWithoutWrite("expired", expired, "expired");

    const signedOut = signIn();
    liveSessionIds.delete(SESSION_A); // the person signed out of Cinatra
    refusedWithoutWrite("parent session signed out", signedOut, "session_revoked");
    liveSessionIds.add(SESSION_A);

    const siteGone = signIn();
    getActiveConnectSiteByIdMock.mockImplementation(() => null); // site disconnected
    refusedWithoutWrite("site revoked", siteGone, "site_revoked");
    siteLive();

    const rotated = signIn();
    siteLive(SITE_A.credentialVersion + 1); // site reconnected: new credential generation
    refusedWithoutWrite("site credential rotated", rotated, "site_revoked");
    siteLive();

    const spent = signIn();
    const successor = renew(spent);
    expect(successor.ok, "control: the first renewal succeeds").toBe(true);
    refusedWithoutWrite("a token already renewed (replay, inside the grace window)", spent, "not_renewable");
    advance(GRACE);
    refusedWithoutWrite("a token already renewed (replay, after the grace window)", spent, "expired");
    if (successor.ok) expect(use(successor.token).ok, "the replays spend nothing").toBe(true);

    const nearlyOut = signIn();
    advance(TTL - GRACE); // no more life than the grace window
    refusedWithoutWrite("a token with only the grace window left", nearlyOut, "not_renewable");
    expect(use(nearlyOut).ok, "a refused renewal spends nothing").toBe(true);

    const elsewhere = signIn();
    refusedWithoutWrite("under another site's binding", elsewhere, "site_mismatch", {
      ...SITE_A,
      siteId: "33333333-3333-3333-3333-333333333333",
    });
    expect(use(elsewhere).ok, "a refused renewal spends nothing").toBe(true);
  });

  // (c) Acceptance 2, third item.
  it("renewal never extends a session past the maximum lifetime", () => {
    expect(
      Number.isFinite(MAX) && MAX > TTL,
      "a maximum session lifetime longer than one token life is defined",
    ).toBe(true);
    const cap = nowMs + MAX * 1000;
    let token = signIn();
    let renewals = 0;
    // Renew a minute before every expiry, for as long as the session allows.
    for (;;) {
      const row = tokenStore.get(__testing.sha256Hex(token))!;
      expect(row.expires_at_ms, "no token outlives the session cap").toBeLessThanOrEqual(cap);
      if (row.expires_at_ms === cap) break; // the last renewal was shortened to end at the cap
      advance(Math.max(1, Math.floor((row.expires_at_ms - nowMs) / 1000) - 60));
      const next = renew(token);
      expect(next.ok, `renewal ${renewals + 1} inside the cap`).toBe(true);
      if (!next.ok) return;
      expect(nowMs + next.expiresIn * 1000, "the advertised life stops at the cap").toBeLessThanOrEqual(cap);
      token = next.token;
      renewals += 1;
      if (renewals > 2000) throw new Error("runaway renewal loop");
    }
    expect(renewals, "the session really lasted many token lives").toBeGreaterThanOrEqual(
      Math.floor(MAX / TTL),
    );
    advance(Math.ceil((cap - nowMs) / 1000) - GRACE);
    // Like with like: the refused renewal still verifies the bearer, and that
    // verification runs the module's expiry sweep, which removes rows that had
    // already expired (the previous renewal's spent grace row). Snapshot only
    // the rows that sweep keeps (expires_at >= now): every one of them must
    // survive, and no row may be added.
    const keys = new Set(
      [...tokenStore.entries()].filter(([, r]) => r.expires_at_ms >= nowMs).map(([k]) => k),
    );
    expect(keys.has(__testing.sha256Hex(token)), "control: the presented bearer is in the snapshot").toBe(true);
    expect(renew(token), "the session's last grace window is not renewable").toEqual({
      ok: false,
      reason: "not_renewable",
    });
    expect(new Set(tokenStore.keys()), "nothing is written or spent").toEqual(keys);
    advance(GRACE);
    expect(renew(token)).toEqual({ ok: false, reason: "expired" });

    // The guard holds on its own too: a chain that began MAX ago is refused even
    // while its newest token still lives (the cap lowered under a live chain).
    const late = signIn();
    const lateRow = tokenStore.get(__testing.sha256Hex(late))!;
    lateRow.created_at_ms = nowMs - MAX * 1000;
    const lateKeys = new Set(tokenStore.keys());
    expect(renew(late)).toEqual({ ok: false, reason: "not_renewable" });
    expect(new Set(tokenStore.keys()), "nothing is written or spent").toEqual(lateKeys);
  });

  // Acceptance 1, the server's half: a frame left open well past one token's
  // life renews on the frame's own schedule and never loses its sign-in, and a
  // request that was already on its way with the previous bearer still lands
  // when the server verifies it inside the grace window. A request verified
  // after the grace window is refused (the stated residual, not a guarantee).
  it("a frame open for 45 minutes stays signed in on the frame's schedule", () => {
    const RENEW_AT = 210; // the frame renews when its 300 s transport credential is 210 s old
    let token = signIn();
    const first = use(token);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const spent: string[] = [];
    for (let elapsed = 0; elapsed < 45 * 60; elapsed += RENEW_AT) {
      advance(RENEW_AT);
      const next = renew(token);
      expect(next.ok, `renewal at ${elapsed + RENEW_AT} s`).toBe(true);
      if (!next.ok) return;
      const inFlight = use(token);
      expect(inFlight.ok, "a request verified inside the grace window with the previous bearer lands").toBe(true);
      spent.push(token);
      token = next.token;
      const now = use(token);
      expect(now.ok).toBe(true);
      if (now.ok) expect(now.claims, "the same sign-in all along").toEqual(first.claims);
      expect(liveRows(), "at most the successor and one grace row").toBeLessThanOrEqual(2);
    }
    advance(GRACE);
    for (const old of spent) expect(use(old).ok, "no spent bearer works after its grace").toBe(false);
    expect(use(token).ok).toBe(true);
  });

  // The guards are the DATABASE's, evaluated when the statement runs: the
  // verifier's earlier read of the same row decides nothing.
  it("the claim reads the clock when it runs, not when the token was checked", () => {
    const t = signIn();
    advance(TTL - 45); // 45 s left when the verifier reads it
    renewClaimHook = () => advance(20); // 25 s left when the claim runs
    const keys = new Set(tokenStore.keys());
    expect(renew(t)).toEqual({ ok: false, reason: "not_renewable" });
    expect(new Set(tokenStore.keys()), "nothing is written or spent").toEqual(keys);
    renewClaimHook = null;

    const u = signIn();
    advance(TTL - 45);
    expect(renew(u).ok, "control: the same token is renewed when the clock stands still").toBe(true);
  });

  // cinatra#4217 r4 — a lost race must not fork the chain. RED BEFORE r4: the
  // claim guard compared with now(), the transaction's START, so a second
  // renewal whose transaction began a second before the first one committed saw
  // the first one's grace row (expiring at the first one's now() + grace) as
  // having more than the grace window left, claimed it and minted a SECOND
  // successor with the same jti. The guard now reads clock_timestamp().
  it("two renewals of one bearer cannot both pass, even when the second one's transaction began first", () => {
    const t = signIn();
    advance(TTL - 60);
    const first = renew(t);
    expect(first.ok, "the first renewal wins").toBe(true);
    if (!first.ok) return;

    // The second renewal's transaction began one second before the first one
    // committed; its statement runs now and sees the grace row.
    renewTxnStartLagMs = 1000;
    const keys = new Set(tokenStore.keys());
    expect(renew(t), "the grace row is never claimed").toEqual({ ok: false, reason: "not_renewable" });
    expect(new Set(tokenStore.keys()), "no second successor is written").toEqual(keys);
    renewTxnStartLagMs = 0;

    const jti = tokenStore.get(__testing.sha256Hex(first.token))!.jti;
    expect(
      [...tokenStore.values()].filter((r) => r.jti === jti && r.expires_at_ms > nowMs + GRACE * 1000),
      "one renewable row for the chain: the first renewal's successor",
    ).toHaveLength(1);
  });

  // cinatra#4217 r5 — the CAP guard reads the statement's clock. RED ON r4: the
  // cap compared with now(), the transaction's START, so a renewal whose
  // transaction began a second before the cap and whose statement ran after it
  // still claimed the chain and wrote a successor whose cap was already past.
  it("a renewal whose transaction began before the cap and ran after it is refused", () => {
    const t = signIn();
    const row = tokenStore.get(__testing.sha256Hex(t))!;
    row.created_at_ms = nowMs - MAX * 1000 - 500; // the cap passed 0.5 s ago
    renewTxnStartLagMs = 1000; // the transaction began 1 s ago, before the cap
    const keys = new Set(tokenStore.keys());
    expect(renew(t), "past the cap when the statement runs").toEqual({ ok: false, reason: "not_renewable" });
    expect(new Set(tokenStore.keys()), "nothing is written or spent").toEqual(keys);
    expect(use(t).ok, "a refused renewal spends nothing").toBe(true);

    // Control: the cap still 0.5 s ahead when the statement runs.
    const u = signIn();
    tokenStore.get(__testing.sha256Hex(u))!.created_at_ms = nowMs - MAX * 1000 + 500;
    const ok = renew(u);
    expect(ok.ok, "control: under the cap when the statement runs").toBe(true);
    if (ok.ok) expect(ok.expiresIn, "the advertised life ends at the cap").toBe(1);
  });

  // cinatra#4217 r5 — every time the statement WRITES or ADVERTISES is reckoned
  // from the instant it acts. RED ON r4: the grace write, the successor's expiry
  // and expires_in read now(), so a statement that ran a second after its
  // transaction began wrote both lives a second short of the instant it acted
  // (expires_in, reckoned from the same stale now(), still read TTL).
  it("a renewal writes and advertises lives from the statement's clock", () => {
    const t = signIn();
    advance(TTL - 60);
    renewTxnStartLagMs = 1000;
    const renewed = renew(t);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.expiresIn, "a full life from the statement's instant").toBe(TTL);
    expect(tokenStore.get(__testing.sha256Hex(renewed.token))!.expires_at_ms).toBe(nowMs + TTL * 1000);
    expect(tokenStore.get(__testing.sha256Hex(t))!.expires_at_ms, "the grace row").toBe(nowMs + GRACE * 1000);
  });

  // cinatra#4217 r6 — the grace row is the EARLIER of the bearer's own expiry
  // and the grace window. The guard and the write read the clock at different
  // moments, so a statement that pauses after a guard that found just over 30 s
  // left would, without LEAST, give the spent bearer a longer life than it had.
  it("the grace row never outlives the bearer it replaces, even when the statement pauses after its guard", () => {
    const t = signIn();
    advance(TTL - 31); // 31 s left: the guard (more than 30 s) passes
    const ownEnd = tokenStore.get(__testing.sha256Hex(t))!.expires_at_ms;
    renewStatementPauseMs = 2000; // the writes read the clock 2 s after the guard
    const renewed = renew(t);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(tokenStore.get(__testing.sha256Hex(t))!.expires_at_ms, "the grace row keeps the bearer's own end").toBe(ownEnd);
    expect(tokenStore.get(__testing.sha256Hex(renewed.token))!.expires_at_ms).toBe(nowMs + 2000 + TTL * 1000);
    expect(renewed.expiresIn).toBe(TTL);

    // The case tells the two statements apart: without LEAST the same pause
    // writes the grace row past the bearer's own end.
    const text = (testing.renewClaimStatement as () => string)();
    const mutant = text.replace(
      "LEAST(expires_at, clock_timestamp() + make_interval(secs => $5))",
      "clock_timestamp() + make_interval(secs => $5)",
    );
    expect(mutant, "the mutation applies").not.toBe(text);
    const u = signIn();
    advance(TTL - 31);
    const uEnd = tokenStore.get(__testing.sha256Hex(u))!.expires_at_ms;
    exec(mutant, [__testing.sha256Hex(u), "mutant-successor-hash", MAX, TTL, GRACE]);
    expect(tokenStore.get(__testing.sha256Hex(u))!.expires_at_ms, "the mutant outlives the bearer").toBeGreaterThan(uEnd);
  });

  // cinatra#4217 r6 — the true live-row bound. Each renewal leaves the bearer it
  // spent as one grace row of at most GRACE, so a chain renewed several times
  // within GRACE has one grace row per such renewal beside its successor. Only
  // the successor is renewable. (Review 3: r5 claimed at most two live rows.)
  it("renewals in quick succession leave one grace row each, and only the successor is renewable", () => {
    const tokens = [signIn()];
    for (let i = 0; i < 3; i += 1) {
      const next = renew(tokens[tokens.length - 1]);
      expect(next.ok, `renewal ${i + 1}`).toBe(true);
      if (!next.ok) return;
      tokens.push(next.token);
    }
    const jti = tokenStore.get(__testing.sha256Hex(tokens[3]))!.jti;
    const chainRows = () => [...tokenStore.values()].filter((r) => r.jti === jti && r.expires_at_ms > nowMs);
    expect(chainRows(), "the successor and three grace rows").toHaveLength(4);
    const renewable = chainRows().filter((r) => r.expires_at_ms > nowMs + GRACE * 1000);
    expect(renewable.map((r) => r.token_hash), "only the successor is renewable").toEqual([
      __testing.sha256Hex(tokens[3]),
    ]);
    for (const spent of tokens.slice(0, 3)) {
      expect(tokenStore.get(__testing.sha256Hex(spent))!.expires_at_ms).toBeLessThanOrEqual(nowMs + GRACE * 1000);
      expect(renew(spent), "a spent bearer is never renewed").toEqual({ ok: false, reason: "not_renewable" });
    }
    advance(GRACE);
    expect(chainRows(), "after GRACE only the successor is live").toHaveLength(1);
  });

  // cinatra#4217 r4 — forensics. RED BEFORE r4: the result named nobody, so the
  // route's renew_success audit line could not name the person either.
  it("a renewal names the person it renewed for, and nothing secret", () => {
    const t = signIn();
    advance(TTL - 60);
    const renewed = renew(t);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.userId, "the verified claim's user id").toBe("user-1");
    expect(Object.keys(renewed).sort()).toEqual(
      ["expiresIn", "ok", "scope", "token", "tokenType", "userId"],
    );
  });

  // The double reads the module's own statement, and it refuses what it cannot
  // read: a mutated statement errors instead of passing with a made-up row.
  it("the in-memory database refuses a renewal statement it cannot read", () => {
    const build = testing.renewClaimStatement;
    expect(typeof build, "the module exposes its renewal statement").toBe("function");
    const text = (build as () => string)();
    const t = signIn();
    const values = [__testing.sha256Hex(t), "successor-hash", MAX, TTL, GRACE];
    const lastIss = text.lastIndexOf("iss, scope");
    const mutants: Array<[string, string]> = [
      ["a fresh jti", text.replace("SELECT $2, jti,", "SELECT $2, gen_random_uuid(),")],
      ["a mistyped copy", text.slice(0, lastIss) + "isss, scope" + text.slice(lastIss + "iss, scope".length)],
      ["an unknown expiry", text.replace("clock_timestamp() + make_interval(secs => $4)", "clock_timestamp() + interval '1 day'")],
      ["an unknown guard", text.replace("AND created_at + make_interval(secs => $3) > clock_timestamp() ", "AND true ")],
    ];
    for (const [label, mutant] of mutants) {
      expect(mutant, `${label}: the mutation applies`).not.toBe(text);
      const before = new Map(tokenStore);
      expect(() => exec(mutant, values), label).toThrow(/renewal double/);
      expect(new Map(tokenStore), `${label}: nothing is changed`).toEqual(before);
    }
  });
});
