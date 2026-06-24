import "server-only";

import { randomUUID } from "node:crypto";
import { writeDefaultLlmProviderToDatabase } from "@/lib/database";
import { logAuditEventStrict } from "@/lib/authz/audit";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Single chokepoint for mutating the GLOBAL default LLM provider (eng#229).
//
// The default LLM provider is a platform-level global setting reachable from
// (a) the admin API route and (b) the LLM-settings server actions. Every path
// MUST share the same fail-closed authority + strict-before-mutation audit, or
// hardening one path leaves the other open. This helper is that chokepoint:
//
//   1. Authority: platform_admin ONLY. `settings.update` alone is NOT enough
//      (it is also granted to org_admin), so we require the platform role on
//      the resolved actor. Callers that have not resolved an actor fail closed.
//   2. Strict audit BEFORE the write. If the audit insert throws we propagate
//      and DO NOT write — no unaudited privileged mutation.
//
// The provider value itself is still validated by the caller and re-validated
// by `writeDefaultLlmProviderToDatabase` (the authoritative {openai,gemini}
// fail-closed sink); this helper does not relax that.
// ---------------------------------------------------------------------------

export class DefaultLlmProviderAuthzError extends Error {
  constructor() {
    super("Platform administrator required to change the default LLM provider.");
    this.name = "DefaultLlmProviderAuthzError";
  }
}

export class DefaultLlmProviderAuditError extends Error {
  constructor() {
    super("Audit write failed; default LLM provider not updated.");
    this.name = "DefaultLlmProviderAuditError";
  }
}

/**
 * Authorize (platform-admin), strict-audit, then write the global default LLM
 * provider. Throws `DefaultLlmProviderAuthzError` for a non-platform actor and
 * `DefaultLlmProviderAuditError` if the pre-write audit insert fails (the write
 * is NOT performed in either case).
 */
export async function updateDefaultLlmProvider(args: {
  actor: ActorContext | undefined;
  provider: "openai" | "gemini";
  requestId?: string;
}): Promise<void> {
  const { actor, provider, requestId } = args;

  if (!actor || actor.platformRole !== "platform_admin") {
    throw new DefaultLlmProviderAuthzError();
  }

  try {
    await logAuditEventStrict({
      actorPrincipalId: actor.principalId,
      actorPrincipalType: "human",
      authSource: "route",
      organizationId: actor.organizationId,
      resourceType: "administration",
      resourceId: "llm_default_provider",
      operation: "settings.default_llm_provider.update",
      decision: "allowed",
      policyVersion: actor.policyVersion,
      requestId: requestId ?? randomUUID(),
      metadata: { provider },
    });
  } catch {
    throw new DefaultLlmProviderAuditError();
  }

  writeDefaultLlmProviderToDatabase(provider);
}
