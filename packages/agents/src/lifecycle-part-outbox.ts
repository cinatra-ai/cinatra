// ---------------------------------------------------------------------------
// THE RUN OUTBOX — the platform-owned lifecycle-part producer
// (cinatra#2930, epic #2926 W3).
//
// THE DEFECT THIS CLOSES. A card that belongs to a moment used to reach a
// conversation only if a model chose to call a tool for it. So a run could park
// at a moment nobody could see: the person was left with a sentence about a
// card, a link to another page, or nothing at all while the run waited. The
// plan states the rule in as many words — "Every host — the chat, a third-party
// application, the run page, the review page — mounts the moment's card from the
// run state the moment the coordinator signals it. In a conversation the
// platform itself writes the card into the run's own turn, from an outbox the
// coordinator feeds when a moment opens — a durable part with its provenance and
// its place in the turn, so it is there after a reload and whether or not the
// assistant's model says anything."
//
// WHAT IS IN THIS MODULE. The producer half only: the entry the coordinator
// hands over when a moment opens, the provenance vocabulary that records WHO
// delivered a card, and the leaf seam a host wires its writer into. The writing
// half is the host's — `src/lib/lifecycle/lifecycle-run-outbox.ts` — because the
// run's own turn lives in the app's assistant-turn store, which this package
// deliberately cannot reach.
//
// A LEAF PORT, the SAME idiom as `setRunWaitNotifier` (run-wait-notifier.ts):
// one global-symbol slot, zero runtime dependencies, so a boot file can import
// it directly instead of through the barrel and a duplicated module instance
// across a bundle boundary still finds the one wired writer.
//
// BEST-EFFORT BY CONTRACT, exactly like the moment write it sits beside: a
// lifecycle record must never fail a run. Everything here swallows, logs and
// returns; the run keeps the behaviour it had before the outbox existed, which
// is the card arriving only when a model asked for it.
// ---------------------------------------------------------------------------

