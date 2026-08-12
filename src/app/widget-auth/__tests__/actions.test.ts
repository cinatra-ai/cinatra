// The hosted widget-auth grant action (cinatra#407) and the scope a SIGN-IN
// records (cinatra#2574, epic #2564 S8a; reworked by cinatra#2631).
//
// Owner ruling (2026-08-10): "treat sign in as consent." There is no consent
// screen and no Continue button, so the property under test is no longer "what
// the user read on the consent screen is what the code carries" — it is that the
// grant has EXACTLY ONE source, the server constant; that a screen which showed
// a DIFFERENT set is refused; and that every gate which does not depend on the
// removed screen still runs before anything is recorded.
//
// The action has no parameter through which a grant could be requested, so these
// tests drive the two things that DO vary: the transaction's own record of what
// its sign-in screen displayed, and the surrounding gates.

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthSession = vi.fn();
const resolveOrgRoleForUser = vi.fn();
const issueUserAuthCode = vi.fn();
const loadActiveTransaction = vi.fn();
const emitWidgetAuthAudit = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));
vi.mock("@/lib/widget-user-auth", () => ({
  issueUserAuthCode: (...a: unknown[]) => issueUserAuthCode(...a),
  loadActiveTransaction: (...a: unknown[]) => loadActiveTransaction(...a),
  // The REAL fingerprint (a pure hash of the session id) — the binding between
  // the sentinel and the session is the property under test, so it is not stubbed.
  widgetSessionFingerprint: (id: unknown) =>
    typeof id === "string" && id.trim()
      ? createHash("sha256").update(id.trim()).digest("hex").slice(0, 32)
      : "",
  // Likewise REAL: whether the arrival presenting a nonce is the arrival the
  // record was written for is the property under test (rework round 7).
  widgetScreenNonceHash: (nonce: unknown) =>
    typeof nonce === "string" && /^[a-f0-9]{64}$/.test(nonce)
      ? createHash("sha256").update(nonce).digest("hex")
      : "",
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));

import { issueWidgetAuthCodeAction } from "../actions";
import {
  WIDGET_LIFECYCLE_READ_SCOPE,
  WIDGET_SIGNIN_GRANTED_SCOPES,
  WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
  widgetDisplayedScopesToken,
  widgetNoSignInScreenToken,
} from "@/lib/widget-lifecycle-scope";

const DISPLAYED = widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES);

/**
 * Two ARRIVALS at one transaction (codex rework round 7, finding 1). Each holds
 * a single-use nonce its browser was given; the transaction stores the HASH of
 * whichever one recorded what was displayed.
 */
const nonceOf = (who: string) => createHash("sha256").update(`nonce:${who}`).digest("hex");
const hashOf = (nonce: string) => createHash("sha256").update(nonce).digest("hex");
const NONCE_A = nonceOf("person-A");
const NONCE_B = nonceOf("person-B");

/** The no-screen sentinel one session would earn. */
const noScreenFor = (sessionId: string) =>
  widgetNoSignInScreenToken(
    createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
  );

const TXN = {
  displayedScopes: DISPLAYED,
  // A's screen recorded the set, so the record is A's.
  screenNonceHash: hashOf(NONCE_A),
  txnId: "txn-1",
  siteId: "site-1",
  client: "wordpress",
  orgId: "org-A",
  siteOrigin: "https://wp.test",
  agentSlug: "wordpress-content-editor",
  instanceId: "inst-1",
  codeChallenge: "c",
  state: "s",
};

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "sess-1" },
  });
  loadActiveTransaction.mockReturnValue(TXN);
  resolveOrgRoleForUser.mockResolvedValue("member");
  issueUserAuthCode.mockReturnValue({
    ok: true,
    code: "code-1",
    state: "s",
    siteOrigin: "https://wp.test",
  });
});

describe("one run of the hosted flow records the whole grant", () => {
  it("issues the code with the SERVER constant's scope set — including lifecycle.read", async () => {
    const r = await issueWidgetAuthCodeAction("txn-1", NONCE_A);
    expect(r.ok).toBe(true);
    expect(issueUserAuthCode).toHaveBeenCalledWith({
      txnId: "txn-1",
      userId: "user-1",
      // cinatra#2684 — and the SESSION that authorized it, read off the server's
      // own session and never off the request, so the code (and the token it
      // mints) dies when that session does.
      authSessionId: "sess-1",
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
    });
    expect(WIDGET_SIGNIN_GRANTED_SCOPES).toContain(WIDGET_LIFECYCLE_READ_SCOPE);
  });

  it("has no channel through which a caller could ask for a WIDER grant", async () => {
    // cinatra#2631: the consent form is gone, and with it every field a caller
    // could have smuggled a scope through. The two arguments are the transaction
    // id and this arrival's nonce — neither names a scope, and anything else is
    // inert.
    await (
      issueWidgetAuthCodeAction as unknown as (...a: unknown[]) => Promise<unknown>
    )("txn-1", NONCE_A, { grantedScopes: ["lifecycle.decide", "superuser"] }, "everything");
    const call = issueUserAuthCode.mock.calls[0]?.[0] as { grantedScopes: unknown };
    expect(call.grantedScopes).toEqual(WIDGET_SIGNIN_GRANTED_SCOPES);
  });

  it("audits the granted scopes on the code_issued event", async () => {
    await issueWidgetAuthCodeAction("txn-1", NONCE_A);
    const issued = emitWidgetAuthAudit.mock.calls.find(([e]) => e === "code_issued");
    expect(issued).toBeDefined();
    expect((issued as [string, Record<string, unknown>])[1].grantedScopes).toBe(
      WIDGET_LIFECYCLE_READ_SCOPE,
    );
  });
});

