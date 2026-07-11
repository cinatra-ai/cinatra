import "server-only";

// PM WORK-STORE provider SELECTION policy (cinatra#1032 deliverable 3) — the
// resolution policy the policy-free discovery bridge
// (src/lib/register-pm-work-store-providers.ts) deliberately left to the
// consumer, per the ratified decision on the private tracker (2026-07-11):
//
//   The provider is chosen ONCE, at project instantiation, and persisted on
//   the project instance: a CONFIGURED provider wins; AUTO-selection applies
//   only when exactly one provider is connected; selection FAILS CLOSED on
//   none or several. A project can never silently migrate between PM tools.
//
// `selectPmWorkStoreProvider` is the PURE four-branch policy (deterministic,
// no I/O — unit-tested exhaustively). `resolvePersistedPmWorkStore` is the
// ONLY runtime read seam: it resolves the ALREADY-PERSISTED provider id to a
// live registered `PmWorkStore` and fails closed when that provider is
// disconnected — no runtime path may re-run auto-selection.

import {
  listPmWorkStores,
  lookupPmWorkStore,
  type PmWorkStore,
} from "@cinatra-ai/sdk-extensions";

export type PmWorkStoreSelection =
  | {
      kind: "selected";
      providerId: string;
      /** 'configured' = the explicitly configured provider won; 'auto' =
       *  exactly one connected provider existed. */
      mode: "configured" | "auto";
    }
  | {
      kind: "rejected";
      reason:
        /** A configured id was supplied but is blank/whitespace. */
        | "invalid_configured"
        /** The configured provider is not among the connected providers. */
        | "configured_not_connected"
        /** No provider is connected (fail-closed). */
        | "none_connected"
        /** More than one provider is connected and none is configured
         *  (fail-closed — never guess). */
        | "ambiguous";
      /** The (deduped) connected provider ids, for the refusal message. */
      connectedProviderIds: string[];
    };

/**
 * The pure once-at-instantiation selection policy. `configuredProviderId`
 * null/undefined = no configured provider. Connected ids are deduped before
 * the "exactly one" test (a double-registered provider is still ONE tool).
 */
export function selectPmWorkStoreProvider(input: {
  configuredProviderId?: string | null;
  connectedProviderIds: readonly string[];
}): PmWorkStoreSelection {
  const connected = [...new Set(input.connectedProviderIds)];
  const configuredRaw = input.configuredProviderId;

  if (configuredRaw !== null && configuredRaw !== undefined) {
    const configured = configuredRaw.trim();
    if (configured.length === 0) {
      return { kind: "rejected", reason: "invalid_configured", connectedProviderIds: connected };
    }
    if (!connected.includes(configured)) {
      return {
        kind: "rejected",
        reason: "configured_not_connected",
        connectedProviderIds: connected,
      };
    }
    return { kind: "selected", providerId: configured, mode: "configured" };
  }

  if (connected.length === 0) {
    return { kind: "rejected", reason: "none_connected", connectedProviderIds: connected };
  }
  if (connected.length > 1) {
    return { kind: "rejected", reason: "ambiguous", connectedProviderIds: connected };
  }
  return { kind: "selected", providerId: connected[0], mode: "auto" };
}

/** The connected provider ids as the host sees them right now (the capability
 *  registry via the SDK's lazy external resolver), deduped by provider id. */
export function connectedPmWorkStoreProviderIds(): string[] {
  return [...new Set(listPmWorkStores().map((p) => p.providerId))];
}

export type PersistedPmWorkStoreResolution =
  | { ok: true; store: PmWorkStore }
  | { ok: false; reason: "provider_disconnected"; providerId: string };

/**
 * Resolve the provider ALREADY persisted on a project instance to a live
 * `PmWorkStore`. Fail-closed when it is disconnected — the caller surfaces
 * the outage; it NEVER falls back to another provider or re-runs selection
 * (the sticky rule: a project never silently migrates between PM tools).
 */
export function resolvePersistedPmWorkStore(instance: {
  providerId: string;
}): PersistedPmWorkStoreResolution {
  const store = lookupPmWorkStore(instance.providerId);
  if (!store) {
    return { ok: false, reason: "provider_disconnected", providerId: instance.providerId };
  }
  return { ok: true, store };
}
