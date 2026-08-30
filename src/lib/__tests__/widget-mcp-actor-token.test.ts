/**
 * widget-mcp-actor-token mint + verify contract (S5 Wave 1).
 *
 * The public-site (WordPress/Drupal) widget path moves off the bespoke
 * `/api/agents/{slug}/stream` relay onto `/api/assistants/chat`. From the
 * validated dual-token pair the route builds a server-verified widget principal
 * and mints THIS `cinatra.widget.mcp-obo` OBO token so the CMS write authorizes
 * AS THE END USER against the pinned canonical instance — with the person's REAL
 * platform tier since cinatra#2674 (epic #2564 S8e), which removed the floor in
 * the change set that removed its justification.
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
 *  - `prole` carries the SERVER-RESOLVED tier (cinatra#2674): omitted → `member`
 *    (so every token minted before the slice keeps its narrow meaning), the
 *    exact elevated literal → `platform_admin`, and any other value → `member`.
 *    A "smuggled" claim is not a threat model here: forging one requires the
 *    HMAC secret, and with that secret every other claim is forgeable too (G5)
 *  - cross-type forgery: a chat / agent-run token does NOT verify here (and a
 *    widget token does NOT verify under the chat verifier)
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

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
  parentJti: "cwu-row-jti-1",
  turnRunId: "run-of-this-turn",
};

const EXPECTED_ACTOR: WidgetMcpActor = {
  delegation: "public_site_widget",
  userId: "u-widget",
  orgId: "org-widget",
  instanceId: "inst-canonical-uuid",
  kind: "wordpress",
  jti: "turn-nonce-abc123",
  parentJti: "cwu-row-jti-1",
  turnRunId: "run-of-this-turn",
  platformRole: "member",
  // cinatra#2577 — WIDGET_INPUT mints no `lcr`, so the grant reads false.
  lifecycleRead: false,
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
    pjti: "cwu-row-jti-1",
    run: "run-of-this-turn",
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
    // The two seals (cinatra#2687) ride the token as their own claims.
    expect(p.pjti).toBe("cwu-row-jti-1");
    expect(p.run).toBe("run-of-this-turn");
    // prole is omitted for the ordinary (member) input — see the tier suite.
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

  it("carries the per-turn `jti` onto the resolved actor (the audit handle)", () => {
    // `jti` distinguishes two tokens minted for the same turn. It is NOT the
    // turn binding — `run` is (cinatra#2687) — and this module's job is to
    // REQUIRE it and surface it verbatim.
    const token = issueWidgetMcpActorToken({ ...WIDGET_INPUT, jti: "nonce-xyz" });
    expect(verify(token)?.jti).toBe("nonce-xyz");
  });

  it("rejects a token re-signed without a `jti` (fail closed)", () => {
    const { jti: _drop, ...noJti } = baseClaims();
    expect(verify(signClaims(noJti))).toBeNull();
    expect(verify(signClaims(baseClaims({ jti: "" })))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two seals (cinatra#2687). This module PARSES them; the authorization layer
// (widget-mcp-actor-authorization.ts) is what checks them against the live
// sign-in and the live turn. What is pinned here is that neither can be absent:
// a token that names no parent and no turn is one nothing downstream could check
// even if it wanted to, so it never resolves an actor at all.
// ---------------------------------------------------------------------------
describe("widget-mcp-actor-token verify — the parent + turn seals (#2687)", () => {
  it("surfaces both seals verbatim on the resolved actor", () => {
    const actor = verify(
      issueWidgetMcpActorToken({
        ...WIDGET_INPUT,
        parentJti: "cwu-row-42",
        turnRunId: "run-42",
      }),
    );
    expect(actor?.parentJti).toBe("cwu-row-42");
    expect(actor?.turnRunId).toBe("run-42");
  });

  it("rejects a token re-signed without a `pjti` — including one minted before #2687", () => {
    const { pjti: _drop, ...noParent } = baseClaims();
    // This IS the pre-#2687 token shape: a valid HMAC over the old claim set.
    expect(verify(signClaims(noParent))).toBeNull();
    expect(verify(signClaims(baseClaims({ pjti: "" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ pjti: "   " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ pjti: 7 })))).toBeNull();
  });

  it("rejects a token re-signed without a `run` — the seal is not optional", () => {
    const { run: _drop, ...noRun } = baseClaims();
    expect(verify(signClaims(noRun))).toBeNull();
    expect(verify(signClaims(baseClaims({ run: "" })))).toBeNull();
    expect(verify(signClaims(baseClaims({ run: "   " })))).toBeNull();
    expect(verify(signClaims(baseClaims({ run: 7 })))).toBeNull();
  });

  it("positive control: the SAME hand-signed path WITH both seals verifies", () => {
    const actor = verify(signClaims(baseClaims()));
    expect(actor).toEqual(EXPECTED_ACTOR);
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
  // THE SECOND IS PINNED HERE, and only here. The verifier reads its OWN
  // `Date.now()` on every call, so this boundary can only be stated at all if
  // the test and the code under test agree on what second it is — and a case
  // built from a live reading asks wall-clock time to stand still across
  // several calls. It does not: a second ticking over mid-case turns the
  // still-valid arm below into a rejection, which is how this test failed on a
  // loaded runner.
  //
  // The agreement is therefore made explicit instead of assumed. `Date.now` is
  // stubbed on the one global object BOTH sides look it up on, every claim
  // below is built from the pinned constant rather than from a second reading,
  // and the stub itself is asserted before it is relied on — so a fixture that
  // ever failed to take hold fails as a broken fixture, on its own line,
  // instead of as a mysterious acceptance at the boundary. Timers are left
  // completely alone (no fake-timer install), so nothing else in this file
  // changes behaviour, and the stub is removed after every case.
  const PINNED_MS = 1_800_000_000_000; // an exact second boundary, in UTC
  const PINNED_S = PINNED_MS / 1000;
  let clockMs = PINNED_MS;
  let nowSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    clockMs = PINNED_MS;
    nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
  });

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = undefined;
  });

  it("rejects a token AT its exp second (exp <= now, RFC 7519)", () => {
    // The pin is the premise of every assertion below, so it is asserted, not
    // trusted.
    expect(now()).toBe(PINNED_S);
    const t = PINNED_S;
    // iat = t-120, exp = t → lifetime is exactly 120 s AND exp === now.
    expect(verify(signClaims(baseClaims({ iat: t - 120, exp: t })))).toBeNull();
    // One second earlier still verifies (exp = now+1).
    expect(
      verify(signClaims(baseClaims({ iat: t - 119, exp: t + 1 }))),
    ).not.toBeNull();
    // The far side of the same boundary: the SAME token, refused the moment
    // the clock reaches its `exp` second. `<` would accept it here, and that
    // acceptance is the whole point of the `<=` the verifier spells out.
    clockMs = PINNED_MS + 1000;
    expect(now()).toBe(PINNED_S + 1);
    expect(
      verify(signClaims(baseClaims({ iat: t - 119, exp: t + 1 }))),
    ).toBeNull();
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

describe("widget-mcp-actor-token — the platform tier (G5, cinatra#2674)", () => {
  it("omitting the tier still means `member` — a pre-S8e token cannot elevate", () => {
    const token = issueWidgetMcpActorToken(WIDGET_INPUT);
    // The claim is not written at all for the narrow case, so `member` has
    // exactly one representation on the wire.
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    expect(payload).not.toHaveProperty("prole");
    expect(verify(token)?.platformRole).toBe("member");
  });

  it("CARRIES `platform_admin` when the server resolved it", () => {
    const token = issueWidgetMcpActorToken({
      ...WIDGET_INPUT,
      platformRole: "platform_admin",
    });
    expect(verify(token)?.platformRole).toBe("platform_admin");
  });

  it("resolves NARROW for any claim value that is not the exact literal", () => {
    for (const prole of ["PLATFORM_ADMIN", "admin", " platform_admin", 1, true, {}, null]) {
      const verified = verify(signClaims(baseClaims({ prole })));
      expect(verified).not.toBeNull();
      expect(verified?.platformRole).toBe("member");
    }
    // NEGATIVE CONTROL: the exact literal, through the same signing path, DOES
    // resolve elevated — so the cases above are narrow for the right reason.
    expect(verify(signClaims(baseClaims({ prole: "platform_admin" })))?.platformRole).toBe(
      "platform_admin",
    );
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

// ---------------------------------------------------------------------------
// cinatra#2577 (epic #2564 S8d) — the `lcr` lifecycle-read GRANT claim.
//
// The `cwu_` never crosses the MCP boundary; this token does, and it carries the
// grant the route already established from that `cwu_`'s own consume. Everything
// here is about the claim being STRICT and the no-grant token being the
// unchanged one — so a session that predates the grant, an older node's token,
// and a tampered payload all resolve to "no grant" by the same reading.
// ---------------------------------------------------------------------------

describe("widget-mcp-actor-token — the lifecycle-read grant (S8d)", () => {
  it("mints `lcr: true` only when the grant is genuinely held", () => {
    const granted = decodePayload(
      issueWidgetMcpActorToken({ ...WIDGET_INPUT, lifecycleRead: true }),
    );
    expect(granted.lcr).toBe(true);
  });

  it("mints NO claim at all when the grant is absent — the token is unchanged", () => {
    // Not `lcr: false`. A no-grant token is byte-identical to a pre-S8d one, so
    // the absent claim has exactly one fail-closed reading everywhere.
    for (const input of [
      WIDGET_INPUT,
      { ...WIDGET_INPUT, lifecycleRead: false },
    ]) {
      const payload = decodePayload(issueWidgetMcpActorToken(input));
      expect("lcr" in payload).toBe(false);
    }
    // The byte-equality below is asserted under a FROZEN clock. Every token is
    // stamped `iat`/`exp` from `Date.now()`, so two issuances that straddle a
    // second boundary differ by one second on those two claims alone and the
    // comparison would fail for a reason that has nothing to do with the grant.
    // Freezing the clock across both issuances makes the property hold by
    // construction: the ONLY thing that can differ between the two tokens is a
    // claim the absent grant added, which is exactly what this asserts.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      expect(issueWidgetMcpActorToken({ ...WIDGET_INPUT, lifecycleRead: false })).toBe(
        issueWidgetMcpActorToken(WIDGET_INPUT),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("round-trips the grant through verify", () => {
    const actor = verify(issueWidgetMcpActorToken({ ...WIDGET_INPUT, lifecycleRead: true }));
    expect(actor?.lifecycleRead).toBe(true);
  });

  it("reads an ABSENT claim as no grant", () => {
    expect(verify(issueWidgetMcpActorToken(WIDGET_INPUT))?.lifecycleRead).toBe(false);
  });

  it.each([["true"], [1], [{}], [null], [false], [["lifecycle.read"]]])(
    "reads a validly-SIGNED `lcr` of %p as no grant (strict === true)",
    (value) => {
      // The claim-shape attack: a valid signature must not defeat the reading.
      // Anything other than the literal `true` grants nothing.
      const base = decodePayload(issueWidgetMcpActorToken(WIDGET_INPUT));
      const actor = verify(signClaims({ ...base, lcr: value }));
      expect(actor).not.toBeNull();
      expect(actor?.lifecycleRead).toBe(false);
    },
  );

  it("the grant is not a way around any OTHER fail-closed claim", () => {
    // It is an additive grant, never a bypass: a token that fails the kind, the
    // instance pin or the type check is still null, grant or no grant.
    const base = decodePayload(
      issueWidgetMcpActorToken({ ...WIDGET_INPUT, lifecycleRead: true }),
    );
    expect(verify(signClaims({ ...base, inst: "" }))).toBeNull();
    expect(verify(signClaims({ ...base, knd: "joomla" }))).toBeNull();
    expect(verify(signClaims({ ...base, t: "cinatra.chat.mcp-obo" }))).toBeNull();
  });
});