// codex rework round 0, finding 1 — removing the consent screen moved the
// display one request earlier; it did not remove the possibility that the screen
// and the recording come from different builds mid-rollout.
describe("what the sign-in screen displayed is checked against what is recorded", () => {
  it("refuses when the transaction's screen displayed a DIFFERENT scope set", async () => {
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: `${DISPLAYED} some.other`,
    });
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "stale_screen",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
    const denied = emitWidgetAuthAudit.mock.calls.find(([e]) => e === "consent_denied");
    expect((denied as [string, Record<string, unknown>])[1].reason).toBe(
      "stale_signin_screen",
    );
  });

  it("refuses a screen that displayed NO extra grants at all", async () => {
    // The other direction of the rollout window: an older build's screen said
    // nothing about lifecycle work, and this build would record it.
    loadActiveTransaction.mockReturnValue({ ...TXN, displayedScopes: "" });
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "stale_screen",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("proceeds when no screen rendered AND a current node proved it", async () => {
    // The sentinel is written at exactly one point: a node running this build
    // observed a session that already existed when the transaction was created,
    // so no screen of this flow can have rendered for it. That is the person who
    // already held a Cinatra session, and the gap it represents is real — the PR
    // says so rather than this check pretending to close it.
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: noScreenFor("sess-1"),
    });
    expect((await issueWidgetAuthCodeAction("txn-1", NONCE_A)).ok).toBe(true);
  });

  it("REFUSES a sentinel earned by SOMEBODY ELSE'S session", async () => {
    // codex rework round 5, finding 1. A member holding a session can stamp the
    // sentinel with a bare GET and leave the transaction unconsumed; a different
    // person could then be walked through an older node's legacy sign-in screen
    // for the same transaction. The sentinel names the arrival it proved, so it
    // says nothing about this one.
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: noScreenFor("sess-somebody-else"),
    });
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "stale_screen",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("REFUSES a hand-made no-screen lookalike", async () => {
    // The value the browser cannot produce must also be one a stray write cannot
    // produce: an unnamed claim matches no session at all.
    for (const forged of ["(no-screen)", "(no-screen:)", "(no-screen:deadbeef)"]) {
      vi.clearAllMocks();
      loadActiveTransaction.mockReturnValue({ ...TXN, displayedScopes: forged });
      expect((await issueWidgetAuthCodeAction("txn-1", NONCE_A)).ok).toBe(false);
      expect(issueUserAuthCode).not.toHaveBeenCalled();
    }
  });

  it("REFUSES the sentinel when the session cannot be named at all", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: noScreenFor("sess-1"),
    });
    expect((await issueWidgetAuthCodeAction("txn-1", NONCE_A)).ok).toBe(false);
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("REFUSES a transaction nobody classified — the MIXED-VERSION window", async () => {
    // codex rework round 3, finding 1. A new node created the transaction; an
    // OLD node rendered its legacy signed-out page, which names none of the
    // grants this build records and writes nothing; the person signed in there.
    // The column still says "nothing is known", and nothing is known, so nothing
    // is granted — the person opens the assistant login again and reads the
    // current sentences.
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
    });
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "stale_screen",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
    const denied = emitWidgetAuthAudit.mock.calls.find(([e]) => e === "consent_denied");
    expect((denied as [string, Record<string, unknown>])[1].reason).toBe(
      "stale_signin_screen",
    );
  });

  it("REFUSES a transaction that predates the mechanism (NULL)", async () => {
    // In-flight across the one deploy that introduces the column: nothing is
    // known about what its screen showed, so nothing is granted.
    loadActiveTransaction.mockReturnValue({ ...TXN, displayedScopes: null });
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "stale_screen",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("the two unknowing states are refused BEFORE the membership check runs", async () => {
    // Ordering matters: the refusal must not depend on being a member, or a
    // member of the org would still be granted on a record nothing wrote.
    for (const displayedScopes of [WIDGET_SIGNIN_SCREEN_UNCLASSIFIED, null]) {
      vi.clearAllMocks();
      loadActiveTransaction.mockReturnValue({ ...TXN, displayedScopes });
      expect((await issueWidgetAuthCodeAction("txn-1", NONCE_A)).ok).toBe(false);
      expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
      expect(issueUserAuthCode).not.toHaveBeenCalled();
    }
  });
});

