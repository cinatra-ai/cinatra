// Deeplink: Initial setup wizard LLM-provider step; navigated to from setup
// orchestration, not from app chrome.
//
// THE SIMPLIFIED PROVIDER STEP (cinatra#2389, epic #2385 S4).
//
// Two logo'd provider cards, minimal fields, no ceremony:
//
//   1. the intro says what this step decides — the LLM that drives the
//      Cinatra chat assistant;
//   2. the two wizard-eligible providers render as standalone cards (no
//      wrapper card, no "Provider" heading), each with its brand mark from
//      the host connector icon map;
//   3. the chosen provider contributes only its minimal connection section —
//      an API key + a how-to-get-a-key helper link (plus, on Anthropic, the
//      explicit skills-upload consent). A ready stored connection hides the
//      key field behind an Administration pointer;
//   4. CONTINUE drives S3's claim→commit machine (cinatra#2388) — there is no
//      Finish/verify ceremony card and no receipt display. After commitment
//      the chosen card stays active and the other renders de-emphasized and
//      non-interactive ("changeable later in Administration"); while another
//      admin's claim is pending the step is read-only.
//
// Readiness derives from S3's model with NO receipt: the committed record is
// the provider lock, plus a fresh matching keyed credential fingerprint, plus
// the provider-specific readiness inputs re-read live.
//
// Gemini is deliberately NOT offered here (`wizardEligible: false`): it is a
// perfectly valid global default, but admin-configured after setup.
//   5. cinatra#2502 item E — ONE PRIMARY ACTION. The separate Save/Change
//      button is retired: the key field and the Anthropic consent live inside
//      the Continue form, and one submit saves → consents → commits (design
//      spec `specs/app-setup.html` §I).
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { buildKnownWizardEligibleProviders } from "@cinatra-ai/sdk-extensions/llm-provider-contract";
import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";
import {
  getLlmProviderSurface,
  getLlmProviderSurfacePackageName,
} from "@/lib/llm-provider-surfaces";
import { readAnthropicMcpMode } from "@/lib/setup-readiness-saga";
// S3 (cinatra#2388): rendering derives from the provider-commit machine —
// committed = the provider LOCK; any pending claim renders the generic
// read-only state (identifier-free view).
import { deriveSetupAiStepState } from "@/lib/setup-provider-commit";
// The EXISTING host brand-icon map (cinatra#1325) — no new logo mechanism.
// The map is keyed by connector slug (scoped npm name minus its scope); the
// slug is derived from the provider's LIVE capability registration, so core
// never names a concrete extension package (the coupling ban).
import { connectorBrandIcon } from "@/components/connector-brand-icons";
import {
  SETUP_CREDENTIAL_SAVE_STEP_ID,
  readSetupProviderSelection,
  readSetupReadinessFailure,
} from "@/app/setup/model/readiness-state";
import {
  selectSetupProviderAction,
  continueSetupModelStepAction,
  enableAnthropicNativeSkillDeliveryAction,
} from "@/app/setup/model/actions";
import { SetupModelStepForm } from "@/app/setup/model/model-step-form";
import { SETUP_NOTICE_MESSAGES } from "@/app/setup/setup-flash";
import {
  SetupOpenAIProviderStep,
  isOpenAIConnectionReady,
} from "@/app/setup/model/openai-provider-step";
import {
  SetupAnthropicProviderStep,
  isAnthropicConnectionReady,
} from "@/app/setup/model/anthropic-provider-step";

export const metadata: Metadata = { title: "Setup: Model" };

type SetupAiPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

// cinatra#2477 (owner acceptance review) — the cards carry NO descriptive
// blurb: logo + name only. The only text a card may show below its label is
// functional state (connector not installed / choice locked), never copy.
const PROVIDER_COPY: Record<string, { label: string }> = {
  openai: { label: "OpenAI" },
  anthropic: { label: "Anthropic" },
};

