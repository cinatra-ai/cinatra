// The ANTHROPIC connection form for the setup AI step (cinatra#2093 S6,
// reshaped by cinatra#2390 S5).
//
// Deliberately minimal: the key, the EXPLICIT skills-upload consent, and an
// honest statement of what finishing setup on this provider will do. The card
// posts through the TYPED save action (`useActionState` island + toasts) —
// failures surface as toasts carrying the server-sanitized message, never as
// error text in a URL and never as durable failure records.
//
// THE CONSENT IS PART OF THE SAVE (S5): the checkbox carries the upload
// gate's advisory content, the server input carries the literal consent plus
// the acting admin's attribution, and the workspace opt-in + the bulk
// consent-ledger grant land in ONE transaction. Scope: installed non-personal
// package identities (personal skills keep per-skill grants). A consent
// failure blocks the S3 commit — the readiness saga verifies the recorded
// consent instead of granting it silently.
//
// Every reader/writer resolves through the `llm-provider-surface` capability
// the anthropic connector registers at activation. Connector absent → the
// degraded info state replaces the form (never a form that could not save).

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";

import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { saveSetupAnthropicConnectionAction } from "@/app/setup/ai/actions";
import { SetupProviderConnectionForm } from "@/app/setup/ai/provider-connection-form";
import { ANTHROPIC_SETUP_CONSENT_FIELD } from "@/app/setup/ai/readiness-state";

export async function SetupAnthropicProviderStep() {
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

  return (
    <section className="rounded-card border border-line bg-surface-strong p-6 shadow-sm">
      <p className="text-base font-semibold text-foreground">Anthropic credentials</p>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Paste an API key from console.anthropic.com. Cinatra stores it encrypted and never shows it
        again.
      </p>

      <SetupProviderConnectionForm
        action={saveSetupAnthropicConnectionAction}
        successMessage="Anthropic connection saved and skills-upload consent recorded."
        className="mt-5 grid gap-4"
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
    </section>
  );
}
