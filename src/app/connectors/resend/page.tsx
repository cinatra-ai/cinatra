import "server-only";
import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { requireAdminSession } from "@/lib/auth-session";
// The connector's server module resolves through the generated extension
// manifest — this mount names no connector package. Resend ships no React
// setup/settings page (its surface is this host mount), so the module's
// config/status exports are the data contract consumed here.
import { requireConnectorModule } from "@/lib/connector-modules.server";
import type { ResendConnectorModule } from "./resend-connector-module";

import { saveResendConfigAction, sendResendTestEmailAction } from "./actions";

export const metadata: Metadata = { title: "Resend | Cinatra" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
function pick(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ResendConnectorPage(props: { searchParams?: Promise<SearchParams> }) {
  await requireAdminSession();
  const sp = (await (props.searchParams ?? Promise.resolve({}))) as SearchParams;
  const saved = pick(sp.saved) === "1";
  const notice = pick(sp.notice);
  const error = pick(sp.error);

  const { getResendConfig, getResendStatus } =
    await requireConnectorModule<ResendConnectorModule>("resend-connector");
  const config = getResendConfig();
  const status = getResendStatus();
  const statusBadge =
    status.status === "connected"
      ? "Connected"
      : status.status === "incomplete"
        ? "Incomplete"
        : "Not connected";

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Resend"
        description="Send platform & transactional email (password reset, verification, change-email) through Resend."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {saved ? (
          <Alert variant="success" className="rounded-control">
            <AlertDescription>Resend settings saved.</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert variant="success" className="rounded-control">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" className="rounded-control">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <section className="soft-panel rounded-panel p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-base font-semibold text-foreground">Resend API</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Status: {statusBadge}
                {status.detail ? ` — ${status.detail}` : ""}
              </p>
            </div>
          </div>

          <form action={saveResendConfigAction} className="mt-5 grid items-start gap-4 border-t border-line pt-5 sm:grid-cols-2">
            <Field>
              <FieldLabel>Sender (From) address</FieldLabel>
              <Input
                name="fromEmail"
                type="email"
                defaultValue={config.fromEmail}
                placeholder="no-reply@mail.cinatra.ai"
              />
              <span className="text-xs font-normal text-muted-foreground">
                Use a dedicated sending subdomain verified in Resend (e.g. mail.cinatra.ai),
                not the apex cinatra.ai — that keeps transactional-mail reputation isolated
                from your Google Workspace mail.
              </span>
            </Field>
            <Field>
              <FieldLabel>Sender display name</FieldLabel>
              <Input name="fromName" defaultValue={config.fromName} placeholder="Cinatra" />
            </Field>
            <Field>
              <FieldLabel>Reply-To (optional)</FieldLabel>
              <Input name="replyTo" type="email" defaultValue={config.replyTo} placeholder="support@cinatra.ai" />
            </Field>
            <Field>
              <FieldLabel>Enabled</FieldLabel>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" name="enabled" defaultChecked={config.enabled} />
                Use Resend for assigned email purposes
              </label>
            </Field>

            <Field className="sm:col-span-2">
              <FieldLabel>API key</FieldLabel>
              <Input
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder={
                  config.hasApiKeyOverride
                    ? "•••••••• (stored in-app — paste a new key to replace)"
                    : "Uses RESEND_API_KEY from the instance environment"
                }
              />
              <span className="text-xs font-normal text-muted-foreground">
                Leave blank to keep the current source. The in-app key is encrypted at rest
                (AES-256-GCM) and takes precedence over the environment variable.
              </span>
              {config.hasApiKeyOverride ? (
                <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" name="clearApiKey" />
                  Remove the in-app key and fall back to RESEND_API_KEY
                </label>
              ) : null}
            </Field>

            <div className="sm:col-span-2 flex justify-end">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </section>

        <section className="soft-panel rounded-panel p-5">
          <p className="text-base font-semibold text-foreground">Send a test email</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Sends a test message via Resend to your own address. Verifies the API key and sender
            domain end-to-end.
          </p>
          <form action={sendResendTestEmailAction} className="mt-4">
            <Button type="submit" variant="secondary">
              Send test to me
            </Button>
          </form>
        </section>
      </PageContent>
    </Main>
  );
}