/**
 * The provider's brand mark from the host icon map, resolved through the LIVE
 * `llm-provider-surface` capability registration (package name → slug → map).
 * Null when the connector is absent or its slug has no mapped mark — the card
 * simply renders without a logo (never a foreign fallback emblem).
 */
function providerBrandIcon(provider: string): ReactNode | null {
  const packageName = getLlmProviderSurfacePackageName(provider);
  if (!packageName) return null;
  const slug = packageName.includes("/")
    ? packageName.slice(packageName.lastIndexOf("/") + 1)
    : packageName;
  return connectorBrandIcon(slug);
}

export default async function SetupAiPage({ searchParams }: SetupAiPageProps) {
  const resolvedSearchParams = await (searchParams ??
    Promise.resolve({} as Record<string, string | string[] | undefined>));
  const stay = pickSearchParam(resolvedSearchParams.stay) === "1";

  const eligible = buildKnownWizardEligibleProviders();
  // S3 (cinatra#2388): the machine's state drives this page. This read also
  // performs the lazy receipt→commitment migration on configured instances.
  const aiState = await deriveSetupAiStepState();
  const commitState = aiState.commitState;

  // ANY PENDING CLAIM renders the generic read-only state — including the
  // claimant's own stale tab: every server action on this step refuses under
  // a pending claim (claims are short-lived and expiry is the recovery), so
  // rendering interactive controls that can only bounce would be dishonest.
  // No nonce, no actor, no provider — nothing that identifies the claimant
  // or their run.
  if (commitState.kind === "claim-pending") {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <p className="text-base font-semibold text-foreground">Choose your LLM provider</p>
        </div>
        <Alert data-testid="setup-ai-in-progress">
          <AlertTitle>LLM provider setup in progress</AlertTitle>
          <AlertDescription>
            An administrator is completing this step right now. This page is read-only
            until that run finishes.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const committedProvider =
    commitState.kind === "committed" ? commitState.commitment.provider : null;
  // The committed provider IS the selection: the choice is locked, so the
  // stored pick can never render a different provider's form.
  const selected = committedProvider ?? readSetupProviderSelection();
  const failure = readSetupReadinessFailure();
  // A CREDENTIAL-SAVE failure surfaces as a toast at the provider's own form
  // (the control the operator used); the inline alert reports Continue runs.
  const readinessFailure =
    failure && failure.step !== SETUP_CREDENTIAL_SAVE_STEP_ID ? failure : null;
  // A `native-skills-probe` failure whose cause is the `function-tools` MCP
  // mode is the one failure with a remedy the wizard can PERFORM. Gate on the
  // STORED mode, the authority the derivation itself reads; the action
  // re-checks the same condition before mutating.
  const offerNativeMcpSwitch =
    selected === "anthropic" &&
    readinessFailure?.step === "native-skills-probe" &&
    readAnthropicMcpMode() === "function-tools";

  // The selected provider's stored-connection state: drives the saved alert
  // above the cards and the key-field visibility inside the provider section.
  const selectedConnectionReady =
    selected === "openai"
      ? await isOpenAIConnectionReady()
      : selected === "anthropic"
        ? await isAnthropicConnectionReady()
        : false;
  // The REOPENED key flow (S3): the commitment stands but its credential
  // fingerprint no longer matches — the key field must show even over a
  // connection that reads ready, so the operator can re-enter and re-commit.
  const keyReopened = committedProvider !== null && !aiState.credentialFresh;

  // Auto-forward once the step is genuinely ready (committed + fresh
  // credential + live provider inputs), unless the operator came back via the
  // stepper or a Continue failure is still standing. The suppression keys off
  // the DURABLE failure record rather than an `?error` param: the failure is
  // real state the operator has to act on, not a one-shot flash. The transient
  // flash itself goes through the wizard's codes-only <SearchParamToast> (see
  // setup-flash.ts) — this page never reads notification text from the URL.
  const steps = await getSetupWizardSteps();
  const nextStep = getFirstIncompleteStep(steps);
  // cinatra#2502 item E: a DEGRADED-but-successful save rides the codes-only
  // notice channel on the commit's success redirect. This step immediately
  // forwards, so the notice has to travel with the forward or the operator
  // never sees it. Passed through ONLY when it is a code this wizard knows —
  // an arbitrary `?notice=` from a crafted link is dropped here as well as
  // ignored by the toast island, so nothing attacker-supplied is ever relayed.
  const notice = pickSearchParam(resolvedSearchParams.notice);
  const relayedNotice =
    notice && Object.hasOwn(SETUP_NOTICE_MESSAGES, notice)
      ? `?notice=${encodeURIComponent(notice)}`
      : "";
  if (aiState.ready && !failure && !stay) {
    if (!nextStep || nextStep.id !== "ai") {
      redirect(`${nextStep?.href ?? "/setup/complete"}${relayedNotice}`);
    }
  }
  const continueHref = !nextStep || nextStep.id === "ai" ? "/setup/complete" : nextStep.href;

  // The chosen provider's minimal connection section — the key field and, on
  // Anthropic, the consent control (or the Administration pointer once the
  // stored connection reads ready). Built once and placed by the branch below:
  // inside the step's form while there is still something to submit, and
  // beside the navigation link once there is not.
  const providerSection =
    selected === "openai" ? (
      <SetupOpenAIProviderStep keyReopened={keyReopened} />
    ) : selected === "anthropic" ? (
      <SetupAnthropicProviderStep keyReopened={keyReopened} />
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-base font-semibold text-foreground">Choose your LLM provider</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          The provider you pick here is the LLM that drives the Cinatra chat assistant — it
          runs the assistant, agents and skill generation. You can change it later in
          Administration.
        </p>
      </div>

      {/* The saved-connection alert — ABOVE the provider cards, and only when
          the selected provider's stored connection exists and is ready. */}
      {selected && selectedConnectionReady ? (
        <Alert data-testid="setup-connection-saved">
          <Check className="size-4" aria-hidden />
          <AlertTitle>
            {PROVIDER_COPY[selected]?.label ?? selected} connection saved
          </AlertTitle>
          <AlertDescription>
            Cinatra stores the API key encrypted and never shows it again. Rotate or replace
            it later in Administration.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* The two provider cards — standalone (no wrapper card, no heading). */}
      <div className="grid gap-3 sm:grid-cols-2">
        {eligible.map((provider) => {
          const copy = PROVIDER_COPY[provider] ?? { label: provider };
          const installed = getLlmProviderSurface(provider) !== null;
          const isSelected = selected === provider;
          // S3 (cinatra#2388): a commitment LOCKS the choice — the other card
          // is de-emphasized and refuses selection; Administration is the
          // change path.
          const lockedOut = committedProvider !== null && provider !== committedProvider;
          const brandIcon = providerBrandIcon(provider);
          return (
            <form action={selectSetupProviderAction} key={provider}>
              <Input type="hidden" name="provider" value={provider} />
              <Button
                type="submit"
                variant="outline"
                disabled={!installed || lockedOut}
                aria-pressed={isSelected}
                data-testid={`setup-provider-${provider}`}
                className={[
                  "h-auto w-full flex-col items-start gap-1.5 whitespace-normal rounded-card border p-4 text-left",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : lockedOut
                      ? "border-line opacity-60"
                      : "border-line hover:border-primary/50",
                ].join(" ")}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="flex items-center gap-2.5">
                    {brandIcon ? (
                      <span
                        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface"
                        aria-hidden
                      >
                        {brandIcon}
                      </span>
                    ) : null}
                    <span className="text-sm font-semibold text-foreground">{copy.label}</span>
                  </span>
                  {isSelected ? <Check className="size-4 text-primary" aria-hidden /> : null}
                </span>
                {/* Functional state only (cinatra#2477): a normally
                    selectable card renders no text below its label. */}
                {!installed || lockedOut ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {!installed
                      ? `The ${copy.label} connector is not installed or active on this instance.`
                      : "The provider choice is committed — changeable later in Administration."}
                  </span>
                ) : null}
              </Button>
            </form>
          );
        })}
      </div>

      {/* The REOPENED key flow: the lock stands, the credential no longer
          matches — the key section below is forced open for re-entry.
          cinatra#2504: a commitment made before credential-fingerprint
          capture existed (`credentialFingerprintNeverCaptured`) reads the
          same "not fresh" as a genuine rotation/removal, but the
          rotation/removal copy is FALSE for it — nothing changed, the
          fingerprint simply was never recorded. Render the accurate copy for
          that case; the rotation copy still renders for an actual mismatch.

          cinatra#2502 item E — this alert and the standing-failure one below
          sit ABOVE the step's form rather than between the key field and
          Continue. Two reasons, both structural: the fix-forward inside the
          failure alert is itself a form, and a form inside the step's form
          would be invalid markup; and an explanation reads better before the
          field it is about than after it. */}
      {keyReopened ? (
        <Alert variant="destructive" data-testid="setup-credential-reopened">
          <TriangleAlert className="size-4" aria-hidden />
          {aiState.credentialFingerprintNeverCaptured ? (
            <>
              <AlertTitle>This setup predates credential verification</AlertTitle>
              <AlertDescription>
                This instance&rsquo;s{" "}
                {PROVIDER_COPY[committedProvider ?? ""]?.label ?? committedProvider} provider
                was committed before Cinatra verified credentials at setup time — nothing was
                removed or rotated. The provider choice stays committed; press Continue to
                verify the saved key now. You do not need to re-enter it.
              </AlertDescription>
            </>
          ) : (
            <>
              <AlertTitle>The saved credentials changed</AlertTitle>
              <AlertDescription>
                The {PROVIDER_COPY[committedProvider ?? ""]?.label ?? committedProvider} key
                this instance was set up with was removed, rotated, or can no longer be read.
                The provider choice stays committed — enter the key below and press Continue
                to re-verify.
              </AlertDescription>
            </>
          )}
        </Alert>
      ) : null}

      {/* A standing Continue failure — actionable detail from the durable
          record (the flash channel carries codes only, never this text). */}
      {readinessFailure ? (
        <Alert variant="destructive" data-testid="setup-readiness-failure">
          <TriangleAlert className="size-4" aria-hidden />
          <AlertTitle>The provider could not be committed ({readinessFailure.step})</AlertTitle>
          <AlertDescription>
            <span className="block">{readinessFailure.message}</span>
            {readinessFailure.fixForward ? (
              <span className="mt-2 block font-medium">{readinessFailure.fixForward}</span>
            ) : null}
            {/* The fix-forward, PERFORMABLE. Without this the instruction
                names a setting no surface renders and no admin route reaches
                during setup. */}
            {offerNativeMcpSwitch ? (
              <form action={enableAnthropicNativeSkillDeliveryAction} className="mt-3">
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  data-testid="setup-enable-native-mcp"
                >
                  Switch to native MCP delivery
                </Button>
              </form>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* THE ONE PRIMARY ACTION (cinatra#2502 item E, spec §I). The chosen
          provider's key field and — on Anthropic — its consent control live
          INSIDE this form, and the single Continue submits them: one press
          saves the credential through S5's typed channel, records the consent
          in its own transaction, and drives S3's claim→commit machine. There
          is no separate Save, and no Finish/verify card.

          Once the step reads ready there is nothing left to submit, so
          Continue degrades to a plain navigation link. */}
      {aiState.ready ? (
        <>
          {providerSection}
          <div className="flex justify-end">
            <Button asChild data-testid="setup-ai-continue">
              <Link href={continueHref}>
                Continue
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </>
      ) : selected ? (
        <SetupModelStepForm
          action={continueSetupModelStepAction}
          className="grid gap-4"
          testId={`setup-${selected}-connection-form`}
        >
          <Input type="hidden" name="provider" value={selected} />
          {providerSection}
        </SetupModelStepForm>
      ) : null}
    </div>
  );
}
