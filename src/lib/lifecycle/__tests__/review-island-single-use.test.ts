// SINGLE USE for the review-island credential (cinatra#2754, the maintainer's
// 2026-08-21 hardening ruling, requirement 1) — and the one-minute life
// (requirement 2) where the ledger is the thing that honours it.
//
// These run the REAL mint site and the REAL serving path against an in-memory
// stand-in for the ledger table that behaves the way Postgres does: an INSERT
// that loses to an existing key writes nothing, and a DELETE returns the row
// only when one was actually removed. Nothing about the mechanism is mocked —
// only the storage under it — so what these cases prove is the ORDER and the
// KEY, which is exactly what the ruling is about.
//
// The ruling's closing list, by name:
//   • replay-after-paint refused        → "a replay of the painted address"
//   • refusal-then-retry still paints   → "a refusal never burns the grant"
//   • two islands in one transcript     → "two cards off ONE cwu_ both paint"
//   • the 60s expiry honored at consume → "an expired grant, at the DB clock"
//   • (the redaction requirement lives in
//      src/lib/__tests__/review-island-query-redaction.test.ts)

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-island-single-use";

// ---------------------------------------------------------------------------
// The stand-in store. ONE fake table plus the token-row read the serving path
// makes, dispatched by statement shape — an unrecognized statement THROWS, so a
// change to the store's SQL cannot silently start passing here.
// ---------------------------------------------------------------------------

type LedgerRow = {
  credential_hash: string;
  org_id: string;
  user_id: string;
  jti: string;
  run_id: string;
  review_task_id: string;
  expires_at: number;
};

const ledger = new Map<string, LedgerRow>();
/** The DATABASE's clock, in unix seconds — moved independently of the codec's. */
let dbClockSeconds = Math.floor(Date.now() / 1000);
let tokenRow: Record<string, unknown> | null = null;
let insertThrows = false;

function execute(query: { text: string; values?: unknown[] }) {
  const text = query.text;
  const values = query.values ?? [];
  if (text.startsWith("SELECT user_id")) {
    return { rows: tokenRow ? [tokenRow] : [], rowCount: tokenRow ? 1 : 0 };
  }
  if (text.includes("WHERE expires_at < now()")) {
    for (const [key, row] of ledger) if (row.expires_at < dbClockSeconds) ledger.delete(key);
    return { rows: [], rowCount: 0 };
  }
  if (text.startsWith("INSERT INTO")) {
    if (insertThrows) throw new Error("ledger write failed");
    const hash = String(values[0]);
    if (ledger.has(hash)) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
    ledger.set(hash, {
      credential_hash: hash,
      org_id: String(values[1]),
      user_id: String(values[2]),
      jti: String(values[3]),
      run_id: String(values[4]),
      review_task_id: String(values[5]),
      expires_at: Number(values[6]),
    });
    return { rows: [{ credential_hash: hash }], rowCount: 1 };
  }
  if (text.includes("credential_hash = $1")) {
    const [hash, jti, runId, reviewTaskId] = values.map((v) => String(v));
    const row = ledger.get(hash);
    // The WHERE, faithfully: hash + gate + principal + not expired, at the DB clock.
    if (
      !row ||
      row.jti !== jti ||
      row.run_id !== runId ||
      row.review_task_id !== reviewTaskId ||
      !(row.expires_at > dbClockSeconds)
    ) {
      return { rows: [], rowCount: 0 };
    }
    ledger.delete(hash);
    return { rows: [{ credential_hash: hash }], rowCount: 1 };
  }
  throw new Error(`unexpected statement in the island single-use fake: ${text}`);
}

