import "server-only";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import { StatusPill } from "@/components/ui/status-pill";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileText, Rows, Sparkles } from "lucide-react";
import { requireAdminSession } from "@/lib/auth-session";
import { objectTypeRegistry } from "../registry";
import {
  readAllDynamicObjectTypes,
  type DynamicObjectTypeRecord,
} from "../auto-registrar";
import {
  approveDynamicObjectTypeAction,
  archiveDynamicObjectTypeAction,
} from "./object-type-actions";

/**
 * Object Type Registry admin screen.
 *
 * Two sections:
 *   1. Package types (static, read-only) — from objectTypeRegistry.list()
 *   2. Dynamic types (DB-backed, admin-actionable) — from readAllDynamicObjectTypes()
 */
export async function ObjectTypesScreen() {
  await requireAdminSession();
  const staticTypes = objectTypeRegistry.list();
  const dynamicTypes = await readAllDynamicObjectTypes();
  const proposedCount = dynamicTypes.filter((t) => t.status === "proposed").length;

  // Sort: proposed (oldest first) → active (alpha) → archived (alpha)
  const sortedDynamic = [...dynamicTypes].sort((a, b) => {
    const order = { proposed: 0, active: 1, archived: 2 } as const;
    const av = order[a.status as keyof typeof order] ?? 3;
    const bv = order[b.status as keyof typeof order] ?? 3;
    if (av !== bv) return av - bv;
    if (a.status === "proposed") {
      return a.createdAt.getTime() - b.createdAt.getTime();
    }
    return a.type.localeCompare(b.type);
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Administration"
        title="Data types"
        description="Static (package-defined) and dynamic (DB-backed) type registry. Approve or archive proposed types from the classifier."
        actions={proposedCount > 0 ? <ProposedCountBadge count={proposedCount} /> : undefined}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <StaticTypesSection types={staticTypes} />
        <DynamicTypesSection types={sortedDynamic} />
      </PageContent>
    </Main>
  );
}

// ---------------------------------------------------------------------------
// PageHeader actions: amber proposed-count badge

function ProposedCountBadge({ count }: { count: number }) {
  return (
    <Badge variant="outline" className="font-mono text-xs">
      {count} proposed
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Section 1: static (package) types

type StaticTypeDef = ReturnType<typeof objectTypeRegistry.list>[number];

function StaticTypesSection({ types }: { types: readonly StaticTypeDef[] }) {
  return (
    <section className="soft-panel rounded-card px-6 py-6">
      <h2 className="text-lg font-semibold text-foreground mb-1">Package types</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Registered in code by @cinatra/* packages at startup. Read-only.
      </p>
      {types.length === 0 ? (
        <div className="text-sm text-muted-foreground">No package types registered.</div>
      ) : (
        <TooltipProvider>
          <div className="divide-y divide-border">
            {types.map((def) => (
              <StaticTypeRow key={def.type} def={def} />
            ))}
          </div>
        </TooltipProvider>
      )}
    </section>
  );
}

function StaticTypeRow({ def }: { def: StaticTypeDef }) {
  // Source-package derivation: parse @scope/package:local-id → "scope/package".
  // Inline regex derived from OBJECT_TYPE_NAMESPACE_RE in packages/objects/src/namespace.ts.
  const nsMatch = def.type.match(/^@([\w-]+)\/([\w-]+):/);
  const sourcePackage = nsMatch ? `${nsMatch[1]}/${nsMatch[2]}` : "—";
  const detailRenderer = Boolean(def.renderers?.detail);
  const rowRenderer = Boolean(def.renderers?.listRow);

  return (
    <div className="flex h-12 items-center gap-4 px-2">
      <span className="font-mono text-xs text-foreground w-[260px] truncate">{def.type}</span>
      <span className="text-sm text-foreground flex-1 truncate">{def.type}</span>
      <Badge variant="secondary" className="font-mono text-xs">
        {def.category}
      </Badge>
      <span className="font-mono text-xs text-muted-foreground w-[180px] truncate">
        {sourcePackage}
      </span>
      <div className="flex items-center gap-2 w-[80px] shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <FileText
              className={
                detailRenderer
                  ? "h-4 w-4 text-foreground"
                  : "h-4 w-4 text-muted-foreground opacity-40"
              }
              aria-hidden
            />
          </TooltipTrigger>
          <TooltipContent>
            {detailRenderer ? "Detail renderer registered" : "No detail renderer"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Rows
              className={
                rowRenderer
                  ? "h-4 w-4 text-foreground"
                  : "h-4 w-4 text-muted-foreground opacity-40"
              }
              aria-hidden
            />
          </TooltipTrigger>
          <TooltipContent>
            {rowRenderer ? "Row renderer registered" : "No row renderer"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 2: dynamic (DB-backed) types

function DynamicTypesSection({ types }: { types: DynamicObjectTypeRecord[] }) {
  return (
    <section className="soft-panel rounded-card px-6 py-6">
      <h2 className="text-lg font-semibold text-foreground mb-1">Dynamic types</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Registered at runtime — from the LLM classifier, MCP callers, or agent install. Approve to mark as canonical in the registry; archive to hide from the default view.
      </p>
      {types.length === 0 ? (
        <DynamicTypesEmptyState />
      ) : (
        <div className="divide-y divide-border">
          {types.map((row) => (
            <DynamicTypeRow key={row.type} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function DynamicTypesEmptyState() {
  return (
    <div className="flex flex-col items-center text-center py-8 gap-3">
      <Sparkles className="h-12 w-12 text-muted-foreground" aria-hidden />
      <div className="text-base font-semibold text-foreground">No dynamic types yet.</div>
      <p className="text-sm text-muted-foreground max-w-md">
        Dynamic types appear when an agent saves an object the classifier can&apos;t categorize, when an MCP caller registers a type, or when an agent installs with declared output types.
      </p>
    </div>
  );
}

function DynamicTypeRow({ row }: { row: DynamicObjectTypeRecord }) {
  const showApprove = row.status === "proposed";
  const showArchive = row.status === "proposed" || row.status === "active";

  return (
    <div className="flex h-12 items-center gap-4 px-2">
      <span className="font-mono text-xs text-foreground w-[240px] truncate">{row.type}</span>
      <span className="text-sm text-foreground flex-1 truncate">{row.inferredName || "—"}</span>
      <Badge variant="secondary" className="font-mono text-xs">{row.inferredCategory}</Badge>
      {/* Provenance columns source, confidence, and createdAt are explicit and visible.
          They give the admin the context needed to decide approve/archive. */}
      <SourceBadge source={row.source} />
      <ConfidenceBadge confidence={row.confidence} />
      <StatusBadge status={row.status} />
      <CreatedAtCell createdAt={row.createdAt} />
      <OriginContextChips ctx={row.originContext} />
      <CanonicalKeysPills keys={row.canonicalKeys} />
      <div className="flex items-center gap-2 w-[180px] justify-end shrink-0">
        {showApprove && (
          <form action={approveDynamicObjectTypeAction.bind(null, row.type)}>
            <Button type="submit" size="sm">Approve</Button>
          </form>
        )}
        {showArchive && <ArchiveDialog typeId={row.type} />}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: string | null }) {
  if (source === "classifier") {
    return <Badge variant="outline" className="font-mono text-xs">classifier</Badge>;
  }
  if (source === "mcp") {
    return <Badge variant="outline" className="font-mono text-xs">mcp</Badge>;
  }
  if (source === "install") {
    return <Badge variant="secondary" className="font-mono text-xs">install</Badge>;
  }
  if (source === "admin") {
    return <Badge variant="secondary" className="font-mono text-xs">admin</Badge>;
  }
  return <Badge variant="secondary" className="font-mono text-xs">—</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "proposed") {
    return <StatusPill status="hold">proposed</StatusPill>;
  }
  if (status === "active") {
    return <LifecycleBadge status="active" />;
  }
  return <LifecycleBadge status="archived" />;
}

// Confidence is one of the provenance columns (source / confidence / createdAt)
// that admins use to decide approve-vs-archive.
// Categorical "high" / "low" / null.
function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (confidence === "high") {
    return <Badge variant="default" className="font-mono text-xs">high</Badge>;
  }
  if (confidence === "low") {
    return <Badge variant="outline" className="font-mono text-xs">low</Badge>;
  }
  // null/unknown — render an explicit em-dash so the column is never blank/ambiguous.
  return <Badge variant="secondary" className="font-mono text-xs">—</Badge>;
}

