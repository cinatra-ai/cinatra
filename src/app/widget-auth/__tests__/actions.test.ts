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

/** The no-screen sentinel one session would earn. */
const noScreenFor = (sessionId: string) =>
  widgetNoSignInScreenToken(
    createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
  );

const TXN = {
  displayedScopes: DISPLAYED,
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
    const r = await issueWidgetAuthCodeAction("txn-1");
    expect(r.ok).toBe(true);
    expect(issueUserAuthCode).toHaveBeenCalledWith({
      txnId: "txn-1",
      userId: "user-1",
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
    });
    expect(WIDGET_SIGNIN_GRANTED_SCOPES).toContain(WIDGET_LIFECYCLE_READ_SCOPE);
  });

  it("has no channel through which a caller could ask for a WIDER grant", async () => {
    // cinatra#2631: the consent form is gone, and with it every field a caller
    // could have smuggled a scope through. The transaction id is the only
    // argument, and extra arguments are inert.
    await (
      issueWidgetAuthCodeAction as unknown as (...a: unknown[]) => Promise<unknown>
    )("txn-1", { grantedScopes: ["lifecycle.decide", "superuser"] }, "everything");
    const call = issueUserAuthCode.mock.calls[0]?.[0] as { grantedScopes: unknown };
    expect(call.grantedScopes).toEqual(WIDGET_SIGNIN_GRANTED_SCOPES);
  });

  it("audits the granted scopes on the code_issued event", async () => {
    await issueWidgetAuthCodeAction("txn-1");
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
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
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
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
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
    expect((await issueWidgetAuthCodeAction("txn-1")).ok).toBe(true);
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
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
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
      expect((await issueWidgetAuthCodeAction("txn-1")).ok).toBe(false);
      expect(issueUserAuthCode).not.toHaveBeenCalled();
    }
  });

  it("REFUSES the sentinel when the session cannot be named at all", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: noScreenFor("sess-1"),
    });
    expect((await issueWidgetAuthCodeAction("txn-1")).ok).toBe(false);
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
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
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
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
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
      expect((await issueWidgetAuthCodeAction("txn-1")).ok).toBe(false);
      expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
      expect(issueUserAuthCode).not.toHaveBeenCalled();
    }
  });
});

describe("the gates that do not depend on the removed screen still run", () => {
  it("records NOTHING without a session", async () => {
    getAuthSession.mockResolvedValue(null);
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
      ok: false,
      reason: "not_authenticated",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("records NOTHING for a consumed or expired transaction (single-use)", async () => {
    loadActiveTransaction.mockReturnValue(null);
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
      ok: false,
      reason: "transaction_expired",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("records NOTHING for a non-member of the TRANSACTION's org", async () => {
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
      ok: false,
      reason: "not_org_member",
    });
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-A", "user-1");
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("refuses an empty transaction id before it does any work", async () => {
    expect(await issueWidgetAuthCodeAction("")).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it("reports a losing race on the single-use transaction as expired", async () => {
    issueUserAuthCode.mockReturnValue({ ok: false, reason: "txn_not_found" });
    expect(await issueWidgetAuthCodeAction("txn-1")).toEqual({
      ok: false,
      reason: "transaction_expired",
    });
  });
});
