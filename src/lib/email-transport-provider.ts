import "server-only";

// Host-side resolution of the `email-system` capability (the lazy/guarded
// host-access cutover): the email-connector registers its provider-neutral
// send facade (routing chain + dev-mode recipient override live
// connector-side) as a capability provider from `register(ctx)`; the host's
// trigger email-send path resolves it HERE at call time — never by
// dynamic-importing the package.
//
// DISTINCT from `src/lib/email-system.ts` (the host's per-user active-
// connector router): this surface preserves the exact semantics of the
// connector facade the trigger path previously imported.
//
// Degraded mode: provider absent → null; the trigger send fails with a
// descriptive error (same failure class as "No connected email connector").

import {
  EMAIL_SYSTEM_CAPABILITY,
  type EmailSystemProvider,
} from "@cinatra-ai/sdk-extensions";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability impl is `unknown` by contract.
function isEmailSystemProvider(impl: unknown): impl is EmailSystemProvider {
  if (typeof impl !== "object" || impl === null) return false;
  return typeof (impl as { sendEmail?: unknown }).sendEmail === "function";
}

/** The live email send facade, or null when the email-connector is absent. */
export function resolveEmailSystemFacade(): EmailSystemProvider | null {
  const match = resolveCapabilityProviders(EMAIL_SYSTEM_CAPABILITY).find((p) =>
    isEmailSystemProvider(p.impl),
  );
  return (match?.impl as EmailSystemProvider | undefined) ?? null;
}

/** Fail-loud resolution for sends that cannot proceed without the facade. */
export function requireEmailSystemFacade(): EmailSystemProvider {
  const provider = resolveEmailSystemFacade();
  if (!provider) {
    throw new Error(
      "Email system unavailable — the email connector extension is not installed/active. " +
        "Install/activate it to send trigger emails.",
    );
  }
  return provider;
}
