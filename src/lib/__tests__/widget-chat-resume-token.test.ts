/**
 * widget-chat-resume-token mint + verify contract (S5 follow-up, cinatra#1221).
 *
 * The public-site (WordPress/Drupal) widget resumes a dropped assistant stream
 * over the AG-UI resume route (`GET /api/assistants/runs/{runId}/stream`), which
 * is session-only otherwise. The OWNER RULING (issue #1221, 2026-07-19) chose
 * OPTION A: a DISTINCT, short-lived, RUN-BOUND resume token with its OWN
 * audience — NOT the chat-audience broker token (option B, audience-widening,
 * rejected). This suite mirrors the merged 23-test `widget-mcp-actor-token`
 * matrix, adapted for the resume token's RUN-BINDING:
 *  - round-trip: a fresh token verifies FOR THE RUN it was minted with and
 *    reconstructs the exact resume actor (delegation, ids, kind, runId, jti)
 *  - RUN-BINDING: a token minted for run A is rejected at run B (the
 *    per-instance-replay analog); `run` is REQUIRED and FAIL-CLOSED
 *  - TTL is 600 s (SHORT — minted at turn start, useful only for the one-shot
 *    reconnect); an expired / stretched-lifetime token is rejected AT VERIFY
 *  - `inst` / `knd` REQUIRED and FAIL-CLOSED even under a valid HMAC
 *  - `src` fixed discriminator, `org` / `sub` / `jti` required, blank-after-trim
 *  - `prole` OMITTED → the verifier hard-codes `platformRole: "member"`, and a
 *    smuggled `prole: "platform_admin"` still resolves to `member` (G5 floor)
 *  - cross-type forgery BOTH directions: a chat / mcp-obo / opaque cit_ token
 *    does NOT verify here, and a resume token does NOT verify under the mcp-obo
 *    verifier
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The mcp-obo module derives its aud/iss from the MCP credentials; the reverse
// cross-type test mints one, so its mock must be present at import time.
const PUBLIC_BASE_URL = "https://cinatra-test.tailnet000.ts.net";
const PUBLIC_MCP_URL = `${PUBLIC_BASE_URL}/api/mcp`;
const PUBLIC_AUTH_URL = `${PUBLIC_BASE_URL}/api/auth`;

vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getLocalMcpServerUrl: (path: string) => `http://localhost:3000${path}`,
  getPublicMcpServerUrl: () => PUBLIC_MCP_URL,
}));

import {
  issueWidgetChatResumeToken,
  verifyWidgetChatResumeToken,
  WIDGET_CHAT_RESUME_TOKEN_TYPE,
  WIDGET_CHAT_RESUME_ROUTE_PATH,
  type WidgetChatResumeActor,
  type WidgetChatResumeTokenInput,
} from "../widget-chat-resume-token";
import {
  issueWidgetMcpActorToken,
  verifyWidgetMcpActorToken,
  type WidgetMcpActorTokenInput,
} from "../widget-mcp-actor-token";
import {
  issueChatMcpActorToken,
  type ChatMcpActor,
} from "../chat-mcp-actor-token";

// Pinned literal of the private issuer constant (the module can never drift from
// this without failing the round-trip below).
const RESUME_ISSUER = "cinatra:widget-chat-resume";
const RUN_ID = "run-abc-uuid";

const RESUME_INPUT: WidgetChatResumeTokenInput = {
  userId: "u-widget",
  orgId: "org-widget",
  instanceId: "inst-canonical-uuid",
  kind: "wordpress",
  runId: RUN_ID,
  jti: "run-nonce-abc123",
};

const EXPECTED_ACTOR: WidgetChatResumeActor = {
  delegation: "public_site_widget",
  userId: "u-widget",
  orgId: "org-widget",
  instanceId: "inst-canonical-uuid",
  kind: "wordpress",
  runId: RUN_ID,
  jti: "run-nonce-abc123",
  platformRole: "member",
};

const WIDGET_MCP_INPUT: WidgetMcpActorTokenInput = {
  userId: "u-widget",
  orgId: "org-widget",
  instanceId: "inst-canonical-uuid",
  kind: "wordpress",
  jti: "turn-nonce-abc123",
};

const CHAT_ACTOR: ChatMcpActor = {
  delegation: "chat",
  userId: "u-widget",
  orgId: "org-widget",
  platformRole: "member",
};

const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-resume-token-unit";
});

afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
  }
});

function verify(authToken: string, expectedRunId: string = RUN_ID) {
  return verifyWidgetChatResumeToken({
    authHeader: `Bearer ${authToken}`,
    expectedRunId,
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
    t: WIDGET_CHAT_RESUME_TOKEN_TYPE,
    sub: "u-widget",
    org: "org-widget",
    inst: "inst-canonical-uuid",
    knd: "wordpress",
    run: RUN_ID,
    src: "public_site_widget",
    jti: "run-nonce-abc123",
    scope: "chat:resume",
    aud: WIDGET_CHAT_RESUME_ROUTE_PATH,
    iss: RESUME_ISSUER,
    iat,
    exp: iat + 600,
    ...overrides,
  };
}

describe("widget-chat-resume-token mint", () => {
  it("issues a token with the 600-second TTL and the resume type + claims", () => {
    const before = now();
    const token = issueWidgetChatResumeToken(RESUME_INPUT);
    const after = now();
    const p = decodePayload(token);
    expect(p.iat).toBeGreaterThanOrEqual(before);
    expect(p.iat).toBeLessThanOrEqual(after);
    expect((p.exp as number) - (p.iat as number)).toBe(600);
    expect(p.t).toBe("cinatra.widget.chat-resume");
    expect(p.src).toBe("public_site_widget");
    expect(p.scope).toBe("chat:resume");
    expect(p.aud).toBe(WIDGET_CHAT_RESUME_ROUTE_PATH);
    expect(p.iss).toBe(RESUME_ISSUER);
    expect(p.inst).toBe("inst-canonical-uuid");
    expect(p.knd).toBe("wordpress");
    expect(p.run).toBe(RUN_ID);
    expect(p.jti).toBe("run-nonce-abc123");
    // prole is DELIBERATELY not minted — the floor is imposed at verify.
    expect(p).not.toHaveProperty("prole");
  });

  it("has an audience DISTINCT from the chat broker route (option A, not B)", () => {
    // The resume endpoint keeps its OWN audience; a token bound to it can never
    // be a `/api/assistants/chat`-audience token.
    expect(WIDGET_CHAT_RESUME_ROUTE_PATH).not.toBe("/api/assistants/chat");
  });
});

describe("widget-chat-resume-token verify — round-trip", () => {
  it("verifies a freshly-minted token FOR ITS RUN and reconstructs the exact actor", () => {
    const token = issueWidgetChatResumeToken(RESUME_INPUT);
    expect(verify(token)).toEqual(EXPECTED_ACTOR);
  });

  it("round-trips a drupal-kind token", () => {
    const token = issueWidgetChatResumeToken({ ...RESUME_INPUT, kind: "drupal" });
    expect(verify(token)?.kind).toBe("drupal");
  });

  it("rejects a malformed token and an absent Authorization header", () => {
    expect(verify("not-a-jwt")).toBeNull();
    expect(
      verifyWidgetChatResumeToken({ authHeader: null, expectedRunId: RUN_ID }),
    ).toBeNull();
  });
});

describe("widget-chat-resume-token verify — RUN-BINDING (G-resume core)", () => {
  it("rejects a token minted for a DIFFERENT run (cross-run replay)", () => {
    const token = issueWidgetChatResumeToken(RESUME_INPUT); // run = RUN_ID
    expect(verify(token, "some-other-run")).toBeNull();
  });

  it("positive control: the SAME token verifies for its OWN run", () => {
    const token = issueWidgetChatResumeToken(RESUME_INPUT);
    expect(verify(token, RUN_ID)?.runId).toBe(RUN_ID);
  });

  it("rejects a token re-signed without / with a blank `run` even under a valid HMAC", () => {
    const { run: _drop, ...noRun } = baseClaims();
    expect(verify(signClaims(noRun))).toBeNull();
    expect(verify(signClaims(baseClaims({ run: "" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ run: "   " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ run: 42 })))).toBeNull();
  });
});

describe("widget-chat-resume-token verify — TTL / reconnect window", () => {
  it("rejects a token past its 600 s TTL", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-19T01:00:00Z"));
      const token = issueWidgetChatResumeToken(RESUME_INPUT);
      // +601 s — one second past the 600 s TTL.
      vi.setSystemTime(new Date("2026-07-19T01:10:01Z"));
      expect(verify(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still accepts a token comfortably inside the 600 s window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-19T01:00:00Z"));
      const token = issueWidgetChatResumeToken(RESUME_INPUT);
      vi.setSystemTime(new Date("2026-07-19T01:05:00Z")); // +300 s
      expect(verify(token)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the 600 s lifetime AT VERIFY — rejects a signed token with a stretched lifetime", () => {
    const iat = now();
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 1800 })))).toBeNull(); // 30 min
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 601 })))).toBeNull(); // +1 s
    expect(verify(signClaims(baseClaims({ iat, exp: iat + 599 })))).toBeNull(); // -1 s
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

  it("carries the per-run `jti` onto the resolved actor", () => {
    const token = issueWidgetChatResumeToken({ ...RESUME_INPUT, jti: "nonce-xyz" });
    expect(verify(token)?.jti).toBe("nonce-xyz");
  });

  it("rejects a token re-signed without a `jti` (fail closed)", () => {
    const { jti: _drop, ...noJti } = baseClaims();
    expect(verify(signClaims(noJti))).toBeNull();
    expect(verify(signClaims(baseClaims({ jti: "" })))).toBeNull();
  });
});

describe("widget-chat-resume-token verify — inst REQUIRED / fail-closed", () => {
  it("rejects a token re-signed without a valid `inst` even under a valid HMAC", () => {
    const { inst: _drop, ...noInst } = baseClaims();
    expect(verify(signClaims(noInst))).toBeNull();
    expect(verify(signClaims(baseClaims({ inst: "" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ inst: 42 })))).toBeNull();
  });

  it("positive control: the SAME hand-signed path WITH a valid `inst` verifies", () => {
    const ok = verify(signClaims(baseClaims()));
    expect(ok).not.toBeNull();
    expect(ok?.instanceId).toBe("inst-canonical-uuid");
  });
});

describe("widget-chat-resume-token verify — blank-after-trim identity claims", () => {
  it("rejects a WHITESPACE-ONLY inst / org / sub / jti / run even under a valid HMAC", () => {
    expect(verify(signClaims(baseClaims({ inst: "   " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ org: "  " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ sub: "\t" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ jti: " " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ run: "\n" })))).toBeNull();
  });
});

describe("widget-chat-resume-token verify — signature canonicalization", () => {
  it("rejects a non-canonical re-encoding of a valid signature", () => {
    const token = issueWidgetChatResumeToken(RESUME_INPUT);
    const [h, p, s] = token.split(".");
    for (const junk of ["=", "!"]) {
      expect(verify(`${h}.${p}.${s}${junk}`)).toBeNull();
    }
    expect(verify(`${h}.${p}.${s}`)).not.toBeNull();
  });
});

describe("widget-chat-resume-token verify — knd REQUIRED / fail-closed", () => {
  it("rejects a token re-signed without / with an unknown `knd` even under a valid HMAC", () => {
    const { knd: _drop, ...noKnd } = baseClaims();
    expect(verify(signClaims(noKnd))).toBeNull();
    expect(verify(signClaims(baseClaims({ knd: "" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ knd: "shopify" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ knd: 1 })))).toBeNull();
  });

  it("accepts only the two enumerated kinds", () => {
    expect(verify(signClaims(baseClaims({ knd: "wordpress" })))?.kind).toBe("wordpress");
    expect(verify(signClaims(baseClaims({ knd: "drupal" })))?.kind).toBe("drupal");
  });
});

describe("widget-chat-resume-token verify — src / org / aud / iss fail-closed", () => {
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

  it("rejects a token bound to the CHAT-turn audience or a wrong issuer/scope", () => {
    // The audience-widening attack (option B): a token carrying the chat route
    // audience must NOT verify at the resume seam.
    expect(verify(signClaims(baseClaims({ aud: "/api/assistants/chat" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ iss: "cinatra:something-else" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ scope: "mcp:connect" })))).toBeNull();
  });
});

describe("widget-chat-resume-token verify — platform-admin floor (G5)", () => {
  it("resolves platformRole to `member` for a normal token (prole omitted)", () => {
    const token = issueWidgetChatResumeToken(RESUME_INPUT);
    expect(verify(token)?.platformRole).toBe("member");
  });

  it("resolves to `member` even when a token SMUGGLES prole:'platform_admin'", () => {
    const smuggled = signClaims(baseClaims({ prole: "platform_admin" }));
    const verified = verify(smuggled);
    expect(verified).not.toBeNull();
    expect(verified?.platformRole).toBe("member");
  });
});

describe("widget-chat-resume-token verify — cross-type forgery protection (both directions)", () => {
  it("rejects a chat-mcp-obo-typed token under the resume verifier", () => {
    const chatToken = issueChatMcpActorToken(CHAT_ACTOR);
    expect(verify(chatToken)).toBeNull();
  });

  it("rejects an mcp-obo widget token under the resume verifier", () => {
    const mcpToken = issueWidgetMcpActorToken(WIDGET_MCP_INPUT);
    expect(verify(mcpToken)).toBeNull();
  });

  it("rejects an OPAQUE chat broker (cit_/cwu_) token under the resume verifier", () => {
    // The chat-audience broker tokens are opaque, prefixed, non-JWT strings —
    // they are NEVER accepted at the resume seam (option A, not B).
    expect(verify("cit_deadbeefdeadbeefdeadbeef")).toBeNull();
    expect(verify("cwu_cafebabecafebabecafebabe")).toBeNull();
  });

  it("REVERSE: rejects a resume token under the mcp-obo verifier", () => {
    const resumeToken = issueWidgetChatResumeToken(RESUME_INPUT);
    const asMcp = verifyWidgetMcpActorToken({
      authHeader: `Bearer ${resumeToken}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(asMcp).toBeNull();
  });

  it("rejects a resume token whose signature was spliced onto a mutated payload", () => {
    const token = issueWidgetChatResumeToken(RESUME_INPUT);
    const [header, payload, signature] = token.split(".");
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    obj.run = "attacker-chosen-run";
    const mutated = Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
    expect(verify(`${header}.${mutated}.${signature}`, "attacker-chosen-run")).toBeNull();
  });
});
