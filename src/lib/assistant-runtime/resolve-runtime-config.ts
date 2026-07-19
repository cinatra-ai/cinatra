import "server-only";

// Handle-generic assistant runtime-config resolution (cinatra#1823, epic #1037
// P4.1). Resolves the AssistantRuntimeConfig for a registered assistant PRINCIPAL
// from its PERSISTED `assistant_config` sidecar via the `assistant_user_id` link
// (readAssistantConfigByPrincipalId) — the same resolution ladder the generalized
// assistant-MCP surface uses (resolveRuntimeConfigForTarget in assistant-mcp.ts),
// lifted to a shared module so the AG-UI `/api/assistants/chat` HTTP endpoint can
// serve ANY registered assistant (WordPress / Drupal / @cinatra) by its own
// config rather than the hardcoded Cinatra binding.
//
// The ladder:
//   1. a valid linked sidecar  -> build the runtime from it (the forward path);
//   2. a CORRUPT linked sidecar -> fail CLOSED (never mask corruption by falling
//      back to the reference config);
//   3. NO linked template       -> the built-in @cinatra handle keeps the
//      in-code reference config (transitional); any other principal fails closed.

import { readAssistantConfigByPrincipalId } from "@cinatra-ai/agents";
import { safeParseAssistantConfig } from "@/lib/assistant-config";
import {
  BUILT_IN_CINATRA_ASSISTANT_USERNAME,
  isBuiltInCinatraAssistantUserId,
} from "@/lib/assistant-users";
import { buildAssistantRuntimeConfig, type AssistantRuntimeConfig } from "./ports";
import { buildCinatraAssistantRuntimeConfig } from "./cinatra-assistant-config";

export type ResolveRuntimeConfigResult =
  | { ok: true; runtimeConfig: AssistantRuntimeConfig }
  | { ok: false; code: "ASSISTANT_CONFIG_UNAVAILABLE" };

/**
 * Resolve the runtime config for an assistant principal. `handle` is the
 * normalized mention handle (used only to gate the built-in @cinatra reference
 * fallback). Structured result — never throws for an unresolvable/corrupt config
 * (the caller fail-closes, e.g. 404-hides).
 */
export async function resolveAssistantRuntimeConfigByPrincipal(params: {
  assistantUserId: string;
  handle: string;
}): Promise<ResolveRuntimeConfigResult> {
  const { assistantUserId, handle } = params;

  let raw: string | null;
  try {
    raw = await readAssistantConfigByPrincipalId(assistantUserId);
  } catch {
    return { ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" };
  }

  if (raw != null) {
    const parsed = safeParseAssistantConfig(raw);
    if (parsed.ok) {
      // Forward path: build from the persisted sidecar (schema defaults applied).
      // buildAssistantRuntimeConfig throws on a schema-VALID-but-degenerate sidecar
      // (e.g. an empty skillBundle — the P1 schema permits `[]`, but the runtime
      // requires skillBundle[0] as the always-loaded system skill), so a build
      // failure fails CLOSED here rather than escaping as an unstructured 500 — this
      // resolver's contract is "never throws; structured result" (the caller 404-hides).
      try {
        return { ok: true, runtimeConfig: buildAssistantRuntimeConfig(parsed.config) };
      } catch {
        return { ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" };
      }
    }
    // A corrupt linked sidecar fails CLOSED — never fall back to the reference
    // config (that would mask corruption).
    return { ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" };
  }

  // No linked template. The built-in @cinatra principal keeps the in-code
  // reference config (transitional until its registration link is resolvable);
  // any other principal fails closed. The fallback is gated on the RESOLVED
  // principal's persisted identity (isBuiltInCinatraAssistantUserId — an assistant
  // principal whose username is the reserved Cinatra name), NOT the caller-supplied
  // `handle` string: a non-built-in principal that owned the "cinatra" handle must
  // never receive the reference config (fail-closed). The cheap handle check is a
  // pre-filter that avoids the DB round-trip for the common non-Cinatra path.
  // The cheap handle check short-circuits FIRST (no DB round-trip on the common
  // non-Cinatra path); only a "cinatra" handle triggers the persisted-identity
  // read. That read is a SECOND DB round-trip, so it is wrapped: a transient
  // failure fails CLOSED (structured) rather than throwing out as a 500 — same
  // "never throws" contract as the sidecar read above, and it never yields the
  // reference config on an unverified principal.
  let isBuiltInCinatra = false;
  try {
    isBuiltInCinatra =
      handle.trim().toLowerCase() === BUILT_IN_CINATRA_ASSISTANT_USERNAME &&
      (await isBuiltInCinatraAssistantUserId(assistantUserId));
  } catch {
    return { ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" };
  }
  if (isBuiltInCinatra) {
    return { ok: true, runtimeConfig: buildCinatraAssistantRuntimeConfig() };
  }
  return { ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" };
}