// codex rework round 7, finding 1 — A REAL DISPLAYED SET IS A FACT ABOUT ONE
// ARRIVAL. The record says what was shown; the nonce says who it was shown to.
// The `(no-screen)` half of this class was closed in round 5 by naming the
// session; this is the half where a screen really rendered, for somebody else.
describe("the record is admitted only to the arrival it was written for", () => {
  it("REFUSES person B, who never held the nonce person A's screen was given", async () => {
    // THE EXPLOIT, at the action seam. A opened the transaction sessionless on a
    // current node — recording the current set — and walked away. B opened the
    // same unconsumed transaction on a legacy node, read the LEGACY copy, signed
    // in there, and arrived here. B's browser was never given A's nonce, so the
    // set A's screen displayed says nothing about what B read.
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_B)).toEqual({
      ok: false,
      reason: "stale_screen",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
    const denied = emitWidgetAuthAudit.mock.calls.find(([e]) => e === "consent_denied");
    expect((denied as [string, Record<string, unknown>])[1].reason).toBe(
      "stale_signin_screen",
    );
  });

  it("REFUSES the same B in the OTHER ordering — B's legacy screen came first", async () => {
    // The legacy node rendered first and recorded nothing, so the transaction was
    // still unclassified when A's current-node screen recorded and took the
    // record. B returns holding nothing either way: there is no ordering in which
    // an arrival that was never handed a nonce can redeem a record.
    for (const presented of ["", "   ", NONCE_B, "not-a-nonce", hashOf(NONCE_A)]) {
      vi.clearAllMocks();
      loadActiveTransaction.mockReturnValue({ ...TXN });
      expect((await issueWidgetAuthCodeAction("txn-1", presented)).ok).toBe(false);
      expect(issueUserAuthCode).not.toHaveBeenCalled();
    }
  });

  it("ADMITS person A, who presents the nonce their own screen was given", async () => {
    // The whole flow still works for the person it belongs to — the fix must not
    // close the ordinary path along with the exploit.
    expect((await issueWidgetAuthCodeAction("txn-1", NONCE_A)).ok).toBe(true);
    expect(issueUserAuthCode).toHaveBeenCalled();
  });

  it("REFUSES a record left with NO arrival at all — this mechanism's own rollout window", async () => {
    // A node running the build BEFORE this one records a displayed set and no
    // nonce. That record fails closed exactly like `(unclassified)` and the
    // pre-column NULL: nothing about it names the person standing here.
    for (const screenNonceHash of [null, undefined, "", "not-hex"]) {
      vi.clearAllMocks();
      loadActiveTransaction.mockReturnValue({ ...TXN, screenNonceHash });
      expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
        ok: false,
        reason: "stale_screen",
      });
      expect(issueUserAuthCode).not.toHaveBeenCalled();
    }
  });

  it("REFUSES a no-screen sentinel presented by an arrival holding the wrong nonce", async () => {
    // The two bindings are independent. Holding the session the sentinel names is
    // not the same as holding the nonce the record was written with, and either
    // one missing is a refusal.
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: noScreenFor("sess-1"),
      screenNonceHash: hashOf(NONCE_A),
    });
    expect((await issueWidgetAuthCodeAction("txn-1", NONCE_B)).ok).toBe(false);
    expect((await issueWidgetAuthCodeAction("txn-1", NONCE_A)).ok).toBe(true);
  });

  it("a correct nonce cannot rescue a set this build would not grant", async () => {
    // The other independence: being the right arrival says nothing about whether
    // what you read is what would be recorded.
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: `${DISPLAYED} some.other`,
    });
    expect((await issueWidgetAuthCodeAction("txn-1", NONCE_A)).ok).toBe(false);
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("the arrival check runs BEFORE the membership check", async () => {
    // Same ordering property the unknowing states have: a member of the org must
    // not be granted on a record that was never written for them.
    await issueWidgetAuthCodeAction("txn-1", NONCE_B);
    expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("never puts the nonce in the audit trail", async () => {
    // It is a bearer secret for the length of one transaction; the trail records
    // that an arrival did not match, never what it presented.
    await issueWidgetAuthCodeAction("txn-1", NONCE_B);
    const serialized = JSON.stringify(emitWidgetAuthAudit.mock.calls);
    expect(serialized).not.toContain(NONCE_B);
    expect(serialized).not.toContain(NONCE_A);
    expect(serialized).not.toContain(hashOf(NONCE_A));
  });
});

describe("the gates that do not depend on the removed screen still run", () => {
  it("records NOTHING without a session", async () => {
    getAuthSession.mockResolvedValue(null);
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "not_authenticated",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("records NOTHING for a consumed or expired transaction (single-use)", async () => {
    loadActiveTransaction.mockReturnValue(null);
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "transaction_expired",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("records NOTHING for a non-member of the TRANSACTION's org", async () => {
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "not_org_member",
    });
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-A", "user-1");
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("refuses an empty transaction id before it does any work", async () => {
    expect(await issueWidgetAuthCodeAction("", NONCE_A)).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("reports a losing race on the single-use transaction as expired", async () => {
    issueUserAuthCode.mockReturnValue({ ok: false, reason: "txn_not_found" });
    expect(await issueWidgetAuthCodeAction("txn-1", NONCE_A)).toEqual({
      ok: false,
      reason: "transaction_expired",
    });
  });
});
