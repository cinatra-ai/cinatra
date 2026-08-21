"use server";

// ---------------------------------------------------------------------------
// The schedule proposal floor — Confirm / Adjust (cinatra#2569, epic #2564 S5).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f §VI.
//
// §VI: "Confirm / Adjust is new here, and only here … In the conversation the
// act is different: nothing exists until the reader confirms."
//
// These two are the ONLY entry points that turn a proposal into anything, and
// they are HUMAN SESSION actions by construction — `requireAuthSession` is the
// first statement in each, and the acting user and org come from that session,
// never from an argument. There is no MCP primitive on any surface that reaches
// them, which is what makes "the AI can present a schedule and can never arm
// one" a property of the call graph rather than a promise.
//
// ITS OWN MODULE rather than more of `run-actions.ts`, for a measured reason.
// `run-actions.ts` is reachable from the self-MCP surface, so appending here
// would put the confirm transaction, the install outbox and the recurrence
// translation on five locked dev-perf route graphs — for code that only the
// rendered card ever calls. The route-graph ratchet measures exactly that.
//
// A `"use server"` module exports async FUNCTIONS ONLY — no types, no
// constants, no re-exports. That is a build-tier constraint neither typecheck
// nor vitest can see, so it is stated here rather than discovered in CI.
// ---------------------------------------------------------------------------

import { requireAuthSession } from "@/lib/auth-session";

import type { ProposalSchedule } from "@/lib/trigger-schedule-proposal-token";

/**
 * Confirm a proposed schedule: spend the proposal, create the run and record
 * the schedule-install intent in ONE transaction, then drain the install.
 *
 * Idempotent by the consume edge, not by convention: a double-click, a retried
 * request and a genuine race all answer with the SAME run — the first one — and
 * a second run is impossible because the losing transaction rolls its own run
 * back with the failed consume insert.
 */
export async function confirmScheduleProposal(args: {
  token: string;
}): Promise<
  | { ok: true; runId: string; alreadyConfirmed: boolean }
  | { ok: false; error: string }
> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!userId || !orgId) return { ok: false, error: "unauthorized" };
  const role =
    (session?.user as { role?: string | null } | null | undefined)?.role ?? null;

  const { confirmTriggerScheduleProposal } = await import(
    "./trigger-schedule-proposal-service"
  );
  return confirmTriggerScheduleProposal({ userId, orgId, role }, args.token);
}

/**
 * Adjust a proposal — i.e. RE-PROPOSE it.
 *
 * §VI draws Adjust as re-opening the same option rows in place, and this action
 * is what settles them back into a proposal: a new token that INHERITS the
 * adjusted-away proposal's consume identity. It still mutates nothing, because
 * there is nothing to mutate, so an abandoned adjustment leaves no trace — but
 * the stale card is no longer separately spendable, because it and the
 * replacement are ONE row in the consume table (cinatra#2859).
 *
 * TAKES THE CARD'S OWN REF, not a template id. Two things follow, and both are
 * why the argument changed: the consume identity to inherit can only be read
 * out of a token this server minted, and the template is read from that
 * verified ref — so Adjust can never be re-pointed at an agent the reader was
 * never proposed.
 */
export async function adjustScheduleProposal(args: {
  ref: string;
  schedule: ProposalSchedule;
}): Promise<
  { ok: true; token: string; expiresAt: number } | { ok: false; error: string }
> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!userId || !orgId) return { ok: false, error: "unauthorized" };

  const { adjustTriggerSchedule } = await import("./trigger-schedule-propose");
  const { PROPOSAL_REFUSALS } = await import(
    "./trigger-schedule-proposal-service"
  );
  const proposed = await adjustTriggerSchedule({
    priorToken: args.ref,
    userId,
    orgId,
    schedule: args.schedule,
  });
  if (!proposed.ok) return { ok: false, error: PROPOSAL_REFUSALS.invalid };
  return { ok: true, token: proposed.token, expiresAt: proposed.expiresAt };
}
