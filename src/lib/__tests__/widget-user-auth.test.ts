import { beforeEach, describe, expect, it, vi } from "vitest";
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
} = vi.hoisted(() => ({
  runPostgresQueriesSyncMock: vi.fn(),
  readConnectorConfigMock: vi.fn(),
  readMetadataValueMock: vi.fn(),
  ensureSchemaMock: vi.fn(),
  validateConnectServerCredentialMock: vi.fn(),
  getActiveConnectSiteByIdMock: vi.fn(),
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
import {
  WIDGET_SIGNIN_GRANTED_SCOPES,
  WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
  displayedScopesAgree,
  screenRecordAdmitsArrival,
  widgetDisplayedScopesToken,
  widgetNoSignInScreenToken,
  type WidgetExtensionScope,
} from "@/lib/widget-lifecycle-scope";

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

function tableOf(sql: string): "txn" | "code" | "token" | null {
  if (sql.includes("widget_auth_transactions")) return "txn";
  if (sql.includes("widget_auth_codes")) return "code";
  if (sql.includes("widget_user_tokens")) return "token";
  return null;
}
function storeOf(t: "txn" | "code" | "token") {
  return t === "txn" ? txnStore : t === "code" ? codeStore : tokenStore;
}

// Interpret one SQL statement against the in-memory stores. Supports the exact
// shapes the module emits: INSERT (...) VALUES (... make_interval(secs=>$N)),
// SELECT ... WHERE <key>=$1 [AND consumed_at IS NULL] [AND expires_at>now()],
// UPDATE ... SET consumed_at=now() ... RETURNING, DELETE ... WHERE key=$1 ...
// RETURNING, and the unconditional "DELETE ... WHERE expires_at < now()" sweep.
function exec(sql: string, values: unknown[] = []): { rows: Record<string, unknown>[] } {
  const t = tableOf(sql);
  if (!t) return { rows: [] };
  const store = storeOf(t);

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
    // expires_at is: it is one half of the ordering proof.
    if (t === "txn") row.created_at_ms = nowMs;
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

describe("issueUserAuthCode — single-use transaction consume", () => {
  it("issues a code carrying the txn binding + the userId", () => {
    const t = newTxn(SITE_A);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const issued = issueUserAuthCode({ txnId: t.txnId, userId: "user-1" });
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
    expect(issueUserAuthCode({ txnId: t.txnId, userId: "user-1" }).ok).toBe(true);
    const second = issueUserAuthCode({ txnId: t.txnId, userId: "user-1" });
    expect(second).toEqual({ ok: false, reason: "txn_not_found" });
  });
  it("an expired txn cannot issue a code", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) return;
    nowMs += (__testing.TRANSACTION_TTL_SECONDS + 1) * 1000;
    expect(issueUserAuthCode({ txnId: t.txnId, userId: "user-1" })).toEqual({
      ok: false,
      reason: "txn_not_found",
    });
  });
});

describe("redeemUserAuthCode — PKCE + single-use + cross-site binding", () => {
  function issueCodeFor(site = SITE_A) {
    const t = newTxn(site);
    if (!t.ok) throw new Error("txn failed");
    const issued = issueUserAuthCode({ txnId: t.txnId, userId: "user-1" });
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
    const issued = issueUserAuthCode({ txnId: t.txnId, userId: "user-1" });
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
    const issued = issueUserAuthCode({
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
    // Derived from the granted set rather than spelled out: cinatra#2575 added a
    // second grant, and a literal here would have to be re-typed for every one.
    // What is asserted is the SHAPE — the base scope plus exactly the granted
    // set, in the canonical order the mint writes.
    expect(minted.scope.split(" ")).toEqual([
      "wordpress-content-editor.user",
      ...[...WIDGET_SIGNIN_GRANTED_SCOPES].sort(),
    ]);
    expect(minted.scope.split(" ")).toContain(WIDGET_LIFECYCLE_READ_SCOPE);

    const r = consumeUserWidgetToken({
      token: minted.token,
      agentSlug: "wordpress-content-editor",
      routePath: WIDGET_LIFECYCLE_READ_ROUTE_PATH,
      requestOrigin: SITE_A.siteOrigin,
      requiredScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claims.grantedScopes).toEqual([...WIDGET_SIGNIN_GRANTED_SCOPES].sort());
    expect(r.claims.grantedScopes).toContain(WIDGET_LIFECYCLE_READ_SCOPE);

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
    const issued = issueUserAuthCode({
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
    const issued = issueUserAuthCode({ txnId: t.txnId, userId: "user-1" });
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
    const issued = issueUserAuthCode({ txnId: t.txnId, userId: "user-1" });
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
  return widgetNoSignInScreenToken(widgetSessionFingerprint(sessionId));
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
    expect(issueUserAuthCode({ txnId: t.txnId, userId: "user-1" }).ok).toBe(true);
  });

  it("returns null for a transaction that is gone", () => {
    const t = newTxn(SITE_A);
    if (!t.ok) throw new Error("txn");
    expect(issueUserAuthCode({ txnId: t.txnId, userId: "user-1" }).ok).toBe(true);
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
      expect(widgetNoSignInScreenToken(widgetSessionFingerprint(bad))).toBe("");
    }
  });

  it("a sentinel earned by one session is refused for another", () => {
    const mine = noScreenTokenFor("sess-A");
    const theirs = noScreenTokenFor("sess-B");
    expect(displayedScopesAgree(theirs, WIDGET_SIGNIN_GRANTED_SCOPES, mine)).toBe(false);
    expect(displayedScopesAgree(mine, WIDGET_SIGNIN_GRANTED_SCOPES, mine)).toBe(true);
  });
});
