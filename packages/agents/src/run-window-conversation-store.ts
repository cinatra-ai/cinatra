// The PER-RUN WINDOW CONVERSATION store (cinatra#2933, lifecycle-b W5b).
//
// Outside the chat, a prompt window is the person's conversation with the
// assistant ABOUT THE RUN it sits under, and the plan keeps that conversation
// with the run: "the exchange is stored with the run, so it is there after a
// reload and can be read later beside the run."
//
// WHERE IT LIVES. On `agent_run_messages` — the table the epic's issue names
// first ("repurposed with the insert finally called"). Nothing in production
// called the insert before this module, so the table carries no rows to
// migrate and the shape needs no DDL change: a window row is an ordinary row
// whose `message_type` is `window`, which is why this store ships without a
// migration artifact.
//
// WHY THE DISCRIMINATOR, AND NOT A SHARED SPACE. The table's original purpose
// is the run's own LLM replay thread, and two readers already exist for it:
// `readAgentRunMessages` (the run seed at /api/agents/runs/[runId]) and the
// `agent_run_messages_list` primitive. Neither may start returning a person's
// window conversation, so `readAgentRunMessages` filters the window rows out
// and this module is the only reader that returns them. The two uses share the
// table and nothing else.
//
// APPEND-ONLY, PER TURN, SERVER-SIDE — and deliberately NOT the client save
// chain (cinatra#2909). That chain sends the WHOLE transcript from the browser
// and lets the last body to commit win, so a save abandoned at its client bound
// can still commit late and undo a newer intent. Nothing here can inherit that
// race: a turn INSERTS its own row, the browser never sends a transcript, and
// no statement in this module updates or deletes a row that already exists. Two
// turns racing for one sequence number collide on the table's own unique index
// instead of overwriting each other, and the loser retries onto the next free
// number — the row that lost the race is never the row that disappears.

import { eq, and, ne, asc, max } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "./db";
import { agentRunMessages } from "./schema";

/**
 * The `message_type` that marks a row as belonging to a prompt window's
 * per-run conversation rather than to the run's own replay thread. Exported so
 * the replay reader names the same string this writer writes.
 */
export const RUN_WINDOW_MESSAGE_TYPE = "window" as const;

/**
 * The five prompt windows outside the chat, named by the plan: "on the run
 * page, the step-by-step screen, the schedule screen, the armed-trigger tab and
 * the review page". The surface is recorded with the row so the exchange can be
 * read back beside the run and told apart per window.
 */
export const RUN_WINDOW_SURFACES = [
  "run-page",
  "step-by-step",
  "schedule",
  "armed-trigger",
  "review",
] as const;

export type RunWindowSurface = (typeof RUN_WINDOW_SURFACES)[number];

export function isRunWindowSurface(value: unknown): value is RunWindowSurface {
  return (
    typeof value === "string" &&
    (RUN_WINDOW_SURFACES as readonly string[]).includes(value)
  );
}

export type RunWindowMessage = {
  id: string;
  runId: string;
  sequence: number;
  role: "user" | "assistant";
  surface: RunWindowSurface;
  text: string;
  /**
   * For an assistant row: the sequence of the message it answers.
   *
   * Two turns sent at once interleave — the table serializes the ROWS, not the
   * turns, so `user A, user B, assistant A, assistant B` is a real ordering. The
   * pairing is therefore recorded rather than inferred from adjacency, so a
   * later read can never present one answer as though it answered the other
   * message. `null` on a person's own row, and on any row written before this
   * was recorded.
   */
  replyToSequence: number | null;
  /**
   * THE FILL, when this row is one (cinatra#2934, lifecycle-b W5c).
   *
   * The plan: "the assistant returns the filled values, the screen writes them
   * into its own fields, and nothing is submitted until you press the button."
   * The values live on the RUN, beside the conversation, because that is the
   * only place both halves of the road can read them: the screen reads them to
   * write them into its fields, and the SUBMIT — when the person asks for one —
   * reads them back on the server so what is sent is what was shown, never what
   * a model re-states at the press.
   *
   * A fill row is NOT a bubble: its `text` is empty and the reader that draws
   * the conversation skips it. The assistant's own answer is what the person
   * reads; a second synthesized "Field: value" line would be the page talking
   * over the conversation.
   */
  fill: RunWindowFill | null;
  /**
   * The MESSAGE this row belongs to — the turn's own durable identity, which is
   * also the identity the lent-action grant is minted against.
   *
   * Correlating by the RUN alone is not enough: two people, or two tabs, can be
   * typing in the same run's windows at once, and a submit that read "the run's
   * newest fill" could send another turn's values or another turn's file
   * (convergence round 1, finding 5). `null` on a row written before this was
   * recorded, which the readers treat as "not this message".
   */
  messageId: string | null;
  /**
   * The files attached beside the person's message, when this row is theirs.
   *
   * The plan: "A file attached beside your message travels with your answer to
   * the waiting agent exactly as it does today. The new road must not swallow it
   * into an ordinary chat message, and must not leave it behind when the answer
   * is finally sent." Recorded HERE so the answer can carry them whether the
   * person presses Continue in the browser or asks the assistant to submit.
   */
  attachments: readonly RunWindowAttachment[] | null;
  createdAt: Date;
};

