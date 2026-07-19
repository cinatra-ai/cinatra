/**
 * widget-mcp-actor-token mint + verify contract (S5 Wave 1).
 *
 * The public-site (WordPress/Drupal) widget path moves off the bespoke
 * `/api/agents/{slug}/stream` relay onto `/api/assistants/chat`. From the
 * validated dual-token pair the route builds a server-verified widget principal
 * and mints THIS `cinatra.widget.mcp-obo` OBO token so the CMS write authorizes
 * AS THE END USER against the pinned canonical instance, with platform-admin
 * floored to `member` — no privilege widening.
 *
 * These tests pin the token half of the S5-W1 negative-test contract:
 *  - round-trip: a fresh token verifies for the audience/issuer it was minted
 *    with and reconstructs the exact widget actor (delegation, ids, kind, jti)
 *  - TTL is 120 s (SHORT — the widget turn is a single blocking CMS-edit
 *    dispatch, far tighter than the chat token's 30 min); an expired token is
 *    rejected (T6 TTL leg)
 *  - `inst` is REQUIRED and FAIL-CLOSED — a token re-signed without a valid
 *    `inst` (missing / blank) is rejected even under a valid HMAC (G2/G3)
 *  - `knd` is REQUIRED and FAIL-CLOSED — a token re-signed without / with an
 *    unknown `knd` is rejected even under a valid HMAC (G9)
 *  - `src` fixed discriminator, `jti` required
 *  - `prole` OMITTED → the verifier hard-codes `platformRole: "member"`, and a
 *    hand-crafted token that SMUGGLES `prole: "platform_admin"` still resolves
 *    to `member` (the platform-admin floor is imposed at verify) (G5)
 *  - cross-type forgery: a chat / agent-run token does NOT verify here (and a
 *    widget token does NOT verify under the chat verifier)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const PUBLIC_BASE_URL = "https://cinatra-test.tailnet000.ts.net";
const PUBLIC_MCP_URL = `${PUBLIC_BASE_URL}/api/mcp`;
const PUBLIC_AUTH_URL = `${PUBLIC_BASE_URL}/api/auth`;

vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getLocalMcpServerUrl: (path: string) => `http://localhost:3000${path}`,
  getPublicMcpServerUrl: () => PUBLIC_MCP_URL,
}));

import {
  issueWidgetMcpActorToken,
  verifyWidgetMcpActorToken,
  WIDGET_MCP_TOKEN_TYPE,
  type WidgetMcpActor,
  type WidgetMcpActorTokenInput,
} from "../widget-mcp-actor-token";
import {
  issueChatMcpActorToken,
  verifyChatMcpActorToken,
  type ChatMcpActor,
} from "../chat-mcp-actor-token";
import {
  issueAgentRunMcpActorToken,
  type AgentRunMcpActor,
} from "../agent-run-mcp-actor-token";

const WIDGET_INPUT: WidgetMcpActorTokenInput = {
  userId: "u-widget",
  orgId: "org-widget",
  instanceId: "inst-canonical-uuid",
  kind: "wordpress",
  jti: "turn-nonce-abc123",
};

const EXPECTED_ACTOR: WidgetMcpActor = {
  delegation: "public_site_widget",
  userId: "u-widget",
  orgId: "org-widget",
  instanceId: "inst-canonical-uuid",
  kind: "wordpress",
  jti: "turn-nonce-abc123",
  platformRole: "member",
};

const CHAT_ACTOR: ChatMcpActor = {
  delegation: "chat",
  userId: "u-widget",
  orgId: "org-widget",
  platformRole: "member",
};

const AGENT_RUN_ACTOR: AgentRunMcpActor = {
  delegation: "agent_run",
  userId: "u-widget",
  orgId: "org-widget",
  runId: "run-uuid",
  platformRole: "member",
  oboCeiling: [
    { tier: "user", id: "u-widget" },
    { tier: "organization", id: "org-widget" },
  ],
};

const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-actor-token-unit";
});

afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
  }
});

function verify(authToken: string) {
  return verifyWidgetMcpActorToken({
    authHeader: `Bearer ${authToken}`,
    request: new Request(PUBLIC_MCP_URL),
    expectedAudience: PUBLIC_MCP_URL,
    expectedIssuer: PUBLIC_AUTH_URL,
  });
}

function decodePayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** Hand-craft a validly-HMAC-signed token from arbitrary claims (the CLAIM-shape
 *  attack: even a valid signature must not defeat the fail-closed verifier). */
