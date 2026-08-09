"use server";

/**
 * Setup AI-step server actions (cinatra#2093 S6; folded by cinatra#2502 item E).
 *
 * Two acts, deliberately separate:
 *
 *   selectSetupProviderAction    — records the owner's PICK. It does NOT commit
 *                                  `llm_default_provider`: the pick only decides
 *                                  which connection form to show next, and
 *                                  committing before the readiness saga has
 *                                  proven anything is precisely the half-applied
 *                                  state S6 removes.
 *   continueSetupModelStepAction — THE STEP'S ONE PRIMARY ACTION. Saves the
 *                                  credential, records the consent where one is
 *                                  required, and runs the READINESS SAGA. The
 *                                  saga is the ONLY thing that commits the
 *                                  stored default, and it does so through the
 *                                  AUDITED platform-admin mutation this action
 *                                  injects — setup must not become a second,
 *                                  unaudited write path.
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
  isAnthropicUploadOptInStanding,
  readAnthropicMcpMode,
  runSetupReadinessSaga,
  sanitizeReadinessMessage,
  writeAnthropicMcpMode,
} from "@/lib/setup-readiness-saga";
// The wizard's codes-only NOTICE channel (never text) — the one transport a
// degraded-but-successful save has once Continue redirects on success.
import { SETUP_CONNECTION_DEGRADED_NOTICE_CODE } from "@/app/setup/setup-flash";
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
  type SetupModelStepResult,
} from "@/app/setup/model/readiness-state";

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
    redirect("/setup/model?stay=1&error=setup-provider-invalid");
  }
  // S3 (cinatra#2388): provider selection REFUSES switches while a claim is
  // pending or a commitment exists. Re-selecting the already-committed
  // provider is allowed (it only decides which form renders); switching away
  // is Administration's transactional transition, not a wizard click.
  const commitState = readSetupProviderCommitState();
  if (commitState.kind === "claim-pending") {
    redirect("/setup/model?stay=1&error=setup-provider-claim-pending");
  }
  if (commitState.kind === "committed" && commitState.commitment.provider !== parsed.data) {
    redirect("/setup/model?stay=1&error=setup-provider-locked");
  }
  writeConnectorConfigToDatabase(SETUP_PROVIDER_SELECTION_CONFIG_KEY, parsed.data);
  redirect("/setup/model?stay=1");
}

// ---------------------------------------------------------------------------
// S5 (cinatra#2390): the TYPED setup save channel.
//
// The step's ONE form posts through `useActionState` (the <SetupModelStepForm>
// island). Its result is `{ok, code, sanitizedMessage}` — the save and consent
// legs NEVER redirect and NEVER put error text in a URL or in durable state.
// The connector's registered non-redirecting `saveConnection` UI action does
// the actual persistence, reached through the installed-extension dispatch (the
// same authorization pipeline as the generic action endpoint). The pre-S5
// redirecting path (`saveOpenAIConnectionAction` + error-in-URL) stays retired
// on this surface; the codes-only flash channel and every other consumer are
// untouched.
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

// cinatra#2502 — the step this names is now called "Secrets" (route
// /setup/secrets). A fix-forward that names a step the rail does not show is
// worse than no fix-forward at all, so the copy moves with the label.
const SECRETS_STEP_FIX_FORWARD =
  " Finish the Secrets step first — the key is stored through the connection " +
  "service, which is not configured yet. Complete Secrets, then come back and " +
  "save the key.";

/**
 * THE CREDENTIAL LEG of the single Continue (cinatra#2502 item E).
 *
 * Not an exported action any more: the separate Save/Change button is retired,
 * so this runs INSIDE {@link continueSetupModelStepAction} — but its contract
 * is unchanged. It dispatches the connector's registered non-redirecting
 * `saveConnection` action through the host writer and returns the writer's
 * typed result verbatim (plus, for the unconfigured-connection-service class on
 * Anthropic, the fix-forward that names the step to finish first). It never
 * redirects and never writes durable failure state.
 *
 * The OpenAI arm collects the connection fields into the flat values map the
 * connector consumes (the same shape its schema-config admin surface submits);
 * the setup form only renders `apiKey`, and the rest stay Administration's.
 */
