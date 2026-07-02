import "server-only";

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getActorContext } from "@/lib/auth-session";
import {
  getConnectorRegistryEntryBySlug,
  resolveConnectorBadgeState,
} from "@/lib/connectors-registry.server";
// Importing the built-in readiness probes (side effect) registers a probe per
// bundled connector, so the host-injected setup-page badge reads the SAME live
// connection signal the /connectors card grid does.
import "@/lib/connector-readiness.server";
import { ConnectorBadge } from "@cinatra-ai/connectors/connector-badge";
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
  resolveRuntimeConnectorCardRecord,
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

  const actor = await getActorContext();

  // Resolve the connector by slug, then require the vendor segment to match
  // its manifest-resolved identity (installed-extension scope) — no hardcoded
  // vendor handling. A connector with a build-time CATALOG descriptor takes the
  // catalog path; a purely RUNTIME-installed connector with NO catalog descriptor
  // takes the runtime-only fallback (cinatra#658 Track 2 — closing the L62 gap
  // where `getConnectorRegistryEntryBySlug` returned undefined and the route
  // notFound()'d before any runtime lookup).
  const catalogEntry = getConnectorRegistryEntryBySlug(slug);

  // Resolved connector identity for this route, from EITHER source.
  let packageId: string;
  let displayName: string;
  let isCatalog: boolean;

  if (catalogEntry) {
    if (catalogEntry.vendor !== vendor) notFound();
    if (subroute !== catalogEntry.setupSubroute) notFound();
    // Catalog policy gate (unchanged): canonical-first → legacy fallback.
    const decision = enforceConnectorPolicy(catalogEntry.packageId, actor, "read");
    if (!decision.allowed) notFound();
    packageId = catalogEntry.packageId;
    displayName = catalogEntry.displayName;
    isCatalog = true;
  } else {
    // RUNTIME-ONLY fallback. `enforceConnectorPolicy` denies a no-catalog package
    // (`unknown_connector`) BEFORE any canonical check (codex finding 1), so we
    // CANNOT reach the runtime surface through it. Instead, resolve the trusted
    // runtime card record: it runs the FULL trust gate (actor has an active
    // canonical install in scope → anchor → integrity → signature → trust). A
    // non-null result is therefore BOTH proof of trust AND of actor authorization
    // for this install (the canonical install row is addressable in the actor's
    // scope) — the exact two facts the catalog policy + bundled manifest provide.
    // We never loosen the catalog policy; this is a parallel trusted-runtime path.
    const packageName = `@${vendor}/${slug}`;
    const cardRecord = await resolveRuntimeConnectorCardRecord(packageName, actor);
    // Fail closed: no trusted+addressable runtime install → not found (never leak
    // existence to an unauthorized/cross-org actor).
    if (!cardRecord || cardRecord.vendor !== vendor || cardRecord.slug !== slug) {
      notFound();
    }
    // A runtime-only connector reaches its setup route only via the schema-config
    // surface (it ships no base-image React loader). Reuse the catalog setup
    // subroute convention ("setup").
    if (subroute !== "setup") notFound();
    packageId = packageName;
    displayName = cardRecord.displayName;
    isCatalog = false;
  }

  const manifest = isCatalog ? STATIC_EXTENSION_MANIFEST[packageId] : undefined;

  // Prefer the RUNTIME (marketplace-installed) connector-UI record when one
  // exists: a schema-config connector installed at runtime declares its surface
  // as DATA in the on-disk package store, NOT in the base-image static manifest.
  // The resolver is fail-closed — it returns a record only for a TRUSTED, active
  // install for this actor (canonical store + trusted anchor); otherwise null,
  // and the static manifest is the bundled/base-image fallback. For a runtime-only
  // connector there IS no static manifest entry, so the runtime record is the
  // only source (and the trust gate already passed via the card record above).
  const runtimeUiRecord = await resolveRuntimeConnectorUiRecord(packageId, actor);

  // Branch on the connector's declared UI surface. A `schema-config` connector
  // ships NO React — the host renders its declared `cinatra.configSchema` from
  // its single `sdk-ui` instance. Only this branch diverges from the legacy
  // base-image setup-page path; `bundled-react` / legacy connectors keep it.
  const render = chooseConnectorUiRender(runtimeUiRecord ?? manifest);
  // Host-evaluated admin flag for the schema-config renderer's `select.adminOnly`
  // option gating (UX scoping only; the host write handler re-rejects an
  // admin-only value from a non-admin).
  const isAdmin = actor?.platformRole === "platform_admin";

  // The HOST injects the connection-status badge top-right on EVERY
  // setup page — never the extension. State + count come from the SAME readiness
  // probe that feeds the connector's `/connectors` card badge, so the two stay
  // identical. Resolution is fail-soft (a throwing/absent probe → "not
  // connected"); for a user-scoped connector the count comes from the actor's
  // own saved connections, so we thread the human user id through.
  const readinessUserId =
    actor?.principalType === "HumanUser" ? actor.principalId : null;
  const badgeState = await resolveConnectorBadgeState(packageId, {
    userId: readinessUserId,
  });
  const statusBadge = (
    <ConnectorBadge
      connected={badgeState.connected}
      label={badgeState.connectedLabel}
    />
  );

  if (render.kind === "schema-config") {
    // Resolve the addressable install id so named actions / status probes can
    // POST to /api/extensions/{installId}/actions/...; when the connector isn't
    // installed/active for the actor's workspace, show an explicit Install /
    // Activate CTA instead of letting action POSTs 404 opaquely.
    const installId = await resolveActiveInstallIdForActor(packageId, actor);
    return (
      <Main className="min-h-screen">
        <PageHeader
          title={displayName}
          description="Connector setup"
          actions={statusBadge}
        />
        <PageContent className="flex flex-col gap-6 pb-8">
          {installId ? (
            <SchemaConfigConnectorForm
              installId={installId}
              packageName={packageId}
              surface={render.surface}
              isAdmin={isAdmin}
            />
          ) : (
            <InstallActivateCta displayName={displayName} />
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
        <PageHeader
          title={displayName}
          description="Connector setup"
          actions={statusBadge}
        />
        <PageContent className="flex flex-col gap-6 pb-8">
          <Alert variant="destructive">
            <AlertTitle>This connector&apos;s setup schema is invalid</AlertTitle>
            <AlertDescription>
              {displayName} declares a schema-driven setup surface, but its
              configuration schema could not be validated. The connector must be
              fixed and republished before it can be configured.
            </AlertDescription>
          </Alert>
        </PageContent>
      </Main>
    );
  }

  // From here on, only a CATALOG connector with a bundled-react setup page can
  // proceed. A runtime-only connector ships no base-image React loader, so it can
  // only ever be schema-config / invalid above — if it falls through to here,
  // surface the "requires rebuild" state rather than crash.
  if (!catalogEntry) {
    const rebuild = requiresRebuildState(packageId);
    return (
      <Main className="min-h-screen">
        <PageHeader
          title={displayName}
          description="Connector setup"
          actions={statusBadge}
        />
        <PageContent className="flex flex-col gap-6 pb-8">
          <Alert>
            <AlertTitle>This connector requires a rebuild</AlertTitle>
            <AlertDescription>{rebuild.message}</AlertDescription>
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
  const loadSetupPage = catalogEntry.loadSetupPage;
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
    const rebuild = requiresRebuildState(packageId);
    return (
      <Main className="min-h-screen">
        <PageHeader
          title={displayName}
          description="Connector setup"
          actions={statusBadge}
        />
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
    packageId,
    manifest?.requestedHostPorts ?? [],
  );
  // The bundled-react setup page renders its OWN chrome (its own
  // PageHeader / `<main>`), so the host cannot inject into its actions slot the
  // way the schema-config branches do. Instead the host floats the SAME
  // `<ConnectorBadge>` top-right of the page, OVER the extension's chrome, via a
  // positioned overlay. The overlay is `pointer-events-none` so it never steals
  // a click from the extension's own header controls during the connector-repo
  // cleanup window (the extension's own status indicator is removed per repo —
  // openai-connector is the exemplar). The badge itself stays read-only.
  return (
    <div className="relative">
      <div className="pointer-events-none absolute right-4 top-6 z-10 sm:right-8 lg:right-6">
        {statusBadge}
      </div>
      <SetupPage
        packageId={packageId}
        slug={catalogEntry.slug}
        searchParams={searchParams}
        ctx={ctx}
      />
    </div>
  );
}
