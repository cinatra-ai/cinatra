"use client";

// ---------------------------------------------------------------------------
// THE conversation column's DATA PATHS — one implementation, one transport seam
// (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// S8f made `/chat` and the widget render one conversation column. Six of its
// affordances still failed closed on the widget, and the column was never the
// reason: each one reads or writes through a request that `/chat` made with a
// cookie, and the widget cannot make a cookie request — the embed frame is
// same-origin to the Cinatra app, so an ambient cookie answers as whoever else
// is signed in on that browser.
//
// This module is where those requests live now. There is ONE of each, and it
// takes an optional TRANSPORT: absent means the first-party cookie request,
// byte-identical to what `/chat` sent before; present means broker headers built
// AT CALL TIME from the host's closure-held tokens, with `credentials: "omit"`.
// That is the same seam the turn driver already takes, applied to the rest of
// the column's data — so a conversation feature cannot be wired for one surface
// and forgotten on the other, because there is only one place to wire it.
//
// EVERY ONE OF THESE IS A REQUEST, NOT A DECISION. What comes back is decided by
// the endpoint, against the caller's own live standing, with the same per-row
// check on both branches. Nothing here narrows or widens anything.
// ---------------------------------------------------------------------------

import type { Mentionable } from "@cinatra-ai/sdk-ui/prompt-field";
import { deriveThreadTitle } from "./ag-ui-chat-client";
import type { UiMessage } from "./types";

/**
 * How a surface proves who is asking. Structurally identical to the turn
 * driver's pair, and deliberately not imported from the column: this module must
 * be reachable from a host that has not mounted a column yet (the embed resolves
 * its history BEFORE it mounts one).
 */
export type ConversationServiceTransport = {
  authHeaders: () => Record<string, string>;
  credentialsMode: "omit";
};

/** The fetch init a transport implies. Cookie hosts get exactly what they had. */
function requestInit(
  transport: ConversationServiceTransport | undefined,
  init: RequestInit = {},
): RequestInit {
  const headers = { ...(init.headers as Record<string, string> | undefined) };
  if (!transport) return { ...init, headers };
  return {
    ...init,
    headers: { ...headers, ...transport.authHeaders() },
    credentials: transport.credentialsMode,
  };
}

// ---------------------------------------------------------------------------
// Item 1 — the thread transcript.
// ---------------------------------------------------------------------------

/**
 * Read one thread's messages, for seeding the column's `initialMessages`.
 *
 * Returns `null` for every unusable answer — a 401, a 404 (which is also what a
 * denial looks like: the endpoint refuses to disclose a thread's existence
 * across tenants), a transport failure, a body that is not a message array. A
 * caller renders an empty conversation for all of them, which is what it would
 * have rendered anyway, so a failed restore is never a visible error.
 */
export async function fetchThreadMessages(
  threadId: string,
  transport?: ConversationServiceTransport,
): Promise<UiMessage[] | null> {
  if (!threadId) return null;
  try {
    const res = await fetch(
      `/api/assistants/threads/${encodeURIComponent(threadId)}`,
      requestInit(transport, { cache: "no-store" }),
    );
    if (!res.ok) return null;
    const payload = (await res.json()) as { messages?: unknown } | null;
    if (!Array.isArray(payload?.messages)) return null;
    return payload.messages as UiMessage[];
  } catch {
    return null;
  }
}

/**
 * The thread payload BOTH surfaces post. `/chat` has always sent this object to
 * `POST /api/assistants/threads`; naming it here is what makes "the same payload
 * contract" checkable instead of asserted.
 *
 * `ownerUserId`/`teamId` are deliberately ABSENT from the type: the server
 * derives ownership from the existing row and strips whatever the body carried,
 * so a field here would be a field that is dropped — and a client author would
 * reasonably read its presence as meaning it does something.
 */