async function saveProviderCredential(
  provider: LlmProvider,
  formData: FormData,
): Promise<SetupConnectionSaveResult> {
  if (provider === "anthropic") {
    const apiKey = formString(formData, "apiKey")?.trim() ?? "";
    const saved = await saveSetupProviderConnection("anthropic", { apiKey });
    if (!saved.ok && !connectionServiceReady()) {
      // The unconfigured-connection-service class keeps its fix-forward naming
      // the step to complete first — decided from the LIVE nango status, never
      // by matching the connector's error string.
      return { ...saved, sanitizedMessage: saved.sanitizedMessage + SECRETS_STEP_FIX_FORWARD };
    }
    return saved;
  }
  const values: Record<string, string> = {};
  for (const key of ["apiKey", "projectId", "organizationId", "serviceTier", "defaultModel"]) {
    const value = formString(formData, key);
    if (value !== null) values[key] = value;
  }
  return saveSetupProviderConnection("openai", values);
}

/**
 * THE CONSENT TRANSACTION (S5's "Anthropic consent at save"), unchanged in
 * substance and now reached from the single Continue.
 *
 * The workspace upload opt-in AND the bulk consent-ledger grant land in ONE
 * transaction, attributed to the acting admin. Scope = the installed
 * NON-PERSONAL package identities (the bulk selector excludes personal skills
 * by construction); idempotent per identity. A throw rolls back BOTH — there is
 * no half-enabled opt-in — and the typed failure it returns BLOCKS the commit:
 * the readiness saga's bulk-consent step verifies the recorded consent instead
 * of granting it, so Continue can never commit a provider whose consent never
 * landed.
 */
function recordAnthropicUploadConsent(
  actorUserId: string | null,
): (SetupConnectionSaveResult & { ok: false }) | null {
  try {
    grantSetupConsentWithWorkspaceOptInInDatabase(actorUserId);
    return null;
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
        "recorded, so AI setup cannot complete on Anthropic yet. Press Continue again to " +
        `retry. (${message})`,
    };
  }
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
    redirect("/setup/model?stay=1");
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
    redirect("/setup/model?stay=1&error=setup-mcp-mode-switch-failed");
  }

  redirect("/setup/model?stay=1");
}

/**
 * THE SINGLE CONTINUE (cinatra#2502 item E, design spec `specs/app-setup.html`
 * §I "one primary action per step").
 *
 * One form, one button. Submitting Continue persists the step's input,
 * validates it, and moves the wizard forward — the operator never presses two
 * buttons in order. The fold spans three separately-designed mechanisms, and
 * each one's invariant survives intact:
 *
 *   S5, the typed save channel (cinatra#2390) — the credential leg returns
 *     `{ok, code, sanitizedMessage}` and NEVER redirects. A rejected key leaves
 *     the operator exactly where they were, with the sanitized reason on the
 *     field; no error text reaches a URL and nothing durable is written.
 *
 *   The consent transaction — the LITERAL consent input is still required
 *     before anything is saved (consent is an operator act, never implied by a
 *     key), and the opt-in + bulk ledger grant still land in ONE transaction
 *     after the key. A consent failure blocks the commit.
 *
 *   S3, the commit saga and its claim fence (cinatra#2388) — the fence is read
 *     BEFORE the credential is touched (a run in flight must not have the key
 *     it is verifying changed underneath it) and again at the commit, where
 *     `beginSetupProviderClaim`'s insert-if-absent is the real fence. The
 *     saga's redirect discipline is untouched: a refusal or a failed run
 *     redirects with a stable CODE and `stay=1`, a success redirects to
 *     `/setup/model` WITHOUT `stay=1` so the step re-derives and auto-forwards.
 *
 * EXACTLY ONE HONEST STATE per failure, never a half-advanced wizard:
 *
 *   consent-declined       — nothing written at all; typed refusal on the field.
 *   key-refused            — the connector rejected the key; nothing stored, no
 *                            claim taken, no commitment.
 *   saved-but-unconfirmed  — the key IS stored and the run stopped after it
 *                            (consent write failed, or the saga refused/failed).
 *                            The step keeps the saved-connection alert AND the
 *                            standing failure, and the wizard does not advance.
 *   commit-refused         — the fence or the lock refused; the codes-only
 *                            flash reports it and the step re-renders read-only
 *                            or locked, as the machine's state dictates.
 *
 * The previous run's durable failure record is cleared the moment this one gets
 * past the fence, so the step can never show two runs' outcomes at once.
 */
