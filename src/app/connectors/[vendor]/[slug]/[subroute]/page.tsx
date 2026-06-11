import "server-only";

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getActorContext } from "@/lib/auth-session";
import {
  getConnectorRegistryEntryBySlug,
} from "@/lib/connectors-registry.server";
import {
  enforceConnectorPolicy,
} from "@/lib/connector-policy";
import { createExtensionHostContext } from "@/lib/extension-host-context";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";
import { chooseConnectorUiRender } from "@/lib/connector-ui-render";
import {
  resolveActiveInstallIdForActor,
  resolveRuntimeConnectorUiRecord,
} from "@/lib/extension-install-resolution";
import { requiresRebuildState } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";
import { InstallActivateCta } from "@/components/extensions/install-activate-cta";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

type RouteParams = {
  vendor: string;
  slug: string;
  subroute: string;
};

type DispatchPageProps = {
  params: Promise<RouteParams>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(props: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { vendor, slug } = await props.params;
  // The vendor segment is validated against the connector's manifest-resolved
  // identity (installed-extension scope), not a hardcoded vendor literal.
  const entry = getConnectorRegistryEntryBySlug(slug);
  if (!entry || entry.vendor !== vendor) {
    return { title: "Not found" };
  }
  return { title: `${entry.displayName} | Connectors` };
}

export default async function ConnectorDispatchPage(props: DispatchPageProps) {
  const [{ vendor, slug, subroute }, searchParams] = await Promise.all([
    props.params,
    props.searchParams ?? Promise.resolve({}),
  ]);

  // Resolve the connector by slug, then require the vendor segment to match
  // its manifest-resolved identity (installed-extension scope) — no hardcoded
  // vendor handling.
  const entry = getConnectorRegistryEntryBySlug(slug);
  if (!entry || entry.vendor !== vendor) {
    notFound();
  }
  if (subroute !== entry.setupSubroute) {
    notFound();
  }

  const actor = await getActorContext();
  const decision = enforceConnectorPolicy(entry.packageId, actor, "read");
  if (!decision.allowed) {
    notFound();
  }

  const manifest = STATIC_EXTENSION_MANIFEST[entry.packageId];

  // Prefer the RUNTIME (marketplace-installed) connector-UI record when one
  // exists: a schema-config connector installed at runtime declares its surface
  // as DATA in the on-disk package store, NOT in the base-image static manifest.
  // The resolver is fail-closed — it returns a record only for a TRUSTED, active
  // install for this actor (canonical store + trusted anchor); otherwise null,
  // and the static manifest is the bundled/base-image fallback.
  const runtimeUiRecord = await resolveRuntimeConnectorUiRecord(entry.packageId, actor);

  // Branch on the connector's declared UI surface. A `schema-config` connector
  // ships NO React — the host renders its declared `cinatra.configSchema` from
  // its single `sdk-ui` instance. Only this branch diverges from the legacy
  // base-image setup-page path; `bundled-react` / legacy connectors keep it.
  const render = chooseConnectorUiRender(runtimeUiRecord ?? manifest);

  if (render.kind === "schema-config") {
    // Resolve the addressable install id so named actions / status probes can
    // POST to /api/extensions/{installId}/actions/...; when the connector isn't
    // installed/active for the actor's workspace, show an explicit Install /
    // Activate CTA instead of letting action POSTs 404 opaquely.
    const installId = await resolveActiveInstallIdForActor(entry.packageId, actor);
    return (
      <Main className="min-h-screen">
        <PageHeader title={entry.displayName} description="Connector setup" />
        <PageContent className="flex flex-col gap-6 pb-8">
          {installId ? (
            <SchemaConfigConnectorForm
              installId={installId}
              packageName={entry.packageId}
              surface={render.surface}
            />
          ) : (
            <InstallActivateCta displayName={entry.displayName} />
          )}
        </PageContent>
      </Main>
    );
  }

  if (render.kind === "invalid-schema-config") {
    // Fail-closed: a connector that declares schema-config with a malformed
    // configSchema renders an error, NEVER the bundled-react importer.
    return (
      <Main className="min-h-screen">
        <PageHeader title={entry.displayName} description="Connector setup" />
        <PageContent className="flex flex-col gap-6 pb-8">
          <Alert variant="destructive">
            <AlertTitle>This connector&apos;s setup schema is invalid</AlertTitle>
            <AlertDescription>
              {entry.displayName} declares a schema-driven setup surface, but its
              configuration schema could not be validated. The connector must be
              fixed and republished before it can be configured.
            </AlertDescription>
          </Alert>
        </PageContent>
      </Main>
    );
  }

  // Legacy / bundled-react path: import + render the base-image React setup page.
  // Build a grant-aware host context from the extension's manifest. The setup
  // page consumes ctx.<port>.* instead of `@/lib/*` host modules directly. Only
  // ports the manifest lists in `requestedHostPorts` are wired; the rest are
  // fail-loud on access (least-privilege). Render-time only — server actions
  // cannot safely close over `ctx`.
  const loadSetupPage = entry.loadSetupPage;
  let mod: Awaited<ReturnType<NonNullable<typeof loadSetupPage>>>;
  try {
    if (!loadSetupPage) {
      // A `schema-config` connector has no React setup-page loader, but it should
      // never reach this branch (the render decision routes it to the
      // schema-config branch above). If a connector lands here without a loader,
      // surface the "requires rebuild" state rather than crashing.
      throw new Error("no setup-page loader");
    }
    mod = await loadSetupPage();
    if (isDegradedExtensionLoad(mod)) {
      // cinatra#7: a guardedOptional page loader RESOLVES the
      // standardized degraded result when its module is absent post-build —
      // route it into the same "requires rebuild" state as a thrown load.
      throw new Error(`setup-page module absent: ${mod.reason}`);
    }
  } catch {
    // No loadable React module means the connector's bundled-react setup page is
    // not in this base image — surface the "requires rebuild" state rather than
    // throwing an opaque placeholder error.
    const rebuild = requiresRebuildState(entry.packageId);
    return (
      <Main className="min-h-screen">
        <PageHeader title={entry.displayName} description="Connector setup" />
        <PageContent className="flex flex-col gap-6 pb-8">
          <Alert>
            <AlertTitle>This connector requires a rebuild</AlertTitle>
            <AlertDescription>{rebuild.message}</AlertDescription>
          </Alert>
        </PageContent>
      </Main>
    );
  }
  const SetupPage = mod.default;
  const ctx = createExtensionHostContext(
    entry.packageId,
    manifest?.requestedHostPorts ?? [],
  );
  return (
    <SetupPage
      packageId={entry.packageId}
      slug={entry.slug}
      searchParams={searchParams}
      ctx={ctx}
    />
  );
}
