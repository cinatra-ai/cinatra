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

  // cinatra#2501 — the server URL is supplied by an operator env override, so
  // whatever it points at is what this instance talks to and the field below is
  // decorative. That is ALL this predicate means: it says nothing about whether
  // the target is local or hosted (an env var can point at either), so the copy
  // it drives only ever talks about env-management.
  const serverUrlEnvManaged = envManaged.serverUrl;
  // A key is already on file (env override or a previous save), so the field is
  // a rotate-or-keep, not a first-time entry.
  const hasSavedSecretKey = envManaged.secretKey || Boolean(settings.secretKey);

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
              required={!hasSavedSecretKey}
            />
            {/*
              cinatra#2501 — the field STAYS required with no key on file, and
              the help text now says where the key comes from.

              Making it optional would be the worse bug: a saved non-empty
              secret key is the ONLY thing that flips this step to connected, so
              an empty submit would loop the operator back here forever with no
              explanation. And a PLACEHOLDER is just as bad in the other
              direction — `FLAG_AUTH_ENABLED=false` on the bundled nango-server
              turns off its DASHBOARD auth, NOT its API secret-key auth (see the
              note in scripts/ci/works-after/nango.sh), so a dummy value would
              complete the wizard while every Nango API call 401s. The local
              server seeds a REAL key for its `dev` environment; the operator
              needs that one, and now the step says how to get it.
            */}
            {hasSavedSecretKey ? (
              <span className="text-xs font-normal text-muted-foreground">Leave blank to keep the current saved key.</span>
            ) : (
              <span className="text-xs font-normal text-muted-foreground">
                From your Nango dashboard: Environment Settings → Secret Key. Running the bundled
                local Nango? Read its seeded key with{" "}
                <code className="rounded bg-surface px-1 py-0.5 font-mono">
                  docker compose exec -T nango-db psql -U nango -d nango -tAc &quot;SELECT secret_key
                  FROM _nango_environments WHERE name=&#39;dev&#39; LIMIT 1;&quot;
                </code>
                . A made-up value is not accepted — the local server still checks the API key.
              </span>
            )}
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
            {/*
              cinatra#2501 — the old copy ("Leave blank to use the default
              hosted service") told an env-managed instance the exact opposite
              of what happens: the env value wins host-side, so blank keeps the
              CONFIGURED server, which on a local install is the bundled Nango.
            */}
            {serverUrlEnvManaged ? (
              <span className="text-xs font-normal text-muted-foreground">
                Set by this instance&apos;s environment (NANGO_SERVER_URL) — leave blank to keep it.
                That value decides which Nango is used, hosted or your own.
              </span>
            ) : (
              <span className="text-xs font-normal text-muted-foreground">
                Leave blank to use the default hosted service. Set this only if you run your own Nango instance.
              </span>
            )}
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