const emitWidgetAuthAudit = vi.fn();
const widgetAuthSessionIsLive = vi.fn();
const getActiveConnectSiteById = vi.fn();
const resolveActorGrantsForUserInOrg = vi.fn();
const readUserIsPlatformAdmin = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: { queries: { text: string; values?: unknown[] }[] }) =>
    input.queries.map(execute),
  quotePostgresIdentifier: (v: string) => `"${v}"`,
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/connect-sites-store", () => ({
  getActiveConnectSiteById: (...a: unknown[]) => getActiveConnectSiteById(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  resolveActorGrantsForUserInOrg: (...a: unknown[]) => resolveActorGrantsForUserInOrg(...a),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readUserIsPlatformAdmin: (...a: unknown[]) => readUserIsPlatformAdmin(...a),
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));
vi.mock("@/lib/widget-session-binding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/widget-session-binding")>();
  return { ...actual, widgetAuthSessionIsLive: (id: unknown) => widgetAuthSessionIsLive(id) };
});
// The actor's token verifier is not exercised here — the mint site takes claims
// the caller has already consumed — but the module imports it.
vi.mock("@/lib/widget-user-auth", () => ({ consumeUserWidgetToken: vi.fn() }));

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import {
  REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM,
  REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS,
  mintReviewIslandCredential,
  verifyReviewIslandCredential,
} from "../review-island-credential";
import { islandCredentialHash } from "../review-island-grant-store";
import { resolveIslandCredentialReader } from "../review-island-serving";
import { mintWidgetReviewIslandUrl } from "../widget-lifecycle-actor";
import type { UserTokenClaims } from "@/lib/widget-user-auth";
import {
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";

const GATE_A = { runId: "run-1", reviewTaskId: "task-1" };
const GATE_B = { runId: "run-1", reviewTaskId: "task-2" };
const AGENT = "wordpress-content-editor";

/** The `cwu_` claims a resolve has already consumed — the mint site's input. */
const CLAIMS: UserTokenClaims = {
  userId: "user-1",
  orgId: "org-A",
  siteId: "site-1",
  client: "wordpress",
  siteOrigin: "https://wp.example.test",
  agentSlug: AGENT,
  instanceId: "inst-1",
  jti: "jti-1",
  grantedScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
};

/** The nine sealed fields, out of the same claims the mint site seals. */
const CREDENTIAL_PAYLOAD = {
  orgId: CLAIMS.orgId,
  userId: CLAIMS.userId,
  jti: CLAIMS.jti,
  siteId: CLAIMS.siteId,
  client: CLAIMS.client,
  instanceId: CLAIMS.instanceId,
  agentSlug: CLAIMS.agentSlug,
};

function liveTokenRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: CLAIMS.userId,
    org_id: CLAIMS.orgId,
    site_id: CLAIMS.siteId,
    client: CLAIMS.client,
    instance_id: CLAIMS.instanceId,
    agent_slug: CLAIMS.agentSlug,
    site_origin: CLAIMS.siteOrigin,
    aud: `${WIDGET_BROKER_ROUTE_PATH} ${WIDGET_LIFECYCLE_READ_ROUTE_PATH}`,
    scope: `${AGENT}.user ${WIDGET_LIFECYCLE_READ_SCOPE}`,
    credential_version: 3,
    auth_session_id: "sess-1",
    not_expired: true,
    ...overrides,
  };
}

const SITE_ROW = {
  siteId: CLAIMS.siteId,
  client: CLAIMS.client,
  orgId: CLAIMS.orgId,
  widgetOrigin: CLAIMS.siteOrigin,
  credentialVersion: 3,
};

const refFor = (gate: { runId: string; reviewTaskId: string }) => encodeLifecycleGateRef(gate)!;

/** Mint through the REAL mint site and hand back the two halves the card holds. */
function mintAddress(gate: { runId: string; reviewTaskId: string }) {
  const ref = refFor(gate);
  const url = mintWidgetReviewIslandUrl({
    claims: CLAIMS,
    ref,
    runId: gate.runId,
    reviewTaskId: gate.reviewTaskId,
  });
  expect(url).not.toBeNull();
  const parsed = new URL(url!, "https://island.invalid");
  const credential = parsed.searchParams.get(REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM)!;
  expect(credential.length).toBeGreaterThan(0);
  return { ref, credential, url: url! };
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.clear();
  insertThrows = false;
  dbClockSeconds = Math.floor(Date.now() / 1000);
  tokenRow = liveTokenRow();
  getActiveConnectSiteById.mockReturnValue(SITE_ROW);
  resolveActorGrantsForUserInOrg.mockResolvedValue({
    orgRole: "member",
    teamIds: [],
    teamRoles: {},
    projectGrants: [],
  });
  readUserIsPlatformAdmin.mockResolvedValue(false);
  widgetAuthSessionIsLive.mockReturnValue(true);
});

