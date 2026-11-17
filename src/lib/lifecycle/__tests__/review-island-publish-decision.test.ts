// cinatra#4150 W4 C1b: THE WIDGET PATH of a publish card's artifacts row.
//
// The same credential, grant and serving path as a review gate's island, sealed as a PUBLISH-DECISION credential whose
// subject is one row (run, decision, input). These run the REAL mint site and the REAL serving path against the same
// in-memory ledger stand-in as review-island-single-use.test.ts. What is pinned:
//   - a publish credential paints only beside the publish ref it was minted for, and hands the page that row;
//   - the two kinds never cross: a gate credential beside a publish ref, and a publish credential beside a gate ref,
//     are refused (and a refusal burns no grant);
//   - another input or another decision under the same run is refused;
//   - the grant is spent once, exactly as a gate's;
//   - the mint refuses a ref that does not name the ids it is asked to seal;
//   - a gate credential's sealed shape is unchanged (no subject).
// Red first: at C1's head mintWidgetPublishDecisionIslandUrl and the publish ref family do not exist (import fails).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-island-publish-decision";

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

import {
  encodeLifecycleGateRef,
  encodePublishDecisionIslandRef,
  publishDecisionIslandSubjectKey,
} from "../lifecycle-card-ref";
import {
  REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM,
  mintReviewIslandCredential,
  verifyReviewIslandCredential,
} from "../review-island-credential";
import { resolveIslandCredentialReader } from "../review-island-serving";
import { mintWidgetPublishDecisionIslandUrl, mintWidgetReviewIslandUrl } from "../widget-lifecycle-actor";
import type { UserTokenClaims } from "@/lib/widget-user-auth";
import {
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";

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


const ROW = { runId: "run-1", decisionId: "dec-1", input: "reviewTargets" };
const GATE = { runId: "run-1", reviewTaskId: "task-1" };

function mintPublish(row: typeof ROW = ROW, ref = encodePublishDecisionIslandRef(row)!) {
  const url = mintWidgetPublishDecisionIslandUrl({ claims: CLAIMS, ref, ...row });
  if (url === null) return null;
  const credential = new URL(url, "https://island.invalid").searchParams.get(REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM)!;
  return { ref, credential, url };
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.clear();
  insertThrows = false;
  dbClockSeconds = Math.floor(Date.now() / 1000);
  tokenRow = liveTokenRow();
  getActiveConnectSiteById.mockReturnValue(SITE_ROW);
  resolveActorGrantsForUserInOrg.mockResolvedValue({ orgRole: "member", teamIds: [], teamRoles: {}, projectGrants: [] });
  readUserIsPlatformAdmin.mockResolvedValue(false);
  widgetAuthSessionIsLive.mockReturnValue(true);
});

