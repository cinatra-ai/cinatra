import "server-only";

import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
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
// Server-reference bridge for the connector setup-page form actions
// (twenty-connector#39): SOME setup pages rendered by this route bind the
// host's "use server" connector-setup actions (published via the capability
// registry at boot) directly into `<form action={…}>` — today the
// mcp-server-connector bundled-react FALLBACK, plus any lock-pinned OLDER
// twenty-connector (the current twenty-connector binds connector-local
// "use server" actions instead, cinatra#1097). The boot (instrumentation)
// graph is compiled WITHOUT the "use server" reference transform, so the
// published instances carry no server-reference marker and RSC would reject
// them at form render. This import (side effect) reflects the compiler-minted
// reference metadata from THIS route's transformed compilation onto those
// published instances, and simultaneously anchors the "use server" module
// into this route's graph so the form POST-back resolves here. See the
// bridge module's header for the full layering story and its known
// replacement-hazard limit (cinatra#1097).
import "@/lib/connector-setup-action-references.server";
// Side-effect import: loads the host extension wiring so `ctx.ui` action
// registrations exist in THIS route's compilation before the SERVER-side
// hydration read below resolves the registry (same reason + pattern as the
// generic action dispatch route /api/extensions/[installId]/actions/[actionId]).
// Hydration still fail-closes to a blank form on a registry miss.
import "@/lib/extensions";
import { resolveExtensionUiAction } from "@/lib/extension-ui-registry";
import { resolveSchemaConfigInitialValues } from "@/lib/extension-config-hydration";
import {
  enforceConnectorPolicy,
} from "@/lib/connector-policy";
import { resolveConnectorSetupRedirect } from "@/lib/connector-setup-redirect";
import { createExtensionHostContext } from "@/lib/extension-host-context";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";
import { chooseConnectorUiRender } from "@/lib/connector-ui-render";
import {
  resolveActiveInstallForActor,
  resolveActiveInstallIdForActor,
  resolveRuntimeConnectorUiRecord,
  resolveRuntimeConnectorCardRecord,
} from "@/lib/extension-install-resolution";
import { resolveVersionKeyedUiAction } from "@/lib/extension-version-keyed-serving";
import {
  requiresRebuildState,
  filterSurfaceForLocalCliEligibility,
} from "@/lib/extension-schema-config";
import type { SchemaConfigSurface } from "@/lib/extension-schema-config";
import { localCliEligible } from "@/lib/runtime-mode";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";
import { ConnectorStatusProbeCard } from "@/components/extensions/connector-status-probe-card";
import { SearchParamToast, type SearchParamToastConfig } from "@/components/search-param-toast";
import { InstallActivateCta } from "@/components/extensions/install-activate-cta";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { ConnectorSetupPage } from "@cinatra-ai/sdk-ui/connector-setup-page";
import { ConnectorSetupColumns } from "@cinatra-ai/sdk-ui/connector-setup-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConnectionSharingSection } from "@/components/extensions/connection-sharing-section";

/**
 * The connector's declared `status-probe` action id, if any. Model-A lifts that
 * probe into the right-column status card (design §II), so the page reads the
 * SAME action id the inline row would have used ("connectionStatus" for the
 * key-based connectors) — the host never invents a probe id. Scans the flat
 * fields first, then tab panels; the first status-probe wins.
 */
function findStatusProbeActionId(surface: SchemaConfigSurface): string | undefined {
  const scan = (fields: SchemaConfigSurface["fields"]) => {
    for (const f of fields) {
      if (f.kind === "status-probe") return f.actionId;
    }
    return undefined;
  };
  return scan(surface.fields) ?? surface.tabs?.map((t) => scan(t.fields)).find(Boolean);
}

export const dynamic = "force-dynamic";