/**
 * One fill: the screen it is for, and the values placed in its fields.
 *
 * `ref` is the screen's own server-minted reference — the row is keyed to the
 * screen, so a fill for a screen the run has moved past cannot be read back onto
 * the next one.
 */
export type RunWindowFill = {
  ref: string;
  values: Record<string, unknown>;
};

/**
 * One attachment reference, exactly as the upload route minted it. Stored
 * opaquely: this module never reads inside it and never mints one.
 */
export type RunWindowAttachment = Record<string, unknown>;

/** The JSON body persisted in `content_json` for a window row. */
type RunWindowMessageBody = {
  messageType: typeof RUN_WINDOW_MESSAGE_TYPE;
  role: "user" | "assistant";
  surface: RunWindowSurface;
  text: string;
  replyToSequence?: number | null;
  fill?: RunWindowFill | null;
  attachments?: readonly RunWindowAttachment[] | null;
  messageId?: string | null;
};

/**
 * How many times an append retries a sequence collision before giving up. The
 * collision is the unique (run_id, sequence) index doing its job when two turns
 * on the same run race; each retry re-reads the high-water mark, so the bound
 * is about concurrent writers on ONE run, not about load.
 */
const SEQUENCE_RETRY_LIMIT = 5;

function isUniqueViolation(err: unknown): boolean {
  // node-postgres surfaces the SQLSTATE on `code`; drizzle re-throws the driver
  // error (sometimes wrapped, with the original on `cause`).
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "23505") return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return (cause as { code?: unknown } | null)?.code === "23505";
}

/**
 * Append ONE window message to a run's conversation. Server-side, per turn,
 * append-only: the caller hands over one message, never a transcript.
 */
