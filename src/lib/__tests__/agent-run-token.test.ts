/**
 * Run-token spine — pure mint / hash / verify (#1193).
 *
 * Hermetic: no database. The verifier's unique-index lookup is injected, so
 * the fail-closed logic (absent ⇒ 403, present-but-unresolvable ⇒ 403, no body
 * fallback) is proven without the store. The DB-backed resolution is proven in
 * agent-run-token.integration.test.ts against the verify stack.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  mintRunToken,
  hashRunToken,
  verifyRunToken,
  CINATRA_RUN_TOKEN_MESSAGE_KEY,
  RUN_TOKEN_BYTES,
  type RunTokenResolution,
} from "../agent-run-token";

describe("agent-run-token — mint + hash", () => {
  it("mints a base64url token whose hash is sha256-hex of the token (token !== hash)", () => {
    const { token, tokenHash } = mintRunToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(token).not.toBe(tokenHash);
    expect(tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints unique tokens (and hashes) across many calls — no reuse", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const { token, tokenHash } = mintRunToken();
      expect(seen.has(token)).toBe(false);
      expect(seen.has(tokenHash)).toBe(false);
      seen.add(token);
      seen.add(tokenHash);
    }
  });

  it("hashRunToken is deterministic and input-sensitive", () => {
    expect(hashRunToken("abc")).toBe(hashRunToken("abc"));
    expect(hashRunToken("abc")).not.toBe(hashRunToken("abd"));
  });

  it("exposes a 256-bit token size and the reserved double-underscore message key", () => {
    expect(RUN_TOKEN_BYTES).toBe(32);
    expect(CINATRA_RUN_TOKEN_MESSAGE_KEY).toBe("__cinatra_run_token__");
  });
});

describe("agent-run-token — verifyRunToken (fail-closed, injected lookup)", () => {
  const run: RunTokenResolution = { id: "r1", orgId: "org1", runBy: "u1" };

  it("resolves the run on a unique-index hit", async () => {
    const { token, tokenHash } = mintRunToken();
    const lookup = async (h: string) => (h === tokenHash ? run : null);
    await expect(verifyRunToken(token, lookup)).resolves.toEqual({ ok: true, run });
  });

  it("absent token ⇒ { ok:false, reason:'absent' } and the lookup is NEVER consulted (no body fallback)", async () => {
    let calls = 0;
    const lookup = async () => {
      calls++;
      return run;
    };
    for (const bad of [null, undefined, ""] as const) {
      await expect(verifyRunToken(bad, lookup)).resolves.toEqual({ ok: false, reason: "absent" });
    }
    expect(calls).toBe(0);
  });

  it("present-but-unresolvable ⇒ { ok:false, reason:'unresolvable' }", async () => {
    const lookup = async () => null;
    await expect(verifyRunToken(mintRunToken().token, lookup)).resolves.toEqual({
      ok: false,
      reason: "unresolvable",
    });
  });

  it("resolves by the token's HASH, never by the raw token", async () => {
    const { token, tokenHash } = mintRunToken();
    let received: string | null = null;
    const lookup = async (h: string) => {
      received = h;
      return h === tokenHash ? run : null;
    };
    await verifyRunToken(token, lookup);
    expect(received).toBe(tokenHash);
    expect(received).not.toBe(token);
  });
});
