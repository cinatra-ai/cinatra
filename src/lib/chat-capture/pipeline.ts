import "server-only";

// Chat-capture detection PIPELINE (cinatra#1367) — the CHAT_CAPTURE_DETECTION
// job body. Stage order (each stage records its outcome on the ledger row so
// the whole pipeline is idempotent and auditable):
//
//   claim → per-user enablement → resolve turn text → lexical pre-filter →
//   quota reservation (atomic) → redact → LLM classifier → distill (per-user
//   serialized) → finalize 'captured' + audit event.
//
// Content flow contract: raw chat text is read ONCE from the persisted thread
// payload and immediately redacted; the classifier and the distiller only
// ever see the REDACTED text (seeded-secret test pins this). The job payload
// carries only ids — chat content never enters Redis.
//
// DEFERRED (#1037 assistant→agent target mapping): this slice distills into
// the owner's STANDALONE chat-capture personal skill (no installed-agent
// target). The (user, agent)-scoped delta + S2 run-delivery acceptance and
// multi-assistant disambiguation land when #1037 P1 registers assistants as
// agent rows.

import { createOrUpdateChatCaptureSkill } from "@cinatra-ai/skills";
import { readChatThreadPayloadById } from "@/lib/chat-thread-store";
import { isChatCaptureEnabledForUser, readSkillAutosaveConfig } from "@/lib/skill-autosave";
import { buildLegacyMirrorTurnId } from "@/lib/project-inheritance";
import { readSkillActiveRevisionFromDatabase } from "@/lib/skill-lifecycle-store";
import { logAuditEvent } from "@/lib/authz/audit";
import { runChatCaptureLexicalPrefilter } from "./detector";
import { redactChatCaptureText } from "./redact";
import { classifyChatCaptureMessage } from "./classifier";
import {
  claimChatCaptureTurn,
  finalizeChatCaptureTurn,
  reserveChatCaptureClassifierQuota,
} from "./ledger";

export type ChatCaptureDetectionPayload = {
  threadId: string;
  turnId: string;
  ownerUserId: string;
};

// ---------------------------------------------------------------------------
// Per-user capture serialization (codex round-0 finding 3; span-widened in
// codex round-1 to also cover the classifier-quota reservation).
//
// Two concurrent flagged turns for ONE user race two shared resources: the
// per-user classifier quota (a rolling-window count — parallel reservations
// could both pass the same cap boundary) and the deterministic chat-capture
// skill (both would read the same content, distill independently, and the
// second write would silently drop the first delta). runChatCaptureDetectionJob
// runs the reservation → classifier → distill span inside this chain so both
// are serialized per user. The shared BullMQ worker runs with concurrency 4 IN
// ONE PROCESS (the background worker boots in the app process — see
// background-jobs.ts), so an in-process promise chain per user is a correct
// mutex for the deployed topology; the ledger claim + the deterministic skill
// id provide cross-process idempotency for job re-delivery (the quota is a soft
// cap and may overrun by at most the cross-process concurrency). Chain entries
// self-remove when their tail settles.
// ---------------------------------------------------------------------------
const userCaptureChains = new Map<string, Promise<unknown>>();

async function withUserCaptureLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prior = userCaptureChains.get(userId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Track settlement (never rejects) so a failed capture can't poison the chain.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  userCaptureChains.set(userId, tail);
  void tail.then(() => {
    if (userCaptureChains.get(userId) === tail) userCaptureChains.delete(userId);
  });
  return run;
}

/** Exposed for the race test only. */
export function __chatCaptureChainDepthForTest(): number {
  return userCaptureChains.size;
}

function resolveTurnText(
  payload: Record<string, unknown>,
  threadId: string,
  turnId: string,
): { text: string } | null {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as Record<string, unknown>;
    if (typeof msg.id !== "string" || msg.id.length === 0) continue;
    if (msg.role !== "user") continue;
    if (buildLegacyMirrorTurnId(threadId, msg.id) !== turnId) continue;
    if (typeof msg.content !== "string" || msg.content.trim().length === 0) return null;
    return { text: msg.content };
  }
  return null;
}

/**
 * Job body for CHAT_CAPTURE_DETECTION. Never throws for SKIP outcomes (the
 * ledger records why); throws only on real pipeline failures AFTER marking
 * the row 'error', so BullMQ's retry/backoff drives recovery and the re-claim
 * path resumes the turn.
 */
