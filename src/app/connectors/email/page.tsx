import "server-only";
import type { Metadata } from "next";
import Link from "next/link";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ProviderSelect } from "./provider-select";
import { requireAdminSession } from "@/lib/auth-session";
import {
  EMAIL_PURPOSES,
  getEmailRouting,
  listEmailProvidersWithStatus,
} from "@/lib/email-system";

import { setEmailRoutingAction } from "./actions";

export const metadata: Metadata = { title: "Email | Cinatra" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
function pick(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function EmailConnectorsPage(props: { searchParams?: Promise<SearchParams> }) {
  await requireAdminSession();
  const sp = (await (props.searchParams ?? Promise.resolve({}))) as SearchParams;
  const saved = pick(sp.saved) === "1";
  const error = pick(sp.error);

  const providers = await listEmailProvidersWithStatus();
  const routing = getEmailRouting();

  const STATUS_LABEL: Record<string, string> = {
    connected: "Connected",
    incomplete: "Incomplete",
    not_connected: "Not connected",
  };

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Email"
        description="Choose which provider sends each kind of email. Providers must be connected before they can be assigned."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {saved ? (
          <Alert variant="success" className="rounded-control">
            <AlertDescription>Email routing saved.</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" className="rounded-control">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {/* Per-purpose provider assignment */}
        <section className="soft-panel rounded-panel p-5">
          <p className="text-base font-semibold text-foreground">Routing</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Assign a connected provider to each email purpose.
          </p>

          <div className="mt-4 flex flex-col gap-5">
            {EMAIL_PURPOSES.map((purpose) => {
              const current = routing[purpose.id] ?? "";
              const requiresSystemEmail =
                "requiresSystemEmail" in purpose && purpose.requiresSystemEmail === true;
              const eligibleProviders = providers.filter(
                (p) =>
                  p.status === "connected" && (!requiresSystemEmail || p.supportsSystemEmail),
              );
              return (
                <form
                  key={purpose.id}
                  action={setEmailRoutingAction}
                  className="grid items-end gap-3 border-t border-line pt-4 sm:grid-cols-[1fr_auto]"
                >
                  <Input type="hidden" name="purpose" value={purpose.id} />
                  <div>
                    <p className="text-sm font-semibold text-foreground">{purpose.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{purpose.description}</p>
                    <Field className="mt-3">
                      <FieldLabel>Provider</FieldLabel>
                      <ProviderSelect
                        name="connectorId"
                        defaultValue={current}
                        placeholder={
                          eligibleProviders.length === 1
                            ? `Auto (${eligibleProviders[0].name})`
                            : "Not assigned"
                        }
                        options={eligibleProviders.map((p) => ({
                          value: p.connectorId,
                          label: p.name,
                        }))}
                      />
                      {eligibleProviders.length === 0 ? (
                        <span className="mt-1 text-xs font-normal text-muted-foreground">
                          No eligible provider is connected yet. Configure one below.
                        </span>
                      ) : null}
                    </Field>
                  </div>
                  <Button type="submit">Save</Button>
                </form>
              );
            })}
          </div>
        </section>

        {/* Provider inventory + status */}
        <section className="soft-panel rounded-panel p-5">
          <p className="text-base font-semibold text-foreground">Providers</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Providers not successfully connected are shown as deactivated. Configure each on its own
            page.
          </p>
          <ul className="mt-4 flex flex-col gap-3">
            {providers.map((p) => {
              const connected = p.status === "connected";
              return (
                <li
                  key={p.connectorId}
                  className="flex items-center justify-between gap-4 border-t border-line pt-3"
                >
                  <div className={connected ? "" : "opacity-60"}>
                    <p className="text-sm font-semibold text-foreground">
                      {p.name}{" "}
                      <span
                        className={
                          connected
                            ? "text-xs font-normal text-success"
                            : "text-xs font-normal text-muted-foreground"
                        }
                      >
                        {STATUS_LABEL[p.status] ?? p.status}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.detail ?? p.description}
                    </p>
                  </div>
                  <Link
                    href={p.settingsHref}
                    className="shrink-0 text-sm font-medium text-foreground underline hover:text-foreground/80"
                  >
                    Configure
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      </PageContent>
    </Main>
  );
}
