import "server-only";

/**
 * The REAL {@link SetupReadinessPorts} implementation (cinatra#2093, epic #2086
 * S6) — the wiring that binds the saga to the genuine machinery:
 *
 *   bulk consent      → S5's `grantSetupWithAnthropicBulkConsent` (the consent
 *                       ledger + the derived `allowAnthropicUpload` projection
 *                       + the reconcile-outbox row, all in one transaction)
 *   strict sync       → S5's `syncCatalogSkillsToAnthropicStrict` (THROWS
 *                       rather than letting an all-skipped run pass)
 *   probe             → the connector's ABI v2 `probeNativeSkills` surface
 *                       member, resolved through the live capability registry
 *   commit            → the same audited chokepoint every other writer uses
 *
 * NOTHING here re-implements a contract surface. The saga's ports exist so its
 * ordering/failure/compensation logic can be exercised without a live key —
 * they are NOT a place to fake the contracts themselves.
 */

import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";
import type { LlmNativeSkillsProbeResult } from "@cinatra-ai/sdk-extensions";

import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { grantSetupWithAnthropicBulkConsent } from "@/lib/anthropic-skill-config-service";
import {
  readDefaultLlmProviderFromDatabase,
  writeDefaultLlmProviderToDatabase,
  writeAnthropicSkillSyncEnabledToDatabase,
} from "@/lib/database";
import {
  computeReadinessFingerprint,
  writeSetupReadinessReceipt,
  clearSetupReadinessReceipt,
  type SetupReadinessPorts,
} from "@/lib/setup-readiness-saga";

/**
 * Build the production ports.
 *
 * `setDefaultProvider` is injected rather than hardcoded so the CALLER (the
 * setup server action) supplies the AUDITED platform-admin mutation it is
 * already required to go through — the saga must not become a second, unaudited
 * write path for `llm_default_provider`. The default falls back to the same
 * chokepoint every writer uses.
 */
