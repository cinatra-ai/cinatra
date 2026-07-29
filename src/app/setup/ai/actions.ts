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
import { isNangoConfigured } from "@/lib/nango-system";
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import {
  clearSetupReadinessReceipt,
  readAnthropicMcpMode,
  runSetupReadinessSaga,
  sanitizeReadinessMessage,
  writeAnthropicMcpMode,
} from "@/lib/setup-readiness-saga";
import { createSetupReadinessPorts } from "@/lib/setup-readiness-ports";
import {
  SETUP_CREDENTIAL_SAVE_STEP_ID,
  SETUP_PROVIDER_SELECTION_CONFIG_KEY,
  SETUP_READINESS_FAILURE_CONFIG_KEY,
  readSetupReadinessFailure,
} from "@/app/setup/ai/readiness-state";

/**
 * `redirect()` signals by THROWING a tagged error, so any `catch` placed around
 * a call that might redirect has to let that one through.
 *
 * Where this actually matters, precisely: `saveAnthropicSetupKeyAction` calls
 * CONNECTOR-owned code (`surface.saveAPISettings`) directly, and connector code
 * is free to redirect. It does NOT extend to the readiness saga's ports — the
 * saga catches its ports' throws BY DESIGN and converts them into readiness
 * failures, so a port that redirected would already have been absorbed before
 * `completeAiSetupAction` ever saw it. The guard there covers a redirect thrown
 * by the saga machinery itself.
 */
function isNextRedirect(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

/** The error's CLASS, for logs — never its message or stack (both can echo a
 *  provider credential back; that is exactly why the operator-facing copy goes
 *  through `sanitizeReadinessMessage`). */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

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
 * host never touches the connector's CREDENTIAL shape directly —
 * `saveAPISettings` is the connector-owned write that also carries its own
 * gating.
 *
 * THE FAILURE IS PART OF THE CONTRACT, not an exception. That writer
 * hard-requires a configured connection service
 * (`if (!deps.nango.isConfigured()) throw`), and an unconfigured one is the
 * NORMAL pre-setup state — the wizard's own **Connections** step is still
 * incomplete at exactly this point. Letting the throw escape hands the operator
 * an unhandled server error on the happy path of a fresh install.
 *
 * PARITY WITH THE OPENAI ARM of this same step, read off its code rather than
 * assumed: `saveConnection` (openai-connector actions-core) treats an
 * unconfigured Nango as a TOLERATED condition (`if (apiKey &&
 * nango.isConfigured())` — it simply skips the pointer sync), and reports every
 * genuine failure by REDIRECTING with a flash, never by throwing out of the
 * action. Anthropic's writer cannot tolerate the condition (its credential
 * lives in Nango only, with no DB-fallback write), so the parity that is
 * actually available is the reporting semantics: every failure class becomes an
 * in-page actionable state plus the wizard's codes-only flash.
 *
 * NOTHING IS SWALLOWED. Every error the connector's writer REJECTS with is
 * recorded and rendered (a `redirect()` it throws is control flow and passes
 * through untouched); the unconfigured-connection-service class additionally
 * earns a fix-forward naming the step to complete first, decided from the LIVE
 * nango status rather than by matching the connector's error string. A failure
 * of the recording write itself is not caught — that is the wizard's existing
 * posture for a dead config store, and pretending to handle it here would just
 * hide it.
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

  let failure: { message: string; fixForward: string | null } | null = null;
  try {
    await surface.saveAPISettings({ apiKey });
  } catch (err) {
    if (isNextRedirect(err)) throw err;
    const message = sanitizeReadinessMessage(err instanceof Error ? err.message : String(err));
    // Loud server-side too — but the SANITIZED message plus the error class,
    // never the raw error. A provider writer is free to echo the credential
    // back in its message or stack, and a server log is durable and often
    // shipped off-box: sanitizing the operator-facing copy while logging the
    // raw error would defeat the sanitizer entirely.
    console.error(`[setup-ai] saving the Anthropic API key failed (${errorClass(err)}): ${message}`);
    const connectionServiceReady = (() => {
      try {
        return isNangoConfigured();
      } catch {
        // The nango-system surface itself being unresolvable is the same
        // operator situation as "not configured yet", and is the fail-closed
        // reading either way.
        return false;
      }
    })();
    failure = {
      message,
      fixForward: connectionServiceReady
        ? null
        : "Finish the Connections step first — the Anthropic key is stored through the connection service, which is not configured yet. Complete Connections, then come back and save the key.",
    };
  }

  if (failure) {
    writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, {
      step: SETUP_CREDENTIAL_SAVE_STEP_ID,
      message: failure.message,
      fixForward: failure.fixForward,
      at: new Date().toISOString(),
    });
    redirect("/setup/ai?stay=1&error=setup-provider-save-failed");
  }

  // A new credential invalidates any receipt earned under the old one; clear
  // the stale failure record too so the step does not show a resolved error.
  writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, null);
  redirect("/setup/ai?stay=1");
}

