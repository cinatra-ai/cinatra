/**
 * connector-instance pending-call DECISION token mint + verify contract
 * (S5 destructive-confirmation, cinatra#2020, PR-2).
 *
 * The server read that renders a destructive-confirmation card mints this
 * short-lived signed token — one per action family per parked row — and the
 * decide server action (PR-4) presents it back on Confirm / Deny / Cancel. It is
 * a served-card CSRF-style nonce layered OVER the live session + row ownership;
 * single-use is DB-consume-backed (the row CAS), so a token is intentionally
 * replayable within its TTL. This suite mirrors the merged `widget-chat-resume-
 * token` matrix, adapted for the decision token's row / requester / org / session
 * / action BINDINGS:
 *  - round-trip: a fresh token verifies for its exact bindings and reconstructs
 *    the decision; the payload carries EXACTLY the specified claim set
 *  - pc / sub / org / sid BINDING: a token minted for another row / requester /
 *    org / session is rejected (each REQUIRED + FAIL-CLOSED)
 *  - act / action-confusion: a confirm-token authorizes ONLY confirm; a
 *    reject-token authorizes deny AND cancel but NEVER confirm (the ONE mapping)
 *  - TTL is 600 s (SHORT); an expired / stretched-lifetime token is rejected AT
 *    VERIFY; future-dated / non-integer timestamps rejected
 *  - every claim REQUIRED, blank-after-trim, and fail-closed even under a valid
 *    HMAC (the claim-shape attack); signature canonicalization + splice-resist
 *  - cross-type forgery BOTH directions vs the widget-chat-resume token
 */
import { createHmac } from "node:crypto";

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import {
  issuePendingCallDecisionToken,
  verifyPendingCallDecisionToken,
  pendingCallDecisionActForAction,
  PENDING_CALL_DECISION_TOKEN_TYPE,
  type PendingCallDecision,
  type PendingCallDecisionAction,
  type PendingCallDecisionTokenInput,
} from "../connector-instance-pending-call-decision-token";
import {
  issueWidgetChatResumeToken,
  verifyWidgetChatResumeToken,
} from "../widget-chat-resume-token";

// Pinned literals of the private aud/iss constants (the module can never drift
// from these without failing the round-trip + hand-signed positive controls).
const DECISION_AUDIENCE = "cinatra:connector-instance:pending-call-decision";
const DECISION_ISSUER =
  "cinatra:connector-instance-pending-call-decision-token";

const PENDING_CALL_ID = "cipc_0123456789abcdef0123456789abcdef";
const USER_ID = "u-requester";
const ORG_ID = "org-abc";
const SESSION_ID = "sess-live-xyz";

const CONFIRM_INPUT: PendingCallDecisionTokenInput = {
  pendingCallId: PENDING_CALL_ID,
  userId: USER_ID,
  orgId: ORG_ID,
  sessionId: SESSION_ID,
  act: "confirm",
};
const REJECT_INPUT: PendingCallDecisionTokenInput = {
  ...CONFIRM_INPUT,
  act: "reject",
};

const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-decision-token-unit";
});

afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
  }
});

const issue = issuePendingCallDecisionToken;

/** Verify with the default (matching) bindings; override per test. */
function verify(
  token: string | null | undefined,
  overrides: Partial<{
    expectedPendingCallId: string;
    expectedUserId: string;
    expectedOrgId: string;
    expectedSessionId: string;
    expectedAction: PendingCallDecisionAction;
  }> = {},
): PendingCallDecision | null {
  return verifyPendingCallDecisionToken({
    token,
    expectedPendingCallId: PENDING_CALL_ID,
    expectedUserId: USER_ID,
    expectedOrgId: ORG_ID,
    expectedSessionId: SESSION_ID,
    expectedAction: "confirm",
    ...overrides,
  });
}

function decodePayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** Hand-craft a validly-HMAC-signed token from arbitrary claims (the CLAIM-shape
 *  attack: even a valid signature must not defeat the fail-closed verifier). */