export async function continueSetupModelStepAction(
  _prevState: SetupModelStepResult | null,
  formData: FormData,
): Promise<SetupModelStepResult> {
  const session = await requireAdminSession();
  const parsed = providerSchema().safeParse(formData.get("provider"));
  if (!parsed.success) {
    return {
      ok: false,
      code: "provider-invalid",
      sanitizedMessage: "Choose one of the offered AI providers, then press Continue.",
    };
  }
  const provider = parsed.data as LlmProvider;
  const actorUserId = session.user?.id ?? null;

  // --- The claim fence, PRE-FLIGHT ----------------------------------------
  // Read before the credential is touched. Under a pending claim another
  // admin's run is verifying a specific credential; writing a new one
  // underneath it would invalidate the fingerprint that run started with. The
  // pre-S5 Save button had no such guard because the page hid it — the fold
  // makes the refusal a server-side fact, not a rendering accident.
  const fence = readSetupProviderCommitState();
  if (fence.kind === "claim-pending") {
    redirect("/setup/model?stay=1&error=setup-provider-claim-pending");
  }
  if (fence.kind === "committed" && fence.commitment.provider !== provider) {
    redirect("/setup/model?stay=1&error=setup-provider-locked");
  }

  // --- The GATES: everything that can refuse without writing anything ------
  // Ordered before the first durable write on purpose, so "consent declined ⇒
  // nothing was written" is literally true rather than nearly true.
  //
  // An EMPTY key field over a readable stored credential is not an error: the
  // reopened-key flow explicitly tells the operator they do not need to
  // re-enter a key that is still there, and a ready stored connection renders
  // no key field at all. It is an error only when there is nothing to verify.
  const submittedKey = formString(formData, "apiKey")?.trim() ?? "";
  if (submittedKey.length === 0) {
    const live = await readLiveCredentialFingerprint(provider);
    if (live.status !== "readable") {
      return {
        ok: false,
        code: "key-missing",
        sanitizedMessage:
          live.status === "absent"
            ? `Enter your ${provider === "anthropic" ? "Anthropic" : "OpenAI"} API key to continue.`
            : `Cinatra could not read a stored ${provider === "anthropic" ? "Anthropic" : "OpenAI"} credential. Enter the API key to continue.`,
      };
    }
  }

  // The consent gate. No checkbox, no write — and the refusal happens here, in
  // the gate block, so it cannot be preceded by a clearing write either. It is
  // REQUIRED exactly when the workspace opt-in does not already stand, which
  // is the same authority the step uses to decide whether to render the
  // control, so a stored, consented Anthropic connection is never asked again.
  const consentGiven = formString(formData, ANTHROPIC_SETUP_CONSENT_FIELD) === "on";
  if (provider === "anthropic" && !isAnthropicUploadOptInStanding() && !consentGiven) {
    return {
      ok: false,
      code: "consent-required",
      sanitizedMessage:
        "Confirm the skills-upload consent to set up Anthropic: setup uploads your " +
        "installed skills (full SKILL.md files plus their bundled files) to your " +
        "Anthropic workspace, where Anthropic retains them.",
    };
  }

  // --- THE FENCE, ACQUIRED BEFORE THE CREDENTIAL IS WRITTEN ----------------
  // The pre-flight read above is advisory: two submissions can both observe
  // "absent" and then both write a key. `beginSetupProviderClaim` is the real
  // fence (insert-if-absent, nonce-owned), so this run takes it BEFORE the
  // save and holds it through save → consent → readiness → commit. That is
  // what makes "the fence guards the credential, not just the commit" true:
  // the loser of the race never reaches `saveProviderCredential` at all, so a
  // committing run can no longer verify and commit a credential some other
  // operator wrote underneath it.
  //
  // Only the ABSENT state can be fenced this way — the machine refuses a claim
  // over a commitment by design. The committed-same RE-VERIFY path (a key
  // rotation on an already-committed instance) therefore stays claimless,
  // exactly as it was before this change; fencing it needs a re-verification
  // lease the machine does not have, which is S3's to add, not this step's.
  const startingFingerprint = await readLiveCredentialFingerprint(provider);
  let claim: { nonce: string; priorDefault: string } | null = null;
  if (fence.kind === "absent") {
    const begun = beginSetupProviderClaim({
      provider,
      actorId: actorUserId,
      startingCredentialFingerprint:
        startingFingerprint.status === "readable" ? startingFingerprint.fingerprint : null,
    });
    if (!begun.ok) {
      redirect(
        begun.refusal === "committed"
          ? "/setup/model?stay=1&error=setup-provider-locked"
          : "/setup/model?stay=1&error=setup-provider-claim-pending",
      );
    }
    claim = { nonce: begun.claim.nonce, priorDefault: begun.claim.priorDefault };
  }

  // The fence's LIFECYCLE, in one place. `claimConsumed` is set only when the
  // atomic setup sink swallowed the claim (claim → committed); every other
  // exit — typed refusal, redirect, or an unexpected throw — goes through the
  // `finally` below, so no path can leave the step wedged read-only for the
  // claim's whole 10-minute TTL. Codex round 2, finding 1: the failure read and
  // the clearing write below are inside the guard for exactly that reason.
  let claimConsumed = false;
  const releaseClaim = () => {
    if (!claim || claimConsumed) return;
    try {
      releaseSetupProviderClaim({ nonce: claim.nonce });
    } catch (err) {
      console.error(`[setup-ai] could not release the setup claim (${errorClass(err)})`);
    }
  };

  /**
   * Does this run STILL hold the fence it took?
   *
   * Holding the nonce is not the same as owning the lease: the claim can have
   * expired (an expired claim reads as `absent`), been replaced by another
   * run's claim, or been superseded by a commitment. The credential save is an
   * unbounded network call now that it happens inside the lease, so this is
   * re-asked before every side effect that reaches outside this request —
   * recording the consent, and the readiness saga's own uploads. The commit CAS
   * would refuse a lost fence anyway; these effects would not.
   */
  const stillHoldsFence = (): boolean => {
    if (!claim) return true; // claimless re-verify path — nothing to lose
    const state = readSetupProviderCommitState();
    return state.kind === "claim-pending" && state.claim.nonce === claim.nonce;
  };

  // TWO RESIDUAL RACE WINDOWS, both S3's to close and neither created here
  // (codex convergence round 3 on cinatra#2502 item E — recorded rather than
  // papered over):
  //
  //  1. The check above is a POINT-IN-TIME read, not a lease. The readiness
  //     saga's Anthropic leg performs an unbounded strict catalog upload, so a
  //     run can outlive the 10-minute claim TTL and keep uploading unfenced.
  //     Nothing is COMMITTED unfenced — `commitSetupProviderClaim` re-checks the
  //     nonce and expiry and CASes — but the uploads are not covered. Closing it
  //     needs claim renewal (a heartbeat/CAS extension) on the machine itself.
  //     This has been true since S3 (cinatra#2388) shipped; item E widens the
  //     window by the credential save it moved inside the fence.
  //  2. After the sink CONSUMES the claim, a post-commit compensation
  //     (a receipt-write failure tombstoning the commitment) leaves this run
  //     holding no fence, and the failure record it then writes is unfenced —
  //     a newly claiming run could have its cleared record overwritten. Closing
  //     it needs an ownership-scoped (CAS) failure-record primitive.
  //
  // Both are stated on the PR as known residuals with the S3 follow-up named.

  try {
    // This run owns the step's reported outcome from here on — and, on the
    // absent path, it owns the fence too, so clearing the previous run's record
    // can no longer erase a concurrent run's actionable failure. Whether one was
    // standing is carried back so the island refreshes the route exactly when a
    // now-false alert is still painted, and not otherwise (a refresh empties the
    // key field the operator just typed into).
    const clearedStandingFailure = readSetupReadinessFailure() !== null;
    writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, null);
    const typed = (result: SetupConnectionSaveResult): SetupModelStepResult =>
      clearedStandingFailure ? { ...result, clearedStandingFailure } : result;

    // --- Leg 1: the credential, under the fence ----------------------------
    let degraded = false;
    if (submittedKey.length > 0) {
      let saved: SetupConnectionSaveResult;
      try {
        saved = await saveProviderCredential(provider, formData);
      } catch (err) {
        if (isNextRedirect(err)) throw err; // connector code may redirect
        console.error(`[setup-ai] the provider credential save threw (${errorClass(err)})`);
        return typed({
          ok: false,
          code: "save-failed",
          sanitizedMessage: sanitizeReadinessMessage(
            err instanceof Error ? err.message : String(err),
          ),
        });
      }
      if (!saved.ok) return typed(saved);
      degraded = saved.code === "saved-degraded";
    }
    const credentialWritten = submittedKey.length > 0;

    // The lease may have expired underneath an unbounded save. Stop here rather
    // than run the consent transaction and the saga's uploads unfenced; the
    // step re-renders under whoever owns it now.
    if (!stillHoldsFence()) {
      redirect("/setup/model?stay=1&error=setup-provider-claim-pending");
    }

    if (provider === "anthropic" && consentGiven) {
      const consentFailure = recordAnthropicUploadConsent(actorUserId);
      if (consentFailure) {
        // The key is stored and the consent is not: that is the
        // saved-but-unconfirmed state, and it has to SURVIVE A RELOAD, not just
        // live in the typed result the island renders once.
        writeFailureRecord({
          step: "bulk-consent",
          message: consentFailure.sanitizedMessage,
          fixForward: null,
          credentialWritten,
        });
        return typed(consentFailure);
      }
    }

    // --- Leg 2: the commit saga (never returns — it always redirects) ------
    // From here the credential may already be stored, so EVERY failure has to
    // leave the durable "saved but unconfirmed" record behind it: a stored key
    // with no commitment and no standing explanation is the half-honest state
    // this whole action exists to prevent.
    try {
      await commitProviderThroughSaga(
        provider,
        actorUserId,
        degraded,
        claim,
        credentialWritten,
        () => {
          claimConsumed = true;
        },
      );
    } catch (err) {
      if (isNextRedirect(err)) throw err;
      // Written while the fence is still held — releasing first would let a
      // newly-claiming run clear the key and then have this stale record land
      // on top of it (codex round 2, finding 4).
      recordUnconfirmedRun(err, credentialWritten);
      redirect("/setup/model?stay=1&error=setup-readiness-failed");
    }
  } finally {
    releaseClaim();
  }
  // Unreachable: every path through the saga leg ends in `redirect()`. Typed
  // so the action's return type stays honest rather than relying on `never`
  // inference across an async boundary.
  return { ok: true, code: "saved", sanitizedMessage: null };
}