describe("the mint records a grant, hashed", () => {
  it("writes ONE row keyed by sha256(credential) — never the credential itself", () => {
    const { credential } = mintAddress(GATE_A);
    expect(ledger.size).toBe(1);
    const [key, row] = [...ledger.entries()][0];
    expect(key).toBe(createHash("sha256").update(credential, "utf8").digest("hex"));
    expect(key).toBe(islandCredentialHash(credential));
    expect(key).not.toBe(credential);
    // The stored expiry is the credential's OWN sealed one — one clock, not two.
    expect(row.expires_at).toBe(verifyReviewIslandCredential(credential)!.expiresAt);
    expect(row.jti).toBe(CLAIMS.jti);
    expect(row.run_id).toBe(GATE_A.runId);
  });

  it("hands out NO ADDRESS when the grant cannot be recorded", () => {
    insertThrows = true;
    const url = mintWidgetReviewIslandUrl({
      claims: CLAIMS,
      ref: refFor(GATE_A),
      runId: GATE_A.runId,
      reviewTaskId: GATE_A.reviewTaskId,
    });
    // A credential whose one use cannot be enforced is the replayable credential
    // this ruling removed, so the caller renders no island instead.
    expect(url).toBeNull();
  });
});

describe("RULING TEST 1 — replay-after-paint is refused", () => {
  it("paints once, and the SAME address opens nothing afterwards", async () => {
    const { ref, credential } = mintAddress(GATE_A);

    const first = await resolveIslandCredentialReader({ credential, ref });
    expect(first).not.toBeNull();
    expect(first!.runId).toBe(GATE_A.runId);
    // The grant is spent by the paint.
    expect(ledger.size).toBe(0);

    const replay = await resolveIslandCredentialReader({ credential, ref });
    expect(replay).toBeNull();
    // It got all the way to the last rung — this is a SPENT address, not a
    // credential that failed one of the checks above it.
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "widget_lifecycle_read_rejected",
      expect.objectContaining({ reason: "island_credential_spent" }),
    );
  });

  it("a THIRD presentation is refused too — spending is terminal", async () => {
    const { ref, credential } = mintAddress(GATE_A);
    expect(await resolveIslandCredentialReader({ credential, ref })).not.toBeNull();
    expect(await resolveIslandCredentialReader({ credential, ref })).toBeNull();
    expect(await resolveIslandCredentialReader({ credential, ref })).toBeNull();
  });
});

describe("RULING TEST 2 — a refusal never burns the grant", () => {
  it("refused on the REF binding, then the same address still paints", async () => {
    const { ref, credential } = mintAddress(GATE_A);
    // Rung 1 refuses: a genuine credential presented with another gate's ref.
    expect(
      await resolveIslandCredentialReader({ credential, ref: refFor(GATE_B) }),
    ).toBeNull();
    expect(ledger.size).toBe(1); // NOT burnt

    expect(await resolveIslandCredentialReader({ credential, ref })).not.toBeNull();
  });

  it("refused on the LIVE PRINCIPAL, then the same address still paints", async () => {
    const { ref, credential } = mintAddress(GATE_A);
    // Rung 2 refuses: the parent sign-in looks gone on this attempt.
    widgetAuthSessionIsLive.mockReturnValueOnce(false);
    expect(await resolveIslandCredentialReader({ credential, ref })).toBeNull();
    expect(ledger.size).toBe(1);

    expect(await resolveIslandCredentialReader({ credential, ref })).not.toBeNull();
  });

  it("refused on a SEALED BINDING and on ORG STANDING, then it still paints", async () => {
    const { ref, credential } = mintAddress(GATE_A);
    // Rung 3 refuses: the live row drifted from the seal on this attempt.
    tokenRow = liveTokenRow({ instance_id: "inst-2" });
    expect(await resolveIslandCredentialReader({ credential, ref })).toBeNull();
    // Rung 4 refuses: membership is momentarily unreadable.
    tokenRow = liveTokenRow();
    resolveActorGrantsForUserInOrg.mockResolvedValueOnce({
      orgRole: null,
      teamIds: [],
      teamRoles: {},
      projectGrants: [],
    });
    expect(await resolveIslandCredentialReader({ credential, ref })).toBeNull();
    expect(ledger.size).toBe(1);

    expect(await resolveIslandCredentialReader({ credential, ref })).not.toBeNull();
    expect(ledger.size).toBe(0);
  });
});

