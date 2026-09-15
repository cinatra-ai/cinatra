// @vitest-environment jsdom
//
// THE PREVIEW'S FIRST RENDER, UNDER THE WIDGET'S OWN CREDENTIAL (cinatra#3051).
//
// WHAT THIS MEASURES, AND WHY IT IS ONE FILE. The review inside a third-party
// page drew "The preview did not load" at the pending instant and the full
// header with the rendered body minutes later at the settled instant. The
// question that has to be answered with a measurement rather than a story is:
// what does the request the WIDGET ARM ACTUALLY ISSUES get back from the
// handler that answers it? So this file composes that request the way the card
// composes it — the address the card builds from the SERVER-MINTED one, with
// the ref, the credential and the two frame selectors — and puts it through the
// REAL request guard and the REAL serving ladder, against a ledger that behaves
// the way the real table does.
//
// WHAT IT SHOWS.
//
//   1. AN IN-TIME FIRST PRESENTATION IS ADMITTED. The guard takes the credential
//      branch, widens the framing wall to the one registered origin, and the
//      ladder resolves the reader. The first render is NOT refused by the
//      handler — so a failed first preview is not a 401/403/404 from a
//      cookie-only route, and not a race with the gate's mint.
//
//   2. THE SECOND PRESENTATION OF THE SAME ADDRESS IS REFUSED. The grant is
//      worth one paint. Anything that re-presents the address the frame already
//      holds — a frame remount on the same `src` — draws the empty island. That
//      is the measured reason the card's own "Try again" could not recover: it
//      bumped the frame's mount key BEFORE the fresh address arrived, so its
//      first act was to re-present the spent one. The retry now waits.
//
//   3. AN ADDRESS THAT CARRIES NO CREDENTIAL IS ANSWERED EMPTY. A widget frame
//      with no session cookie — which is every genuinely cross-site embed — is
//      answered by the guard with an empty document, before the page runs. So a
//      resolve that could not mint (a ledger write that did not land, a field
//      out of bounds) yields a frame that paints nothing at all.
//
//   4. AND AN EXPIRED ADDRESS IS REFUSED AT THE DATABASE CLOCK. The credential
//      lives one minute from the resolve that minted it, so any delay between
//      the answer and the frame's fetch that exceeds it costs the paint.
//
// EVERY ONE of those outcomes used to reach the reader as a panel that named
// nothing, because the header and the floor lived inside the document that did
// not arrive. That is what the sibling suite
// (`packages/agents/src/__tests__/review-gate-card.target-header-floor.test.tsx`)
// closes; this suite is the measurement underneath it.
//
//   pnpm exec vitest run src/lib/lifecycle/__tests__/review-island-first-render.test.ts

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-island-first-render";

// ---------------------------------------------------------------------------
// The ledger, as Postgres behaves: an INSERT that loses to an existing key
// writes nothing, and a DELETE returns the row only when one was removed. Same
// stand-in as `review-island-single-use.test.ts`, for the same reason — what is
// proven here is the ORDER and the KEY, not the driver.
// ---------------------------------------------------------------------------

type LedgerRow = { credential_hash: string; jti: string; run_id: string; review_task_id: string; expires_at: number };