export async function runChatCaptureDetectionJob(
  payload: ChatCaptureDetectionPayload,
  jobId: string,
): Promise<void> {
  const { threadId, turnId, ownerUserId } = payload;

  // 1. Durable claim — a terminal row makes any re-delivery a no-op.
  if (!claimChatCaptureTurn({ threadId, turnId, ownerUserId })) {
    return;
  }

  const finalize = (
    status: Parameters<typeof finalizeChatCaptureTurn>[0]["status"],
    extra?: { skillId?: string | null; revisionId?: string | null; detail?: string | null },
  ) => finalizeChatCaptureTurn({ threadId, turnId, status, ...extra });

  try {
    // 2. Enablement at RUN time: master switch AND the per-user preference
    // (null = follow the admin default). Toggle-off stops future captures —
    // nothing is ever deleted here.
    const config = readSkillAutosaveConfig();
    if (!config.enabled || !isChatCaptureEnabledForUser(ownerUserId, config)) {
      finalize("skipped_disabled");
      return;
    }

    // 3. Resolve the turn's CURRENT persisted text. Thread deleted, message
    // edited away, or owner drifted since enqueue ⇒ skip (abandonment is
    // harmless by design).
    const thread = readChatThreadPayloadById(threadId);
    if (!thread) {
      finalize("skipped_missing", { detail: "thread-missing" });
      return;
    }
    const persistedOwner = typeof thread.ownerUserId === "string" ? thread.ownerUserId : null;
    if (persistedOwner !== ownerUserId) {
      finalize("skipped_missing", { detail: "owner-drift" });
      return;
    }
    const turn = resolveTurnText(thread, threadId, turnId);
    if (!turn) {
      finalize("skipped_missing", { detail: "turn-missing" });
      return;
    }

    // 4. Lexical pre-filter — ordinary turns end HERE with zero LLM cost
    // (classifier_called stays false on the ledger row: the proof).
    const prefilter = runChatCaptureLexicalPrefilter(turn.text);
    if (!prefilter.pass) {
      finalize("skipped_prefilter", { detail: prefilter.reason });
      return;
    }

    // 5–10. Serialize the per-user QUOTA-RESERVATION → classifier → distill →
    // finalize span in one process-local per-user chain (withUserCaptureLock).
    // Two reasons the reservation must be inside the lock, not just the distill:
    //   - the classifier quota is a PER-USER rolling cap counted by a subquery
    //     over the owner's classifier_called rows; two concurrent same-user
    //     turns reserving in parallel could BOTH observe `cap - 1` and both
    //     pass. Serializing makes each reservation observe the prior turn's
    //     committed classifier_called row, so the cap holds.
    //   - the standalone skill is amended read-amend-write on ONE deterministic
    //     id, so same-user distills must not interleave (no lost delta).
    // The shared BullMQ worker runs concurrency 4 in ONE process (see
    // withUserCaptureLock / background-jobs.ts), so the in-process chain is the
    // correct serialization for the deployed topology; the ledger claim + the
    // deterministic id give cross-process idempotency for the SKILL, and a
    // 'captured' ledger row is immutable (finalizeChatCaptureTurn), so no
    // re-delivery can clobber a recorded capture. Static skills+LLM import is
    // fine — this module is itself lazy-loaded by the registry handler, so the
    // graph stays out of the worker's module load.
    await withUserCaptureLock(ownerUserId, async () => {
      // 5. Atomic per-user quota reservation (single conditional UPDATE).
      if (!reserveChatCaptureClassifierQuota({ threadId, turnId, ownerUserId })) {
        finalize("skipped_rate_capped");
        return;
      }

      // 6. Redact BEFORE any LLM sees the text (classifier AND distiller).
      const redacted = redactChatCaptureText(turn.text);

      // 7. Classifier (fail-closed: unusable/absent response ⇒ no capture).
      const classification = await classifyChatCaptureMessage(redacted);
      if (!classification?.durable) {
        finalize("skipped_classifier", {
          detail: classification ? null : "classifier-unavailable",
        });
        return;
      }
      const instruction = (classification.instruction ?? redacted).trim();

      // 8. Distill into the owner's standalone chat-capture skill.
      const skill = await createOrUpdateChatCaptureSkill({
        ownerUserId,
        instruction,
        provenance: { threadId, turnId },
      });

      // 9. Provenance: the revision the write moved the active pointer to.
      let revisionId: string | null = null;
      try {
        revisionId = readSkillActiveRevisionFromDatabase(skill.id)?.activeRevisionId ?? null;
      } catch (err) {
        console.warn(
          `[chat-capture] active-revision read failed skill=${skill.id}:`,
          err instanceof Error ? err.message : err,
        );
      }

      finalize("captured", { skillId: skill.id, revisionId });

      // 10. Best-effort audit event (the ledger row is the durable provenance).
      await logAuditEvent({
        actorPrincipalId: ownerUserId,
        actorPrincipalType: "system",
        authSource: "worker",
        resourceType: "skill",
        resourceId: skill.id,
        operation: "skills.chat_capture.captured",
        decision: "allowed",
        metadata: { threadId, turnId, revisionId, jobId },
      });
    });
  } catch (err) {
    // Mark 'error' (re-claimable) then rethrow so BullMQ retry accounting +
    // failure reporting see the real failure.
    try {
      finalize("error", { detail: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    } catch {
      // Ledger unavailable — the rethrow below still surfaces the failure.
    }
    throw err;
  }
}
