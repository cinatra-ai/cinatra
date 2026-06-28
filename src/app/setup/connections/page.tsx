// Deeplink: Initial setup Connections step (Nango under the hood); navigated to from setup orchestration, not from app chrome.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowRight, LinkIcon } from "lucide-react";
import { saveNangoConnectionAction } from "@/app/campaigns/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldGroup, Field, FieldLabel } from "@/components/ui/field";

export const metadata: Metadata = { title: "Setup: Connections" };
import { getNangoSettings, getNangoStatus } from "@/lib/nango-system";
import { getSetupWizardSteps, getFirstIncompleteStep } from "@/lib/setup-wizard";

type SetupNangoPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function pickSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SetupNangoPage({ searchParams }: SetupNangoPageProps) {
  const nangoStatus = getNangoStatus();

  if (nangoStatus.status === "connected") {
    const steps = await getSetupWizardSteps();
    const next = getFirstIncompleteStep(steps);
    redirect(next?.href ?? "/");
  }

  const resolvedSearchParams = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const settings = getNangoSettings();
  const errorMessage = pickSearchParam(resolvedSearchParams.error);
  const saved = pickSearchParam(resolvedSearchParams.saved) === "1";

  return (
    <section className="rounded-card border border-line bg-surface-strong p-6 shadow-sm">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Connections</h2>
        <p className="mt-3 max-w-[64ch] text-sm leading-[1.55] text-pretty text-muted-foreground">
          Cinatra uses Nango to store and manage external API credentials and OAuth connections. Configure the connection to your Nango instance.
        </p>
      </div>

      {errorMessage ? (
        <Alert variant="destructive" className="mt-5 rounded-control">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {saved ? (
        <Alert variant="success" className="mt-5 rounded-control">
          <AlertDescription>Nango administration were saved.</AlertDescription>
        </Alert>
      ) : null}

      <form action={saveNangoConnectionAction} className="mt-6 grid gap-4">
        <Input type="hidden" name="redirectTo" value="/setup" />
        <FieldGroup>
          <Field>
            <FieldLabel>Secret key</FieldLabel>
            <Input
              name="secretKey"
              type="password"
              defaultValue={process.env.NANGO_SECRET_KEY ? "" : (settings.secretKey ?? "")}
              required={!process.env.NANGO_SECRET_KEY && !settings.secretKey}
            />
            {process.env.NANGO_SECRET_KEY || settings.secretKey ? (
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
                defaultValue={process.env.NANGO_SERVER_URL ? "" : (settings.serverUrl ?? "")}
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
