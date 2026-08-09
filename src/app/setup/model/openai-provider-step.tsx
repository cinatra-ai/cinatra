// The OPENAI connection section for the setup LLM-provider step.
//
// Reshaped by cinatra#2389 (epic #2385 S4) to the minimal form the step needs:
// the API key plus a how-to-get-a-key helper link — nothing else. The
// Project ID / Organization ID passthrough fields and the "Additional
// administration" section (service tier + default-model picker) are REMOVED
// from setup: the tier stays Standard and the default model is the provider
// surface's declared default; both remain configurable in Administration.
//
// A stored connection that reads READY hides the key field behind a one-line
// Administration pointer (key rotation/replacement happens there) — unless
// the commit machine reopened the key flow (`keyReopened`: the committed
// credential fingerprint no longer matches), in which case the key field is
// forced open for re-entry.
//
// The form posts through the TYPED save action (`useActionState` island +
// toasts, S5 cinatra#2390) — failures surface as toasts carrying the
// server-sanitized message, never as error text in a URL.

import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";

import { saveSetupOpenAIConnectionAction } from "@/app/setup/model/actions";
import { SetupProviderConnectionForm } from "@/app/setup/model/provider-connection-form";
import { readOpenAIConnection } from "@/lib/openai-connection-store";
// Every OpenAI reader resolves through the `llm-provider-surface` capability
// the openai connector registers at activation (lazy/guarded host-access
// cutover). Connector absent → the degraded info state below replaces the
// connection form.
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";

/** The OpenAI key-console page the helper links to (pinned by cinatra#2389). */
const OPENAI_KEY_CONSOLE_URL = "https://platform.openai.com/api-keys";

/** Does this host have a live, ready OpenAI connection? Used by the orchestrator. */
export async function isOpenAIConnectionReady(): Promise<boolean> {
  const surface = getLlmProviderSurface("openai");
  if (!surface) return false;
  const connection = readOpenAIConnection();
  const configured = await surface.getConfiguredConnection?.(connection ?? undefined);
  return surface.isConnectionReady?.(configured ?? connection ?? undefined) === true;
}

export async function SetupOpenAIProviderStep({ keyReopened }: { keyReopened?: boolean }) {
  const openAISurface = getLlmProviderSurface("openai");
  if (!openAISurface) {
    // Degraded mode: the openai connector is not installed/active on this
    // host. Render an explanatory state instead of a connection form that
    // could never validate or save.
    return (
      <Alert>
        <AlertTitle>OpenAI connector unavailable</AlertTitle>
        <AlertDescription>
          The OpenAI connector extension is not installed or active on this instance, so the
          default LLM provider cannot be configured here. Install/activate it (or configure a
          different provider in Administration) and reload this step.
        </AlertDescription>
      </Alert>
    );
  }
  const connection = readOpenAIConnection();
  const configuredConnection = (await openAISurface.getConfiguredConnection?.(
    connection ?? undefined,
  )) as { apiKey?: string } | null | undefined;
  const isConnected =
    openAISurface.isConnectionReady?.(configuredConnection ?? connection ?? undefined) === true;
  const hasApiKey = Boolean(configuredConnection?.apiKey || connection?.apiKey);
  // A ready stored connection hides the key field — unless the commit machine
  // reopened the key flow (fingerprint mismatch: re-entry is the remedy).
  const showKeyForm = !isConnected || keyReopened === true;

  // CARDLESS (cinatra#2502 item A, design spec `specs/app-setup.html` §I): the
  // key field sits directly on the wizard column like every other step's
  // fields. Rule #8 keeps white for what the operator touches — the <Input>
  // below and the selectable provider cards — not for the section around them.
  return (
    <section>
      <p className="text-base font-semibold text-foreground">OpenAI API key</p>
      {showKeyForm ? (
        <>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Create or copy a secret key in the{" "}
            <Link
              href={OPENAI_KEY_CONSOLE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              OpenAI API keys console
            </Link>
            . Cinatra stores it encrypted and never shows it again.
          </p>
          <SetupProviderConnectionForm
            action={saveSetupOpenAIConnectionAction}
            successMessage="OpenAI connection saved."
            className="mt-4 grid gap-4"
            testId="setup-openai-connection-form"
          >
            <Field>
              <FieldLabel>API key</FieldLabel>
              <Input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={hasApiKey ? "••••••••••••••••" : "sk-..."}
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit">{hasApiKey ? "Change" : "Save"}</Button>
            </div>
          </SetupProviderConnectionForm>
        </>
      ) : (
        // The stored connection is ready: no key field — rotation and
        // replacement live in Administration, not in setup.
        <p className="mt-0.5 text-sm text-muted-foreground" data-testid="setup-openai-admin-pointer">
          A ready OpenAI connection is already stored. Rotate or replace the key later in
          Administration.
        </p>
      )}
    </section>
  );
}