function signClaims(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signingInput = `${encodedHeader}.${payload}`;
  const signature = createHmac("sha256", secret!)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

const now = () => Math.floor(Date.now() / 1000);

function baseClaims(overrides: Record<string, unknown> = {}) {
  const iat = now();
  return {
    t: PENDING_CALL_DECISION_TOKEN_TYPE,
    pc: PENDING_CALL_ID,
    sub: USER_ID,
    org: ORG_ID,
    act: "confirm",
    sid: SESSION_ID,
    jti: "nonce-fixed-abc123",
    aud: DECISION_AUDIENCE,
    iss: DECISION_ISSUER,
    iat,
    exp: iat + 600,
    ...overrides,
  };
}

/** baseClaims with ONE key omitted (the missing-claim attack) — no unused binding. */
function claimsWithout(key: string, overrides: Record<string, unknown> = {}) {
  return Object.fromEntries(
    Object.entries(baseClaims(overrides)).filter(([k]) => k !== key),
  );
}

describe("pending-call-decision-token mint", () => {
  it("issues a token with the 600 s TTL, the decision type, and the specified claims", () => {
    const before = now();
    const token = issue(CONFIRM_INPUT);
    const after = now();
    const p = decodePayload(token);
    expect(p.iat).toBeGreaterThanOrEqual(before);
    expect(p.iat).toBeLessThanOrEqual(after);
    expect((p.exp as number) - (p.iat as number)).toBe(600);
    expect(p.t).toBe("cinatra.connector-instance.pending-call-decision");
    expect(p.aud).toBe(DECISION_AUDIENCE);
    expect(p.iss).toBe(DECISION_ISSUER);
    expect(p.pc).toBe(PENDING_CALL_ID);
    expect(p.sub).toBe(USER_ID);
    expect(p.org).toBe(ORG_ID);
    expect(p.sid).toBe(SESSION_ID);
    expect(p.act).toBe("confirm");
    expect(typeof p.jti).toBe("string");
    expect((p.jti as string).length).toBeGreaterThan(0);
  });

  it("mints EXACTLY the specified claim set (no scope/src/prole borrowed from the mirror)", () => {
    const p = decodePayload(issue(CONFIRM_INPUT));
    expect(Object.keys(p).sort()).toEqual(
      ["act", "aud", "exp", "iat", "iss", "jti", "org", "pc", "sid", "sub", "t"].sort(),
    );
  });

  it("self-generates a UNIQUE jti per mint (no external nonce; the row CAS is single-use)", () => {
    const a = decodePayload(issue(CONFIRM_INPUT)).jti;
    const b = decodePayload(issue(CONFIRM_INPUT)).jti;
    expect(a).not.toBe(b);
  });

  it("mints a reject-family token when asked", () => {
    expect(decodePayload(issue(REJECT_INPUT)).act).toBe("reject");
  });

  it("throws when BETTER_AUTH_SECRET is absent (never a silent unsigned token)", () => {
    const saved = process.env.BETTER_AUTH_SECRET;
    try {
      delete process.env.BETTER_AUTH_SECRET;
      expect(() => issue(CONFIRM_INPUT)).toThrow(/BETTER_AUTH_SECRET/);
    } finally {
      process.env.BETTER_AUTH_SECRET = saved;
    }
  });
});

describe("pending-call-decision-token verify — round-trip", () => {
  it("verifies a freshly-minted confirm token and reconstructs the exact decision", () => {
    const token = issue(CONFIRM_INPUT);
    const jti = decodePayload(token).jti as string;
    expect(verify(token)).toEqual({
      pendingCallId: PENDING_CALL_ID,
      userId: USER_ID,
      orgId: ORG_ID,
      sessionId: SESSION_ID,
      act: "confirm",
      jti,
    });
  });

  it("rejects a malformed / absent / blank / wrong-arity token", () => {
    expect(verify("not-a-jwt")).toBeNull();
    expect(verify(null)).toBeNull();
    expect(verify(undefined)).toBeNull();
    expect(verify("")).toBeNull();
    expect(verify("   ")).toBeNull();
    expect(verify("a.b")).toBeNull();
    expect(verify("a.b.c.d")).toBeNull();
  });

  it("positive control: a hand-signed token with all valid claims verifies", () => {
    const ok = verify(signClaims(baseClaims()));
    expect(ok).not.toBeNull();
    expect(ok?.pendingCallId).toBe(PENDING_CALL_ID);
  });
});

describe("pending-call-decision-token verify — bindings (pc / sub / org / sid)", () => {
  it("rejects a token minted to decide a DIFFERENT pending call (pc binding)", () => {
    const token = issue(CONFIRM_INPUT);
    expect(verify(token, { expectedPendingCallId: "cipc_other" })).toBeNull();
    expect(verify(token, { expectedPendingCallId: PENDING_CALL_ID })).not.toBeNull();
  });

  it("rejects a token for a DIFFERENT requester (sub binding)", () => {
    expect(verify(issue(CONFIRM_INPUT), { expectedUserId: "u-other" })).toBeNull();
  });

  it("rejects a token for a DIFFERENT org (org binding)", () => {
    expect(verify(issue(CONFIRM_INPUT), { expectedOrgId: "org-other" })).toBeNull();
  });

  it("rejects a token exfiltrated to a DIFFERENT session — same user (sid binding)", () => {
    expect(
      verify(issue(CONFIRM_INPUT), { expectedSessionId: "sess-attacker" }),
    ).toBeNull();
  });
});

describe("pending-call-decision-token verify — act / action-confusion", () => {
  it("maps confirm→confirm and deny/cancel→reject (the ONE exported mapping)", () => {
    expect(pendingCallDecisionActForAction("confirm")).toBe("confirm");
    expect(pendingCallDecisionActForAction("deny")).toBe("reject");
    expect(pendingCallDecisionActForAction("cancel")).toBe("reject");
  });

  it("a confirm-token authorizes ONLY confirm — never deny or cancel", () => {
    const token = issue(CONFIRM_INPUT);
    expect(verify(token, { expectedAction: "confirm" })).not.toBeNull();
    expect(verify(token, { expectedAction: "deny" })).toBeNull();
    expect(verify(token, { expectedAction: "cancel" })).toBeNull();
  });

  it("a reject-token authorizes deny AND cancel but NEVER confirm", () => {
    const token = issue(REJECT_INPUT);
    expect(verify(token, { expectedAction: "deny" })).not.toBeNull();
    expect(verify(token, { expectedAction: "cancel" })).not.toBeNull();
    expect(verify(token, { expectedAction: "confirm" })).toBeNull();
  });

  it("rejects a token whose `act` claim is missing / blank / not an act family", () => {
    expect(verify(signClaims(claimsWithout("act")))).toBeNull();
    expect(verify(signClaims(baseClaims({ act: "" })))).toBeNull();
    // the CLAIM vocabulary is the act FAMILY (confirm|reject) — the action
    // vocabulary (deny/cancel) is NOT a valid claim value.
    expect(verify(signClaims(baseClaims({ act: "deny" })), { expectedAction: "deny" })).toBeNull();
    expect(verify(signClaims(baseClaims({ act: "cancel" })), { expectedAction: "cancel" })).toBeNull();
    expect(verify(signClaims(baseClaims({ act: 1 })))).toBeNull();
  });

  it("throws (fail-closed) on an UNKNOWN action — runtime inputs are not type-checked", () => {
    expect(() =>
      pendingCallDecisionActForAction("bogus" as PendingCallDecisionAction),
    ).toThrow();
    // verify() catches the throw and returns null — an unknown action can never
    // silently collapse to reject and decide a reject-family token.
    expect(
      verify(issue(REJECT_INPUT), {
        expectedAction: "bogus" as PendingCallDecisionAction,
      }),
    ).toBeNull();
  });
});

describe("pending-call-decision-token verify — TTL / decide window", () => {
  it("rejects a token past its 600 s TTL", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-27T01:00:00Z"));
      const token = issue(CONFIRM_INPUT);
      vi.setSystemTime(new Date("2026-07-27T01:10:01Z")); // +601 s
      expect(verify(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still accepts a token comfortably inside the 600 s window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-27T01:00:00Z"));
      const token = issue(CONFIRM_INPUT);
      vi.setSystemTime(new Date("2026-07-27T01:05:00Z")); // +300 s
      expect(verify(token)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the 600 s lifetime AT VERIFY — rejects a signed token with a stretched lifetime", () => {
    const iat = now();
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 1800 })))).toBeNull();
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 601 })))).toBeNull();
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 599 })))).toBeNull();
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 600 })))).not.toBeNull();
  });

  it("rejects a future-dated token (iat > now) and non-integer timestamps", () => {
    const t = now();
    expect(verify(signClaims(baseClaims({ iat: t + 300, exp: t + 900 })))).toBeNull();
    expect(verify(signClaims(baseClaims({ iat: t + 0.5, exp: t + 600.5 })))).toBeNull();
  });

  it("rejects a token AT its exp second (exp <= now, RFC 7519)", () => {
    const t = now();
    expect(verify(signClaims(baseClaims({ iat: t - 600, exp: t })))).toBeNull();
    expect(verify(signClaims(baseClaims({ iat: t - 599, exp: t + 1 })))).not.toBeNull();
  });
});

