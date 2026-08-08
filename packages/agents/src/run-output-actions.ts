"use server";
/**
 * Terminal-run output summary (cinatra#2482).
 *
 * The completion card needs to know, at the moment it renders, whether the run
 * left anything behind: provenance-linked output objects (`objects.run_id`),
 * a transcript (messages / accumulated streamed text), or step results. It is
 * read HERE rather than threaded down from the server render because the run
 * frequently completes while the user is watching — an SSR snapshot taken while
 * the run was still `queued` would make a run that DID produce output report
 * "no output".
 *
 * Authorization: the run is re-read through `readAgentRunById` with the caller's
 * actor + role hints (the same door the run screens use), so a caller who
 * cannot see the run gets `run not found`. The object read is then scoped to
 * that run's `orgId` AND handed the caller's `ActorContext`, so
 * `buildOwnershipFilter` applies the canonical ownership vocabulary — this
 * surface can never widen what its caller may already read.
 */
import { requireAuthSession, requireActorContext, isPlatformAdmin, resolveOrgRoleForSession } from "@/lib/auth-session";
import { AuthzError } from "@/lib/authz";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { ActorRoleHints } from "./auth-policy";
import { readAgentRunById, readAgentRunMessages } from "./store";
import {
  deriveProducedOutputTitle,
  type RunOutputEvidence,
  type RunProducedOutput,
} from "./run-terminal-outcome";

export type ReadRunOutputEvidenceResult =
  | ({ ok: true } & RunOutputEvidence)
  | { ok: false; error: string };

/** How many produced outputs the completion card will link. */
const MAX_LINKED_OUTPUTS = 10;

/**
 * How many run-produced objects to CONSIDER before selecting the linkable ones.
 *
 * Deliberately larger than {@link MAX_LINKED_OUTPUTS}: the provenance read is
 * ordered `created_at DESC` and knows nothing about artifact types or read
 * authority, so limiting it to 10 would let ten newer non-artifact (or
 * read-denied) rows hide an older artifact — the card would then report "this
 * run produced no output" about a run that did, which is precisely the false
 * claim this whole fix exists to prevent. Scan a wide window, classify, THEN
 * take the first {@link MAX_LINKED_OUTPUTS} that survive.
 *
 * Bounded rather than unbounded: `listObjectsByFilter` caps at 1000, one run's
 * own output set is small, and each survivor costs one `readArtifactForDetail`.
 */
const MAX_OUTPUT_SCAN = 100;

export async function readRunOutputEvidence(args: {
  runId: string;
}): Promise<ReadRunOutputEvidenceResult> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, error: "unauthorized" };

  const isAdmin = isPlatformAdmin(session);
  const actor: PrimitiveActorContext = {
    actorType: "human",
    source: "ui",
    userId,
  };
  const roles: ActorRoleHints = {
    platformRole: isAdmin ? "platform_admin" : "member",
    orgRole: session
      ? await resolveOrgRoleForSession({ user: { id: session.user.id }, session: session.session })
      : undefined,
    actorOrganizationId: session?.session?.activeOrganizationId ?? undefined,
  };

  let run: Awaited<ReturnType<typeof readAgentRunById>>;
  try {
    run = await readAgentRunById(args.runId, actor, roles);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: "run not found" };
    throw err;
  }
  if (!run) return { ok: false, error: "run not found" };

  const hasStepResults = Array.isArray(run.stepResults) && run.stepResults.length > 0;
  const hasStreamedText = (run.streamedText ?? "") !== "";
  const messages = hasStreamedText ? [] : await readAgentRunMessages(run.id);
  const hasTranscript = hasStreamedText || messages.length > 0;

  // Provenance-linked outputs. Dynamic imports keep the host objects/artifact
  // module graphs off this module's synchronous load (same precedent as
  // `lifecycle-review-orchestration-store.ts`). Fail SOFT: a read error must
  // not turn a completed run's card into an error — the transcript/step-result
  // evidence above still names the outcome correctly.
  //
  // TWO stages, and the second is load-bearing. The indexed `objects.run_id`
  // read finds everything the run wrote, but the card links each row to
  // `/artifacts/<id>`, and that route serves ARTIFACT-typed objects only: it
  // 404s a non-artifact object and shows the not-authorized panel for a
  // list-visible-but-read-denied one. Linking straight off the provenance read
  // would therefore trade one dead end for another. So every candidate is put
  // through `readArtifactForDetail` — the route's OWN resolution, registry
  // predicate and `object.read` gate included — and only a `kind: "ok"` row is
  // ever linked. (Verified live: a `blog_post` object produced by a run linked
  // to a 404 before this gate.)
  let outputs: RunProducedOutput[] = [];
  let outputsUnavailable = false;
  try {
    const viewer = await requireActorContext();
    const { listObjectsByFilter } = await import("@/lib/objects-store");
    const { readArtifactForDetail } = await import("@/lib/artifacts/artifact-service");
    const produced = listObjectsByFilter(
      { orgId: run.orgId, runId: run.id, limit: MAX_OUTPUT_SCAN },
      viewer,
    );
    for (const row of produced) {
      if (outputs.length >= MAX_LINKED_OUTPUTS) break;
      const access = readArtifactForDetail({
        artifactId: row.id,
        orgId: run.orgId,
        actor: viewer,
      });
      if (access.kind !== "ok") continue;
      outputs.push({
        id: row.id,
        type: access.artifact.artifactType || row.type,
        title:
          access.artifact.title?.trim() ||
          deriveProducedOutputTitle({ data: row.data, type: row.type, id: row.id }),
      });
    }
  } catch (err) {
    console.warn(
      "[readRunOutputEvidence] produced-output read failed for run",
      args.runId,
      "— reporting the outputs as UNAVAILABLE, not as absent:",
      err instanceof Error ? err.message : String(err),
    );
    outputs = [];
    // Codex round-2 finding: swallowing this and returning an empty list told
    // the card "this run produced no output" whenever the objects/artifact read
    // was merely broken. Say "could not look" instead — the resolver then takes
    // the conservative branch.
    outputsUnavailable = true;
  }

  return { ok: true, outputs, hasTranscript, hasStepResults, outputsUnavailable };
}