function signClaims(claims: Record<string, unknown>): string {
  const { createHmac } = require("node:crypto");
  const secret = process.env.BETTER_AUTH_SECRET;
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret!)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

const now = () => Math.floor(Date.now() / 1000);

function baseClaims(overrides: Record<string, unknown> = {}) {
  const iat = now();
  return {
    t: WIDGET_MCP_TOKEN_TYPE,
    sub: "u-widget",
    org: "org-widget",
    inst: "inst-canonical-uuid",
    knd: "wordpress",
    src: "public_site_widget",
    jti: "turn-nonce-abc123",
    scope: "mcp:connect",
    aud: PUBLIC_MCP_URL,
    iss: PUBLIC_AUTH_URL,
    iat,
    exp: iat + 120,
    ...overrides,
  };
}

describe("widget-mcp-actor-token mint", () => {
  it("issues a token with the 120-second TTL and the widget type + claims", () => {
    const before = now();
    const token = issueWidgetMcpActorToken(WIDGET_INPUT);
    const after = now();
    const p = decodePayload(token);
    expect(p.iat).toBeGreaterThanOrEqual(before);
    expect(p.iat).toBeLessThanOrEqual(after);
    expect((p.exp as number) - (p.iat as number)).toBe(120);
    expect(p.t).toBe("cinatra.widget.mcp-obo");
    expect(p.src).toBe("public_site_widget");
    expect(p.inst).toBe("inst-canonical-uuid");
    expect(p.knd).toBe("wordpress");
    expect(p.jti).toBe("turn-nonce-abc123");
    // prole is DELIBERATELY not minted — the floor is imposed at verify.
    expect(p).not.toHaveProperty("prole");
  });
});