describe("pending-call-decision-token verify — required claims fail-closed", () => {
  it("rejects a missing / blank / wrong-type `pc` even under a valid HMAC", () => {
    expect(verify(signClaims(claimsWithout("pc")))).toBeNull();
    expect(verify(signClaims(baseClaims({ pc: "" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ pc: 42 })))).toBeNull();
  });

  it("rejects a missing / blank `sub`", () => {
    expect(verify(signClaims(claimsWithout("sub")))).toBeNull();
    expect(verify(signClaims(baseClaims({ sub: "" })))).toBeNull();
  });

  it("rejects a missing / blank `org`", () => {
    expect(verify(signClaims(claimsWithout("org")))).toBeNull();
    expect(verify(signClaims(baseClaims({ org: "" })))).toBeNull();
  });

  it("rejects a missing / blank `sid`", () => {
    expect(verify(signClaims(claimsWithout("sid")))).toBeNull();
    expect(verify(signClaims(baseClaims({ sid: "" })))).toBeNull();
  });

  it("rejects a missing / blank `jti`", () => {
    expect(verify(signClaims(claimsWithout("jti")))).toBeNull();
    expect(verify(signClaims(baseClaims({ jti: "" })))).toBeNull();
  });

  it("rejects WHITESPACE-ONLY identity claims (blank after trim)", () => {
    expect(verify(signClaims(baseClaims({ pc: "   " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ sub: "  " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ org: "\t" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ sid: " " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ jti: "\n" })))).toBeNull();
  });
});

