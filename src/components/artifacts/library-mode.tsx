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
import {
  AlertTriangle,
  Boxes,
  Braces,
  FileText,
  List as ListIcon,
  Mail,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  listArtifacts,
  type ArtifactSummary,
} from "@/lib/artifacts/artifact-service";
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import { isSelectionPreparing } from "@/app/artifacts/[id]/renderer-dispatch";
import { LibraryFacetControl } from "./library-facet-control";

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

function isFileMime(mime: string): boolean {
  return Boolean(mime) && mime !== "application/octet-stream";
}

/** The renderer glyph reflects how the row opens (§III): a claimed typed row,
 * a file-form representation, or the generic fallback. */
function libraryGlyph(summary: ArtifactSummary): {
  Icon: typeof FileText;
  className: string;
} {
  const id = summary.effectiveIdentity;
  if (id.kind === "extension") {
    // Coarse icon by claiming extension family, tinted indigo.
    const ext = id.extension.toLowerCase();
    const Icon = ext.includes("list")
      ? ListIcon
      : ext.includes("mail") || ext.includes("outreach") || ext.includes("email")
        ? Mail
        : Boxes;
    return { Icon, className: "bg-primary/10 text-primary" };
  }
  if (isFileMime(summary.mime)) {
    return { Icon: FileText, className: "bg-warning/10 text-warning" };
  }
  return { Icon: Braces, className: "bg-surface-muted text-muted-foreground" };
}

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

export function LibraryMode({
  orgId,
  actor,
  query,
  facet,
}: {
  orgId: string | null;
  actor: ActorContext;
  query?: string;
  facet?: string;
}) {
  let all: ArtifactSummary[];
  try {
    all = listArtifacts({ orgId, actor, limit: 200 });
  } catch {
    return <LibraryToolbarShell query={query} facet={[]} selectedFacet={facet}>
      <LibraryErrorState />
    </LibraryToolbarShell>;
  }

  // Facet options: every distinct claiming extension present + a default-
  // artifact bucket when any floor/plain row is present.
  const facetOptions = buildFacetOptions(all);

  const q = (query ?? "").trim().toLowerCase();
  const filtered = all.filter((a) => {
    if (facet && facet !== "__all__" && facetKeyOf(a.effectiveIdentity) !== facet) {
      return false;
    }
    if (q) {
      const name = (a.title ?? a.artifactId).toLowerCase();
      if (!name.includes(q)) return false;
    }
    return true;
  });

  return (
    <LibraryToolbarShell query={query} facet={facetOptions} selectedFacet={facet}>
      {filtered.length === 0 ? (
        <LibraryEmptyState filtered={Boolean(q || (facet && facet !== "__all__"))} />
      ) : (
        <ul
          className="overflow-hidden rounded-lg border border-line bg-surface-strong"
          data-testid="artifacts-library-list"
          data-conformance-id="artifacts-library-list"
        >
          {filtered.map((a, i) => (
            <LibraryRow
              key={a.artifactId}
              summary={a}
              isLast={i === filtered.length - 1}
            />
          ))}
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
    const id = a.effectiveIdentity;
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
  const { Icon, className } = libraryGlyph(summary);
  const id = summary.effectiveIdentity;
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
      <span
        className={`grid size-[34px] flex-none place-items-center rounded-lg ${className}`}
      >
        <Icon aria-hidden className="size-[17px]" />
      </span>
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
  children,
}: {
  query?: string;
  facet: Array<{ value: string; label: string }>;
  selectedFacet?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      {/* Toolbar: search · facet · scope. GET form keeps mode = library
          (default), so submitting stays on this page. */}
      <form
        method="get"
        className="flex flex-wrap items-center gap-2 rounded-lg bg-toolbar p-2"
      >
        <label className="flex h-[34px] flex-1 items-center gap-2 rounded-md bg-surface-strong px-3">
          <Search aria-hidden className="size-4 flex-none text-muted-foreground" />
          <Input
            type="search"
            name="q"
            defaultValue={query ?? ""}
            placeholder="Search artifacts"
            className="h-full border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
          />
        </label>
        <LibraryFacetControl options={facet} selected={selectedFacet} />
        <span className="inline-flex h-[34px] items-center gap-1.5 rounded-md border border-line bg-surface-strong px-3 text-xs text-foreground">
          <span className="text-muted-foreground">Scope:</span> Workspace
        </span>
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
      </form>
      {children}
    </div>
  );
}

function LibraryEmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface-strong px-5 py-10 text-center"
      data-testid="artifacts-library-empty"
      data-conformance-id="artifacts-library-empty"
      data-state="empty"
    >
      <div className="grid size-10 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
        <Braces aria-hidden className="size-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">
        {filtered ? "No artifacts match your filters" : "No artifacts yet"}
      </p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        {filtered
          ? "Try a different type or clear the search."
          : "Artifacts appear here as your agents produce work and as you upload files."}
      </p>
    </div>
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
