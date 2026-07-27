import "server-only";
/**
 * cinatra#1939 S3 — the PRODUCTION run-authority mint for the MCP transport.
 *
 * The first perimeter caller of `verifyRunAuthority`: supplies the pooled-db
 * `VerifyRunAuthorityDeps` (the narrow agents-store projection) and converts
 * every refusal/failure into `undefined` — an unstamped frame — so the
 * transport can never be taken down by a stale attempt, a parked run, or a
 * transient read error. Fail-closed: no authority is always safe (org-write
 * seam writers refuse without one); the refusal reason is logged for audit.
 *
 * The (runId, orgId, executionAttemptId) triple comes from a VERIFIED
 * agent-run OBO token (`att` claim) — never caller input.
 */
import { readAgentRunRowForOrgWriteAuthority } from "@cinatra-ai/agents";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import {
  OrgWriteAuthorityError,
  verifyRunAuthority,
  type VerifyRunAuthorityDeps,
} from "./authority";

const productionDeps: VerifyRunAuthorityDeps = {
  readRunRow: (runId) => readAgentRunRowForOrgWriteAuthority(runId),
  nowMs: () => Date.now(),
};

export async function mintRunWriteAuthorityForMcp(
  input: { runId: string; orgId: string; executionAttemptId: string },
  deps: VerifyRunAuthorityDeps = productionDeps,
): Promise<OrgWriteAuthority | undefined> {
  try {
    return await verifyRunAuthority(
      {
        runId: input.runId,
        orgId: input.orgId,
        claimedAttemptId: input.executionAttemptId,
      },
      deps,
    );
  } catch (error) {
    // OrgWriteAuthorityError = a REFUSAL (stale attempt, wrong org, not
    // live); anything else = infra. Both read as "no authority" — the
    // distinction only matters for the log line.
    const refused = error instanceof OrgWriteAuthorityError;
    console.warn(
      `[org-write] run-authority mint ${refused ? "refused" : "failed"} — frame stays unstamped`,
      {
        runId: input.runId,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
}