// CreatedAt is one of the provenance columns. Render the date in the user's
// locale; the full ISO timestamp goes into a title attribute for hover-on-text
// precision.
function CreatedAtCell({ createdAt }: { createdAt: Date }) {
  const iso = createdAt.toISOString();
  const display = createdAt.toLocaleDateString();
  return (
    <span className="text-xs text-muted-foreground w-[110px] truncate" title={iso}>
      {display}
    </span>
  );
}

function OriginContextChips({ ctx }: { ctx: Record<string, unknown> | null }) {
  if (!ctx || Object.keys(ctx).length === 0) {
    return <span className="text-xs text-muted-foreground w-[180px] truncate">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1 w-[260px]">
      {Object.entries(ctx).map(([k, v]) => (
        <Badge key={k} variant="secondary" className="font-mono text-xs">
          {k}={String(v)}
        </Badge>
      ))}
    </div>
  );
}

function CanonicalKeysPills({ keys }: { keys: string[] | null }) {
  if (!keys || keys.length === 0) {
    return <span className="text-xs text-muted-foreground w-[160px] truncate">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1 w-[220px]">
      {keys.map((k) => (
        <Badge key={k} variant="secondary" className="font-mono text-xs">
          {k}
        </Badge>
      ))}
    </div>
  );
}

function ArchiveDialog({ typeId }: { typeId: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
        >
          Archive
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Archive <span className="font-mono">{typeId}</span>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Archived types are hidden from the default registry view but remain in the database for audit history. The classifier may still propose this type again — re-archive if it does. Un-archive by editing the database directly.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={archiveDynamicObjectTypeAction.bind(null, typeId)}>
            <AlertDialogAction type="submit">Archive type</AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
