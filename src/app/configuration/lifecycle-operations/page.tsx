/**
 * LIFECYCLE OPERATIONS — the ops-visibility surface for the artifact-lifecycle
 * interceptions (cinatra#2047 defects D-4 + D-7; epic #2037, slice S0 #2038).
 *
 * S0 shipped two states whose contract says, in as many words, that an operator
 * must be able to see them — and until this page nothing in production read
 * either, so both were silent:
 *
 *   STUCK REVIEW RELEASES (D-4) — S0 AC: "Dead-letter transition after max resume
 *     attempts, surfaced in ops visibility." A resume intent that exhausts its
 *     delivery attempts is correctly dead-lettered and dropped from the claim set,
 *     but the run it would have released stays waiting forever. The store read
 *     (`readDeadLetteredResumeIntents`) had ZERO production callers.
 *
 *   BLOCKED EFFECTS (D-7) — S0's continuation contract: a checkpointed park whose
 *     TTL expires "always-resumes with the protected effect in a terminal
 *     `policy_unresolved` blocked state, ops-surfaced". The park read
 *     (`readPolicyUnresolvedParks`) likewise had ZERO production callers, and the
 *     effect layer did not even consult the park set (fixed in the same lane:
 *     `resolveArtifactEffectDisposition` now reports `policy_unresolved`).
 *
 * cinatra#2571 (epic #2564 S6b) adds a third queue on the same principle:
 *
 *   ACCEPTED SUGGESTIONS — a reviewer's accepted set is persisted in the gate-CAS
 *     transaction and applied through a durable intent. Both ends of that queue
 *     are shown: a DEAD-LETTERED intent (attempts exhausted — nothing retries it)
 *     and a WAITING intent. Waiting is listed rather than hidden because no
 *     production applier is registered yet, so an accepted suggestion legitimately
 *     sits in this queue — and an outstanding decision nobody can see is exactly
 *     the D-4 failure above.
 *
 * Both are ADMIN-only and ORG-SCOPED (each read joins the row that carries the
 * org — the gate for a resume intent, the produced event for a park — so one
 * tenant's stuck releases can never appear to another). READ-ONLY by design: this
 * lane surfaces the states; resolving them is a policy decision, not a button.
 * Consistent with the existing ops pages under /configuration (same
 * `requireAdminSession` + Main/PageHeader/PageContent/Table chrome as
 * telemetry / permissions / the marketplace queues).
 */

