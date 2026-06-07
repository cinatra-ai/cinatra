/**
 * Vendor view of the operator's own extension submissions.
 *
 * Lists every submission the cinatra instance has made (regardless of
 * status). The only mutation here is "Withdraw" on a pending row —
 * approve/reject/retry live on the moderator queue at the sibling
 * `submissions/admin` route.
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
import type { MarketplaceVendorSubmission } from "@cinatra-ai/marketplace-mcp-client";

import { SubmissionStatusPill } from "./submission-status-pill";
import { WithdrawSubmissionButton } from "./withdraw-submission-button";
import { ResultBanner } from "./result-banner";

function resolveMarketplaceToken(): string | undefined {
  return process.env.MARKETPLACE_INSTANCE_TOKEN;
}

async function loadSubmissions(): Promise<{
  rows: MarketplaceVendorSubmission[];
  fetchError: string | null;
}> {
  const token = resolveMarketplaceToken();
  if (!token) {
    return { rows: [], fetchError: "Marketplace instance token is not configured." };
  }
  try {
    const client = createHttpMarketplaceMcpClient({ token });
    const out = await client.extensionSubmissionListSelf();
    return { rows: out.submissions, fetchError: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load submissions.";
    return { rows: [], fetchError: msg };
  }
}

export default async function VendorSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; id?: string; error?: string }>;
}) {
  await requireAdminSession();
  const params = await searchParams;
  const { rows, fetchError } = await loadSubmissions();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="My extension submissions"
        description="Tarballs your instance has submitted to the marketplace for moderator review."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/configuration/marketplace/submissions/admin">Admin queue</Link>
          </Button>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <ResultBanner ok={params.ok} error={params.error ?? fetchError} id={params.id} />

        {fetchError ? null : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No submissions yet</EmptyTitle>
              <EmptyDescription>
                Submit a tarball with{" "}
                <code className="rounded bg-surface-strong px-1 py-0.5 text-xs">
                  cinatra extensions submit
                </code>{" "}
                to see it appear here.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild variant="outline">
                <Link href="/configuration/marketplace">Browse marketplace</Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="soft-panel">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Target</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.submission_id}>
                    <TableCell className="font-mono text-sm">{s.target_final_identity}</TableCell>
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
                      {s.status === "pending" ? (
                        <WithdrawSubmissionButton
                          submissionId={s.submission_id}
                          targetIdentity={s.target_final_identity}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
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
