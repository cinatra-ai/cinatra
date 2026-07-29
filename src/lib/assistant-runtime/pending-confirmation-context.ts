import "server-only";

// Model-visible pending-confirmation OUTCOMES (cinatra#2020 design §6.3,
// PR-4): a bounded system-context section closing the loop the §2.1 park
// message opened — the turn-N tool result told the model the call was parked;
// turn N+1 sees how it resolved via this section. Deliberate v1 minimalism:
// no thread-store schema change, no new stream event (#1216 owns the
// first-class approval view); one string term concatenated into the runtime's
// existing system-context assembly.
//
// BOUNDS: only the viewer's DECIDED transitions (executed / failed / denied /
// cancelled / expired) from the last hour, newest first, hard-capped at 5
// one-line entries. Lines carry tool/server/status only — never args,
// previews, or endpoints. Empty section ⇒ empty string (byte-identical
// system prompt for users with no confirmation activity).

import {
  listPendingCallsForViewer,
  type ConnectorInstancePendingCallRecord,
  type PendingCallStoreDeps,
} from "@/lib/connector-instance-pending-call-store";

/** Max one-line entries in the section (§6.3). */
export const PENDING_CONFIRMATION_CONTEXT_MAX_LINES = 5;
/** Recency window for reported transitions (§6.3). */
export const PENDING_CONFIRMATION_CONTEXT_WINDOW_MS = 60 * 60 * 1000;

const REPORTED_STATUSES = new Set(["executed", "failed", "denied", "cancelled", "expired"]);

function lineFor(record: ConnectorInstancePendingCallRecord): string {
  const target = `${record.toolName} on ${record.serverId}`;
  switch (record.status) {
    case "executed":
      return `[user confirmed] ${target} → executed`;
    case "failed":
      return record.failureCode === "execution_interrupted"
        ? `[confirmed, outcome unknown] ${target} → interrupted; verify on the site before retrying`
        : `[confirmed but not executed] ${target} → failed (${record.failureCode ?? "error"})`;
    case "denied":
      return `[user denied] ${target} → not executed`;
    case "cancelled":
      return `[user cancelled] ${target} → not executed`;
    case "expired":
      return `[expired unconfirmed] ${target} → not executed`;
    default:
      return `[pending] ${target}`;
  }
}

/**
 * Build the bounded section, or `""` when there is nothing to report. The
 * viewer read lazy-flips stale rows first (store-owned), so an expired card
 * reports as expired here without any cron.
 */
export async function buildPendingConfirmationContext(
  input: { orgId: string; userId: string },
  deps?: {
    listForViewer?: typeof listPendingCallsForViewer;
    storeDeps?: PendingCallStoreDeps;
    now?: () => number;
  },
): Promise<string> {
  const listForViewer = deps?.listForViewer ?? listPendingCallsForViewer;
  const now = deps?.now ?? Date.now;
  let records: ConnectorInstancePendingCallRecord[];
  try {
    records = await listForViewer({ orgId: input.orgId, userId: input.userId }, deps?.storeDeps);
  } catch {
    // Context enrichment must never fail the turn — absent section on a read
    // failure (the cards themselves remain the actionable surface).
    return "";
  }
  const cutoff = now() - PENDING_CONFIRMATION_CONTEXT_WINDOW_MS;
  // One effective timestamp per record, reused for BOTH the recency filter
  // and the ordering — a mismatched pair would let the cap keep an older
  // row over a more recently decided one, and an unparseable date must sort
  // last rather than scramble the comparator with NaN.
  const effectiveTs = (r: ConnectorInstancePendingCallRecord): number => {
    const ts = Date.parse(r.decidedAt ?? r.updatedAt);
    return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
  };
  const recent = records
    .filter((r) => REPORTED_STATUSES.has(r.status))
    .filter((r) => effectiveTs(r) >= cutoff)
    .sort((a, b) => effectiveTs(b) - effectiveTs(a))
    .slice(0, PENDING_CONFIRMATION_CONTEXT_MAX_LINES);
  if (recent.length === 0) return "";
  return (
    `\n\nRecent destructive-tool confirmation outcomes (the user decided these on their confirmation cards):\n` +
    recent.map((r) => `- ${lineFor(r)}`).join("\n") +
    `\n`
  );
}