describe("RULING TEST 3 — two islands in one transcript both paint", () => {
  it("two gates minted off ONE cwu_ each get their own grant and each paints", async () => {
    const a = mintAddress(GATE_A);
    const b = mintAddress(GATE_B);
    // HASH-KEYED, not slot-keyed: the second mint does not evict the first.
    expect(ledger.size).toBe(2);
    expect(a.credential).not.toBe(b.credential);

    const paintedA = await resolveIslandCredentialReader({
      credential: a.credential,
      ref: a.ref,
    });
    const paintedB = await resolveIslandCredentialReader({
      credential: b.credential,
      ref: b.ref,
    });
    expect(paintedA).not.toBeNull();
    expect(paintedB).not.toBeNull();
    expect(paintedA!.reviewTaskId).toBe(GATE_A.reviewTaskId);
    expect(paintedB!.reviewTaskId).toBe(GATE_B.reviewTaskId);
    expect(ledger.size).toBe(0);

    // NEGATIVE CONTROL — and neither one replays.
    expect(
      await resolveIslandCredentialReader({ credential: a.credential, ref: a.ref }),
    ).toBeNull();
    expect(
      await resolveIslandCredentialReader({ credential: b.credential, ref: b.ref }),
    ).toBeNull();
  });

  it("painting the SECOND card first leaves the FIRST card perfectly usable", async () => {
    const a = mintAddress(GATE_A);
    const b = mintAddress(GATE_B);
    expect(
      await resolveIslandCredentialReader({ credential: b.credential, ref: b.ref }),
    ).not.toBeNull();
    expect(
      await resolveIslandCredentialReader({ credential: a.credential, ref: a.ref }),
    ).not.toBeNull();
  });
});

describe("RULING TEST 4 — the one-minute life", () => {
  it("the TTL is 60 seconds, and it is the ONLY definition", () => {
    expect(REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS).toBe(60);
    const now = 1_800_000_000;
    const credential = mintReviewIslandCredential(
      { ...CREDENTIAL_PAYLOAD, ...GATE_A },
      { nowSeconds: now },
    )!;
    // The seal says one minute…
    expect(verifyReviewIslandCredential(credential, { nowSeconds: now })!.expiresAt).toBe(
      now + 60,
    );
    // …and verify agrees, to the second: alive at +59, dead at +60.
    expect(verifyReviewIslandCredential(credential, { nowSeconds: now + 59 })).not.toBeNull();
    expect(verifyReviewIslandCredential(credential, { nowSeconds: now + 60 })).toBeNull();
  });

  it("a grant past its minute is refused AT THE CONSUME, on the DATABASE clock", async () => {
    const { ref, credential } = mintAddress(GATE_A);
    // Only the DATABASE's clock moves: the seal is still openable, so the resolve
    // reaches the LAST rung and it is the ledger that refuses.
    dbClockSeconds += REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS + 1;
    expect(await resolveIslandCredentialReader({ credential, ref })).toBeNull();
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "widget_lifecycle_read_rejected",
      expect.objectContaining({ reason: "island_credential_spent" }),
    );
    // NEGATIVE CONTROL — one second inside the minute, the same address paints.
    dbClockSeconds -= 2;
    expect(await resolveIslandCredentialReader({ credential, ref })).not.toBeNull();
  });
});

describe("the ledger is never an oracle", () => {
  it("a forged credential is refused without ever reaching the ledger", async () => {
    mintAddress(GATE_A);
    const before = ledger.size;
    expect(
      await resolveIslandCredentialReader({ credential: "not-a-credential", ref: refFor(GATE_A) }),
    ).toBeNull();
    expect(ledger.size).toBe(before);
  });
});