export function createSetupReadinessPorts(options?: {
  setDefaultProvider?: (provider: LlmProvider) => Promise<void> | void;
}): SetupReadinessPorts {
  const setDefaultProvider =
    options?.setDefaultProvider ??
    (async (p: LlmProvider) => {
      writeDefaultLlmProviderToDatabase(p);
    });

  return {
    async validateCredential(provider) {
      const surface = getLlmProviderSurface(provider);
      if (!surface) {
        return {
          ok: false,
          message: `The ${provider} connector is not installed or active on this instance.`,
        };
      }
      // "Key saved + PLAIN-REQUEST validation": a LIVE, minimal call through the
      // connector's own catalog reader. A stored-shape check cannot tell a
      // valid key from a revoked one, which is the whole reason this step
      // exists.
      //
      // FAIL CLOSED WHEN NOTHING CAN BE VALIDATED. If a surface exposes neither
      // a key reader nor a live catalog read, we have performed no validation
      // at all — reporting `ok` would be the cached-boolean dishonesty this
      // saga replaces, dressed up as a step. Say so instead.
      if (!surface.getConfiguredAPIKey && !surface.listAvailableModels) {
        return {
          ok: false,
          message: `The installed ${provider} connector exposes no way to validate its credentials, so setup cannot confirm the connection works. Update the ${provider} connector.`,
        };
      }
      try {
        if (surface.getConfiguredAPIKey) {
          const key = await surface.getConfiguredAPIKey();
          if (!key) return { ok: false, message: `No ${provider} API key is saved yet.` };
        }
        if (surface.listAvailableModels) {
          const models = await surface.listAvailableModels({});
          if (!models || models.length === 0) {
            return {
              ok: false,
              message: `The ${provider} credentials were accepted but no models are available to this key.`,
            };
          }
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          message: `The ${provider} credentials were rejected: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    async isSurfaceReady(provider) {
      const surface = getLlmProviderSurface(provider);
      if (!surface) return false;
      if (!surface.isConnectionReady) return true; // nothing to assert against
      const connection = await surface.getConfiguredConnection?.();
      return surface.isConnectionReady(connection ?? undefined) === true;
    },

    grantBulkConsent(grantedBy) {
      // The ledger grant ALONE is not enough (codex round-1 finding #4). The
      // strict catalog sync is INERT — it returns cleanly having done nothing —
      // while the workspace opt-in (`anthropic_skill_sync_enabled`) is OFF, so
      // a saga that only granted consent would upload nothing and still
      // "succeed". Turning the workspace opt-in ON is precisely what
      // "setup with Anthropic" MEANS, and it is the same act the admin Skills
      // tab performs; the operator's explicit provider choice IS that act.
      //
      // Order matters: enable the outer gate FIRST, then grant, so a crash
      // between them leaves the gate on with no consent (upload-ineligible,
      // fail-closed) rather than consent with no gate (which would look
      // consented but never upload).
      writeAnthropicSkillSyncEnabledToDatabase(true);
      grantSetupWithAnthropicBulkConsent(grantedBy);
    },

    async runStrictInitialSync() {
      const { syncCatalogSkillsToAnthropicStrict } = await import(
        "@/lib/anthropic-skill-sync-service"
      );
      const result = await syncCatalogSkillsToAnthropicStrict();
      // The strict entry THROWS on a real failure; a returned `ok:false` here
      // means an app-layer condition it reports rather than raises. Treat it as
      // a failure too — committing on a sync that reported not-ok is exactly
      // the "masquerading success" S5's strict mode exists to stop.
      if (result.ok === false) {
        throw new Error(
          result.namespaceError ??
            result.diskReadError ??
            (result.noApiKey
              ? "no Anthropic API key is configured"
              : "the strict catalog sync reported failure"),
        );
      }
      // `noApiKey` is an INERT no-op the strict entry reports without raising
      // (codex round-1 finding #4). For the durable reconcile worker that is a
      // correct skip; for SETUP it is a hard failure — there is no point
      // committing a provider whose skills were never uploaded.
      if (result.noApiKey) {
        throw new Error(
          "the Anthropic catalog sync did not run because no API key is configured",
        );
      }
      // The skills that ACTUALLY hold a remote revision after this run — the
      // only references the probe may legitimately use. THROWS on any lookup
      // failure rather than degrading to `[]`.
      const uploadedSkillIds = await readSyncedAnthropicSkillTargets();
      return { uploadedSkillIds };
    },

    async probeNativeSkills(input): Promise<LlmNativeSkillsProbeResult> {
      const surface = getLlmProviderSurface("anthropic");
      if (!surface?.probeNativeSkills) {
        // FAIL CLOSED. A connector that cannot be probed cannot be proven to
        // deliver skills, and "we could not check" must never read as ready.
        throw new Error(
          "The installed Anthropic connector does not implement the native-skills probe (cinatra.llmProvider ABI v2). Update the Anthropic connector to a version that declares ABI v2.",
        );
      }
      return surface.probeNativeSkills({
        skillId: input.skillId,
        version: input.version,
        timeoutMs: 30_000,
      });
    },

    async createDisposableProbeSkill() {
      const { createDisposableAnthropicProbeSkill } = await import(
        "@/lib/anthropic-skill-probe-service"
      );
      return createDisposableAnthropicProbeSkill();
    },

    async commitDefaultProvider(provider) {
      // AWAITED by the saga before its post-commit verification (codex round-1
      // finding #1): the production implementation is the audited mutation,
      // which completes a strict audit insert BEFORE writing.
      await setDefaultProvider(provider);
    },

    async restoreDefaultProvider(provider) {
      // The chokepoint refuses anything non-default-capable, so a prior value
      // that is no longer eligible simply does not restore — which is the
      // correct fail-closed outcome, not a silent downgrade.
      writeDefaultLlmProviderToDatabase(provider);
    },

    readStoredDefaultProvider() {
      return readDefaultLlmProviderFromDatabase();
    },

    computeFingerprint(provider) {
      return computeReadinessFingerprint(provider);
    },

    writeReceipt(receipt) {
      writeSetupReadinessReceipt(receipt);
    },

    clearReceipt() {
      clearSetupReadinessReceipt();
    },

    now() {
      return new Date();
    },
  };
}

/**
 * The Anthropic-side {skillId, version} references that hold a NON-STALE remote
 * revision in this (api-key, environment) namespace — i.e. the skills that were
 * actually uploaded and are actually referenceable in a `container.skills`
 * request.
 *
 * THROWS on any failure (codex round-1 finding #5). An earlier version caught
 * everything and returned `[]`, which made "the namespace could not be derived"
 * and "the DAO query failed" indistinguishable from an AUTHORITATIVE empty set
 * — and an authoritative empty set is exactly what routes the saga to the
 * disposable-probe fallback. Setup would then complete on a throwaway skill
 * having never confirmed that the real catalog reconciled. `[]` is returned
 * ONLY after a successful query genuinely finds no rows.
 *
 * The stale filter matters for the same reason: a stale row names a revision
 * that may already have been reclaimed remotely, so probing it would exercise
 * the API's 404 path rather than the `container.skills` acceptance path.
 */
async function readSyncedAnthropicSkillTargets(): Promise<
  Array<{ skillId: string; version: string }>
> {
  const { deriveApiKeyFingerprint, deriveEnvironmentNamespace } = await import(
    "@/lib/anthropic-skill-sync-service"
  );
  const fingerprint = deriveApiKeyFingerprint();
  if (!fingerprint) {
    throw new Error(
      "cannot identify the Anthropic API-key namespace, so the uploaded skill set is unknown",
    );
  }
  const environment = deriveEnvironmentNamespace();
  const { listAllSyncRows } = await import("@/lib/anthropic-skill-sync-dao");
  const rows = await listAllSyncRows(fingerprint, environment);
  return rows
    .filter((r) => !r.stale)
    .map((r) => ({ skillId: r.anthropicSkillId, version: r.anthropicVersion }));
}