export async function appendRunWindowMessage(input: {
  runId: string;
  role: "user" | "assistant";
  surface: RunWindowSurface;
  text: string;
  /** The message this answers, when this row is an answer. */
  replyToSequence?: number | null;
  /** The values placed in a screen's fields, when this row is a fill. */
  fill?: RunWindowFill | null;
  /** The files attached beside a person's message. */
  attachments?: readonly RunWindowAttachment[] | null;
  /** The turn this row belongs to (cinatra#2934). */
  messageId?: string | null;
}): Promise<RunWindowMessage> {
  // The SURFACE is checked here rather than trusted from the type: a server
  // action's payload is whatever reached the process, and TypeScript checks
  // nothing at that boundary. An unknown window is refused outright instead of
  // being stored and quietly relabelled on the way back out.
  if (!isRunWindowSurface(input.surface)) {
    throw new Error("Unknown prompt window.");
  }
  const body: RunWindowMessageBody = {
    messageType: RUN_WINDOW_MESSAGE_TYPE,
    role: input.role,
    surface: input.surface,
    text: input.text,
    ...(typeof input.replyToSequence === "number"
      ? { replyToSequence: input.replyToSequence }
      : {}),
    ...(input.fill ? { fill: input.fill } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < SEQUENCE_RETRY_LIMIT; attempt += 1) {
    // The high-water mark is read across the WHOLE run, replay rows included,
    // because the unique index is over (run_id, sequence) and does not care
    // which use a row belongs to.
    const [{ highWater } = { highWater: null }] = await db
      .select({ highWater: max(agentRunMessages.sequence) })
      .from(agentRunMessages)
      .where(eq(agentRunMessages.runId, input.runId));
    const sequence = (highWater ?? 0) + 1;
    const id = randomUUID();
    try {
      await db.insert(agentRunMessages).values({
        id,
        runId: input.runId,
        sequence,
        role: input.role,
        messageType: RUN_WINDOW_MESSAGE_TYPE,
        toolCallId: null,
        toolName: null,
        content: input.text,
        contentJson: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      if (isUniqueViolation(err)) continue; // another turn took this number
      throw err;
    }
    return {
      id,
      runId: input.runId,
      sequence,
      role: input.role,
      surface: input.surface,
      text: input.text,
      replyToSequence: body.replyToSequence ?? null,
      fill: body.fill ?? null,
      attachments: body.attachments ?? null,
      messageId: body.messageId ?? null,
      createdAt: new Date(),
    };
  }
  // The driver's own error is what a reader needs; the sentence is only for the
  // case where the driver threw something that is not an Error at all.
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("Could not append the run window message.", {
    cause: lastErr,
  });
}

/**
 * The run's window conversation in order. `surface` narrows to one window; the
 * whole exchange is returned without it, because the plan's promise is that the
 * conversation can be "read later beside the run".
 */
export async function readRunWindowMessages(
  runId: string,
  opts?: { surface?: RunWindowSurface },
): Promise<RunWindowMessage[]> {
  const rows = await db
    .select()
    .from(agentRunMessages)
    .where(
      and(
        eq(agentRunMessages.runId, runId),
        eq(agentRunMessages.messageType, RUN_WINDOW_MESSAGE_TYPE),
      ),
    )
    .orderBy(asc(agentRunMessages.sequence));

  const out: RunWindowMessage[] = [];
  for (const row of rows) {
    let body: Partial<RunWindowMessageBody> = {};
    try {
      body = JSON.parse(row.contentJson) as Partial<RunWindowMessageBody>;
    } catch {
      // A row whose JSON cannot be parsed still carries its text column; the
      // conversation is readable rather than lost.
    }
    const surface = isRunWindowSurface(body.surface) ? body.surface : "run-page";
    if (opts?.surface && surface !== opts.surface) continue;
    out.push({
      id: row.id,
      runId: row.runId,
      sequence: row.sequence,
      role: row.role === "assistant" ? "assistant" : "user",
      surface,
      text: typeof body.text === "string" ? body.text : row.content,
      replyToSequence:
        typeof body.replyToSequence === "number" ? body.replyToSequence : null,
      fill: readFillBody(body.fill),
      attachments: readAttachmentsBody(body.attachments),
      messageId: typeof body.messageId === "string" && body.messageId.length > 0
        ? body.messageId
        : null,
      createdAt: row.createdAt,
    });
  }
  return out;
}

/**
 * A stored fill, read back defensively: the column is JSON written by an earlier
 * version of this module as much as by this one, so a body that does not have
 * the shape is treated as no fill at all rather than half-read.
 */
function readFillBody(value: unknown): RunWindowFill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { ref, values } = value as { ref?: unknown; values?: unknown };
  if (typeof ref !== "string" || ref.length === 0) return null;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  return { ref, values: values as Record<string, unknown> };
}

/** Stored attachment refs, read back defensively for the same reason. */
function readAttachmentsBody(value: unknown): readonly RunWindowAttachment[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter(
    (v): v is RunWindowAttachment =>
      !!v && typeof v === "object" && !Array.isArray(v),
  );
  return out.length > 0 ? out : null;
}

/**
 * EVERY fill THIS MESSAGE placed on one screen, oldest first.
 *
 * This is the reader the SUBMIT uses. Two properties matter and both are the
 * reason it is keyed by the MESSAGE and returns a LIST:
 *
 *   · a submit must send what the person's own turn placed, not whatever the
 *     run's newest fill happens to be — another tab, or another person typing
 *     in the same run, must not have their values sent under this press
 *     (convergence round 1, finding 5);
 *   · a turn that filled twice — the subject, then the body — left BOTH in the
 *     fields, so a submit that sent only the last one would send something the
 *     person never saw (finding 4). The caller applies them in order over the
 *     screen's own current values.
 */
export async function readRunWindowFillsForMessage(
  runId: string,
  ref: string,
  messageId: string,
): Promise<RunWindowFill[]> {
  if (!messageId) return [];
  const rows = await readRunWindowMessages(runId);
  const out: RunWindowFill[] = [];
  for (const row of rows) {
    if (row.messageId !== messageId) continue;
    if (row.fill && row.fill.ref === ref) out.push(row.fill);
  }
  return out;
}

/**
 * The attachments the person put on THIS message, or `null`.
 *
 * Keyed by the message for the same reason as the fills above: a file attached
 * beside one turn must not travel under another turn's press, and the file
 * attached beside the message that ASKED for the press must not be left behind
 * by it.
 */
export async function readRunWindowAttachmentsForMessage(
  runId: string,
  messageId: string,
): Promise<readonly RunWindowAttachment[] | null> {
  if (!messageId) return null;
  const rows = await readRunWindowMessages(runId);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.role !== "user" || row.messageId !== messageId) continue;
    return row.attachments;
  }
  return null;
}

/**
 * The predicate the replay reader uses to keep window rows out of its result.
 *
 * A bare `<>` is safe here BECAUSE the column cannot be NULL: `message_type` is
 * `text NOT NULL DEFAULT 'text'` in both the Drizzle table and the shipped
 * bootstrap DDL, so there is no three-valued case for the comparison to drop.
 */
export const notARunWindowRow = ne(
  agentRunMessages.messageType,
  RUN_WINDOW_MESSAGE_TYPE,
);
