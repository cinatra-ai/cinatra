import "server-only";

// Host-side resolution of `email-send` capability providers.
//
// Concrete email providers (gmail, resend, future smtp/ses) register an
// `EmailConnector` impl behind the `email-send` capability from their own
// `serverEntry` (`register(ctx)` → `ctx.capabilities.registerProvider(…)`).
// Host surfaces that need to dispatch on email providers (the /connectors/email
// hub, platform mail, the per-user active-connector resolution, HITL schema
// enrichment) resolve them HERE — never by importing a provider package.

import type { EmailConnector, HostEmailRoutingService } from "@cinatra-ai/sdk-extensions";
// Import the capability id from the SDK rather than RE-DECLARING the literal
// (cinatra-engineering#155, eng#168(c) "fix the dangerous"): the SDK is the single
// authority for the `email-send` capability id; a host-side re-declaration would
// silently drift if the SDK constant ever changed. (llm-toolbox-providers.ts is
// the precedent — it imports LLM_TOOLBOX_CAPABILITY.)
import { EMAIL_SEND_CAPABILITY } from "@cinatra-ai/sdk-extensions";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability impl is `unknown` by contract. Validate the
// EmailConnector shape before any host surface trusts it, so a mis-registered
// provider can never reach a send call.
export function isEmailConnector(impl: unknown): impl is EmailConnector {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as {
    definition?: { connectorId?: unknown; name?: unknown };
    send?: unknown;
    findReply?: unknown;
    getStatus?: unknown;
  };
  return (
    typeof candidate.definition?.connectorId === "string" &&
    typeof candidate.definition?.name === "string" &&
    typeof candidate.send === "function" &&
    // findReply is REQUIRED by the contract and called unconditionally by the
    // per-user reply lookup — a provider without it must never pass the guard.
    typeof candidate.findReply === "function" &&
    typeof candidate.getStatus === "function"
  );
}

/** The live `email-send` providers (registration is activation-gated;
 * teardown invalidates — the registered set IS the live set). */
export function resolveEmailSendProviders(): EmailConnector[] {
  return resolveCapabilityProviders(EMAIL_SEND_CAPABILITY)
    .map((p) => p.impl)
    .filter(isEmailConnector);
}

/** Resolve one provider by connectorId, or null. */
export function findEmailSendProvider(connectorId: string): EmailConnector | null {
  return (
    resolveEmailSendProviders().find((p) => p.definition.connectorId === connectorId) ?? null
  );
}

/**
 * The host email-routing service impl (dev-mode override + sent-email writer +
 * sender-identity resolution) this host registers at boot — resolved back here
 * so host surfaces share the exact impls the email facade uses. Null only if
 * the boot registration did not run (test environments).
 */
export function resolveHostEmailRouting(): HostEmailRoutingService | null {
  const impl = resolveCapabilityProviders(
    "@cinatra-ai/host:email-routing",
  )[0]?.impl as HostEmailRoutingService | undefined;
  return impl ?? null;
}