/**
 * THE FIX-FORWARD, PERFORMABLE (the F2 finding on PR #2213).
 *
 * When a `native-skills-probe` failure reports mode `function-tools`, its
 * remedy is flipping the Anthropic connection's MCP mode to `"native"` — and
 * nothing in the product could perform that: the connector declares no
 * `mcpMode` field on its settings schema, the host's legacy
 * `setAnthropicMcpModeAction` is a stub that writes nothing, and every admin
 * route redirects back into the wizard while setup is incomplete. So the
 * failure named a control that did not exist anywhere. This action IS that
 * control, offered exactly where the failure is rendered.
 *
 * Same admin gate as every other action in this step. It changes ONE non-secret
 * setting and deliberately does NOT re-run the saga: the operator re-runs
 * "Verify and save", so a receipt only ever stands on a probe they asked for.
 *
 * THREE THINGS IT REFUSES TO DO (codex round-4 findings 2 and 3 — each is a way
 * this action could otherwise manufacture a state the saga exists to prevent):
 *
 *  1. It re-checks the standing condition AT MUTATION TIME. The button's render
 *     condition is not a guarantee: a stale form, a double submit, or a direct
 *     invocation arrives after the world moved. Without this, the action would
 *     set Anthropic's mode and clear the single global failure record even when
 *     the standing failure is now an unrelated one (e.g. an OpenAI readiness
 *     failure), erasing an error the operator still has to act on.
 *  2. It CLEARS THE RECEIPT, first, and refuses to change the mode if that
 *     clear fails. The mode is a readiness-fingerprint input, so a receipt
 *     earned under the old mode reads as merely-invalid, NOT deleted — and a
 *     failing run's own `clearReceipt` is best-effort. Flipping back to a mode
 *     some earlier receipt was earned under would therefore RESURRECT it and
 *     make setup read ready on a probe that failed. Clearing before the write
 *     means no ordering of crashes can leave mode-changed + stale-receipt.
 *  3. It reports a failed mutation instead of throwing an error page at the
 *     operator — the same protocol as the rest of this step.
 */
export async function enableAnthropicNativeSkillDeliveryAction() {
  await requireAdminSession();

  // (1) The precondition, re-read from durable state rather than trusted from
  // the render that produced the button.
  const standing = readSetupReadinessFailure();
  if (standing?.step !== "native-skills-probe" || readAnthropicMcpMode() !== "function-tools") {
    redirect("/setup/ai?stay=1");
  }

  try {
    // (2) Receipt first, fail-closed: a throw here leaves the mode untouched.
    clearSetupReadinessReceipt();
    writeAnthropicMcpMode("native");
    // The stored failure describes the mode just changed; clearing it stops the
    // step showing a resolved error. It does NOT make the step ready —
    // readiness is a receipt, and there is now provably none.
    writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, null);
  } catch (err) {
    if (isNextRedirect(err)) throw err;
    console.error(
      `[setup-ai] switching the Anthropic MCP mode to native failed (${errorClass(err)}): ` +
        sanitizeReadinessMessage(err instanceof Error ? err.message : String(err)),
    );
    // (3) The step re-renders whatever durable state actually survived — which
    // is why the write order above matters more than this message does.
    redirect("/setup/ai?stay=1&error=setup-mcp-mode-switch-failed");
  }

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
    if (isNextRedirect(err)) throw err;
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
