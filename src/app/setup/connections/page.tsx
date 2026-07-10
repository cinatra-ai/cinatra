// Deeplink: Initial setup Connections step (Nango under the hood); navigated to from setup orchestration, not from app chrome.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowRight, LinkIcon } from "lucide-react";
import { saveNangoConnectionAction } from "@/app/campaigns/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";

export const metadata: Metadata = { title: "Setup: Connections" };
import { getNangoSettings, getNangoSettingsEnvManaged, getNangoStatus } from "@/lib/nango-system";
import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";

// Flash outcomes surface via the shell-bypass setup layout's <SearchParamToast>
// (codes-only). The former inline ?error/?saved <Alert>s duplicated that wizard
// toast and are retired here.
export default async function SetupNangoPage() {
  const nangoStatus = getNangoStatus();

  if (nangoStatus.status === "connected") {
    const steps = await getSetupWizardSteps();
    const next = getFirstIncompleteStep(steps);
    redirect(next?.href ?? "/");
  }

  const settings = getNangoSettings();
  // Which fields are supplied by an operator env override (host-resolved from
  // the connector's manifest, cinatra-ai/cinatra#982) — replaces the direct
  // `process.env.NANGO_*` reads so core hardcodes no connector env-var names.
  const envManaged = getNangoSettingsEnvManaged();

  return (
    <section className="rounded-card border border-line bg-surface-strong p-6 shadow-sm">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Connections</h2>
        <p className="mt-3 max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
          Cinatra uses Nango to store and manage external API credentials and OAuth connections. Configure the connection to your Nango instance.
        </p>
      </div>

      <form action={saveNangoConnectionAction} className="mt-6 grid gap-4">
        <Input type="hidden" name="redirectTo" value="/setup" />
        <FieldGroup>
          <Field>
            <FieldLabel>Secret key</FieldLabel>
            <Input
              name="secretKey"
              type="password"
              defaultValue={envManaged.secretKey ? "" : (settings.secretKey ?? "")}
              required={!envManaged.secretKey && !settings.secretKey}
            />
            {envManaged.secretKey || settings.secretKey ? (
              <span className="text-xs font-normal text-muted-foreground">Leave blank to keep the current saved key.</span>
            ) : null}
          </Field>
          <Field>
            <FieldLabel>Server URL</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <LinkIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                name="serverUrl"
                type="url"
                defaultValue={envManaged.serverUrl ? "" : (settings.serverUrl ?? "")}
                placeholder="https://api.nango.dev"
              />
            </InputGroup>
            <span className="text-xs font-normal text-muted-foreground">
              Leave blank to use the default hosted service. Set this only if you run your own Nango instance.
            </span>
          </Field>
        </FieldGroup>
        <div className="flex justify-end">
          <Button type="submit">
            Continue
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </form>
    </section>
  );
}