import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
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
import { Badge } from "@/components/ui/badge";
import { requireAdminSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Lifecycle operations" };

/** Never cache: an ops queue that shows a stale empty state is worse than no
 * queue at all. */
export const dynamic = "force-dynamic";

function formatTime(value: Date | null): string {
  if (!value) return "—";
  return value.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function shortId(value: string | null): string {
  if (!value) return "—";
  return value.length > 20 ? `${value.slice(0, 18)}…` : value;
}

export default async function LifecycleOperationsPage() {
  const session = await requireAdminSession();
  const orgId = session.session?.activeOrganizationId ?? null;

  // FAIL CLOSED on a missing active organization. Both readers treat an ABSENT
  // orgId as "every organization" (the unscoped script/test posture), and
  // `requireAdminSession` checks only the platform role — so passing an
  // unresolved org through would turn this page into a cross-tenant read for any
  // admin whose session has no active org (Codex convergence). No org ⇒ no data.
  if (!orgId) {
    return (
      <Main className="min-h-screen">
        <PageHeader
          title="Lifecycle operations"
          description="Stuck review releases and effects the lifecycle policy never resolved."
          divider={false}
        />
        <PageContent className="pb-8">
          <Empty data-ops-empty="no-active-organization">
            <EmptyHeader>
              <EmptyTitle>No active organization</EmptyTitle>
              <EmptyDescription>
                These queues are per-organization. Select an organization to see its stuck review
                releases and blocked effects.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </PageContent>
      </Main>
    );
  }

  // Both stores are `server-only` packages/agents modules; imported lazily so the
  // page's module graph stays a leaf (the same posture the other configuration
  // pages take with heavy stores).
  const [
    { readDeadLetteredResumeIntents },
    { readPolicyUnresolvedParks },
    { readDeadLetteredApplicationIntents, readAwaitingApplicationIntents },
  ] = await Promise.all([
    import("@cinatra-ai/agents/artifact-review-gate-store"),
    import("@cinatra-ai/agents/lifecycle-continuation-park-store"),
    import("@cinatra-ai/agents/suggestion-decision-store"),
  ]);

  // Bounded reads: the most recent 100 of each. A deeper queue is a paging
  // concern, not a correctness one — the headline is that these rows exist at all.
  const [deadLettered, blockedEffects, deadApplications, waitingApplications] = await Promise.all([
    readDeadLetteredResumeIntents({ orgId, limit: 100 }),
    readPolicyUnresolvedParks({ orgId, limit: 100 }),
    readDeadLetteredApplicationIntents({ orgId, limit: 100 }),
    readAwaitingApplicationIntents({ orgId, limit: 100 }),
  ]);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Lifecycle operations"
        description="Stuck review releases and effects the lifecycle policy never resolved. Both need an operator; neither resolves itself."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Card className="border-line bg-surface backdrop-blur-none" data-ops-section="dead-lettered-resumes">
          <CardHeader>
            <CardTitle>Stuck review releases</CardTitle>
            <CardDescription>
              A review decision was made, but the resume delivery that releases the run exhausted
              every attempt and was dead-lettered. The run is waiting and nothing will retry it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {deadLettered.length === 0 ? (
              <Empty data-ops-empty="dead-lettered-resumes">
                <EmptyHeader>
                  <EmptyTitle>No stuck releases</EmptyTitle>
                  <EmptyDescription>
                    Every resolved review gate delivered its resume within its attempt budget.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Review task</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Dead-lettered</TableHead>
                    <TableHead>Last error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deadLettered.map((row) => (
                    <TableRow key={row.gateId} data-ops-row="dead-lettered-resume">
                      <TableCell className="font-mono text-xs" title={row.runId}>
                        {shortId(row.runId)}
                      </TableCell>
                      <TableCell className="font-mono text-xs" title={row.reviewTaskId}>
                        {shortId(row.reviewTaskId)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{row.kind}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {row.attempts}/{row.maxAttempts}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTime(row.deadLetteredAt)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.lastError ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card
          className="border-line bg-surface backdrop-blur-none"
          data-ops-section="suggestion-applications"
        >
          <CardHeader>
            <CardTitle>Accepted suggestions</CardTitle>
            <CardDescription>
              Suggestions a reviewer accepted as part of a review decision. Each row is one
              decision&apos;s accepted set, waiting to be applied or dead-lettered after exhausting
              its attempts. A dead-lettered row needs an operator; nothing retries it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {deadApplications.length === 0 && waitingApplications.length === 0 ? (
              <Empty data-ops-empty="suggestion-applications">
                <EmptyHeader>
                  <EmptyTitle>No accepted suggestions outstanding</EmptyTitle>
                  <EmptyDescription>
                    Every accepted suggestion has been applied.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Review task</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Since</TableHead>
                    <TableHead>Last error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...deadApplications, ...waitingApplications].map((row) => (
                    <TableRow key={row.gateId} data-ops-row="suggestion-application">
                      <TableCell className="font-mono text-xs" title={row.runId}>
                        {shortId(row.runId)}
                      </TableCell>
                      <TableCell className="font-mono text-xs" title={row.reviewTaskId}>
                        {shortId(row.reviewTaskId)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {row.deadLetteredAt ? "dead-lettered" : "waiting"}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {row.appliedCount}/{row.acceptedCount}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {row.attempts}/{row.maxAttempts}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTime(row.deadLetteredAt ?? row.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.lastError ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none" data-ops-section="policy-unresolved-parks">
          <CardHeader>
            <CardTitle>Blocked effects (policy unresolved)</CardTitle>
            <CardDescription>
              A checkpointed continuation passed its deadline with the review policy still
              unevaluable. The run always resumes, but the protected effect stays terminally
              blocked: nothing retries it, and no automated path clears it — it needs an explicit
              policy decision.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {blockedEffects.length === 0 ? (
              <Empty data-ops-empty="policy-unresolved-parks">
                <EmptyHeader>
                  <EmptyTitle>No blocked effects</EmptyTitle>
                  <EmptyDescription>
                    Every checkpointed continuation resolved before its deadline.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Artifact</TableHead>
                    <TableHead>Checkpoint</TableHead>
                    <TableHead>Blocked effect</TableHead>
                    <TableHead>Deadline passed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {blockedEffects.map((row) => (
                    <TableRow key={row.id} data-ops-row="policy-unresolved-park">
                      <TableCell className="font-mono text-xs" title={row.runId}>
                        {shortId(row.runId)}
                      </TableCell>
                      <TableCell className="font-mono text-xs" title={row.artifactId ?? undefined}>
                        {shortId(row.artifactId)}
                      </TableCell>
                      <TableCell>{row.checkpoint}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{row.protectedEffect}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTime(row.resolvedAt ?? row.ttlExpiresAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}