export type ConversationThreadWrite = {
  id: string;
  title: string;
  messages: UiMessage[];
  createdAt: string;
  updatedAt: string;
  activeAssistantHandle?: string;
  /**
   * THE TRUNCATION INTENT (cinatra#2823 S9j) — the message ids this save ASSERTS
   * the reader removed, present ONLY on a save that follows an edit-and-resend.
   *
   * It has to be carried rather than inferred. Every save posts the whole
   * transcript, so "absent from the payload" is equally what a save from a tab
   * whose transcript PREDATES a turn looks like, and the server must not treat
   * that as a removal — repairing it is what the durable fold-in is for. Only the
   * writer knows which it is, and only after an edit is it a removal.
   *
   * The server tombstones the removed turns' run-bound rows under this and
   * nothing else; without it a widget edit truncates the mirror rows while the
   * run-bound rows survive, and the reload folds the removed turn back in above
   * the edited prompt — permanently. Unlike the fields above it is NOT a
   * projection of the transcript, so it is never carried forward: a save that
   * does not follow an edit asserts nothing and omits it.
   */
  removedMessageIds?: string[];
  /**
   * THE STREAMING HALF of the same intent (cinatra#2823 S9j) — the RUN IDS this
   * save asserts the reader removed, present ONLY on a save that follows an
   * edit-and-resend.
   *
   * Every id above is minted in the column, and the server's link from such an
   * id to the run-bound row runs through the turn's MIRROR ROW — the row a
   * whole-transcript save writes. A widget save is best-effort and SILENT, so a
   * turn whose save never landed has no such row: its bubble id asserts a name
   * the server has never seen, and the removed turn folds back in above the
   * edited prompt anyway. The run id, minted by the turn route and delivered on
   * the wire, is the one identity both sides hold for those turns.
   *
   * NARROWER than the ids on purpose. A bubble id the server cannot link to a
   * row does nothing, so over-naming there is safe; a run id names the run-bound
   * row outright, so the column offers only the runs of turns anchored to a
   * prompt this edit invalidated (`turn-stream-registry.ts`).
   */
  removedRunIds?: string[];
};

/**
 * Assemble the payload from what a column actually holds. It exists so the two
 * surfaces cannot disagree about the SHAPE while agreeing about the route —
 * `deriveThreadTitle` is `/chat`'s own title rule, imported rather than
 * re-stated, so a thread saved by the widget is titled the way the same
 * conversation would be titled in the app.
 *
 * `createdAt` is the caller's, because only the caller knows whether this thread
 * is new or restored; `updatedAt` is stamped here so every writer stamps it the
 * same way.
 */
export function buildThreadWrite(input: {
  threadId: string;
  messages: UiMessage[];
  createdAt: string;
  activeAssistantHandle?: string;
  /** The column's outstanding truncation intent, when it has one. Empty and
   *  absent are the same thing — an assertion about nothing is no assertion. */
  removedMessageIds?: string[];
  /** ...and its RUN half, on exactly the same terms. */
  removedRunIds?: string[];
}): ConversationThreadWrite {
  const firstUser = input.messages.find((m) => m.role === "user");
  return {
    id: input.threadId,
    title: deriveThreadTitle(typeof firstUser?.content === "string" ? firstUser.content : ""),
    messages: input.messages,
    createdAt: input.createdAt,
    updatedAt: new Date().toISOString(),
    ...(input.activeAssistantHandle
      ? { activeAssistantHandle: input.activeAssistantHandle }
      : {}),
    ...(input.removedMessageIds && input.removedMessageIds.length > 0
      ? { removedMessageIds: input.removedMessageIds }
      : {}),
    ...(input.removedRunIds && input.removedRunIds.length > 0
      ? { removedRunIds: input.removedRunIds }
      : {}),
  };
}

/**
 * KEEP the conversation (cinatra#2683 item 1, write half).
 *
 * The read above restores a transcript; this is what puts one there. Without it
 * a widget's turns live only in the mounted column: they stream, they render,
 * and the next reload opens on a blank panel, because the payload
 * reconstruction reads the legacy-mirror rows this upsert writes and a widget
 * could not write them.
 *
 * BEST-EFFORT AND SILENT, exactly like `/chat`'s writer: a failed save must
 * never interrupt a conversation that is otherwise working. The cost is stated
 * rather than hidden — a save that fails is a turn that will not come back after
 * a reload, and the reader is told nothing at the time.
 *
 * SERIALIZED PER THREAD, and that is a correctness fix rather than tidiness
 * (codex round 0, MEDIUM 3). Each save posts the WHOLE transcript, and the
 * server reconciles the mirror by DELETING every turn the snapshot omits. Two
 * saves in flight at once can therefore commit out of order — an older snapshot
 * landing last deletes the newer turn — which is a silently lost message,
 * discoverable only after a reload. Chaining them means a save always follows
 * the one before it, so the newest snapshot is always the last write.
 *
 * WHAT THE CHAIN DOES NOT COVER, stated (codex round 1): it is ONE JavaScript
 * realm. The same thread open in two tabs, or in a widget and in `/chat` at
 * once, has two chains and no shared order — the server takes the last write it
 * receives. Ordering across realms needs a revision the server can reject a
 * stale write against, which is a change to the shared upsert both surfaces use
 * and is not something a widget slice should invent on its own.
 */