/**
 * The ONE durable failure record a stopped run leaves behind.
 *
 * `credentialWritten` is what makes the "saved but unconfirmed" state readable
 * rather than merely true: when this run stored a key and then failed to
 * commit, the step must say so, or the operator reads a bare error next to a
 * "connection saved" alert and cannot tell which half stands.
 */
function writeFailureRecord(input: {
  step: string;
  message: string;
  fixForward: string | null;
  credentialWritten: boolean;
}): void {
  const savedNote =
    "The key you entered was saved — the provider was not committed. Press Continue to try again.";
  // COMPOSED, not a fallback: a failure that carries its own fix-forward still
  // owes the operator the "your key is stored" half of the state.
  const fixForward =
    [input.fixForward, input.credentialWritten ? savedNote : null]
      .filter((part): part is string => Boolean(part))
      .join(" ") || null;
  writeConnectorConfigToDatabase(SETUP_READINESS_FAILURE_CONFIG_KEY, {
    step: input.step,
    message: input.message,
    fixForward,
    at: new Date().toISOString(),
  });
}

/**
 * The durable record for a run that got past the credential and then could not
 * finish. `step: "commit"` is deliberate: the saga is where this run stopped
 * being able to report for itself, and the step renders the record's message as
 * the standing, actionable explanation next to the saved-connection alert.
 */