describe("the publish-decision credential", () => {
  it("seals the publish subject and the row's subject key, and records ONE grant for it", () => {
    const minted = mintPublish()!;
    expect(minted).not.toBeNull();
    const sealed = verifyReviewIslandCredential(minted.credential)!;
    expect(sealed).toMatchObject({ ...CREDENTIAL_PAYLOAD, runId: ROW.runId, subject: "publish-decision" });
    expect(sealed.reviewTaskId).toBe(publishDecisionIslandSubjectKey(ROW));
    expect(ledger.size).toBe(1);
    expect([...ledger.values()][0]).toMatchObject({ run_id: ROW.runId, review_task_id: publishDecisionIslandSubjectKey(ROW) });
  });

  it("paints once beside its own ref and hands the page the row, never a gate", async () => {
    const { ref, credential } = mintPublish()!;
    const reader = await resolveIslandCredentialReader({ credential, ref });
    expect(reader).not.toBeNull();
    expect(reader!.runId).toBe(ROW.runId);
    expect(reader!.publishDecision).toEqual({ decisionId: ROW.decisionId, input: ROW.input });
    expect(ledger.size).toBe(0);
    expect(await resolveIslandCredentialReader({ credential, ref })).toBeNull();
  });

  it("is refused beside a gate ref, another input or another decision, and the refusal burns nothing", async () => {
    const { ref, credential } = mintPublish()!;
    for (const other of [
      encodeLifecycleGateRef({ runId: ROW.runId, reviewTaskId: publishDecisionIslandSubjectKey(ROW) })!,
      encodePublishDecisionIslandRef({ ...ROW, input: "otherTargets" })!,
      encodePublishDecisionIslandRef({ ...ROW, decisionId: "dec-2" })!,
      encodePublishDecisionIslandRef({ ...ROW, runId: "run-2" })!,
    ]) {
      expect(await resolveIslandCredentialReader({ credential, ref: other })).toBeNull();
    }
    expect(emitWidgetAuthAudit).toHaveBeenCalledWith(
      "widget_lifecycle_read_rejected",
      expect.objectContaining({ reason: "island_ref_mismatch" }),
    );
    expect(ledger.size).toBe(1);
    expect(await resolveIslandCredentialReader({ credential, ref })).not.toBeNull();
  });

  it("a GATE credential beside a publish ref is refused; a gate credential still paints its gate, with no row", async () => {
    const gateRef = encodeLifecycleGateRef(GATE)!;
    const url = mintWidgetReviewIslandUrl({ claims: CLAIMS, ref: gateRef, ...GATE })!;
    const credential = new URL(url, "https://island.invalid").searchParams.get(REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM)!;
    expect(verifyReviewIslandCredential(credential)).not.toHaveProperty("subject");
    expect(
      await resolveIslandCredentialReader({ credential, ref: encodePublishDecisionIslandRef(ROW)! }),
    ).toBeNull();
    const reader = await resolveIslandCredentialReader({ credential, ref: gateRef });
    expect(reader).toMatchObject({ runId: GATE.runId, reviewTaskId: GATE.reviewTaskId, publishDecision: null });
  });

  it("the mint refuses a ref that does not name the row it is asked to seal, and records nothing", () => {
    expect(mintPublish(ROW, encodePublishDecisionIslandRef({ ...ROW, input: "otherTargets" })!)).toBeNull();
    expect(mintPublish(ROW, encodeLifecycleGateRef(GATE)!)).toBeNull();
    expect(mintPublish(ROW, "not-a-ref")).toBeNull();
    expect(ledger.size).toBe(0);
  });

  it("a hand-made credential sealing a subject the codec does not know is not one of ours", () => {
    // Sealed with the codec's own key derivation, so only the subject field is wrong.
    const key = createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update("cinatra:review-island-credential:v1").digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const sealed = {
      o: CLAIMS.orgId, u: CLAIMS.userId, j: CLAIMS.jti, s: CLAIMS.siteId, c: CLAIMS.client, i: CLAIMS.instanceId,
      n: CLAIMS.agentSlug, r: ROW.runId, g: publishDecisionIslandSubjectKey(ROW), x: Math.floor(Date.now() / 1000) + 30, k: "gate",
    };
    const body = Buffer.concat([cipher.update(JSON.stringify(sealed), "utf8"), cipher.final()]);
    const forged = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    expect(verifyReviewIslandCredential(forged)).toBeNull();
    // The same fields with the publish subject open, which proves only the subject made the difference.
    const cipher2 = createCipheriv("aes-256-gcm", key, iv);
    const body2 = Buffer.concat([cipher2.update(JSON.stringify({ ...sealed, k: "pd" }), "utf8"), cipher2.final()]);
    const good = Buffer.concat([iv, body2, cipher2.getAuthTag()]).toString("base64url");
    expect(verifyReviewIslandCredential(good)).toMatchObject({ subject: "publish-decision" });
  });

  it("a mint asked for an unknown subject seals nothing", () => {
    expect(
      mintReviewIslandCredential({
        ...CREDENTIAL_PAYLOAD,
        runId: ROW.runId,
        reviewTaskId: publishDecisionIslandSubjectKey(ROW),
        subject: "gate" as unknown as "publish-decision",
      }),
    ).toBeNull();
  });
});
