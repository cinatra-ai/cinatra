import "server-only";

import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

import type {
  ApprovalEnvelope,
  ApprovalSource,
  ApprovalViewer,
  Direction,
  FetchOpts,
} from "./sources/types";

// ---------------------------------------------------------------------------
// Safe per-source section loader.
//
// Suspense isolates LATENCY, not errors: an async Server Component throw is NOT
// caught by a sibling Suspense boundary, so a naive per-source Suspense would
// let one source's failure blank the whole page. This loader try/catches the
// fetch and renders an inline error envelope on an unexpected failure, so one
// source failing shows an inline section error and never blocks its siblings.
//
// It re-throws Next control-flow signals (redirect() / notFound()) untouched —
// those are identified by their `digest` marker — so a source that legitimately
// redirects still works.
// ---------------------------------------------------------------------------

function isNextControlFlowError(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string") return false;
  return (
    digest.startsWith("NEXT_REDIRECT") ||
    digest === "NEXT_NOT_FOUND" ||
    digest.startsWith("NEXT_HTTP_ERROR_FALLBACK")
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "This section could not be loaded.";
}

export function SourceSkeleton({ title }: { title: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      <Card className="border-line bg-surface">
        <CardContent className="p-4">
          <div className="h-10 animate-pulse rounded-md bg-muted/50" aria-hidden />
        </CardContent>
      </Card>
    </section>
  );
}

export async function SourceSection({
  source,
  viewer,
  direction,
  opts,
}: {
  source: ApprovalSource;
  viewer: ApprovalViewer;
  direction: Direction;
  opts?: FetchOpts;
}) {
  let envelope: ApprovalEnvelope;
  try {
    envelope =
      direction === "inbox"
        ? await source.fetchInbox(viewer, opts)
        : await source.fetchMine(viewer, opts);
  } catch (err) {
    if (isNextControlFlowError(err)) throw err; // never swallow framework control flow
    envelope = {
      availability: "error",
      rows: [],
      actions: [],
      error: { message: errorMessage(err), retryable: true },
    };
  }

  const viewAllHref = source.viewAllHref?.(direction);

  const header = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium text-foreground">{source.title}</h2>
      {viewAllHref ? (
        <Link href={viewAllHref} className="text-xs text-muted-foreground underline hover:text-foreground">
          View all
        </Link>
      ) : null}
    </div>
  );

  let body: React.ReactNode;
  if (envelope.availability === "error") {
    body = (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="flex flex-col items-center gap-2 p-6 text-center">
          <p className="text-sm text-destructive">
            {envelope.error?.message ?? "This section could not be loaded."}
          </p>
          <Link
            href={`/configuration/approvals?direction=${direction}`}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Try again
          </Link>
        </CardContent>
      </Card>
    );
  } else if (envelope.rows.length === 0) {
    body = (
      <Empty className="border-line">
        <EmptyHeader>
          <EmptyTitle>
            {direction === "inbox" ? "Nothing awaiting your decision" : "No requests here"}
          </EmptyTitle>
          <EmptyDescription>
            {direction === "inbox"
              ? `New ${source.title.toLowerCase()} appear here when they need a decision.`
              : `Requests you submit to ${source.title.toLowerCase()} appear here.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardContent className="p-0">
          {envelope.rows.map((row, i) => (
            <div key={row.id} className={i < envelope.rows.length - 1 ? "border-b border-line" : ""}>
              {source.rowRenderer(row, { direction })}
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <section id={source.id} className="flex scroll-mt-24 flex-col gap-2">
      {header}
      {body}
    </section>
  );
}