function recordUnconfirmedRun(err: unknown, credentialWritten: boolean): void {
  const message = sanitizeReadinessMessage(err instanceof Error ? err.message : String(err));
  console.error(`[setup-ai] the provider commit could not complete (${errorClass(err)})`);
  try {
    writeFailureRecord({ step: "commit", message, fixForward: null, credentialWritten });
  } catch (writeErr) {
    console.error(
      `[setup-ai] could not record the unconfirmed-run failure (${errorClass(writeErr)})`,
    );
  }
}

async function commitProviderThroughSaga(
  provider: LlmProvider,
  actorUserId: string | null,
  degraded: boolean,
  /** The fence this run already holds (absent path), or null on re-verify. */
  held: { nonce: string; priorDefault: string } | null,
  /** Whether this run wrote a credential — decides the failure copy's honesty. */
  credentialWritten: boolean,
  /** Called the instant the atomic sink swallows the claim: from then on the
   *  record is a COMMITMENT and releasing the nonce would be wrong. */
  onClaimConsumed: () => void,
): Promise<never> {
  const actor = await getActorContext();

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
  //   absent               → the caller already CLAIMED (fenced, nonce-owned)
  //                          before writing the credential; this leg runs the
  //                          saga and commits through the atomic setup sink.
  //                          The audited mutation is NEVER invoked unfenced.
  //
  // cinatra#2502 item E moved the claim ACQUISITION up into the caller so the
  // fence also covers the credential write. The re-read below is therefore
  // scoped to the claimless RE-VERIFY path: on the fenced path this run's own
  // claim is what the store holds, and re-reading it would refuse the run for
  // its own fence.
  // -------------------------------------------------------------------------
  const snapshot = readSetupProviderCommitSnapshot();
  if (!held) {
    if (snapshot.state.kind === "claim-pending") {
      redirect("/setup/model?stay=1&error=setup-provider-claim-pending");
    }
    if (snapshot.state.kind === "committed" && snapshot.state.commitment.provider !== provider) {
      redirect("/setup/model?stay=1&error=setup-provider-locked");
    }
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
      // cinatra#2502 item E: this run may already have stored a credential, so
      // the flash code alone would leave a saved key with nothing on the step
      // saying why setup did not finish. Written HERE, while the fence is still
      // held — the caller's `finally` releases it afterwards, so a newly
      // claiming run cannot clear the key and then be overwritten by this.
      writeFailureRecord({
        step: "commit",
        message: sanitizeReadinessMessage(err instanceof Error ? err.message : String(err)),
        fixForward: null,
        credentialWritten,
      });
      redirect("/setup/model?stay=1&error=setup-mcp-mode-switch-failed");
    }
  }

  // The keyed digest of the credential this run is about to verify — sampled
  // AFTER the save, so it is the digest of what this run actually stored, and
  // after the mode migration, so the readiness fingerprint is computed under
  // the mode the commit leaves behind. A non-readable outcome is carried as
  // null (fail-closed mismatch on every later readiness read — the step will
  // honestly reopen).
  const liveFingerprint = await readLiveCredentialFingerprint(provider);
  const credentialFingerprint =
    liveFingerprint.status === "readable" ? liveFingerprint.fingerprint : null;

  // The fence this run took before writing the credential (absent path); null
  // on the claimless committed-same re-verify.
  const claimNonce: string | null = held?.nonce ?? null;
  const priorDefault: string | null = held?.priorDefault ?? null;

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
      // The claim is gone — the record IS the commitment now. Releasing the
      // nonce from here on would be a no-op at best; the caller must not try.
      onClaimConsumed();
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

  // The claim's release is the CALLER's `finally` (cinatra#2502 item E): every
  // failure path below writes its durable record while the fence is still held
  // and lets the caller give it back afterwards, so a concurrent run that
  // claims next cannot have its cleared failure key overwritten by this run's
  // stale record.
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
    if (isNextRedirect(err)) throw err;
    writeFailureRecord({
      step: "commit",
      message: sanitizeReadinessMessage(err instanceof Error ? err.message : String(err)),
      fixForward: null,
      credentialWritten,
    });
    redirect("/setup/model?stay=1&error=setup-readiness-failed");
  }

  if (!result.ok) {
    writeFailureRecord({
      step: result.failure.step,
      message: result.failure.message,
      fixForward: result.failure.fixForward ?? null,
      credentialWritten,
    });
    redirect("/setup/model?stay=1&error=setup-readiness-failed");
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
  //
  // cinatra#2502 item E: a DEGRADED save (the key validated and stored, the
  // connection-service copy did not complete) is a success the operator still
  // has to hear about. Under the retired two-button flow it was a warning toast
  // from the save; folded into Continue it would be swallowed by this redirect,
  // so it rides the wizard's codes-only NOTICE channel instead — carried
  // through the step's auto-forward to whichever page the operator lands on.
  redirect(degraded ? `/setup/model?notice=${SETUP_CONNECTION_DEGRADED_NOTICE_CODE}` : "/setup/model");
}
