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
import { grantSetupConsentWithWorkspaceOptInInDatabase } from "@/lib/anthropic-setup-consent-store";
import { isNangoConfigured } from "@/lib/nango-system";
// S5 (cinatra#2390): the typed setup error channel — the host-owned writer
// that dispatches the connector's registered NON-REDIRECTING save action and
// returns `{ok, code, sanitizedMessage}` for the client toast island. No
// redirect, no error text in any URL.
import {
  saveSetupProviderConnection,
  type SetupConnectionSaveResult,
} from "@/lib/setup-provider-connection-writer";
import {
  clearSetupReadinessReceipt,
  readAnthropicMcpMode,
  runSetupReadinessSaga,
  sanitizeReadinessMessage,
  writeAnthropicMcpMode,
} from "@/lib/setup-readiness-saga";
import { createSetupReadinessPorts } from "@/lib/setup-readiness-ports";
// S3 (cinatra#2388): the provider-commit state machine — fenced claims, the
// atomic setup sink, ownership-proven compensation — and the keyed credential
// fingerprint the commitment stores.
import {
  beginSetupProviderClaim,
  commitSetupProviderClaim,
  compensateOwnedSetupCommitment,
  readSetupProviderCommitSnapshot,
  readSetupProviderCommitState,
  refreshCommittedCredentialFingerprint,
  releaseSetupProviderClaim,
} from "@/lib/setup-provider-commit";
import { readLiveCredentialFingerprint } from "@/lib/llm-credential-fingerprint";
import {
  ANTHROPIC_SETUP_CONSENT_FIELD,
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
  // S3 (cinatra#2388): provider selection REFUSES switches while a claim is
  // pending or a commitment exists. Re-selecting the already-committed
  // provider is allowed (it only decides which form renders); switching away
  // is Administration's transactional transition, not a wizard click.
  const commitState = readSetupProviderCommitState();
  if (commitState.kind === "claim-pending") {
    redirect("/setup/ai?stay=1&error=setup-provider-claim-pending");
  }
  if (commitState.kind === "committed" && commitState.commitment.provider !== parsed.data) {
    redirect("/setup/ai?stay=1&error=setup-provider-locked");
  }
  writeConnectorConfigToDatabase(SETUP_PROVIDER_SELECTION_CONFIG_KEY, parsed.data);
  redirect("/setup/ai?stay=1");
}

// ---------------------------------------------------------------------------
// S5 (cinatra#2390): the TYPED setup save actions.
//
// Both provider forms on the setup AI step post here through `useActionState`
// (the <SetupProviderConnectionForm> island). The actions return
// `{ok, code, sanitizedMessage}` — they NEVER redirect and NEVER put error
// text in a URL or in durable state. The connector's registered
// non-redirecting `saveConnection` UI action does the actual persistence,
// reached through the installed-extension dispatch (the same authorization
// pipeline as the generic action endpoint). The pre-S5 redirecting path
// (`saveOpenAIConnectionAction` + error-in-URL) is retired ON THIS SURFACE;
// the codes-only flash channel and every other consumer are untouched.
// ---------------------------------------------------------------------------

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

/** Fail-closed read of the live connection-service status (an unresolvable
 *  surface is the same operator situation as "not configured yet"). */
function connectionServiceReady(): boolean {
  try {
    return isNangoConfigured();
  } catch {
    return false;
  }
}

const CONNECTIONS_STEP_FIX_FORWARD =
  " Finish the Connections step first — the key is stored through the connection " +
  "service, which is not configured yet. Complete Connections, then come back and " +
  "save the key.";

/**
 * Typed OpenAI setup save. Collects the form's connection fields into the flat
 * values map the connector's registered `saveConnection` action consumes (the
 * same shape its schema-config admin surface submits).
 */
export async function saveSetupOpenAIConnectionAction(
  _prevState: SetupConnectionSaveResult | null,
  formData: FormData,
): Promise<SetupConnectionSaveResult> {
  await requireAdminSession();
  const values: Record<string, string> = {};
  for (const key of ["apiKey", "projectId", "organizationId", "serviceTier", "defaultModel"]) {
    const value = formString(formData, key);
    if (value !== null) values[key] = value;
  }
  return saveSetupProviderConnection("openai", values);
}

/**
 * Typed, CONSENT-AWARE Anthropic setup save (S5's "Anthropic consent at
 * save"). The card carries an explicit consent checkbox with the upload
 * gate's advisory content; this action:
 *
 *   1. requires the LITERAL consent input — no checkbox, no save. The consent
 *      is an operator act, never implied by the presence of a key;
 *   2. saves the key through the connector's registered non-redirecting
 *      save action (installed-extension dispatch, typed result);
 *   3. lands the workspace upload opt-in AND the bulk consent-ledger grant in
 *      ONE transaction, attributed to the acting admin. Scope = the installed
 *      NON-PERSONAL package identities (the bulk selector excludes personal
 *      skills by construction); idempotent per identity.
 *
 * A failure at (3) leaves the opt-in OFF (the transaction is all-or-nothing —
 * no half-enabled opt-in), returns a typed failure the island toasts, and
 * BLOCKS the S3 commit: the readiness saga's bulk-consent step now verifies
 * the recorded consent instead of granting it, so Continue cannot commit a
 * provider whose consent never landed.
 */