describe("pending-call-decision-token verify — type / aud / iss discriminators", () => {
  it("rejects a missing / wrong token type", () => {
    expect(verify(signClaims(claimsWithout("t")))).toBeNull();
    expect(verify(signClaims(baseClaims({ t: "cinatra.widget.chat-resume" })))).toBeNull();
  });

  it("rejects a missing / wrong audience", () => {
    expect(verify(signClaims(claimsWithout("aud")))).toBeNull();
    expect(verify(signClaims(baseClaims({ aud: "/api/assistants/chat" })))).toBeNull();
  });

  it("rejects a missing / wrong issuer", () => {
    expect(verify(signClaims(claimsWithout("iss")))).toBeNull();
    expect(verify(signClaims(baseClaims({ iss: "cinatra:something-else" })))).toBeNull();
  });
});

describe("pending-call-decision-token verify — signature integrity", () => {
  it("rejects a non-canonical re-encoding of a valid signature", () => {
    const token = issue(CONFIRM_INPUT);
    const [h, p, s] = token.split(".");
    for (const junk of ["=", "!"]) {
      expect(verify(`${h}.${p}.${s}${junk}`)).toBeNull();
    }
    expect(verify(`${h}.${p}.${s}`)).not.toBeNull();
  });

  it("rejects a wrong header alg/typ even with a body signed under the secret", () => {
    expect(verify(signClaims(baseClaims(), { alg: "none", typ: "JWT" }))).toBeNull();
    expect(verify(signClaims(baseClaims(), { alg: "HS256", typ: "NOPE" }))).toBeNull();
  });

  it("rejects a signature spliced onto a mutated payload (pc swap)", () => {
    const token = issue(CONFIRM_INPUT);
    const [header, payload, signature] = token.split(".");
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    obj.pc = "cipc_attacker-chosen";
    const mutated = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
    // Even binding to the attacker's chosen pc, the signature no longer matches.
    expect(
      verify(`${header}.${mutated}.${signature}`, {
        expectedPendingCallId: "cipc_attacker-chosen",
      }),
    ).toBeNull();
  });
});

describe("pending-call-decision-token verify — cross-type forgery (both directions)", () => {
  it("rejects a widget-chat-resume token under the decision verifier", () => {
    const resumeToken = issueWidgetChatResumeToken({
      userId: USER_ID,
      orgId: ORG_ID,
      instanceId: "inst-canonical-uuid",
      kind: "wordpress",
      runId: "run-abc",
      jti: "run-nonce",
    });
    expect(verify(resumeToken)).toBeNull();
  });

  it("REVERSE: rejects a decision token under the widget-chat-resume verifier", () => {
    const decisionToken = issue(CONFIRM_INPUT);
    expect(
      verifyWidgetChatResumeToken({
        authHeader: `Bearer ${decisionToken}`,
        expectedRunId: "run-abc",
      }),
    ).toBeNull();
  });
});