// Host-owned codes-only flash island for the schema-config setup surface. Host
// actions that redirect back to a connector's setup page carry a stable code —
// e.g. the external-MCP management actions (campaigns/actions.ts) redirect to
// the MCP-servers connector page with ?saved=1 / ?deleted=1, and the Twenty
// connect/disconnect actions with ?error=<code>. The schema-config surface reads
// no searchParams itself, so nothing rendered these outcomes before; this island
// maps each code to a STATIC message and toasts it.
const CONNECTOR_SETUP_FLASH_TOASTS: SearchParamToastConfig[] = [
  { param: "saved", value: "1", message: "Saved.", variant: "success" },
  { param: "deleted", value: "1", message: "Removed.", variant: "success" },
  { param: "error", value: "admin-only", message: "Only an administrator can change this connection.", variant: "error" },
  { param: "error", value: "connect-failed", message: "Could not connect. Check the details and try again.", variant: "error" },
];

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
      // cinatra#1529: before the 404, evaluate the NARROW marketplace-redirect
      // decision. Only a genuinely-absent install of a connector this actor can
      // already discover + install in the in-app marketplace redirects there;
      // every other state (unknown, not-discoverable, inactive/archived install,
      // withdrawn/incompatible, non-admin) fails closed to the 404. The resolver
      // wraps its own catalog/store IO and never throws, so `redirect()` (which
      // throws NEXT_REDIRECT) is called OUTSIDE any try/catch — otherwise this
      // route would convert the redirect back into a 404.
      const redirectDecision = await resolveConnectorSetupRedirect({
        packageName,
        subroute,
        actor,
      });
      if (redirectDecision.kind === "redirect") {
        redirect(redirectDecision.target);
      }
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

  // The connection-status signal. Per the owner ruling for
  // wordpress-assistant-connector#36 ask-6 and design/specs/app-connectors.html
  // §II, the connection-status BADGE no longer sits top-right of any setup page
  // ("the status badge that once sat top-right now lives in that card" — the
  // spec shows no top-right badge anywhere). `badgeState` survives only to SEED
  // the right-column Connection status card (Model-A schema-config path, and the
  // bundled-react host status card below): state + count come from the SAME
  // readiness probe that feeds the connector's `/connectors` card badge, so the
  // two stay identical. Resolution is fail-soft (a throwing/absent probe → "not
  // connected"); for a user-scoped connector the count comes from the actor's
  // own saved connections, so we thread the human user id through.
  const readinessUserId =
    actor?.principalType === "HumanUser" ? actor.principalId : null;
  const badgeState = await resolveConnectorBadgeState(packageId, {
    userId: readinessUserId,
  });

  // HOST-owned per-connection share surface (cinatra#953 W3): rendered on
  // EVERY branch of this route (schema-config, invalid-schema-config, the
  // rebuild states, and the bundled-react page) so the owner of a saved
  // connection always reaches the six-scope picker here. The section renders
  // NOTHING when the actor owns no connection for this connector or the
  // connector declares `only:"user"` (never shareable).
  const sharingSection = <ConnectionSharingSection packageId={packageId} />;

  if (render.kind === "schema-config") {
    // SERVER-SIDE local-CLI eligibility gate (cinatra#1926). A `devPreviewOnly`
    // select option — the connectors' dev/preview "Local CLI" connection mode —
    // is STRIPPED from the surface here, before it ever reaches the client form,
    // whenever this installation is not development-mode and not a preview
    // installation. Decided server-side through the single `localCliEligible`
    // helper (never a client-supplied value); an ineligible install never ships
    // the option's value/label to the browser ("absent from the rendered DOM",
    // not a client-side hide). Every downstream read (hydration, status probe,
    // tab presence) operates on this same gated surface.
    const surface = filterSurfaceForLocalCliEligibility(render.surface, localCliEligible());
    // Resolve the addressable install id so named actions / status probes can
    // POST to /api/extensions/{installId}/actions/...; when the connector isn't
    // installed/active for the actor's workspace, show an explicit Install /
    // Activate CTA instead of letting action POSTs 404 opaquely.
    // Resolve the addressable install WITH its version identity so a NON-DEFAULT
    // side-by-side install hydrates from ITS version's action, not the default's
    // (cinatra#1392 S9). `installId` downstream keeps its meaning (the
    // addressable id for action POST URLs); `isDefault`/`version` only steer the
    // server-side hydration serve below (no visual change).
    const activeInstall = await resolveActiveInstallForActor(packageId, actor);
    const installId = activeInstall?.id ?? null;
    // Model-A applies ONLY to a single-connection connector that declares a real
    // `status-probe` — a connection whose connected/disconnected state the right-
    // column status card can represent (the two key-based connectors openai +
    // anthropic, and any other schema-config connector that declares one). A
    // schema-config connector WITHOUT a status-probe (e.g. the record-list
    // mcp-server connector, which holds many servers and has no single connection
    // status / readiness probe) keeps the ORIGINAL single-column body: a single
    // "Connection status: Disconnected" card would MISREPRESENT such a surface
    // (gpt-5.5 convergence finding). So the presence of a declared probe is the
    // gate between the two layouts.
    // SERVER-invoked opt-in hydration (owner-ratified contract; cinatra#1082
    // item 3): when the connector declares a `hydrateAction`, invoke it here —
    // at render, never from the browser — and thread the sanitized NON-SECRET
    // saved values in as the form's initialValues. Fail-closed: no declaration
    // (today's every-connector state), no install, a missing/erroring/slow
    // action, or a malformed result all resolve `{}` — the pre-hydration blank
    // form, never an error page. `installId` is the actor-scoped addressable
    // install resolved above (proof of authorization for this render).
    const initialValues = await resolveSchemaConfigInitialValues(
      {
        surface,
        packageName: packageId,
        installId,
        isDefault: activeInstall?.isDefault,
        version: activeInstall?.version,
      },
      {
        resolveAction: resolveExtensionUiAction,
        // NON-DEFAULT installs hydrate from their version's action, fail-closed
        // to a blank form (never the default's action).
        resolveVersionedAction: (pkg, ver, act) => {
          const served = resolveVersionKeyedUiAction(pkg, ver, act);
          return served.kind === "serve" ? { handler: served.value.handler } : null;
        },
      },
    );
    const statusProbeActionId = findStatusProbeActionId(surface);
    // A tabbed surface's tab row is page-header chrome (design §II — "the page
    // header and tablist stay at the Wide column"): the form renders it as a
    // `TabsListRow` whose etched rule replaces the header's own, so the header
    // divider is suppressed EXACTLY when that tab row actually renders (the
    // form renders — installId present — AND the surface declares tabs). The
    // Install/Activate CTA state keeps the header rule.
    const hasTabs = !!surface.tabs && surface.tabs.length > 0;
    const headerDivider = !(installId && hasTabs);
    if (statusProbeActionId) {
      // Model-A chrome (design/specs/app-connectors.html §II, "One connection"):
      // the connection-status badge that once sat top-right of the header now
      // lives in the right-column status card, so `ConnectorSetupPage` carries NO
      // header actions. The declared status-probe is lifted into that card (its
      // Check runs the connector's own `connectionStatus` action), and the form
      // column suppresses the inline probe row so the same probe never renders
      // twice. Per the owner's ruling (epic #1101, 2026-07-10) the key-based
      // connectors ALSO get the canonical indigo-plug Connect / red-unplug
      // Disconnect pair: the form renders it from the connector's own
      // `role`-tagged named actions (saveConnection→connect, clearConnection→
      // disconnect), seeded with the connector's connected state so Disconnect is
      // disabled until connected (design §II items 7/8/15/16). `initialConnected`
      // is the SAME `resolveConnectorBadgeState` seed the status card reads.
      //
      // The status card + sharing section are passed INTO the form as the
      // `aside` / `setupFooter` slots: the form owns the §II content layout so
      // a tabbed surface can hoist its tablist ABOVE the two-column grid
      // (tablist = header chrome, never inside the content column) and keep
      // the sharing section on the SETUP surface only.
      return (
        <ConnectorSetupPage
          title={displayName}
          description="Connector setup"
          divider={headerDivider}
          className="flex flex-col gap-6 pb-8"
        >
          {installId ? (
            <SchemaConfigConnectorForm
              installId={installId}
              packageName={packageId}
              surface={surface}
              isAdmin={isAdmin}
              initialValues={initialValues}
              omitFieldKinds={["status-probe"]}
              initialConnected={badgeState.connected}
              aside={
                <ConnectorStatusProbeCard
                  installId={installId}
                  actionId={statusProbeActionId}
                  initialConnected={badgeState.connected}
                  connectedLabel={badgeState.connectedLabel}
                />
              }
              setupFooter={sharingSection}
            />
          ) : (
            <>
              <InstallActivateCta displayName={displayName} />
              {sharingSection}
            </>
          )}
        </ConnectorSetupPage>
      );
    }
    // Probe-less schema-config connector: single-column body (no status card to
    // lift), the SAME §II Wide shell as every other setup page — "the page holds
    // to the Wide column and never spans full width". Per the owner ruling for
    // wordpress-assistant-connector#36 ask-6 (design/specs/app-connectors.html §II
    // shows no top-right badge anywhere), the header carries NO status badge.
    // Model-A (right-column status card) applies only to the status-probe shape;
    // a probe-less connector would be MISREPRESENTED by a single "Disconnected"
    // card (gpt-5.5 convergence finding). A tabbed probe-less surface still gets
    // the hoisted tablist treatment via the form.
    return (
      <ConnectorSetupPage
        title={displayName}
        description="Connector setup"
        divider={headerDivider}
        className="flex flex-col gap-6 pb-8"
      >
        <Suspense fallback={null}>
          <SearchParamToast toasts={CONNECTOR_SETUP_FLASH_TOASTS} />
        </Suspense>
        {installId ? (
          <SchemaConfigConnectorForm
            installId={installId}
            packageName={packageId}
            surface={surface}
            isAdmin={isAdmin}
            initialValues={initialValues}
            setupFooter={sharingSection}
          />
        ) : (
          <>
            <InstallActivateCta displayName={displayName} />
            {sharingSection}
          </>
        )}
      </ConnectorSetupPage>
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
          {sharingSection}
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
        />
        <PageContent className="flex flex-col gap-6 pb-8">
          <Alert>
            <AlertTitle>This connector requires a rebuild</AlertTitle>
            <AlertDescription>{rebuild.message}</AlertDescription>
          </Alert>
          {sharingSection}
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
        />
        <PageContent className="flex flex-col gap-6 pb-8">
          <Alert>
            <AlertTitle>This connector requires a rebuild</AlertTitle>
            <AlertDescription>{rebuild.message}</AlertDescription>
          </Alert>
          {sharingSection}
        </PageContent>
      </Main>
    );
  }
  const SetupPage = mod.default;
  // cinatra#982: thread the manifest-declared env-override input so a setup page
  // reading ctx.settings/ctx.secrets sees the SAME env-first-else-DB precedence
  // real activation does (keeps the render path from diverging from activation).
  const ctx = createExtensionHostContext(packageId, manifest?.requestedHostPorts ?? [], {
    envOverrides: manifest?.envOverrides,
    resolution: manifest?.resolution,
  });
  // The bundled-react setup page renders its OWN chrome (its own
  // PageHeader / `<main>`). Per the owner ruling (wordpress-assistant-connector#36
  // ask-6) and design/specs/app-connectors.html §II, the top-right connection
  // badge that once floated over this chrome is GONE from every setup page — the
  // spec shows no top-right badge anywhere. Removing that overlay is the
  // spec-conformant fix for ALL bundled-react connectors.
  const setupPage = (
    <SetupPage
      packageId={packageId}
      slug={catalogEntry.slug}
      searchParams={searchParams}
      ctx={ctx}
    />
  );

  // Half two of ask-6: the right-column host-owned "Connection status" card must
  // render on wp-assistant's Setup tab. A bundled-react extension self-chromes
  // its whole page (its own <ConnectorSetupPage> header + Tabs), so — unlike the
  // schema-config Model-A path — the host cannot inject the card INTO the
  // extension's Setup TabsContent; the SetupPage component exposes no slot. The
  // spec-EXACT placement (card in the Setup tab's right column, beneath a
  // full-width header) needs a coordinated SDK slot the frozen extension would
  // consume; that is a follow-up. Until then the host wraps the whole page in the
  // shared two-column grid so the card renders in the right column beside the
  // (default) Setup tab, seeded from the SAME readiness signal the /connectors
  // grid badge reads. This is GATED to wordpress-assistant-connector — the only
  // connector the ruling covers — so the other bundled-react setup pages
  // (github / gmail / google-calendar / twenty / … , several mid-rebuild) are
  // untouched by this compromise. TEMPORARY / flagged for owner review.
  const wantsHostStatusCard =
    catalogEntry.slug === "wordpress-assistant-connector";
  if (wantsHostStatusCard) {
    const installId = await resolveActiveInstallIdForActor(packageId, actor);
    return (
      <div className="relative">
        <ConnectorSetupColumns
          conformanceId="connector-setup"
          fields={setupPage}
          aside={
            installId ? (
              <ConnectorStatusProbeCard
                installId={installId}
                initialConnected={badgeState.connected}
                connectedLabel={badgeState.connectedLabel}
              />
            ) : null
          }
        />
        {sharingSection}
      </div>
    );
  }

  return (
    <div className="relative">
      {setupPage}
      {sharingSection}
    </div>
  );
}