const ledger = new Map<string, LedgerRow>();
let dbClockSeconds = Math.floor(Date.now() / 1000);
let tokenRow: Record<string, unknown> | null = null;

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
    const hash = String(values[0]);
    if (ledger.has(hash)) return { rows: [], rowCount: 0 };
    ledger.set(hash, {
      credential_hash: hash,
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
  throw new Error(`unexpected statement in the island first-render fake: ${text}`);
}

const widgetAuthSessionIsLive = vi.fn();
const getActiveConnectSiteById = vi.fn();
const resolveActorGrantsForUserInOrg = vi.fn();
const readUserIsPlatformAdmin = vi.fn();
const resolveVerifiedWidgetFrameOrigin = vi.fn();
const getSessionCookie = vi.fn<() => string | null>(() => null);

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
vi.mock("@/lib/widget-auth-audit", () => ({ emitWidgetAuthAudit: vi.fn() }));
vi.mock("@/lib/widget-session-binding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/widget-session-binding")>();
  return { ...actual, widgetAuthSessionIsLive: (id: unknown) => widgetAuthSessionIsLive(id) };
});
vi.mock("@/lib/widget-user-auth", () => ({ consumeUserWidgetToken: vi.fn() }));
// The guard's collaborators. The frame resolver is the SHARED one the island
// page keys its own answer on; the cookie reader answers what a genuinely
// cross-site frame sends, which is nothing.
vi.mock("@/lib/embed/frame-ancestors.server", () => ({
  FRAME_ANCESTORS_NONE: "'none'",
  frameAncestorsDirectiveFor: () => "'none'",
  resolveVerifiedWidgetFrameOrigin: (input: unknown) => resolveVerifiedWidgetFrameOrigin(input),
}));
vi.mock("better-auth/cookies", () => ({ getSessionCookie: () => getSessionCookie() }));
vi.mock("@/lib/widget-stream-runtime-slug-snapshot", () => ({
  isRuntimeApprovedWidgetStreamPublicPath: () => false,
}));
vi.mock("@/lib/generated/widget-stream-public-paths", () => ({
  GENERATED_WIDGET_STREAM_PUBLIC_PATHS: [],
  GENERATED_WIDGET_STREAM_TOKEN_PATHS: [],
  GENERATED_WIDGET_STREAM_CAPABILITY_PATHS: [],
}));

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS } from "../review-island-credential";
import { resolveIslandCredentialReader } from "../review-island-serving";
import { mintWidgetReviewIslandUrl } from "../widget-lifecycle-actor";
import type { UserTokenClaims } from "@/lib/widget-user-auth";
import {
  WIDGET_LIFECYCLE_READ_ROUTE_PATH,
  WIDGET_LIFECYCLE_READ_SCOPE,
} from "@/lib/widget-lifecycle-scope";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";
import { guardAppRoute } from "@/lib/auth-route-guard";
// THE CARD'S OWN COMPOSITION. The address that reaches the handler below is the
// one the widget arm builds, from the card's own module — not a second string
// assembled by this test to look like it.
import {
  ISLAND_EMPTY_ANCHOR,
  reviewTargetIslandSrc,
} from "@cinatra-ai/agents/review-gate-card";

const GATE = { runId: "run-3051", reviewTaskId: "task-3051" };
const AGENT = "wordpress-content-editor";
const APP_ORIGIN = "https://app.example";
const REGISTERED = "https://wp.example.test";

const CLAIMS: UserTokenClaims = {
  userId: "user-1",
  orgId: "org-A",
  siteId: "site-1",
  client: "wordpress",
  siteOrigin: REGISTERED,
  agentSlug: AGENT,
  instanceId: "inst-1",
  jti: "jti-1",
  grantedScopes: [WIDGET_LIFECYCLE_READ_SCOPE],
};

const FRAME = { assistant: "wordpress", instanceId: CLAIMS.instanceId };

function liveTokenRow(): Record<string, unknown> {
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
  };
}

const REF = encodeLifecycleGateRef(GATE)!;

/**
 * ONE RESOLVE, then the address the card would frame from its answer.
 *
 * The server mints (`mintWidgetReviewIslandUrl`, the real mint site, writing a
 * real grant), and the card composes (`reviewTargetIslandSrc`, the real card),
 * so what the handler is asked below is exactly what a browser would ask.
 */
function widgetArmIslandAddress(scheme: "light" | "dark" = "light"): {
  serverIslandSrc: string;
  framed: string;
} {
  const serverIslandSrc = mintWidgetReviewIslandUrl({
    claims: CLAIMS,
    ref: REF,
    runId: GATE.runId,
    reviewTaskId: GATE.reviewTaskId,
  });
  if (!serverIslandSrc) throw new Error("the resolve minted no island address");
  return { serverIslandSrc, framed: reviewTargetIslandSrc(REF, FRAME, serverIslandSrc, scheme) };
}

/** A NextRequest double carrying only what the guard reads. */
function islandRequest(framed: string) {
  const url = new URL(framed, APP_ORIGIN);
  return { nextUrl: url, url: url.toString(), method: "GET", headers: new Headers() } as never;
}

