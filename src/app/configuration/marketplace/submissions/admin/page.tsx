/**
 * Admin moderator queue for ALL vendors' extension submissions.
 *
 * Gated by cinatra-side `requireAdminSession()` first; the marketplace MCP
 * then enforces the WP cap `CAP_VENDOR_APPROVE` on its admin abilities.
 * If the cinatra instance's marketplace credential lacks that cap, the
 * `extensionSubmissionListAdmin` call returns an MCP error, which we
 * surface via the ResultBanner.
 *
 * Status filter via ?status=<pending|approved|rejected|withdrawn|promoted>;
 * default is `pending` (the moderator's primary queue).
 */

import Link from "next/link";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { requireAdminSession } from "@/lib/auth-session";
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type {
  MarketplaceAdminSubmission,
  MarketplaceExtensionSubmissionListAdminInput,
} from "@cinatra-ai/marketplace-mcp-client";

import { SubmissionStatusPill } from "../submission-status-pill";
import { ResultBanner } from "../result-banner";
import { ApproveButton, RejectButton, RetryPromotionButton } from "./admin-action-buttons";
import { StatusFilter } from "./status-filter";

type StatusFilterValue = NonNullable<MarketplaceExtensionSubmissionListAdminInput["status"]>;
const STATUS_VALUES: StatusFilterValue[] = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "promoted",
  "superseded",
];

function resolveMarketplaceToken(): string | undefined {
  return process.env.MARKETPLACE_INSTANCE_TOKEN;
}

function parseStatusFilter(raw: string | undefined): StatusFilterValue {
  if (raw && (STATUS_VALUES as string[]).includes(raw)) {
    return raw as StatusFilterValue;
  }
  return "pending";
}

async function loadSubmissions(filter: StatusFilterValue): Promise<{
  rows: MarketplaceAdminSubmission[];
  fetchError: string | null;
}> {
  const token = resolveMarketplaceToken();
  if (!token) {
    return { rows: [], fetchError: "Marketplace instance token is not configured." };
  }
  try {
    const client = createHttpMarketplaceMcpClient({ token });
    const out = await client.extensionSubmissionListAdmin({ status: filter, limit: 200 });
    return { rows: out.submissions, fetchError: null };
  } catch (err) {
    // If the marketplace cap is missing on this instance's token, the MCP
    // call rejects here. We surface the message verbatim — operators can
    // grant `CAP_VENDOR_APPROVE` to the user the marketplace token belongs to.
    const msg = err instanceof Error ? err.message : "Failed to load admin queue.";
    return { rows: [], fetchError: msg };
  }
}

export default async function AdminSubmissionsQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; ok?: string; id?: string; error?: string }>;
}) {
  await requireAdminSession();
  const params = await searchParams;
  const filter = parseStatusFilter(params.status);
  const { rows, fetchError } = await loadSubmissions(filter);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Extension submission queue"
        description="Moderate vendor-submitted extension tarballs across all vendors."
        actions={
          <div className="flex items-center gap-2">
            <StatusFilter current={filter} />
            <Button asChild variant="outline" size="sm">
              <Link href="/configuration/marketplace/submissions">My submissions</Link>
            </Button>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <ResultBanner ok={params.ok} error={params.error ?? fetchError} id={params.id} />

        {fetchError ? null : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No {filter} submissions</EmptyTitle>
              <EmptyDescription>
                Nothing here for the moment. Switch the filter to see other states.
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
                  <TableHead>Target</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.submission_id}>
                    <TableCell className="font-mono text-sm">{s.target_final_identity}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      user&nbsp;#{s.vendor_id}
                    </TableCell>
                    <TableCell>
                      <SubmissionStatusPill
                        status={s.status}
                        promotionState={s.promotion_state}
                        promotionError={s.promotion_error}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(s.submitted_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {s.status === "pending" ? (
                          <>
                            <ApproveButton
                              submissionId={s.submission_id}
                              targetIdentity={s.target_final_identity}
                              returnStatus={filter}
                            />
                            <RejectButton
                              submissionId={s.submission_id}
                              targetIdentity={s.target_final_identity}
                              returnStatus={filter}
                            />
                          </>
                        ) : null}
                        {s.status === "approved" && s.promotion_state === "failed" ? (
                          <RetryPromotionButton
                            submissionId={s.submission_id}
                            targetIdentity={s.target_final_identity}
                            promotionError={s.promotion_error}
                            returnStatus={filter}
                          />
                        ) : null}
                        {s.status !== "pending" &&
                        !(s.status === "approved" && s.promotion_state === "failed") ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageContent>
    </Main>
  );
}
