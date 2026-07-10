/**
 * Admin moderator queue for commercial-tier vendor applications.
 *
 * Gated by cinatra-side `requireAdminSession()` first; the marketplace MCP
 * then enforces the WP cap `CAP_VENDOR_APPROVE` on
 * `vendor_application_list_admin` / `vendor_application_approve` /
 * `vendor_application_reject`. If the marketplace admin token is missing or
 * lacks the cap, the list call fails — surfaced via the ResultBanner.
 *
 * Free-tier applications NEVER appear here (they auto-approve inline on
 * apply); the queue is exclusively commercial-tier review.
 *
 * Status filter via ?status=<applied|approved|rejected|cancelled|reset|stuck>;
 * default is `applied` (the moderator's primary queue). `stuck` is a
 * pseudo-filter the marketplace resolves to rows whose recovery saga is
 * terminally stuck (repair_stuck_at set). Pagination via the opaque
 * `next_cursor` returned by the list call.
 */

import { Suspense } from "react";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SearchParamToast, type SearchParamToastConfig } from "@/components/search-param-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

import { requireAdminSession } from "@/lib/auth-session";
import { resolveMarketplaceAdminToken } from "@/lib/marketplace-credentials";
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type {
  MarketplaceVendorApplicationAdminRow,
  MarketplaceVendorApplicationListAdminInput,
} from "@cinatra-ai/marketplace-mcp-client";

import {
  ApproveButton,
  RejectButton,
  ViewDetailSheet,
} from "./admin-action-buttons";
import { VendorApplicationsStatusFilter } from "./status-filter";

type StatusFilterValue = NonNullable<
  MarketplaceVendorApplicationListAdminInput["status"]
>[number];

/** The concrete reservation statuses a row can carry (excludes the `stuck`
 *  pseudo-filter, which is a cross-cutting attribute, not a row status). */
type RowStatus = MarketplaceVendorApplicationAdminRow["status"];

const STATUS_VALUES: StatusFilterValue[] = [
  "applied",
  "approved",
  "rejected",
  "cancelled",
  "reset",
  "stuck",
];

const STATUS_PILL_MAP: Record<RowStatus, StatusPillStatus> = {
  applied: "needs-review",
  approved: "approved",
  rejected: "declined",
  cancelled: "archived",
  reset: "idle",
};

const PAGE_LIMIT = 50;

function parseStatusFilter(raw: string | undefined): StatusFilterValue {
  if (raw && (STATUS_VALUES as string[]).includes(raw)) {
    return raw as StatusFilterValue;
  }
  return "applied";
}

async function loadApplications(
  filter: StatusFilterValue,
  cursor: string | undefined,
): Promise<{
  rows: MarketplaceVendorApplicationAdminRow[];
  nextCursor: string | null;
  fetchError: string | null;
}> {
  let token: string;
  try {
    token = resolveMarketplaceAdminToken();
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : "Marketplace admin token is not configured.";
    return { rows: [], nextCursor: null, fetchError: msg };
  }
  try {
    const client = createHttpMarketplaceMcpClient({ token });
    const out = await client.vendorApplicationListAdmin({
      status: [filter],
      limit: PAGE_LIMIT,
      cursor,
    });
    return { rows: out.rows, nextCursor: out.next_cursor, fetchError: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load applications.";
    return { rows: [], nextCursor: null, fetchError: msg };
  }
}

// Codes-only flash island: the approve/reject actions redirect with `?ok=<op>`
// / `?error=<code>`; both map to STATIC messages here (the raw MCP error is
// logged server-side, never reflected into a toast). A content-LOAD failure is
// NOT a flash — it stays inline (see fetchError below).
const VENDOR_APP_FLASH_TOASTS: SearchParamToastConfig[] = [
  { param: "ok", value: "approve", message: "Vendor application approved.", variant: "success" },
  { param: "ok", value: "reject", message: "Vendor application rejected.", variant: "success" },
  { param: "error", value: "missing-id", message: "Missing application id.", variant: "error" },
  { param: "error", value: "token-missing", message: "Marketplace admin token is not configured.", variant: "error" },
  { param: "error", value: "reason-required", message: "A reject reason is required.", variant: "error" },
  { param: "error", value: "reason-too-long", message: "The reject reason is too long.", variant: "error" },
  { param: "error", value: "approve-failed", message: "Could not approve the application. See server logs for details.", variant: "error" },
  { param: "error", value: "reject-failed", message: "Could not reject the application. See server logs for details.", variant: "error" },
];

export const dynamic = "force-dynamic";

export default async function VendorApplicationsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    cursor?: string;
  }>;
}) {
  await requireAdminSession();
  const params = await searchParams;
  const filter = parseStatusFilter(params.status);
  const cursor = params.cursor && params.cursor.trim() !== "" ? params.cursor : undefined;
  const { rows, nextCursor, fetchError } = await loadApplications(filter, cursor);

  const nextHref = nextCursor
    ? `?status=${encodeURIComponent(filter)}&cursor=${encodeURIComponent(nextCursor)}`
    : null;
  // Previous-page navigation is best-served by going back to the
  // unparameterised filter root (cursor-based pagination is forward-only).
  const previousHref = cursor ? `?status=${encodeURIComponent(filter)}` : null;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Vendor applications"
        description="Moderate commercial-tier vendor applications. Free-tier applications auto-approve inline and never appear here."
        actions={<VendorApplicationsStatusFilter current={filter} />}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Suspense fallback={null}>
          <SearchParamToast toasts={VENDOR_APP_FLASH_TOASTS} />
        </Suspense>
        {fetchError ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load applications</AlertTitle>
            <AlertDescription className="break-words">{fetchError}</AlertDescription>
          </Alert>
        ) : null}

        {fetchError ? null : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No {filter} applications</EmptyTitle>
              <EmptyDescription>
                Nothing here for the moment. Switch the filter to see other
                states.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild variant="outline">
                <Link href="?status=approved">View approved</Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="soft-panel">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Display name</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Applied at</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.application_id}>
                    <TableCell className="text-sm">{row.display_name}</TableCell>
                    <TableCell className="font-mono text-sm">{row.scope}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.tier}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(row.applied_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill status={STATUS_PILL_MAP[row.status]}>
                          {row.status}
                        </StatusPill>
                        {row.repair_stuck_at ? (
                          <Badge variant="destructive">
                            {row.recovery_attempts > 0
                              ? `Repair stuck · ${row.recovery_attempts} attempts`
                              : "Repair stuck"}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <ViewDetailSheet application={row} />
                        {row.status === "applied" ? (
                          <>
                            <ApproveButton
                              applicationId={row.application_id}
                              scope={row.scope}
                              returnStatus={filter}
                            />
                            <RejectButton
                              applicationId={row.application_id}
                              scope={row.scope}
                              returnStatus={filter}
                            />
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {previousHref || nextHref ? (
          <div className="flex items-center justify-between gap-2">
            {previousHref ? (
              <Button asChild variant="outline" size="sm">
                <Link href={previousHref}>Previous</Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Previous
              </Button>
            )}
            {nextHref ? (
              <Button asChild variant="outline" size="sm">
                <Link href={nextHref}>Next</Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next
              </Button>
            )}
          </div>
        ) : null}
      </PageContent>
    </Main>
  );
}
