import "server-only";

/**
 * Non-action readers + config keys for the setup AI step (cinatra#2093, epic
 * #2086 S6). Split out of `actions.ts` because a `"use server"` module may only
 * export async server actions — a sync reader exported from one is a build
 * error, not a style preference.
 */

import {
  readConnectorConfigFromDatabase,
} from "@/lib/database";
import { buildKnownWizardEligibleProviders } from "@cinatra-ai/sdk-extensions/llm-provider-contract";
import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";

/**
 * The owner's IN-PROGRESS pick. Deliberately distinct from
 * `llm_default_provider` (the COMMITTED choice): the pick only decides which
 * connection form to render next. Committing before the readiness saga has
 * proven anything is exactly the half-applied state S6 removes.
 */
export const SETUP_PROVIDER_SELECTION_CONFIG_KEY = "setup_provider_selection";

/**
 * The last readiness failure, kept so the step can render the ACTIONABLE error
 * (and its fix-forward prompt) after the action's redirect. The wizard's flash
 * protocol carries stable CODES only — never server-supplied text — so the
 * detail cannot ride the query string and lives here instead.
 */
export const SETUP_READINESS_FAILURE_CONFIG_KEY = "setup_readiness_last_failure";

/**
 * The failure record's `step` for a failure that happened BEFORE the saga —
 * saving the provider credential from this step's own form. Deliberately NOT a
 * member of `SETUP_READINESS_STEPS`: the saga never ran, so labelling it with
 * one of the saga's step ids would misreport where the run stopped. The step
 * renders this class at the credential FORM (where the operator acted) rather
 * than in the readiness alert.
 */
export const SETUP_CREDENTIAL_SAVE_STEP_ID = "credential-save";

export type SetupReadinessFailureRecord = {
  step: string;
  message: string;
  fixForward: string | null;
  at: string;
};

/**
 * The stored pick, filtered through the CURRENT wizard-eligible set: a pick
 * that is no longer eligible (the connector was removed, or its declaration
 * changed) reads as "no pick" rather than rendering a form for a provider the
 * wizard may not offer.
 */
export function readSetupProviderSelection(): LlmProvider | null {
  const stored = readConnectorConfigFromDatabase<string | null>(
    SETUP_PROVIDER_SELECTION_CONFIG_KEY,
    null,
  );
  const eligible = buildKnownWizardEligibleProviders() as readonly string[];
  return stored && eligible.includes(stored) ? (stored as LlmProvider) : null;
}

export function readSetupReadinessFailure(): SetupReadinessFailureRecord | null {
  const raw = readConnectorConfigFromDatabase<SetupReadinessFailureRecord | null>(
    SETUP_READINESS_FAILURE_CONFIG_KEY,
    null,
  );
  return raw && typeof raw === "object" && typeof raw.message === "string" ? raw : null;
}
