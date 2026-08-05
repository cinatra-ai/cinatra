import "server-only";
/**
 * §II Library mode — the acting user's artifacts (cinatra#1431, spec
 * design@4c6799db §II). Lists EXACTLY the claimed/faceted set resolved for the
 * acting user: `listArtifacts` applies the object-store ownership filter +
 * canonical `object.read` per row (per-actor) and enriches every row through
 * the landed effective-identity service (claims × bindings × classic × install
 * status). Non-artifact internals never appear here — those live only in Raw
 * objects (§IV).
 *
 * Each row is the identity line (renderer glyph · artifact name · claimed-by
 * chip) over a muted meta line (owner / visibility · relative updated), the
 * last row dropping its divider. The activation barrier (§III) shows a muted
 * "Preparing" label wherever selection would sit while a claim's binding has
 * not yet landed; Open always renders the row read-only.
 */
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Braces } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { AvailableScopes } from "@/components/access-scope";
import {
  readOrgsWithTeamsForUserActiveOnly,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import {
  isDefaultScopeSelection,
  parseScopeFilterParam,
  scopeSelectionMatchesAny,
  type ScopeToken,
} from "@/lib/scope-filter";
import { artifactScopeEntries } from "@/lib/artifacts/artifact-scope-entries";
import {
  listArtifacts,
  type ArtifactSummary,
} from "@/lib/artifacts/artifact-service";
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import { isSelectionPreparing } from "@/app/artifacts/[id]/renderer-dispatch";
import { isDashboardArtifactType } from "@/lib/dashboards/dashboard-artifact-surface";
import type { DashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-surface";
import { resolveLibraryDashboardPointers } from "@/lib/dashboards/dashboard-artifact-pointer-resolvers";
import { LibraryToolbar } from "./library-toolbar";
import { isFileMime, LibraryRowGlyph } from "./library-row-glyph";
import { DashboardLibraryRow } from "./dashboard-library-row";
import {
  LibraryUploadButton,
  LibraryUploadDropZone,
  LibraryUploadProvider,
} from "./library-upload";

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

const DEFAULT_ARTIFACT_FACET = "__default__";

/** Prettify an extension package id into a display name:
 * `@cinatra-ai/prospect-lists:list` → "Prospect Lists". */
export function extensionDisplayName(extension: string): string {
  const afterScope = extension.includes("/")
    ? extension.slice(extension.indexOf("/") + 1)
    : extension;
  const base = afterScope.split(":")[0] ?? afterScope;
  return base
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// The renderer glyph (§III) is resolved by `LibraryRowGlyph` through the
// artifact-UI dispatch spine: a claimed row resolves its winner's registered
// `listRow` capability (S7/M2, cinatra#1631); the file-vs-structured floor
// split stays host-side in that seam. The former host-side per-extension-family
// icon map is deleted.

function ownerLabel(level: ArtifactSummary["ownerLevel"]): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Claim resolution for the facet + chip: an extension identity resolves to
 * its package; the floor / plain object resolves to the default-artifact
 * facet. */
function facetKeyOf(id: EffectiveIdentity): string {
  return id.kind === "extension" ? id.extension : DEFAULT_ARTIFACT_FACET;
}

// ---------------------------------------------------------------------------
// Library mode (server component)
// ---------------------------------------------------------------------------

/** A resolved, faceted, searched library entry: a normal artifact row, or a
 *  §VIII dashboard row that survived the Phase-1 dual authorization. */
type VisibleLibraryItem =
  | { readonly kind: "artifact"; readonly summary: ArtifactSummary }
  | {
      readonly kind: "dashboard";
      readonly summary: ArtifactSummary;
      readonly pointer: DashboardArtifactPointer;
    };

export async function LibraryMode({
  orgId,
  actor,
  userId,
  query,
  facet,
  scopeParam,
}: {
  orgId: string | null;
  actor: ActorContext;
  /** The acting user's id (session-resolved by the page). */
  userId: string | null;
  query?: string;
  facet?: string;
  /** The raw `?scope=` search param (parsed by the canonical parser here). */
  scopeParam?: string | string[];
}) {
  // Scope filter (cinatra#2449) — the SAME wiring as /connectors and /skills:
  // build the actor's accessible scopes (orgs they belong to, projects they
  // can read) for the shared picker, gate org/team/project tokens to those
  // memberships, and parse `?scope=` through the ONE canonical multi-scope
  // parser (invalid / inaccessible tokens drop; an empty or workspace-
  // containing selection collapses to the default, broadest view). Artifacts
  // carry no admin-only tier, so the "admin" token is not offered and a stale
  // `?scope=admin` collapses to the default.
  const orgs = userId ? await readOrgsWithTeamsForUserActiveOnly(userId) : [];
  const projects = userId && orgId ? await readProjectsForUser(userId, orgId) : [];
  const scopes: AvailableScopes = {
    orgs: orgs.map((org) => ({
      id: org.id,
      name: org.name,
      teams: org.teams.map((t) => ({ id: t.id, name: t.name })),
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    canGrantWorkspace: true,
  };
  const accessibleScopeTokens = new Set<string>(["personal", "workspace"]);
  for (const org of orgs) {
    accessibleScopeTokens.add(`org:${org.id}`);
    for (const team of org.teams) accessibleScopeTokens.add(`team:${team.id}`);
  }
  for (const project of projects) accessibleScopeTokens.add(`project:${project.id}`);
  const effectiveScopeTokens = parseScopeFilterParam(
    scopeParam,
    accessibleScopeTokens,
  );

  let all: ArtifactSummary[];
  try {
    all = listArtifacts({ orgId, actor, limit: 200 });
  } catch {
    return (
      <LibraryToolbarShell
        query={query}
        facet={[]}
        selectedFacet={facet}
        scopeValue={effectiveScopeTokens}
        scopes={scopes}
      >
        <LibraryErrorState />
      </LibraryToolbarShell>
    );
  }

  // §VIII — resolve the pointer for every dashboard-typed row, applying the
  // Phase-1 DUAL AUTHORIZATION (object.read, already applied by `listArtifacts`,
  // PLUS the dashboard resolver's owner+project gate) + the liveness gate. A
  // dashboard row survives ONLY when its pointer is present; the resolution fails
  // CLOSED (empty map) so a dashboard is never rendered un-gated.
  const dashboardIds = all
    .filter((a) => isDashboardArtifactType(a.objectType))
    .map((a) => a.artifactId);
  const dashboardPointers = await resolveLibraryDashboardPointers(
    orgId,
    dashboardIds,
  );

  // Facet options: every distinct claiming extension present + a default-
  // artifact bucket when any floor/plain row is present. Derived from the
  // dual-auth-GATED set (all rows MINUS dashboard rows the §VIII gate denied),
  // so a list-but-not-read dashboard never discloses its "Dashboards" facet —
  // the dual-authorization drop is complete, not row-only. Filtered off `all`
  // (before the active-facet/search filter) so the facet selector still offers
  // every readable facet regardless of the current selection.
  const facetSource = all.filter(
    (a) =>
      !isDashboardArtifactType(a.objectType) ||
      dashboardPointers.has(a.artifactId),
  );
  const facetOptions = buildFacetOptions(facetSource);

  const q = (query ?? "").trim().toLowerCase();
  const facetActive = Boolean(facet && facet !== "__all__");
  const scopeActive = !isDefaultScopeSelection(effectiveScopeTokens);

  const visible: VisibleLibraryItem[] = [];
  for (const a of all) {
    if (facet && facet !== "__all__" && facetKeyOf(a.presentationIdentity) !== facet) {
      continue;
    }
    // Scope OR-filter (cinatra#2449): the default (broadest) selection shows
    // every visible row; otherwise a row survives when ANY of its scope
    // entries (owner locus + optional project binding) OR-matches the
    // selection — the same predicate lift as the connectors card filter.
    if (
      scopeActive &&
      !artifactScopeEntries(a).some((entry) =>
        scopeSelectionMatchesAny(effectiveScopeTokens, entry),
      )
    ) {
      continue;
    }
    if (isDashboardArtifactType(a.objectType)) {
      // Dual-auth denied / not-live / templated ⇒ absent from the map ⇒ dropped.
      const pointer = dashboardPointers.get(a.artifactId);
      if (!pointer) continue;
      // A dashboard row searches on its DISPLAY name (the twin's objects.data
      // carries only identity/scope, so `summary.title` is null here).
      if (q && !pointer.name.toLowerCase().includes(q)) continue;
      visible.push({ kind: "dashboard", summary: a, pointer });
      continue;
    }
    if (q) {
      const name = (a.title ?? a.artifactId).toLowerCase();
      if (!name.includes(q)) continue;
    }
    visible.push({ kind: "artifact", summary: a });
  }

  return (
    <LibraryToolbarShell
      query={query}
      facet={facetOptions}
      selectedFacet={facet}
      scopeValue={effectiveScopeTokens}
      scopes={scopes}
    >
      {visible.length === 0 ? (
        <LibraryEmptyState filtered={Boolean(q) || facetActive || scopeActive} />
      ) : (
        <ul
          className="overflow-hidden rounded-lg border border-line bg-surface-strong"
          data-testid="artifacts-library-list"
          data-conformance-id="artifacts-library-list"
        >
          {visible.map((item, i) =>
            item.kind === "dashboard" ? (
              <DashboardLibraryRow
                key={item.summary.artifactId}
                pointer={item.pointer}
                isLast={i === visible.length - 1}
              />
            ) : (
              <LibraryRow
                key={item.summary.artifactId}
                summary={item.summary}
                isLast={i === visible.length - 1}
              />
            ),
          )}
        </ul>
      )}
    </LibraryToolbarShell>
  );
}

function buildFacetOptions(
  items: readonly ArtifactSummary[],
): Array<{ value: string; label: string }> {
  const exts = new Set<string>();
  let hasDefault = false;
  for (const a of items) {
    const id = a.presentationIdentity;
    if (id.kind === "extension") exts.add(id.extension);
    else hasDefault = true;
  }
  const opts = Array.from(exts)
    .sort()
    .map((e) => ({ value: e, label: extensionDisplayName(e) }));
  if (hasDefault) {
    opts.push({ value: DEFAULT_ARTIFACT_FACET, label: "Default artifact" });
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function LibraryRow({
  summary,
  isLast,
}: {
  summary: ArtifactSummary;
  isLast: boolean;
}) {
  const id = summary.presentationIdentity;
  const name = summary.title ?? summary.artifactId;
  const preparing = isSelectionPreparing(id);
  const rel = summary.updatedAt
    ? formatDistanceToNow(new Date(summary.updatedAt), { addSuffix: true })
    : "recently";

  return (
    <li
      data-field="name=identity.displayName"
      data-state="kind:artifact"
      className={
        "flex items-center gap-3.5 px-3.5 py-3" +
        (isLast ? "" : " border-b border-line")
      }
    >
      <LibraryRowGlyph summary={summary} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            {name}
          </span>
          <ClaimChip identity={id} />
          {isFileMime(summary.mime) ? (
            <span className="rounded-full border border-line bg-surface-muted px-2 py-0.5 font-mono text-badge-xs tracking-tight text-foreground">
              {summary.mime}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {ownerLabel(summary.ownerLevel)} · {summary.visibility} · updated {rel}
        </p>
      </div>
      {preparing ? (
        <span
          className="flex-none rounded-md px-2 py-1 text-xs text-muted-foreground"
          data-testid="artifacts-activation-preparing"
          data-conformance-id="artifacts-activation-preparing"
          title="Preparing — pinning and context selection unlock once this artifact's binding lands."
        >
          Preparing
        </span>
      ) : null}
      <Button asChild variant="outline" size="sm" className="flex-none">
        <Link
          href={`/artifacts/${summary.artifactId}`}
          data-action="open-artifact -> rendered"
        >
          Open
        </Link>
      </Button>
    </li>
  );
}

function ClaimChip({ identity }: { identity: EffectiveIdentity }) {
  if (identity.kind === "extension") {
    return (
      <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
        {extensionDisplayName(identity.extension)}
      </span>
    );
  }
  // Floor + plain object both read as the default-artifact floor here.
  return (
    <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-xs font-semibold text-muted-foreground">
      Default artifact
    </span>
  );
}

// ---------------------------------------------------------------------------
// Toolbar + states
// ---------------------------------------------------------------------------

function LibraryToolbarShell({
  query,
  facet,
  selectedFacet,
  scopeValue,
  scopes,
  children,
}: {
  query?: string;
  facet: Array<{ value: string; label: string }>;
  selectedFacet?: string;
  scopeValue: ScopeToken[];
  scopes: AvailableScopes;
  children: React.ReactNode;
}) {
  return (
    <LibraryUploadProvider>
      <div className="flex flex-col gap-3.5">
        {/* Toolbar: search · facet · scope (§I, spec L311–319) with the §VI
            Upload control at the right edge — live filtering via the shared
            toolbar composition (LibraryToolbar), no Apply step. The whole
            list below is a drop target (LibraryUploadDropZone). */}
        <LibraryToolbar
          query={query}
          facetOptions={facet}
          selectedFacet={selectedFacet}
          scopeValue={scopeValue}
          scopes={scopes}
          uploadAction={<LibraryUploadButton />}
        />
        <LibraryUploadDropZone>{children}</LibraryUploadDropZone>
      </div>
    </LibraryUploadProvider>
  );
}

function LibraryEmptyState({ filtered }: { filtered: boolean }) {
  return (
    <Empty
      data-testid="artifacts-library-empty"
      data-conformance-id="artifacts-library-empty"
      data-state="empty"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Braces aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          {filtered ? "No artifacts match your filters" : "No artifacts yet"}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Try a different type or clear the search."
            : "Artifacts appear here as your agents produce work and as you upload files."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function LibraryErrorState() {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface-strong px-5 py-10 text-center"
      data-testid="artifacts-library-error"
      data-conformance-id="artifacts-library-error"
      data-state="error"
    >
      <div className="grid size-10 place-items-center rounded-lg bg-destructive/10 text-destructive">
        <AlertTriangle aria-hidden className="size-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">
        Couldn&apos;t load your artifacts
      </p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        The library source failed.{" "}
        <Link href="/artifacts" className="text-primary underline-offset-4 hover:underline">
          Retry
        </Link>
      </p>
    </div>
  );
}