import {
  LIFECYCLE_MOMENT_CARD_KIND,
  isRunCarriedLifecycleKind,
  type LifecycleCardKind,
  type LifecycleMoment,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

// ---------------------------------------------------------------------------
// Provenance — WHO delivered this card
// ---------------------------------------------------------------------------

/**
 * The two deliveries, recorded on the part itself.
 *
 *   `platform_injected` — the platform wrote it because the run reached the
 *     moment. No model was asked, and none can withhold it.
 *   `tool_represented`  — a "show me" tool brought the card back into view. The
 *     plan keeps those tools and keeps them second: "recorded as exactly that".
 *
 * RECORDED, NOT INFERRED. A reader that had to guess which delivery produced a
 * part would be re-deriving exactly the fact this wave exists to state.
 */
export const LIFECYCLE_PART_PROVENANCE = Object.freeze([
  "platform_injected",
  "tool_represented",
] as const);

export type LifecyclePartProvenance = (typeof LIFECYCLE_PART_PROVENANCE)[number];

export function isLifecyclePartProvenance(
  value: unknown,
): value is LifecyclePartProvenance {
  return (
    typeof value === "string" &&
    (LIFECYCLE_PART_PROVENANCE as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The producer identity
// ---------------------------------------------------------------------------

/**
 * The PLATFORM producer's label, and it is deliberately not a server label any
 * MCP surface can present.
 *
 * The envelope recognizer binds recognition to a (server, tool) tuple because
 * tool results are model-visible and model-influenced. The platform is not a
 * tool call at all: it is the coordinator, reached through a seam no model
 * holds. Its label carries a colon, which the MCP injection boundary refuses in
 * a server label, so no connector in any organization can ever present it — the
 * same narrow-acceptance discipline the self-MCP tuple already uses, applied to
 * a producer that is not on the tool surface in the first place.
 */
export const LIFECYCLE_PLATFORM_PRODUCER_LABEL = "cinatra:platform";

/** The platform producer's act. One act, and it is not a tool. */
export const LIFECYCLE_PLATFORM_PRODUCER_ACT = "lifecycle_moment_opened";

// ---------------------------------------------------------------------------
// The outbox entry
// ---------------------------------------------------------------------------

/**
 * One moment opening, as the coordinator hands it over.
 *
 * `cardRef` is the moment's server-checked reference — the same value the run
 * row states. A moment with no reference still opens (the audit reading can),
 * and the host decides whether it has anything to write; nothing here invents a
 * reference it was not given.
 */
export type LifecycleMomentOpened = {
  runId: string;
  orgId: string;
  moment: LifecycleMoment;
  cardKind: LifecycleCardKind;
  cardRef: string | null;
};

/**
 * The host's writer. One method, and it answers nothing: whether the part
 * landed is not knowable from the producer side — the run's turn may not exist
 * yet, may not be a conversation at all, or may already carry the card.
 */
export interface LifecyclePartOutbox {
  onMomentOpened(entry: LifecycleMomentOpened): Promise<void>;
}

const LIFECYCLE_PART_OUTBOX_SLOT = Symbol.for(
  "cinatra.agents.lifecyclePartOutbox",
);

type OutboxHolder = { outbox: LifecyclePartOutbox | null };

function outboxHolder(): OutboxHolder {
  const g = globalThis as unknown as Record<symbol, OutboxHolder | undefined>;
  return (g[LIFECYCLE_PART_OUTBOX_SLOT] ??= { outbox: null });
}

/** Host wiring entry: inject the writer. Pass `null` to clear (tests). */
export function setLifecyclePartOutbox(outbox: LifecyclePartOutbox | null): void {
  outboxHolder().outbox = outbox;
}

/** Internal getter — the wired writer, or `null` when no host wired one. */
export function getLifecyclePartOutbox(): LifecyclePartOutbox | null {
  return outboxHolder().outbox;
}

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

/**
 * PURE. Should this moment feed the outbox at all?
 *
 * Only a RUN-CARRIED kind can be injected from run state, which is the whole
 * claim the injection makes. The one kind that is not run-carried while it is
 * held — a schedule stated in a conversation, before Confirm — is excluded here
 * BY THE SAME READER the protocol package states it with, rather than by a
 * second list this module would have to keep in step: it arrives in the
 * assistant's own turn, where the person stated it, and the plan says so in as
 * many words — "it never enters the run outbox, because there is no run".
 *
 * A moment that reaches this function ALWAYS has a run (the coordinator's other
 * carrier never gets here), so the schedule moment it names is the CONFIRMED
 * one, which is run-carried.
 */
export function momentFeedsRunOutbox(moment: LifecycleMoment): boolean {
  const kind = LIFECYCLE_MOMENT_CARD_KIND[moment];
  return isRunCarriedLifecycleKind(kind, { scheduleConfirmed: true });
}

/**
 * How long the coordinator will wait for the outbox before going on.
 *
 * BOUNDED ON PURPOSE (a convergence review, finding 8). The writer is a host-injected
 * function, so "how long can it take" is not knowable here — and this call sits
 * inside the coordinator's moment write, which sits inside a run. An unbounded
 * await would let a slow or never-settling store stall the run itself, which is
 * a far worse outcome than a card arriving only when a tool asks for it.
 *
 * Nothing is cancelled when the budget runs out: the write may still land, and
 * the injection is idempotent, so a late writer that finishes on its own does
 * the right thing. What the budget ends is the WAITING.
 */
export const LIFECYCLE_OUTBOX_BUDGET_MS = 2_000;

/**
 * Feed the outbox. Called by the coordinator when a moment opens on a run.
 *
 * NEVER THROWS and never delays a run: no wired host, a host that throws, a
 * host that takes too long, or a moment with nothing to inject all return
 * quietly. The run's own row already states the moment either way — the outbox
 * is what carries it into the conversation the person is in, not where the fact
 * lives.
 */
export async function emitLifecycleMomentOpened(
  entry: LifecycleMomentOpened,
): Promise<void> {
  if (!momentFeedsRunOutbox(entry.moment)) return;
  const outbox = getLifecyclePartOutbox();
  if (!outbox) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      outbox.onMomentOpened(entry),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            "[lifecycle-part-outbox] the",
            entry.moment,
            "injection for run",
            entry.runId,
            `did not settle within ${LIFECYCLE_OUTBOX_BUDGET_MS}ms — the run goes on and the card arrives only if a tool asks for it`,
          );
          resolve();
        }, LIFECYCLE_OUTBOX_BUDGET_MS);
        // A timer must never hold a worker process open past its work.
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch (err) {
    // The run id is request-influenced, so it is a discrete ARGUMENT and never
    // interpolated into the format string (CodeQL js/tainted-format-string).
    console.warn(
      "[lifecycle-part-outbox] could not inject the",
      entry.moment,
      "card into the turn of run",
      entry.runId,
      "— the run keeps its stated moment and the card arrives only if a tool asks for it:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
