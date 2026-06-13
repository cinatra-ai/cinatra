import type { Metadata } from "next";
import { AlertTriangle } from "lucide-react";

import {
  requireAuthSession,
  resolveOrgRoleForSession,
  isPlatformAdmin,
} from "@/lib/auth-session";
import {
  validateAuthorizeParams,
  issueConsentCsrfToken,
  CONNECT_CODE_CHALLENGE_METHOD,
  CONNECT_SCOPE,
} from "@/lib/connect-provisioning";
import { emitConnectAudit } from "@/lib/connect-audit";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { approveConnectAction, denyConnectAction } from "./actions";

export const metadata: Metadata = { title: "Connect with Cinatra" };
export const dynamic = "force-dynamic";

const CLIENT_LABELS: Record<string, string> = {
  wordpress: "WordPress",
  drupal: "Drupal",
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function UnauthorizedState({ message }: { message: string }) {
  return (
    <Main className="min-h-screen">
      <PageHeader title="Connect with Cinatra" />
      <PageContent>
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Cannot complete the connection</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{message}</p>
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

export default async function ConnectAuthorizePage({ searchParams }: Props) {
  // Session is REQUIRED — this page is gated by the normal auth-route-guard
  // (it is NOT in PUBLIC_PATH_PREFIXES). If the cookie is absent the middleware
  // already 302'd to /sign-in before this renders.
  const session = await requireAuthSession();

  const sp = await searchParams;
  const validation = validateAuthorizeParams({
    client: first(sp.client),
    redirect_uri: first(sp.redirect_uri),
    widget_origin: first(sp.widget_origin),
    state: first(sp.state),
    scope: first(sp.scope),
    code_challenge: first(sp.code_challenge),
    code_challenge_method: first(sp.code_challenge_method),
  });

  if (!validation.ok) {
    return (
      <UnauthorizedState
        message="This connection request is invalid or malformed. Return to your site's settings and click Connect again."
      />
    );
  }
  const params = validation.params;

  // Org-admin gate: org_owner | org_admin | platform_admin. No code is issued
  // for anyone else.
  const orgRole = await resolveOrgRoleForSession(session);
  const authorized =
    orgRole === "org_owner" || orgRole === "org_admin" || isPlatformAdmin(session);
  if (!authorized) {
    return (
      <UnauthorizedState
        message="Only an organization owner or admin can connect a site to this Cinatra instance. Ask an admin to complete the connection."
      />
    );
  }

  const sessionId = String(session.session?.id ?? "");
  const consentCsrf = issueConsentCsrfToken({ sessionId, requestId: params.requestId });
  const clientLabel = CLIENT_LABELS[params.client] ?? params.client;

  emitConnectAudit("authorize_viewed", {
    actor: String(session.user.id),
    orgId: session.session?.activeOrganizationId ?? null,
    client: params.client,
    redirectUri: params.redirectUri,
    widgetOrigin: params.widgetOrigin,
    callbackOrigin: params.callbackOrigin,
  });

  return (
    <Main className="min-h-screen">
      <PageHeader title="Connect with Cinatra" />
      <PageContent>
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Connect {clientLabel} to this Cinatra instance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                <p>
                  Only approve if you just clicked Connect on your own site.
                  Approving sends this site a credential for this Cinatra
                  instance.
                </p>
              </div>
            </div>

            <dl className="space-y-2 text-sm">
              <div className="flex flex-col">
                <dt className="text-muted-foreground">Site (CMS) origin</dt>
                <dd className="break-all font-mono">{params.callbackOrigin}</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-muted-foreground">Widget origin</dt>
                <dd className="break-all font-mono">{params.widgetOrigin}</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-muted-foreground">Platform</dt>
                <dd>{clientLabel}</dd>
              </div>
            </dl>

            <div className="flex gap-3">
              {/* Approve and Deny are both POST server actions. The hidden
                  fields carry the EXACT validated parameter set so the POST
                  cannot smuggle different params than were shown; the consent
                  CSRF token is bound to (sessionId, requestId) and is verified
                  server-side. */}
              <form action={approveConnectAction}>
                <HiddenParams
                  params={params}
                  consentCsrf={consentCsrf}
                />
                <Button type="submit">Approve</Button>
              </form>
              <form action={denyConnectAction}>
                <HiddenParams params={params} consentCsrf={consentCsrf} />
                <Button type="submit" variant="outline">
                  Deny
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}

function HiddenParams({
  params,
  consentCsrf,
}: {
  params: {
    client: string;
    redirectUri: string;
    widgetOrigin: string;
    state: string;
    scope: string;
    codeChallenge: string;
  };
  consentCsrf: string;
}) {
  return (
    <>
      <input type="hidden" name="client" value={params.client} />
      <input type="hidden" name="redirect_uri" value={params.redirectUri} />
      <input type="hidden" name="widget_origin" value={params.widgetOrigin} />
      <input type="hidden" name="state" value={params.state} />
      <input type="hidden" name="scope" value={params.scope || CONNECT_SCOPE} />
      <input type="hidden" name="code_challenge" value={params.codeChallenge} />
      <input
        type="hidden"
        name="code_challenge_method"
        value={CONNECT_CODE_CHALLENGE_METHOD}
      />
      <input type="hidden" name="consent_csrf" value={consentCsrf} />
    </>
  );
}
