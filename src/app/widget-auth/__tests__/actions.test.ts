// The hosted consent action (cinatra#407) and the scope it now records
// (cinatra#2574, epic #2564 S8a).
//
// The point under test: what the user READ on the consent screen is exactly what
// the authorization code CARRIES. The action takes the granted scope set from a
// server constant — the same one the page renders its copy from — so a CMS
// backend, a tampered form, or a widget replaying an old body cannot ask for
// more than the screen displayed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthSession = vi.fn();
const resolveOrgRoleForUser = vi.fn();
const consumeConsentCsrfToken = vi.fn();
const issueUserAuthCode = vi.fn();
const loadActiveTransaction = vi.fn();
const emitWidgetAuthAudit = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));
vi.mock("@/lib/connect-provisioning", () => ({
  consumeConsentCsrfToken: (...a: unknown[]) => consumeConsentCsrfToken(...a),
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
  WIDGET_CONSENT_GRANTED_SCOPES,
  WIDGET_LIFECYCLE_READ_SCOPE,
  widgetConsentRequestId,
} from "@/lib/widget-lifecycle-scope";

const TXN = {
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

function form(extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("txn", "txn-1");
  fd.set("consent_csrf", "csrf-1");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue({
    user: { id: "user-1" },
    session: { id: "sess-1" },
  });
  loadActiveTransaction.mockReturnValue(TXN);
  consumeConsentCsrfToken.mockReturnValue(true);
  resolveOrgRoleForUser.mockResolvedValue("member");
  issueUserAuthCode.mockReturnValue({
    ok: true,
    code: "code-1",
    state: "s",
    siteOrigin: "https://wp.test",
  });
});

describe("the consent records what the screen displayed", () => {
  it("issues the code with the SERVER constant's scope set", async () => {
    const r = await issueWidgetAuthCodeAction(form());
    expect(r.ok).toBe(true);
    expect(issueUserAuthCode).toHaveBeenCalledWith({
      txnId: "txn-1",
      userId: "user-1",
      grantedScopes: WIDGET_CONSENT_GRANTED_SCOPES,
    });
    expect(WIDGET_CONSENT_GRANTED_SCOPES).toContain(WIDGET_LIFECYCLE_READ_SCOPE);
  });

  it("ignores a scope claim smuggled through the form", async () => {
    await issueWidgetAuthCodeAction(
      form({ grantedScopes: "lifecycle.decide superuser", scope: "everything" }),
    );
    const call = issueUserAuthCode.mock.calls[0]?.[0] as { grantedScopes: unknown };
    expect(call.grantedScopes).toEqual(WIDGET_CONSENT_GRANTED_SCOPES);
  });

  it("audits the granted scopes on the code_issued event", async () => {
    await issueWidgetAuthCodeAction(form());
    const issued = emitWidgetAuthAudit.mock.calls.find(([e]) => e === "code_issued");
    expect(issued).toBeDefined();
    expect((issued as [string, Record<string, unknown>])[1].grantedScopes).toBe(
      WIDGET_LIFECYCLE_READ_SCOPE,
    );
  });

  // codex round 0, finding 1 — the page and the action reading the same constant
  // is not a binding. The CSRF token the screen was issued is signed over a
  // request id carrying the DISPLAYED scope set, so a screen from another build
  // cannot authorize a grant it never showed.
  it("binds the consent to the scope set the screen displayed", async () => {
    await issueWidgetAuthCodeAction(form());
    expect(consumeConsentCsrfToken).toHaveBeenCalledWith({
      token: "csrf-1",
      sessionId: "sess-1",
      requestId: widgetConsentRequestId("txn-1", WIDGET_CONSENT_GRANTED_SCOPES),
    });
    // The bound id is NOT the bare transaction id — that is what an
    // already-rendered older screen's token was signed over.
    expect(
      (consumeConsentCsrfToken.mock.calls[0]?.[0] as { requestId: string }).requestId,
    ).not.toBe("txn-1");
  });

  it("refuses a consent screen bound to a DIFFERENT displayed scope set", async () => {
    // Simulate the deploy window: the CSRF verifier only accepts the id the
    // screen was signed with, so a token minted for another set fails here and
    // no code — and therefore no grant — is issued.
    consumeConsentCsrfToken.mockImplementation(
      (input: { requestId: string }) =>
        input.requestId === widgetConsentRequestId("txn-1", []),
    );
    expect(await issueWidgetAuthCodeAction(form())).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });

  it("records NOTHING when the consent does not complete", async () => {
    // Every pre-existing gate still runs before the grant is recorded: a bad
    // CSRF, a non-member, an expired transaction — no code, so no grant.
    consumeConsentCsrfToken.mockReturnValue(false);
    expect(await issueWidgetAuthCodeAction(form())).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    consumeConsentCsrfToken.mockReturnValue(true);
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    expect(await issueWidgetAuthCodeAction(form())).toEqual({
      ok: false,
      reason: "not_org_member",
    });
    expect(issueUserAuthCode).not.toHaveBeenCalled();
  });
});
