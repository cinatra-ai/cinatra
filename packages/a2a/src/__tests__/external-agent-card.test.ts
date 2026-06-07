/**
 * Tests for fetchExternalAgentCard.
 *
 * Contract: returns a discriminated-union Result envelope; never throws.
 *   Success -> { ok: true, card: AgentCard, connectorSlug?: string }
 *   Failure -> { ok: false, reason: "timeout" | "unauthorized" | "invalid_response"
 *                                | "unreachable" | "invalid_card_schema", detail?: string }
 *
 * Mocks @a2a-js/sdk/client's DefaultAgentCardResolver so we control whether
 * card resolution succeeds, throws parse errors, or escapes fetch-layer errors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  return {
    // The mocked DefaultAgentCardResolver captures the fetchImpl passed to it so
    // the test body can drive it through the production classifyingFetch layer.
    lastFetchImpl: null as (typeof fetch) | null,
    // Per-test override for what resolver.getAgentCard returns or throws.
    getAgentCardImpl: (async (_url: string) => {
      throw new Error("not configured");
    }) as (url: string) => Promise<unknown>,
  };
});

vi.mock("@a2a-js/sdk/client", () => {
  class MockResolver {
    private fetchImpl: typeof fetch;
    constructor(opts: { fetchImpl: typeof fetch }) {
      this.fetchImpl = opts.fetchImpl;
      hoisted.lastFetchImpl = opts.fetchImpl;
    }
    async getAgentCard(url: string) {
      // Drive the classifyingFetch layer so network/HTTP errors propagate the
      // way production would see them.
      await this.fetchImpl(url, {});
      return hoisted.getAgentCardImpl(url);
    }
  }
  return { DefaultAgentCardResolver: MockResolver };
});

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------

import { fetchExternalAgentCard } from "../external-agent-card";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

const validCard = {
  name: "External Agent",
  description: "A remote A2A skill",
  version: "1.0.0",
  skills: [{ id: "skill-x", name: "Skill X" }],
  capabilities: { streaming: true },
};

describe("fetchExternalAgentCard", () => {
  beforeEach(() => {
    hoisted.getAgentCardImpl = async () => {
      throw new Error("not configured");
    };
    hoisted.lastFetchImpl = null;
  });

  it("returns { ok: true, card, connectorSlug } for a successful fetch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validCard));
    hoisted.getAgentCardImpl = async () => validCard;
    const result = await fetchExternalAgentCard({
      agentUrl: "https://example.test",
      connectorSlug: "ex-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.name).toBe("External Agent");
      expect(result.card.version).toBe("1.0.0");
      expect(result.connectorSlug).toBe("ex-1");
    }
  });

  it("returns { ok: false, reason: 'timeout' } when the fetch aborts", async () => {
    const hangingFetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const result = await fetchExternalAgentCard({
      agentUrl: "https://slow.test",
      fetchImpl: hangingFetch as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  it("returns { ok: false, reason: 'unauthorized' } for 401 status", async () => {
    const fetchImpl = vi.fn(async () => textResponse("nope", 401));
    const result = await fetchExternalAgentCard({
      agentUrl: "https://auth.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("returns { ok: false, reason: 'unauthorized' } for 403 status", async () => {
    const fetchImpl = vi.fn(async () => textResponse("nope", 403));
    const result = await fetchExternalAgentCard({
      agentUrl: "https://auth.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("returns { ok: false, reason: 'invalid_response' } when resolver throws a JSON parse error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    hoisted.getAgentCardImpl = async () => {
      throw new Error("Unexpected token in JSON at position 0");
    };
    const result = await fetchExternalAgentCard({
      agentUrl: "https://bad-json.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_response");
  });

  it("returns { ok: false, reason: 'unreachable' } for network-level errors", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("ECONNREFUSED");
      throw err;
    });
    const result = await fetchExternalAgentCard({
      agentUrl: "https://offline.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
  });

  it("returns { ok: false, reason: 'invalid_card_schema' } when card is missing required fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    // Card missing `name` and `version` - Zod schema should reject.
    hoisted.getAgentCardImpl = async () => ({ description: "incomplete" });
    const result = await fetchExternalAgentCard({
      agentUrl: "https://bad-schema.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_card_schema");
  });

  it("never throws - always returns a Result envelope", async () => {
    const wildFetch = vi.fn(async () => {
      throw { not: "an error instance" };
    });
    const p = fetchExternalAgentCard({
      agentUrl: "https://weird.test",
      fetchImpl: wildFetch as unknown as typeof fetch,
    });
    await expect(p).resolves.toBeDefined();
    const r = await p;
    expect(r.ok).toBe(false);
  });
});
