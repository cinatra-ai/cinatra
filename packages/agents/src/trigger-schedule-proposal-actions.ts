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
 * is what settles them back into a proposal: a NEW token with a NEW consume
 * identity. It mutates nothing, because there is nothing to mutate, so an
 * abandoned adjustment leaves no trace and a stale token confirmed afterwards
 * still creates exactly the one run it describes.
 */
export async function adjustScheduleProposal(args: {
  templateId: string;
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
    templateId: args.templateId,
    userId,
    orgId,
    schedule: args.schedule,
  });
  if (!proposed.ok) return { ok: false, error: PROPOSAL_REFUSALS.invalid };
  return { ok: true, token: proposed.token, expiresAt: proposed.expiresAt };
}

/**
 * Adjust an EXPIRED proposal — re-propose it from the card's own ref.
 *
 * The same act as `adjustScheduleProposal` and a separate entry point for one
 * reason: an expired card in a transcript has no rows on screen to send, only
 * the ref it was minted with. That ref already carries the template and the
 * schedule server-side and already proves the reader was minted this proposal,
 * so nothing about the agent has to travel to the client and back — which is
 * also why this cannot be steered at a template the caller was never proposed.
 *
 * A HUMAN SESSION action like its siblings: the user and org come from the live
 * cookie session and never from an argument. It arms nothing — re-proposing
 * writes nothing at all — so the "the AI can present a schedule and can never
 * arm one" property is untouched.
 */
export async function adjustExpiredScheduleProposal(args: {
  token: string;
}): Promise<
  { ok: true; token: string; expiresAt: number } | { ok: false; error: string }
> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!userId || !orgId) return { ok: false, error: "unauthorized" };
  const role =
    (session?.user as { role?: string | null } | null | undefined)?.role ?? null;

  const { reproposeExpiredScheduleProposal } = await import(
    "./trigger-schedule-proposal-service"
  );
  return reproposeExpiredScheduleProposal({ userId, orgId, role }, args.token);
}
