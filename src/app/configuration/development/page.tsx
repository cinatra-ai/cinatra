import type { Metadata } from "next";
import { getEmailSystemDevelopmentSettings } from "@/lib/email-system";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { MailIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { SettingsTabNav } from "@/components/settings-tab-nav";
import { SaveEmailSafetyForm } from "./save-development-form";
import { TunnelTabContent } from "./tunnel-tab";
import { ExtensionsTabContent } from "./extensions-tab";

export const metadata: Metadata = { title: "Development" };

// `tunnel` is kept as the query-param value for backward-compat with bookmarks
// and outbound links into this tab. The label reflects what the tab actually
// configures today.
const TABS = [
  { value: "email", label: "Email" },
  { value: "tunnel", label: "Tunnel" },
  { value: "extensions", label: "Extensions" },
];

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SettingsDevelopmentPage({ searchParams }: Props) {
  const resolved = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const requestedTab = (Array.isArray(resolved.tab) ? resolved.tab[0] : resolved.tab) ?? "email";
  const tab = TABS.some((item) => item.value === requestedTab) ? requestedTab : "email";

  const isDevMode = process.env.CINATRA_RUNTIME_MODE === "development";

  return (
    <Main className="min-h-screen">
      <PageHeader title="Development" description="Runtime mode, email safety, and public base URL for this workspace." divider={false} />
      <PageContent className="flex flex-col gap-6 pb-8">
        <SettingsTabNav tabs={TABS} activeTab={tab} />

        {tab === "email" && <EmailTabContent isDevMode={isDevMode} />}

        {tab === "tunnel" && <TunnelTabContent isDevMode={isDevMode} />}

        {tab === "extensions" && <ExtensionsTabContent isDevMode={isDevMode} />}
      </PageContent>
    </Main>
  );
}

function EmailTabContent({ isDevMode }: { isDevMode: boolean }) {
  const emailSystemDevelopment = getEmailSystemDevelopmentSettings();

  return (
    <div className="flex flex-col gap-4">
      {!isDevMode && (
        <div className="rounded-control border border-line bg-surface-muted p-4 text-sm leading-6 text-muted-foreground">
          Email safety administration are only used in development mode. In production, outgoing campaign emails are
          delivered to their stored recipient addresses without any override. The form below is read-only.
        </div>
      )}
      <Card className="max-w-3xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Email safety</CardTitle>
          <CardDescription className="leading-6">
            In development mode, outgoing campaign and test emails are redirected to one override address instead
            of the stored contact addresses.
          </CardDescription>
        </CardHeader>
        <SaveEmailSafetyForm>
          <CardContent className="pb-4">
            <FieldGroup>
              <Field orientation="horizontal">
                <Checkbox
                  id="developmentModeEnabled"
                  name="developmentModeEnabled"
                  defaultChecked={emailSystemDevelopment.developmentModeEnabled}
                  disabled={!isDevMode}
                />
                <FieldContent>
                  <FieldLabel htmlFor="developmentModeEnabled">Override recipient email</FieldLabel>
                  <FieldDescription>Redirect all development email delivery to the address below.</FieldDescription>
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel htmlFor="overrideRecipientEmail">Recipient override</FieldLabel>
                <InputGroup className="max-w-sm">
                  <InputGroupAddon>
                    <MailIcon aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="overrideRecipientEmail"
                    name="overrideRecipientEmail"
                    type="email"
                    defaultValue={emailSystemDevelopment.overrideRecipientEmail}
                    placeholder="you@example.com"
                    disabled={!isDevMode}
                  />
                </InputGroup>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              disabled={!isDevMode}
              title={!isDevMode ? "Email safety administration are only available in development mode" : undefined}
            >
              Save email safety administration
            </Button>
          </CardFooter>
        </SaveEmailSafetyForm>
      </Card>
    </div>
  );
}
