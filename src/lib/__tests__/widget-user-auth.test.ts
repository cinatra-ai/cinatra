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
  issueUserAuthCode,
  redeemUserAuthCode,
  consumeUserWidgetToken,
  resolveCanonicalInstanceForOrigin,
  resolveVerifiedSiteFromCredential,
  isValidState,
  type VerifiedSiteContext,
  __testing,
} from "@/lib/widget-user-auth";

// ---------------------------------------------------------------------------
// In-memory store + a focused SQL interpreter for the three tables.
// ---------------------------------------------------------------------------
type AnyRow = Record<string, unknown> & { expires_at_ms: number; consumed: boolean };
let txnStore: Map<string, AnyRow>; // key = txn_id
let codeStore: Map<string, AnyRow>; // key = code_hash
let tokenStore: Map<string, AnyRow>; // key = token_hash
let nowMs: number;

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
    const key = t === "txn" ? String(row.txn_id) : t === "code" ? String(row.code_hash) : String(row.token_hash);
    store.set(key, row);
    return { rows: [] };
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
  const STREAM_PATH = "/api/agents/wordpress-content-editor/stream";

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

  const STREAM_PATH = "/api/agents/wordpress-content-editor/stream";

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