export async function saveSetupAnthropicConnectionAction(
  _prevState: SetupConnectionSaveResult | null,
  formData: FormData,
): Promise<SetupConnectionSaveResult> {
  const session = await requireAdminSession();
  const apiKey = formString(formData, "apiKey")?.trim();
  if (!apiKey) {
    return {
      ok: false,
      code: "key-missing",
      sanitizedMessage: "Enter an Anthropic API key to save.",
    };
  }
  if (formString(formData, ANTHROPIC_SETUP_CONSENT_FIELD) !== "on") {
    return {
      ok: false,
      code: "consent-required",
      sanitizedMessage:
        "Confirm the skills-upload consent to set up Anthropic: setup uploads your " +
        "installed skills (full SKILL.md files plus their bundled files) to your " +
        "Anthropic workspace, where Anthropic retains them.",
    };
  }

  const saved = await saveSetupProviderConnection("anthropic", { apiKey });
  if (!saved.ok) {
    // The unconfigured-connection-service class keeps its fix-forward naming
    // the step to complete first — decided from the LIVE nango status, never
    // by matching the connector's error string.
    return connectionServiceReady()
      ? saved
      : { ...saved, sanitizedMessage: saved.sanitizedMessage + CONNECTIONS_STEP_FIX_FORWARD };
  }

  try {
    // ONE transaction: the workspace opt-in + the setup-bulk ledger grant
    // (actor-attributed). A throw rolls back BOTH — no half-enabled opt-in.
    grantSetupConsentWithWorkspaceOptInInDatabase(session.user?.id ?? null);
  } catch (err) {
    const message = sanitizeReadinessMessage(err instanceof Error ? err.message : String(err));
    console.error(
      `[setup-ai] recording the Anthropic skills-upload consent failed (${errorClass(err)}): ${message}`,
    );
    return {
      ok: false,
      code: "consent-write-failed",
      sanitizedMessage:
        "The Anthropic key was saved, but the skills-upload consent could not be " +
        "recorded, so AI setup cannot complete on Anthropic yet. Save again to retry. " +
        `(${message})`,
    };
  }

  // A new credential invalidates any receipt earned under the old one; clear
  // a stale failure record too so the step does not show a resolved error.
  writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, null);
  return saved;
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
  const actorUserId = session.user?.id ?? null;

  // -------------------------------------------------------------------------
  // S3 (cinatra#2388): Continue enters the provider-commit STATE MACHINE.
  //
  //   pending claim        → refuse (any claim, including a stale own tab —
  //                          claims are short-lived and expiry is the recovery)
  //   committed, DIFFERENT → refuse (the lock; Administration is the change path)
  //   committed, SAME      → RE-VERIFY: run the readiness saga with a no-op
  //                          commit (the matrix's idempotent no-op — the
  //                          audited default already matches the commitment)
  //                          and refresh the stored credential fingerprint on
  //                          success, which is how a key rotation closes the
  //                          reopened key flow without touching the lock.
  //   absent               → CLAIM (fenced, nonce-owned), run the saga, and
  //                          commit through the atomic setup sink; the audited
  //                          mutation is NEVER invoked unfenced from setup.
  // -------------------------------------------------------------------------
  const snapshot = readSetupProviderCommitSnapshot();
  if (snapshot.state.kind === "claim-pending") {
    redirect("/setup/ai?stay=1&error=setup-provider-claim-pending");
  }
  if (snapshot.state.kind === "committed" && snapshot.state.commitment.provider !== provider) {
    redirect("/setup/ai?stay=1&error=setup-provider-locked");
  }

  // S5 (cinatra#2390): NATIVE MCP AT COMMIT. Committing Anthropic sets/
  // migrates the connector's MCP mode to `native` through the existing
  // preserving writer — eliminating the known foot-gun where a stored
  // `function-tools` mode rejects every Anthropic container-skill delivery at
  // run time while setup reads green. Done BEFORE the fingerprint sampling so
  // the readiness fingerprint this run earns is computed under the mode the
  // commit actually leaves behind. The receipt is cleared FIRST, fail-closed:
  // the mode is a fingerprint input, so flipping it could otherwise resurrect
  // a stale receipt earned under `native` before an operator flipped away.
  if (provider === "anthropic" && readAnthropicMcpMode() !== "native") {
    try {
      clearSetupReadinessReceipt();
      writeAnthropicMcpMode("native");
    } catch (err) {
      if (isNextRedirect(err)) throw err;
      console.error(
        `[setup-ai] migrating the Anthropic MCP mode to native at commit failed (${errorClass(err)}): ` +
          sanitizeReadinessMessage(err instanceof Error ? err.message : String(err)),
      );
      redirect("/setup/ai?stay=1&error=setup-mcp-mode-switch-failed");
    }
  }

  // The keyed digest of the credential this run is about to verify. A
  // non-readable outcome is carried as null (fail-closed mismatch on every
  // later readiness read — the step will honestly reopen).
  const liveFingerprint = await readLiveCredentialFingerprint(provider);
  const credentialFingerprint =
    liveFingerprint.status === "readable" ? liveFingerprint.fingerprint : null;

  // --- Acquire the fence (absent → claimed) --------------------------------
  let claimNonce: string | null = null;
  let priorDefault: string | null = null;
  if (snapshot.state.kind === "absent") {
    const begun = beginSetupProviderClaim({
      provider,
      actorId: actorUserId,
      startingCredentialFingerprint: credentialFingerprint,
    });
    if (!begun.ok) {
      redirect(
        begun.refusal === "committed"
          ? "/setup/ai?stay=1&error=setup-provider-locked"
          : "/setup/ai?stay=1&error=setup-provider-claim-pending",
      );
    }
    claimNonce = begun.claim.nonce;
    priorDefault = begun.claim.priorDefault;
  }

  // Committed-record ownership handoff for the saga's forced-restore path (a
  // receipt-write failure AFTER a landed commit): compensation is CAS-tombstone
  // under proven ownership, never an unconditional default write.
  let committed: { raw: string; provider: string } | null = null;

  // The commit port is ASYNC by contract, so the audited mutation is awaited
  // INSIDE the saga — before its post-commit verification and before the
  // receipt is written. With a claim held, the port is the ATOMIC SETUP SINK:
  // nonce guard + claim→committed CAS + audited default write, one fenced
  // step. On the committed-same re-verify path the port is the matrix's
  // idempotent no-op.
  const ports = createSetupReadinessPorts({
    setDefaultProvider: async (p) => {
      if (claimNonce === null) {
        // Committed-same re-verify: the audited default already matches the
        // commitment; the machine is not re-entered and nothing is written.
        return;
      }
      const committedResult = await commitSetupProviderClaim({
        nonce: claimNonce,
        credentialFingerprint,
        writeAuditedDefault: (pp) => updateDefaultLlmProvider({ actor, provider: pp }),
      });
      if (!committedResult.ok) {
        throw new Error(committedResult.message);
      }
      committed = { raw: committedResult.raw, provider: p };
    },
  });
  // Override the default restore port: under the machine, compensation must
  // prove ownership (byte-equal CAS) before touching anything — an
  // unconditional `writeDefaultLlmProviderToDatabase(prior)` could clobber a
  // concurrent execution's landed state.
  ports.restoreDefaultProvider = async () => {
    if (committed && priorDefault !== null) {
      compensateOwnedSetupCommitment({
        committedRaw: committed.raw,
        committedProvider: committed.provider,
        priorDefault,
      });
      committed = null;
    }
  };

  const releaseClaimIfHeld = () => {
    // No-op when the sink consumed the claim (the record is committed now) or
    // when no claim was taken (re-verify path); conditional-delete otherwise.
    if (claimNonce !== null && committed === null) {
      try {
        releaseSetupProviderClaim({ nonce: claimNonce });
      } catch (err) {
        console.error(`[setup-ai] could not release the setup claim (${errorClass(err)})`);
      }
    }
  };

  let result;
  try {
    result = await runSetupReadinessSaga({
      provider,
      actorUserId,
      // The wizard's compensation is "setup-incomplete": the step keeps
      // prompting with the actionable error. A rollback would be meaningless
      // here — a failed run never leaves a commitment behind (the sink's own
      // compensation and the claim release both act under proven ownership).
      onFailure: "leave-incomplete",
      ports,
    });
  } catch (err) {
    releaseClaimIfHeld();
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
    releaseClaimIfHeld();
    writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, {
      step: result.failure.step,
      message: result.failure.message,
      fixForward: result.failure.fixForward ?? null,
      at: new Date().toISOString(),
    });
    redirect("/setup/ai?stay=1&error=setup-readiness-failed");
  }

  // Committed-same re-verify success: refresh the commitment's stored
  // credential fingerprint to the one this run just verified (byte-equal CAS —
  // a concurrent Administration transition simply wins and the refresh yields).
  if (claimNonce === null && snapshot.state.kind === "committed" && snapshot.raw !== null) {
    refreshCommittedCredentialFingerprint({
      expectedRaw: snapshot.raw,
      commitment: snapshot.state.commitment,
      credentialFingerprint,
    });
  }

  writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, null);
  // S4 (cinatra#2389): Continue IS the commit — on success it advances. The
  // redirect deliberately drops `stay=1` so the step's auto-forward (which
  // re-derives readiness freshly) carries the operator to the next incomplete
  // step; a run that somehow left the step not-ready simply re-renders it.
  redirect("/setup/ai");
}
