import "server-only";

// Host-side resolution of `email-sender-identities` capability providers
// (cinatra#151 Stage 4): a connector holding per-user verified sender
// identities (gmail's synced send-as aliases today) registers a structured
// provider from its own `register(ctx)`; the HITL field-renderer-context
// loader (packages/agents server action) resolves them HERE at call time —
// never by value-importing a connector package.
//
// Consumer-side hardening (the chat-user-context consumer pattern):
//   - deterministic order: providers sorted by packageName;
//   - structural validation: non-conforming impls are skipped with a warning;
//   - failure isolation: a throwing/rejecting provider is skipped with a
//     warning — it must never fail the loader (degraded -> fewer/empty apps).

import type {
  EmailSenderIdentitiesProvider,
  EmailSenderIdentity,
} from "@cinatra-ai/sdk-extensions";
import { EMAIL_SENDER_IDENTITIES_CAPABILITY_ID } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

function isEmailSenderIdentitiesProvider(impl: unknown): impl is EmailSenderIdentitiesProvider {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as { app?: unknown; getSenderIdentities?: unknown };
  return (
    typeof candidate.app === "string" &&
    candidate.app.length > 0 &&
    typeof candidate.getSenderIdentities === "function"
  );
}

function isIdentity(value: unknown): value is EmailSenderIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { email?: unknown; displayName?: unknown };
  return (
    typeof candidate.email === "string" &&
    candidate.email.length > 0 &&
    (candidate.displayName === undefined || typeof candidate.displayName === "string")
  );
}

export type AppSenderIdentities = {
  /** Provider-agnostic app slug (e.g. "gmail"). */
  app: string;
  identities: EmailSenderIdentity[];
};

/**
 * Resolve the live sender-identity providers and collect each app's verified
 * identities for `userId`. Fail-soft per provider; deterministic order;
 * malformed identity rows are dropped (with a warning). Apps with ZERO
 * identities are omitted (the consumer derives "connected apps" from
 * non-empty contributions).
 */
export async function listEmailSenderIdentities(userId?: string): Promise<AppSenderIdentities[]> {
  const providers = [...resolveCapabilityProviders(EMAIL_SENDER_IDENTITIES_CAPABILITY_ID)].sort(
    (a, b) => a.packageName.localeCompare(b.packageName),
  );
  const out: AppSenderIdentities[] = [];
  for (const provider of providers) {
    if (!isEmailSenderIdentitiesProvider(provider.impl)) {
      console.warn(
        `[email-sender-identities] provider ${provider.packageName} has a non-conforming impl — skipped`,
      );
      continue;
    }
    try {
      const result = await provider.impl.getSenderIdentities({ userId });
      if (!Array.isArray(result)) {
        console.warn(
          `[email-sender-identities] provider ${provider.packageName} returned a non-array — skipped`,
        );
        continue;
      }
      const identities = result.filter((row) => {
        if (isIdentity(row)) return true;
        console.warn(
          `[email-sender-identities] provider ${provider.packageName} returned a malformed identity — dropped`,
        );
        return false;
      });
      if (identities.length > 0) {
        out.push({ app: provider.impl.app, identities });
      }
    } catch (err) {
      console.warn(
        `[email-sender-identities] provider ${provider.packageName} threw — skipped:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}