/** One save's own bound. Generous — it carries a whole transcript — but finite. */
const SAVE_TIMEOUT_MS = 15_000;

const inFlightSaves = new Map<string, Promise<boolean>>();

export async function saveThreadTranscript(
  thread: ConversationThreadWrite,
  transport?: ConversationServiceTransport,
): Promise<boolean> {
  if (!thread.id) return false;
  const previous = inFlightSaves.get(thread.id) ?? Promise.resolve(false);
  const next = previous.then(async () => {
    try {
      const res = await fetch(
        "/api/assistants/threads",
        requestInit(transport, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(thread),
          // BOUNDED, because the chain is only as available as its slowest
          // link (codex round 1): a request that never answers would otherwise
          // hold every later save for this thread forever, turning one wedged
          // connection into a conversation that stops being kept at all.
          signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
        }),
      );
      return res.ok;
    } catch {
      /* best-effort: the conversation on screen is unaffected. */
      return false;
    }
  });
  inFlightSaves.set(thread.id, next);
  const landed = await next;
  // Drop the chain only while THIS save is still the tail, so a save already
  // queued behind it keeps its ordering guarantee.
  if (inFlightSaves.get(thread.id) === next) inFlightSaves.delete(thread.id);
  return landed;
}

// ---------------------------------------------------------------------------
// Item 4 — the @-mention participant list.
// ---------------------------------------------------------------------------

/**
 * The people and assistants this reader may address. The endpoint is
 * tenant-scoped by a PROVEN current membership, so what comes back is the
 * reader's own directory on either surface; an empty list is the honest answer
 * for a reader with no co-members, and for a failure.
 */
export async function fetchMentionables(
  transport?: ConversationServiceTransport,
): Promise<Mentionable[]> {
  try {
    const res = await fetch("/api/assistants/list", requestInit(transport));
    if (!res.ok) return [];
    const data = (await res.json()) as { assistants?: { id: string; handle: string }[] };
    if (!Array.isArray(data.assistants)) return [];
    return data.assistants.map((a) => ({ ...a, displayName: a.handle }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Item 3 — the Skill-autosave account setting.
// ---------------------------------------------------------------------------

export type ChatCaptureConfig = {
  enabled: boolean;
  userCanConfigure: boolean;
  userCanSeeIndicator: boolean;
};

/** Read the Skill-autosave config. A failure reads as "not visible", so the
 *  flyout row is absent rather than wrong. */
export async function fetchChatCaptureConfig(
  transport?: ConversationServiceTransport,
): Promise<ChatCaptureConfig | null> {
  try {
    const res = await fetch("/api/assistants/autosave", requestInit(transport));
    if (!res.ok) return null;
    const config = (await res.json()) as {
      enabled?: boolean;
      userCanConfigure?: boolean;
      userCanSeeIndicator?: boolean;
    };
    return {
      enabled: Boolean(config.enabled),
      userCanConfigure: Boolean(config.userCanConfigure),
      userCanSeeIndicator: Boolean(config.userCanSeeIndicator),
    };
  } catch {
    return null;
  }
}

/**
 * Write the Skill-autosave switch — the SAME account setting, through the same
 * handler and the same `can()` check on both surfaces. The server decides what
 * this reader may change; this function only asks.
 */
export async function patchChatCaptureConfig(
  enabled: boolean,
  transport?: ConversationServiceTransport,
): Promise<void> {
  try {
    await fetch(
      "/api/assistants/autosave",
      requestInit(transport, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    );
  } catch {
    /* best-effort: the next read re-states the server's answer. */
  }
}