/** The credential the frame presents, out of the address it was given. */
function presentedCredential(framed: string): string {
  return new URL(framed, APP_ORIGIN).searchParams.get("ic") ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.clear();
  dbClockSeconds = Math.floor(Date.now() / 1000);
  tokenRow = liveTokenRow();
  widgetAuthSessionIsLive.mockReturnValue(true);
  getActiveConnectSiteById.mockReturnValue({
    siteId: CLAIMS.siteId,
    client: CLAIMS.client,
    orgId: CLAIMS.orgId,
    widgetOrigin: CLAIMS.siteOrigin,
    credentialVersion: 3,
  });
  resolveActorGrantsForUserInOrg.mockResolvedValue({
    orgRole: "member",
    teamIds: [],
    teamRoles: {},
    projectGrants: [],
  });
  readUserIsPlatformAdmin.mockResolvedValue(false);
  resolveVerifiedWidgetFrameOrigin.mockReturnValue(REGISTERED);
  getSessionCookie.mockReturnValue(null);
});

describe("the request the widget arm issues, at the handler that answers it", () => {
  it("is the card's own address: the ref, the credential and the two frame selectors", () => {
    const { framed } = widgetArmIslandAddress();
    const url = new URL(framed, APP_ORIGIN);
    expect(url.pathname).toBe("/lifecycle/review-island");
    expect(url.searchParams.get("ref")).toBe(REF);
    expect(url.searchParams.get("ic")).toBeTruthy();
    expect(url.searchParams.get("assistant")).toBe(FRAME.assistant);
    expect(url.searchParams.get("instanceId")).toBe(FRAME.instanceId);
    expect(url.searchParams.get("scheme")).toBe("light");
  });

  it("is ADMITTED at the first presentation — the guard passes it to the page", async () => {
    const { framed } = widgetArmIslandAddress();
    const response = await guardAppRoute(islandRequest(framed));
    // The credential branch: not the empty island, not a sign-in redirect.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("");
    // And the framing wall admits the one ancestor chain this frame really has.
    expect(response.headers.get("content-security-policy")).toBe(
      `frame-ancestors 'self' ${REGISTERED}`,
    );
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("resolves the READER at the first presentation — the first render is not refused", async () => {
    const { framed } = widgetArmIslandAddress();
    const reader = await resolveIslandCredentialReader({
      credential: presentedCredential(framed),
      ref: REF,
    });
    expect(reader, "the handler admits the widget's own first fetch").not.toBeNull();
    expect(reader!.runId).toBe(GATE.runId);
    expect(reader!.reviewTaskId).toBe(GATE.reviewTaskId);
    expect(reader!.actorCtx.orgId).toBe(CLAIMS.orgId);
  });

  it("REFUSES the second presentation of that same address — one paint, one grant", async () => {
    const { framed } = widgetArmIslandAddress();
    const credential = presentedCredential(framed);
    expect(await resolveIslandCredentialReader({ credential, ref: REF })).not.toBeNull();
    // A frame remount on the SAME `src` — what the retry used to do before it
    // waited for a fresh address — presents this a second time.
    expect(
      await resolveIslandCredentialReader({ credential, ref: REF }),
      "the re-presented address paints the empty island",
    ).toBeNull();
  });

  it("REFUSES it once its minute has passed, at the DATABASE clock", async () => {
    const { framed } = widgetArmIslandAddress();
    dbClockSeconds += REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS + 1;
    expect(
      await resolveIslandCredentialReader({ credential: presentedCredential(framed), ref: REF }),
    ).toBeNull();
  });
});

describe("the negative control: a frame with no credential", () => {
  it("is answered EMPTY by the guard, before the page runs", async () => {
    // The card composes the same address MINUS the server's credential — what it
    // frames whenever the resolve answered without one.
    const framed = reviewTargetIslandSrc(REF, FRAME, null, "light");
    expect(new URL(framed, APP_ORIGIN).searchParams.get("ic")).toBeNull();
    const response = await guardAppRoute(islandRequest(framed));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // AND IT IS THE DOCUMENT THE CARD READS (cinatra#3051). This refusal fires
    // the frame's `load` like any other, so the card can only keep the header,
    // the floor and the retry on screen if it can RECOGNIZE it. A zero-byte body
    // could not be told apart from a target that had arrived.
    const body = await response.text();
    expect(body).toContain(ISLAND_EMPTY_ANCHOR);
    // And it says nothing else — no reason, no content: the refusal stays as
    // indistinguishable from every other one as it was.
    expect(body).not.toMatch(/credential|unauthor|forbidden|sign.?in/i);
    // The wall is still the widened one — the frame is legitimate, it simply has
    // nothing to authenticate with, so it paints nothing.
    expect(response.headers.get("content-security-policy")).toBe(
      `frame-ancestors 'self' ${REGISTERED}`,
    );
  });
});
