/**
 * Unit tests for the dispatcher-signed agent-run binding.
 *
 * The binding is an HMAC over {runId, orgId, runBy, purpose, version,
 * iat, exp} keyed by BETTER_AUTH_SECRET. issue/verify must round-trip; every
 * tamper / wrong-key / replay / purpose-mismatch path must be rejected.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  issueAgentRunBinding,
  verifyAgentRunBinding,
  AGENT_RUN_BINDING_PURPOSE,
  AGENT_RUN_BINDING_VERSION,
} from "../agent-run-binding";

const BEFORE = process.env.BETTER_AUTH_SECRET;
const SECRET = "unit-test-secret-for-run-binding-12345";

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = SECRET;
});
afterAll(() => {
  if (BEFORE === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = BEFORE;
});

const TRIPLE = { runId: "run-1", orgId: "org-1", runBy: "user-1" };

describe("issue/verify round-trip", () => {
  it("verifies a freshly minted binding and returns the payload", () => {
    const token = issueAgentRunBinding(TRIPLE);
    const res = verifyAgentRunBinding(token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.runId).toBe("run-1");
    expect(res.payload.orgId).toBe("org-1");
    expect(res.payload.runBy).toBe("user-1");
    expect(res.payload.purpose).toBe(AGENT_RUN_BINDING_PURPOSE);
    expect(res.payload.version).toBe(AGENT_RUN_BINDING_VERSION);
    expect(res.payload.exp).toBeGreaterThan(res.payload.iat);
  });

  it("issue throws on empty identity tuple", () => {
    expect(() => issueAgentRunBinding({ runId: "", orgId: "o", runBy: "u" })).toThrow();
    expect(() => issueAgentRunBinding({ runId: "r", orgId: "", runBy: "u" })).toThrow();
    expect(() => issueAgentRunBinding({ runId: "r", orgId: "o", runBy: "" })).toThrow();
  });
});

describe("rejection paths", () => {
  it("rejects missing / empty token", () => {
    expect(verifyAgentRunBinding(undefined).ok).toBe(false);
    expect(verifyAgentRunBinding(null).ok).toBe(false);
    expect(verifyAgentRunBinding("").ok).toBe(false);
  });

  it("rejects a malformed token (no separator)", () => {
    expect(verifyAgentRunBinding("notadotseparatedtoken").ok).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = issueAgentRunBinding(TRIPLE);
    const tampered = token.slice(0, -3) + "AAA";
    const res = verifyAgentRunBinding(tampered);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
  });

  it("rejects a tampered payload (sig no longer matches)", () => {
    const token = issueAgentRunBinding(TRIPLE);
    const [, sig] = token.split(".");
    const evil = Buffer.from(
      JSON.stringify({
        ...TRIPLE,
        orgId: "org-EVIL",
        purpose: AGENT_RUN_BINDING_PURPOSE,
        version: AGENT_RUN_BINDING_VERSION,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      "utf8",
    ).toString("base64url");
    const res = verifyAgentRunBinding(`${evil}.${sig}`);
    expect(res.ok).toBe(false);
  });

  it("rejects a binding signed with a different secret", () => {
    process.env.BETTER_AUTH_SECRET = "other-secret";
    const token = issueAgentRunBinding(TRIPLE);
    process.env.BETTER_AUTH_SECRET = SECRET;
    const res = verifyAgentRunBinding(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
  });

  it("rejects an expired binding", () => {
    const token = issueAgentRunBinding({ ...TRIPLE, ttlSeconds: 1 });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);
    const res = verifyAgentRunBinding(token);
    vi.useRealTimers();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });

  it("rejects a binding whose exp-iat window exceeds the policy max", () => {
    // Hand-craft a far-future exp with a valid signature for THIS secret.
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        ...TRIPLE,
        purpose: AGENT_RUN_BINDING_PURPOSE,
        version: AGENT_RUN_BINDING_VERSION,
        iat: now,
        exp: now + 99 * 60 * 60, // 99h » 1h policy max
      }),
      "utf8",
    ).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
    const res = verifyAgentRunBinding(`${payload}.${sig}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("ttl_too_long");
  });
});
