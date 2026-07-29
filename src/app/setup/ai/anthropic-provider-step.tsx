// The ANTHROPIC connection form for the setup AI step (cinatra#2093, epic
// #2086 S6).
//
// Deliberately minimal: the key, and an HONEST statement of what finishing
// setup on this provider will do. The heavy lifting — bulk consent, the strict
// initial upload, and the native-skills probe — belongs to the readiness saga
// on the orchestrating page, not to a form, because those steps must run as one
// compensating sequence rather than as side effects of a save.
//
// Every reader/writer resolves through the `llm-provider-surface` capability the
// anthropic connector registers at activation. Connector absent → the degraded
// info state replaces the form (never a form that could not possibly save).

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";

import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";
import { saveAnthropicSetupKeyAction } from "@/app/setup/ai/actions";

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

      <Alert className="mt-4">
        <AlertTitle>What finishing setup on Anthropic will do</AlertTitle>
        <AlertDescription>
          Your installed skills are uploaded to your Anthropic workspace so Claude can use them
          natively. That is a transfer of your skill content to Anthropic. Cinatra asks for your
          explicit consent as part of the verification step, and you can revoke it later in
          Administration.
        </AlertDescription>
      </Alert>

      <form action={saveAnthropicSetupKeyAction} className="mt-5 grid gap-4">
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
        <div className="flex justify-end">
          <Button type="submit">{hasApiKey ? "Change" : "Save"}</Button>
        </div>
      </form>
    </section>
  );
}
