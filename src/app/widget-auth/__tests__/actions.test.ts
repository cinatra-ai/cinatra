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
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));

import { issueWidgetAuthCodeAction } from "../actions";
import {
  WIDGET_LIFECYCLE_READ_SCOPE,
  WIDGET_NO_SIGNIN_SCREEN,
  WIDGET_SIGNIN_GRANTED_SCOPES,
  widgetDisplayedScopesToken,
} from "@/lib/widget-lifecycle-scope";

const DISPLAYED = widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES);

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

  it("proceeds when NO screen was rendered — the stated gap, not a mismatch", async () => {
    // The sentinel is written at transaction creation and means: a build that
    // records displayed sets made this, and none was recorded. That happens when
    // the person already held a Cinatra session. Nothing in the browser can
    // produce it — but the gap it represents is real, and the PR says so rather
    // than this check pretending to close it.
    loadActiveTransaction.mockReturnValue({
      ...TXN,
      displayedScopes: WIDGET_NO_SIGNIN_SCREEN,
    });
    expect((await issueWidgetAuthCodeAction("txn-1")).ok).toBe(true);
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
