// The ANTHROPIC connection section for the setup LLM-provider step
// (cinatra#2093 S6, reshaped by cinatra#2390 S5 and cinatra#2389 S4).
//
// Deliberately minimal: the key with its how-to-get-a-key helper link, the
// EXPLICIT skills-upload consent, and nothing else. The card posts through
// the TYPED save action (`useActionState` island + toasts) — failures surface
// as toasts carrying the server-sanitized message, never as error text in a
// URL and never as durable failure records.
//
// A stored connection that reads READY hides the key form behind a one-line
// Administration pointer (key rotation/replacement happens there) — unless
// the commit machine reopened the key flow (`keyReopened`: the committed
// credential fingerprint no longer matches), in which case the form is forced
// open for re-entry.
//
// THE CONSENT IS PART OF THE SAVE (S5): the checkbox carries the upload
// gate's advisory content, the server input carries the literal consent plus
// the acting admin's attribution, and the workspace opt-in + the bulk
// consent-ledger grant land in ONE transaction. Scope: installed non-personal
// package identities (personal skills keep per-skill grants). A consent
// failure blocks the S3 commit — the commit path verifies the recorded
// consent instead of granting it silently.
//
// Every reader/writer resolves through the `llm-provider-surface` capability
// the anthropic connector registers at activation. Connector absent → the
// degraded info state replaces the form (never a form that could not save).

import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";

import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { isAnthropicUploadOptInStanding } from "@/lib/setup-readiness-saga";
import { saveSetupAnthropicConnectionAction } from "@/app/setup/model/actions";
import { SetupProviderConnectionForm } from "@/app/setup/model/provider-connection-form";
import { ANTHROPIC_SETUP_CONSENT_FIELD } from "@/app/setup/model/readiness-state";

/** The Anthropic key-console page the helper links to (pinned by cinatra#2389). */
const ANTHROPIC_KEY_CONSOLE_URL = "https://console.anthropic.com/settings/keys";

/** Does this host have a live, ready Anthropic connection? Used by the orchestrator. */
export async function isAnthropicConnectionReady(): Promise<boolean> {
  const surface = getLlmProviderSurface("anthropic");
  if (!surface) return false;
  const configured = (await surface.getConfiguredConnection?.()) as
    | { apiKey?: string }
    | null
    | undefined;
  // The surface's own readiness answer when it offers one; otherwise the
  // stored key's presence is the honest available signal.
  if (typeof surface.isConnectionReady === "function") {
    return surface.isConnectionReady(configured ?? undefined) === true;
  }
  return Boolean(configured?.apiKey);
}

export async function SetupAnthropicProviderStep({ keyReopened }: { keyReopened?: boolean }) {
  const surface = getLlmProviderSurface("anthropic");
  if (!surface) {
    return (
      <Alert>
        <AlertTitle>Anthropic connector unavailable</AlertTitle>
        <AlertDescription>
          The Anthropic connector extension is not installed or active on this instance, so it
          cannot be configured here. Install/activate it (or choose a different provider) and
          reload this step.
        </AlertDescription>
      </Alert>
    );
  }

  const configured = (await surface.getConfiguredConnection?.()) as
    | { apiKey?: string }
    | null
    | undefined;
  const hasApiKey = Boolean(configured?.apiKey);
  const isConnected =
    typeof surface.isConnectionReady === "function"
      ? surface.isConnectionReady(configured ?? undefined) === true
      : hasApiKey;
  // A ready stored connection hides the key form — unless the commit machine
  // reopened the key flow (fingerprint mismatch: re-entry is the remedy), or
  // the standing skills-upload opt-in is missing/revoked. The consent is only
  // grantable through the consented key save (S5's one-transaction contract),
  // so hiding the form in that state would leave Continue permanently unable
  // to complete with no control anywhere on the step.
  const showKeyForm =
    !isConnected || keyReopened === true || !isAnthropicUploadOptInStanding();

  return (
    // CARDLESS (cinatra#2502 item A, design spec `specs/app-setup.html` §I) —
    // the same migration as the OpenAI section: the key field and the consent
    // control sit directly on the wizard column, and white stays reserved for
    // the elements the operator actually touches.
    <section>
      <p className="text-base font-semibold text-foreground">Anthropic API key</p>
      {showKeyForm ? (
        <>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Create or copy an API key in the{" "}
            <Link
              href={ANTHROPIC_KEY_CONSOLE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              Anthropic Console
            </Link>
            . Cinatra stores it encrypted and never shows it again.
          </p>

          <SetupProviderConnectionForm
            action={saveSetupAnthropicConnectionAction}
            successMessage="Anthropic connection saved and skills-upload consent recorded."
            className="mt-4 grid gap-4"
            testId="setup-anthropic-connection-form"
          >
            <Field>
              <FieldLabel>API key</FieldLabel>
              <Input
                name="apiKey"
                type="password"
                autoComplete="off"
                data-testid="setup-anthropic-api-key"
                placeholder={hasApiKey ? "••••••••••••••••" : "sk-ant-..."}
              />
            </Field>

            {/* The EXPLICIT consent — the upload gate's advisory content, at the
                act. Native HTML `required` is the client backstop; the server
                action independently refuses a save without the literal consent
                input. */}
            <label className="flex items-start gap-3 rounded-card border border-line p-4 text-sm">
              <Checkbox
                name={ANTHROPIC_SETUP_CONSENT_FIELD}
                required
                data-testid="setup-anthropic-consent"
                className="mt-0.5"
              />
              <span className="flex flex-col gap-1">
                <span className="font-medium text-foreground">
                  Upload my installed skills to my Anthropic workspace
                </span>
                <span className="text-muted-foreground">
                  Anthropic Custom Skills are not ZDR-eligible: setup uploads each installed
                  skill&apos;s full SKILL.md and its bundled files off this instance to your Anthropic
                  workspace, where Anthropic retains them. The consent covers your installed
                  non-personal skill packages, survives skill versions, and stands until you revoke it
                  in Administration. Personal skills are excluded — they keep their own per-skill
                  consent.
                </span>
              </span>
            </label>

            <div className="flex justify-end">
              <Button type="submit">{hasApiKey ? "Change" : "Save"}</Button>
            </div>
          </SetupProviderConnectionForm>
        </>
      ) : (
        // The stored connection is ready: no key field — rotation and
        // replacement live in Administration, not in setup.
        <p
          className="mt-0.5 text-sm text-muted-foreground"
          data-testid="setup-anthropic-admin-pointer"
        >
          A ready Anthropic connection is already stored. Rotate or replace the key later in
          Administration.
        </p>
      )}
    </section>
  );
}
