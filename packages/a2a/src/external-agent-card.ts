import "server-only";

import { DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import type { AgentCard } from "@a2a-js/sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// fetchExternalAgentCard
//
// Wraps @a2a-js/sdk/client's DefaultAgentCardResolver so external A2A agent
// card discovery:
//   1. Has a bounded timeout (default 3s; caller-overridable).
//   2. Returns a typed Result envelope — NEVER throws. Callers pattern-match
//      on result.ok and (for failures) on result.reason.
//   3. Validates the fetched card JSON against a minimal Zod schema before
//      accepting it so malformed cards never reach the DB upsert path.
//
// Call sites:
//   - sendAgentBuilderMessage external branch (dispatch-time re-upsert)
//   - An explicit admin "sync connector" flow
// MUST NOT be called from route resolvers, RSC renders, or any read path.
// ---------------------------------------------------------------------------

// Minimal Zod schema that covers the fields Cinatra reads. `passthrough` keeps
// unknown fields on the returned object so downstream consumers (agent-card.ts)
// can still surface capability flags without the schema re-shaping them.
const AgentSkillSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

const AgentCardSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    version: z.string(),
    skills: z.array(AgentSkillSchema).optional(),
    capabilities: z
      .object({ streaming: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FetchExternalAgentCardInput = {
  agentUrl: string;
  /**
   * Optional — echoed back on the happy-path result for downstream upsert
   * correlation. Not used by this function for any network decision.
   */
  connectorSlug?: string;
  fetchImpl?: typeof fetch;
  /** Default: 3000ms. Applied via AbortSignal.timeout() on every fetch call. */
  timeoutMs?: number;
};

export type FetchExternalAgentCardReason =
  | "timeout"
  | "unauthorized"
  | "invalid_response"
  | "unreachable"
  | "invalid_card_schema";

export type FetchExternalAgentCardResult =
  | { ok: true; card: AgentCard; connectorSlug?: string }
  | { ok: false; reason: FetchExternalAgentCardReason; detail?: string };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Internal error-shape tags used to communicate classification between the
// classifying-fetch layer and the outer try/catch. Using Error.name instead of
// custom classes keeps the surface area small and serialisable.
const ERR_FETCH_TIMEOUT = "FETCH_TIMEOUT";
const ERR_FETCH_UNAUTHORIZED = "FETCH_UNAUTHORIZED";
const ERR_FETCH_UNREACHABLE = "FETCH_UNREACHABLE";
const ERR_FETCH_INVALID = "FETCH_INVALID";

export async function fetchExternalAgentCard(
  input: FetchExternalAgentCardInput,
): Promise<FetchExternalAgentCardResult> {
  const timeoutMs = input.timeoutMs ?? 3000;
  const baseFetch = input.fetchImpl ?? globalThis.fetch;

  // classifyingFetch: wraps the caller-supplied fetch with an abort-timeout
  // and tags error origins so the outer try/catch can produce a typed reason.
  const classifyingFetch: typeof fetch = async (url, init) => {
    let response: Response;
    try {
      response = await baseFetch(url, {
        ...(init ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError")
      ) {
        const tagged = new Error("timeout");
        tagged.name = ERR_FETCH_TIMEOUT;
        throw tagged;
      }
      const tagged = new Error(
        err instanceof Error ? err.message : String(err),
      );
      tagged.name = ERR_FETCH_UNREACHABLE;
      throw tagged;
    }
    if (response.status === 401 || response.status === 403) {
      const tagged = new Error(`http ${response.status}`);
      tagged.name = ERR_FETCH_UNAUTHORIZED;
      throw tagged;
    }
    if (!response.ok) {
      const tagged = new Error(`http ${response.status}`);
      tagged.name = ERR_FETCH_INVALID;
      throw tagged;
    }
    return response;
  };

  const resolver = new DefaultAgentCardResolver({
    fetchImpl: classifyingFetch,
  });

  try {
    // The SDK's public `resolve(baseUrl, path?)` returns AgentCard. Some tests
    // mock a `getAgentCard` method on a class they substitute for
    // DefaultAgentCardResolver, so accept either at runtime to stay compatible
    // with both surfaces.
    type ResolverLike = {
      resolve?: (url: string) => Promise<unknown>;
      getAgentCard?: (url: string) => Promise<unknown>;
    };
    const r = resolver as unknown as ResolverLike;
    const fetchCard = r.resolve?.bind(r) ?? r.getAgentCard?.bind(r);
    if (!fetchCard) {
      return {
        ok: false,
        reason: "unreachable",
        detail: "DefaultAgentCardResolver exposes no resolve/getAgentCard method",
      };
    }
    const raw = await fetchCard(input.agentUrl);
    const parsed = AgentCardSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "invalid_card_schema",
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      };
    }
    return {
      ok: true,
      card: parsed.data as unknown as AgentCard,
      connectorSlug: input.connectorSlug,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === ERR_FETCH_TIMEOUT) {
      return { ok: false, reason: "timeout" };
    }
    if (name === ERR_FETCH_UNAUTHORIZED) {
      return { ok: false, reason: "unauthorized" };
    }
    if (name === ERR_FETCH_UNREACHABLE) {
      return {
        ok: false,
        reason: "unreachable",
        detail: err instanceof Error ? err.message : undefined,
      };
    }
    if (name === ERR_FETCH_INVALID) {
      return { ok: false, reason: "invalid_response" };
    }
    // Resolver-layer error (e.g. JSON parse thrown by DefaultAgentCardResolver)
    // or a non-Error thrown value. Classify by message heuristics; otherwise
    // treat as unreachable (last resort so we never throw).
    const msg =
      err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (msg.includes("json") || msg.includes("parse") || msg.includes("syntax")) {
      return {
        ok: false,
        reason: "invalid_response",
        detail: err instanceof Error ? err.message : undefined,
      };
    }
    return {
      ok: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : undefined,
    };
  }
}