describe("widget-mcp-actor-token verify — round-trip", () => {
  it("verifies a freshly-minted token and reconstructs the exact widget actor", () => {
    const token = issueWidgetMcpActorToken(WIDGET_INPUT);
    expect(verify(token)).toEqual(EXPECTED_ACTOR);
  });

  it("round-trips a drupal-kind token", () => {
    const token = issueWidgetMcpActorToken({ ...WIDGET_INPUT, kind: "drupal" });
    expect(verify(token)?.kind).toBe("drupal");
  });

  it("rejects a wrong-audience token (per-instance replay defense)", () => {
    const token = issueWidgetMcpActorToken(WIDGET_INPUT);
    const verified = verifyWidgetMcpActorToken({
      authHeader: `Bearer ${token}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: "https://other-instance.example.com/api/mcp",
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toBeNull();
  });

  it("rejects a malformed token and an absent Authorization header", () => {
    expect(verify("not-a-jwt")).toBeNull();
    expect(
      verifyWidgetMcpActorToken({
        authHeader: null,
        request: new Request(PUBLIC_MCP_URL),
        expectedAudience: PUBLIC_MCP_URL,
        expectedIssuer: PUBLIC_AUTH_URL,
      }),
    ).toBeNull();
  });
});

describe("widget-mcp-actor-token verify — TTL / replay window (T6)", () => {
  it("rejects a token past its 120 s TTL", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-18T01:00:00Z"));
      const token = issueWidgetMcpActorToken(WIDGET_INPUT);
      // +121 s — one second past the 120 s TTL.
      vi.setSystemTime(new Date("2026-07-18T01:02:01Z"));
      expect(verify(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still accepts a token comfortably inside the 120 s window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-18T01:00:00Z"));
      const token = issueWidgetMcpActorToken(WIDGET_INPUT);
      vi.setSystemTime(new Date("2026-07-18T01:01:00Z")); // +60 s
      expect(verify(token)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the 120 s lifetime at VERIFY — rejects a signed token with a stretched lifetime", () => {
    // Even under a VALID HMAC, a token whose lifetime is not exactly the widget
    // TTL is rejected: the short-TTL replay-containment property is enforced by
    // the verifier, not merely trusted from the issuer.
    const iat = now();
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 1800 })))).toBeNull(); // 30 min
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 121 })))).toBeNull(); // +1 s
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 119 })))).toBeNull(); // -1 s
    // Positive control: the exact 120 s lifetime verifies.
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 120 })))).not.toBeNull();
  });

  it("rejects a future-dated token (iat > now) and non-integer timestamps", () => {
    const t = now();
    expect(verify(signClaims(baseClaims({ iat: t + 300, exp: t + 420 })))).toBeNull();
    expect(verify(signClaims(baseClaims({ iat: t + 0.5, exp: t + 120.5 })))).toBeNull();
  });

  it("carries the per-turn `jti` onto the resolved actor (transport turn-binding input)", () => {
    // Token-level replay containment is the `jti` the transport records against
    // the active thread/turn; the token verifier's job is to (a) REQUIRE it and
    // (b) surface it verbatim. Cross-turn denial itself is a transport test.
    const token = issueWidgetMcpActorToken({ ...WIDGET_INPUT, jti: "nonce-xyz" });
    expect(verify(token)?.jti).toBe("nonce-xyz");
  });

  it("rejects a token re-signed without a `jti` (fail closed)", () => {
    const { jti: _drop, ...noJti } = baseClaims();
    expect(verify(signClaims(noJti))).toBeNull();
    expect(verify(signClaims(baseClaims({ jti: "" })))).toBeNull();
  });
});

describe("widget-mcp-actor-token verify — inst REQUIRED / fail-closed (G2/G3)", () => {
  it("rejects a token re-signed without a valid `inst` even under a valid HMAC", () => {
    const { inst: _drop, ...noInst } = baseClaims();
    // Omitted, blank, and non-string all fail closed — the server-verified
    // origin re-pin can never be lost into an un-pinned OBO actor.
    expect(verify(signClaims(noInst))).toBeNull();
    expect(verify(signClaims(baseClaims({ inst: "" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ inst: 42 })))).toBeNull();
  });

  it("positive control: the SAME hand-signed path WITH a valid `inst` verifies", () => {
    // Proves the rejections above are due to `inst` alone, not a signing/harness
    // artifact.
    const ok = verify(signClaims(baseClaims()));
    expect(ok).not.toBeNull();
    expect(ok?.instanceId).toBe("inst-canonical-uuid");
  });
});

describe("widget-mcp-actor-token verify — blank-after-trim identity claims", () => {
  it("rejects a WHITESPACE-ONLY inst / org / sub / jti even under a valid HMAC", () => {
    // length>0 is not enough — a whitespace-only identity/instance/nonce is
    // treated as absent (fail closed), never a resolved actor.
    expect(verify(signClaims(baseClaims({ inst: "   " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ org: "  " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ sub: "\t" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ jti: " " })))).toBeNull();
  });
});

describe("widget-mcp-actor-token verify — signature canonicalization", () => {
  it("rejects a non-canonical re-encoding of a valid signature", () => {
    // base64url decoding is lenient — a trailing `=`, a stray non-alphabet
    // char, or whitespace all decode to the SAME bytes. The verifier compares
    // the CANONICAL encoding, so a re-encoded signature is rejected (fail
    // closed on signature malleability; keeps the token string canonical).
    const token = issueWidgetMcpActorToken(WIDGET_INPUT);
    const [h, p, s] = token.split(".");
    // `=` (padding) and `!` (out-of-alphabet) are base64url decode-noops that a
    // byte-compare verifier would accept — the canonical encoding compare rejects
    // them. (A trailing space is stripped by the Bearer parser and an extra `.`
    // is caught by the 3-part split — both distinct, pre-existing guards.)
    for (const junk of ["=", "!"]) {
      expect(verify(`${h}.${p}.${s}${junk}`)).toBeNull();
    }
    // Positive control: the exact canonical signature still verifies.
    expect(verify(`${h}.${p}.${s}`)).not.toBeNull();
  });
});

describe("widget-mcp-actor-token verify — exact-expiry boundary", () => {
  it("rejects a token AT its exp second (exp <= now, RFC 7519)", () => {
    const t = now();
    // iat = t-120, exp = t → lifetime is exactly 120 s AND exp === now.
    expect(verify(signClaims(baseClaims({ iat: t - 120, exp: t })))).toBeNull();
    // One second earlier still verifies (exp = now+1).
    expect(
      verify(signClaims(baseClaims({ iat: t - 119, exp: t + 1 }))),
    ).not.toBeNull();
  });
});

describe("widget-mcp-actor-token verify — knd REQUIRED / fail-closed (G9)", () => {
  it("rejects a token re-signed without / with an unknown `knd` even under a valid HMAC", () => {
    const { knd: _drop, ...noKnd } = baseClaims();
    expect(verify(signClaims(noKnd))).toBeNull();
    expect(verify(signClaims(baseClaims({ knd: "" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ knd: "shopify" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ knd: 1 })))).toBeNull();
  });

  it("accepts only the two enumerated kinds", () => {
    expect(verify(signClaims(baseClaims({ knd: "wordpress" })))?.kind).toBe(
      "wordpress",
    );
    expect(verify(signClaims(baseClaims({ knd: "drupal" })))?.kind).toBe(
      "drupal",
    );
  });
});

describe("widget-mcp-actor-token verify — src / org fail-closed", () => {
  it("rejects a token whose `src` discriminator is wrong or missing", () => {
    const { src: _drop, ...noSrc } = baseClaims();
    expect(verify(signClaims(noSrc))).toBeNull();
    expect(verify(signClaims(baseClaims({ src: "chat" })))).toBeNull();
  });

  it("rejects a token re-signed without an `org` (widget path is org-scoped)", () => {
    const { org: _drop, ...noOrg } = baseClaims();
    expect(verify(signClaims(noOrg))).toBeNull();
    expect(verify(signClaims(baseClaims({ org: "" })))).toBeNull();
  });
});

describe("widget-mcp-actor-token verify — platform-admin floor (G5)", () => {
  it("resolves platformRole to `member` for a normal token (prole omitted)", () => {
    const token = issueWidgetMcpActorToken(WIDGET_INPUT);
    expect(verify(token)?.platformRole).toBe("member");
  });

  it("resolves to `member` even when a token SMUGGLES prole:'platform_admin'", () => {
    // Defense-in-depth: even a validly-HMAC-signed token carrying a rogue
    // `prole: "platform_admin"` claim is floored — the verifier IGNORES any
    // role claim and hard-codes `member`. A widget user is NEVER platform_admin
    // at the boundary, so the mcp-boundary immediate-allow can't trigger.
    const smuggled = signClaims(baseClaims({ prole: "platform_admin" }));
    const verified = verify(smuggled);
    expect(verified).not.toBeNull();
    expect(verified?.platformRole).toBe("member");
  });
});

describe("widget-mcp-actor-token verify — cross-type forgery protection", () => {
  it("rejects a chat-typed token under the widget verifier", () => {
    const chatToken = issueChatMcpActorToken(CHAT_ACTOR);
    expect(verify(chatToken)).toBeNull();
  });

  it("rejects an agent-run-typed token under the widget verifier", () => {
    const agentToken = issueAgentRunMcpActorToken(AGENT_RUN_ACTOR);
    expect(verify(agentToken)).toBeNull();
  });

  it("rejects a widget token under the chat verifier (reverse cross-type)", () => {
    const widgetToken = issueWidgetMcpActorToken(WIDGET_INPUT);
    const asChat = verifyChatMcpActorToken({
      authHeader: `Bearer ${widgetToken}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(asChat).toBeNull();
  });

  it("rejects a widget token whose signature was spliced onto a mutated payload", () => {
    const token = issueWidgetMcpActorToken(WIDGET_INPUT);
    const [header, payload, signature] = token.split(".");
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    obj.inst = "attacker-chosen-instance";
    const mutated = Buffer.from(JSON.stringify(obj), "utf8").toString(
      "base64url",
    );
    expect(verify(`${header}.${mutated}.${signature}`)).toBeNull();
  });
});
