"use server";

/**
 * Setup AI-step server actions (cinatra#2093, epic #2086 S6).
 *
 * Two acts, deliberately separate:
 *
 *   selectSetupProviderAction — records the owner's PICK. It does NOT commit
 *                               `llm_default_provider`: the pick only decides
 *                               which connection form to show next, and
 *                               committing before the readiness saga has proven
 *                               anything is precisely the half-applied state S6
 *                               removes.
 *   completeAiSetupAction     — runs the READINESS SAGA. The saga is the ONLY
 *                               thing that commits the stored default, and it
 *                               does so through the AUDITED platform-admin
 *                               mutation this action injects — setup must not
 *                               become a second, unaudited write path.
 */

import { redirect } from "next/navigation";
import { z } from "zod";

import { getActorContext, requireAdminSession } from "@/lib/auth-session";
import { updateDefaultLlmProvider } from "@/lib/admin/default-llm-provider-mutation";
import { buildKnownWizardEligibleProviders } from "@cinatra-ai/sdk-extensions/llm-provider-contract";
import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";
import { writeConnectorConfigToDatabase } from "@/lib/database";
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { runSetupReadinessSaga, sanitizeReadinessMessage } from "@/lib/setup-readiness-saga";
import { createSetupReadinessPorts } from "@/lib/setup-readiness-ports";
import {
  SETUP_PROVIDER_SELECTION_CONFIG_KEY,
  SETUP_READINESS_FAILURE_CONFIG_KEY,
} from "@/app/setup/ai/readiness-state";

function providerSchema() {
  // Built per call rather than at module scope so the eligible set is read from
  // the live declaration projection at request time.
  return z.enum(buildKnownWizardEligibleProviders() as [string, ...string[]]);
}

export async function selectSetupProviderAction(formData: FormData) {
  await requireAdminSession();
  const parsed = providerSchema().safeParse(formData.get("provider"));
  if (!parsed.success) {
    redirect("/setup/ai?stay=1&error=setup-provider-invalid");
  }
  writeConnectorConfigToDatabase(SETUP_PROVIDER_SELECTION_CONFIG_KEY, parsed.data);
  redirect("/setup/ai?stay=1");
}

/**
 * Persist the Anthropic API key through the connector's OWN gated writer. The
 * host never touches the connector's settings shape directly — `saveAPISettings`
 * is the connector-owned write that also carries its own gating.
 */
export async function saveAnthropicSetupKeyAction(formData: FormData) {
  await requireAdminSession();
  const apiKey = (formData.get("apiKey") as string | null)?.trim();
  if (!apiKey) {
    redirect("/setup/ai?stay=1&error=setup-provider-invalid");
  }
  const surface = getLlmProviderSurface("anthropic");
  if (!surface?.saveAPISettings) {
    redirect("/setup/ai?stay=1&error=setup-provider-invalid");
  }
  await surface.saveAPISettings({ apiKey });
  // A new credential invalidates any receipt earned under the old one; clear
  // the stale failure record too so the step does not show a resolved error.
  writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, null);
  redirect("/setup/ai?stay=1");
}

export async function completeAiSetupAction(formData: FormData) {
  const session = await requireAdminSession();
  const parsed = providerSchema().safeParse(formData.get("provider"));
  if (!parsed.success) {
    redirect("/setup/ai?stay=1&error=setup-provider-invalid");
  }
  const provider = parsed.data as LlmProvider;
  const actor = await getActorContext();

  // The commit port is ASYNC by contract, so the audited mutation is awaited
  // INSIDE the saga — before its post-commit verification and before the
  // receipt is written. An earlier version smuggled the promise out through a
  // side channel, which made the verification read the PRE-commit value and
  // could leave a committed provider with no receipt behind it.
  const ports = createSetupReadinessPorts({
    setDefaultProvider: (p) => updateDefaultLlmProvider({ actor, provider: p }),
  });

  let result;
  try {
    result = await runSetupReadinessSaga({
      provider,
      actorUserId: session.user?.id ?? null,
      // The wizard's compensation is "setup-incomplete": the step keeps
      // prompting with the actionable error. A rollback would be meaningless
      // here — the saga never committed anything to roll back to.
      onFailure: "leave-incomplete",
      ports,
    });
  } catch (err) {
    writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, {
      step: "commit",
      message: sanitizeReadinessMessage(err instanceof Error ? err.message : String(err)),
      fixForward: null,
      at: new Date().toISOString(),
    });
    redirect("/setup/ai?stay=1&error=setup-readiness-failed");
  }

  if (!result.ok) {
    writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, {
      step: result.failure.step,
      message: result.failure.message,
      fixForward: result.failure.fixForward ?? null,
      at: new Date().toISOString(),
    });
    redirect("/setup/ai?stay=1&error=setup-readiness-failed");
  }

  writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, null);
  redirect("/setup/ai?stay=1");
}
