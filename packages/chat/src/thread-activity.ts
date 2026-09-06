// Thread-list ordering: distinguish "real conversational activity" from a
// passive thread open/load so a thread's `updatedAt` (and therefore its
// position in the activity-sorted sidebar) is bumped ONLY on real activity.
//
// Why this exists (issue #283): the chat-page "persist whenever messages
// change" effect is keyed on the `messages` array changing. Selecting a thread
// loads its messages via `setMessages`, which re-fires that effect -- and the
// effect unconditionally stamped a fresh `updatedAt`, persisting it. The
// default sidebar sort is by `updatedAt` desc, so merely OPENING a thread
// jumped it to the top and the bump survived reload. No user prompt and no LLM
// response had occurred.
//
// The fix: fingerprint the messages that were loaded for the active thread,
// and only treat a subsequent `messages` change as real activity (worth a
// bump + persist) when the current fingerprint differs from the loaded one.
// A pure open/load echo produces an identical fingerprint and is suppressed.
//
// These functions are pure and unit-tested in
// `__tests__/thread-activity.test.ts`. The fingerprint must be computed from
// the SAME message array that is handed to `setMessages` on load (ids are
// backfilled there for legacy messages) -- computing it from a separately
// re-mapped array would mint different ids and defeat the comparison.

/** Minimal shape this module needs from a chat message. */
export type ActivityMessage = {
  id: string;
  role: string;
  content: string;
  // `error` and the streamed `parts` length are included so that an
  // edit/regenerate that lands a same-length, same-id correction (or an error
  // turning into content) still reads as activity rather than being swallowed
  // by a content-length-only fingerprint.
  error?: string;
  parts?: unknown[];
  // `mentions` / `mentionState` are attached to the user message AFTER the
  // immediate user-message save (once routing resolves which external
  // assistants to poll). That metadata-only setMessages MUST register as
  // activity so the mention is persisted and `chat_mentions_poll` can see the
  // pending external mention — otherwise external-only mentions never get
  // polled. So these fields are part of the fingerprint.
  mentions?: Array<{ assistantUserId?: string; offset?: number }>;
  mentionState?: Record<string, string>;
};

// Cheap, stable string hash (FNV-1a, 32-bit). Avoids pulling in a crypto
// dependency on the client and avoids retaining megabytes of joined content;
// collisions are astronomically unlikely for this use and a collision only
// risks a single missed/extra reorder, never data loss.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  // Coerce to an unsigned 32-bit value for a stable, sign-free string.
  return hash >>> 0;
}

/**
 * Fingerprint of a thread's message list. Two message arrays produce the same
 * fingerprint iff they have the same length and, per message, the same id,
 * role, content, error, and number of streamed parts. Designed to change on
 * every real activity event (user submit, assistant/LLM response, edit/
 * regenerate, externally-added message) and to stay identical across a pure
 * thread open/load.
 */
export function fingerprintMessages(messages: readonly ActivityMessage[]): string {
  // Per-message hashes joined so that a reorder or a count change is also
  // captured. Hashing per message keeps each input bounded and lets the overall
  // string stay short regardless of total content size.
  const parts = messages.map((m) => {
    const partsLen = Array.isArray(m.parts) ? m.parts.length : 0;
    // Length-prefix every field (`<len>:<value>`) so distinct field tuples can
    // never alias into the same pre-hash string -- e.g. id "a"+content "b" vs
    // id "ab"+content "" both decode unambiguously. This avoids needing a
    // reserved separator character (control bytes would make this a "binary"
    // source file and are fragile inside a TS template literal).
    const err = m.error ?? "";
    // Stable, order-independent summary of mention routing metadata: the count
    // plus each mention's target + offset, and the sorted mentionState entries.
    const mentionsSig = Array.isArray(m.mentions)
      ? m.mentions.map((x) => `${x.assistantUserId ?? ""}@${x.offset ?? ""}`).join(",")
      : "";
    const mentionStateSig = m.mentionState
      ? Object.keys(m.mentionState)
          .sort()
          .map((k) => `${k}=${m.mentionState![k]}`)
          .join(",")
      : "";
    const pre =
      `${m.id.length}:${m.id}` +
      `${m.role.length}:${m.role}` +
      `${m.content.length}:${m.content}` +
      `${err.length}:${err}` +
      `p${partsLen}` +
      `${mentionsSig.length}:${mentionsSig}` +
      `${mentionStateSig.length}:${mentionStateSig}`;
    return fnv1a(pre).toString(36);
  });
  return `${messages.length}|${parts.join(".")}`;
}

/**
 * True iff the current messages represent real conversational activity since
 * the thread was loaded -- i.e. they differ from the loaded snapshot. A pure
 * open/load echo returns false (no bump, no persist).
 *
 * `loadedFingerprint` is the fingerprint captured when the active thread's
 * messages were last loaded (or "" for a brand-new thread that started empty,
 * which makes the first user message register as activity).
 */
export function isRealActivity(
  loadedFingerprint: string,
  currentMessages: readonly ActivityMessage[],
): boolean {
  return fingerprintMessages(currentMessages) !== loadedFingerprint;
}

// ---------------------------------------------------------------------------
// THE TRANSCRIPT A REBUILT CHAT PAGE ALREADY HAD (cinatra#3007, fix leg 10).
// ---------------------------------------------------------------------------
// The page holds the open thread's messages in component state and fills that
// state from `GET /api/assistants/threads/<id>` after it mounts. That is right
// for a page opened cold. It is wrong for a page that is TORN DOWN AND REBUILT
// while the reader is looking at it: the rebuilt instance starts from an empty
// list, so the whole conversation — every turn, and every lifecycle card drawn
// at a turn's own slot — is GONE from the document for as long as that read
// takes, and then comes back. Nothing failed; the transcript simply was not
// there for a while.
//
// The held-turn gate photographed exactly that. Its recorder reads the DOM
// without waiting, on purpose, because a record is a photograph: it found the
// conversation list attached with NOTHING painted inside it, moments after the
// same run's settled row had been asserted on its own root. The trace shows the
// rebuild between the two instants — the page's in-flight reads aborted and a
// fresh mount re-issuing them — with the thread read still on the wire when the
// shutter opened. Under load that read is not fast.
//
// So the transcript survives the rebuild, and this is the whole mechanism: a
// per-document, per-thread record of the messages the page last had for a
// thread, written whenever that thread's list is the one on screen and read
// once, to seed the first render of a page opening on the SAME thread. The read
// the page issues anyway still lands and still replaces what is drawn, so
// nothing here becomes an authority — it only decides what is drawn in the gap.
//
// IT IS NOT A CACHE, and the difference matters: nothing is served FROM it, it
// is never consulted for a thread the page is not already opening, it never
// suppresses a read, and it is bounded to the most recent `REMEMBERED_THREADS`
// threads in insertion order so a long session cannot grow it without limit. It
// lives in the document and dies with the tab.
//
// IT LIVES IN THIS MODULE because this is where "the messages this thread was
// LOADED with" already lives — the fingerprint above is taken from exactly the
// array recorded here — and because the `/chat` route graph is ratcheted: a
// module of its own would cost that route a permanent +1 for three functions.
const REMEMBERED_TRANSCRIPTS = new Map<string, readonly ActivityMessage[]>();
const REMEMBERED_THREADS = 8;

/**
 * THE KEY IS THE VIEWER AND THE THREAD, NEVER THE THREAD ALONE.
 *
 * Signing out of this product is a CLIENT-SIDE route change — the account menu
 * awaits `signOut()` and then pushes `/sign-in` — so the document, and every
 * module-scope value in it, outlives the person who was signed in. Keyed by
 * thread id alone this record would therefore be handed to WHOEVER is signed in
 * next on a shared browser: one press of the back button after the next person
 * signs in reaches the previous person's thread URL, and the page would paint
 * that transcript on its first frame, before the server's refusal for the new
 * reader has even been asked for. Keyed by the viewer as well, the next person
 * recalls nothing at all and sees the empty conversation they are entitled to.
 *
 * The viewer id is the one the page is already rendered for. `null` is a viewer
 * in its own right (a surface with no signed-in reader) and matches only itself.
 */
function transcriptKey(viewerId: string | null | undefined, threadId: string): string {
  return `${viewerId ?? ""}\u0000${threadId}`;
}

/**
 * Record the list the page currently has for `threadId`.
 *
 * `loadedThreadId` is the page's own "whose data is on screen" gate, passed in
 * rather than re-derived: mid-load the list still belongs to the thread being
 * left, and recording it under the new one would remember the wrong conversation.
 * An EMPTY list is not recorded either — a page mid-rebuild legitimately holds
 * one, and it would replace the transcript this exists to keep.
 *
 * `viewerId` is the reader the page is drawn for — see `transcriptKey`.
 */
export function rememberThreadTranscript(
  viewerId: string | null | undefined,
  threadId: string | null,
  loadedThreadId: string | null,
  messages: readonly ActivityMessage[],
): void {
  if (!threadId || loadedThreadId !== threadId || messages.length === 0) return;
  const key = transcriptKey(viewerId, threadId);
  // Re-insert so the eviction below is genuinely least-recently-seen.
  REMEMBERED_TRANSCRIPTS.delete(key);
  REMEMBERED_TRANSCRIPTS.set(key, messages);
  while (REMEMBERED_TRANSCRIPTS.size > REMEMBERED_THREADS) {
    const oldest = REMEMBERED_TRANSCRIPTS.keys().next();
    if (oldest.done) break;
    REMEMBERED_TRANSCRIPTS.delete(oldest.value);
  }
}

/**
 * The list the page last had for `threadId` — EMPTY when it has never had one,
 * which is the cold open and is exactly what the page started from before this
 * rule existed.
 */
export function recallThreadTranscript(
  viewerId: string | null | undefined,
  threadId: string | null | undefined,
): ActivityMessage[] {
  const remembered = threadId ? REMEMBERED_TRANSCRIPTS.get(transcriptKey(viewerId, threadId)) : undefined;
  return remembered ? [...remembered] : [];
}

/**
 * The LOAD fingerprint that belongs to that seeded list.
 *
 * Seeding the list without seeding this would make a rebuilt page read as new
 * activity and persist itself — bumping `updatedAt` and reordering the sidebar
 * on a page that did nothing (issue #283). Empty string when nothing is
 * remembered, which is the pre-existing "nothing loaded yet" reading.
 */
export function recalledThreadFingerprint(
  viewerId: string | null | undefined,
  threadId: string | null | undefined,
): string {
  const remembered = threadId ? REMEMBERED_TRANSCRIPTS.get(transcriptKey(viewerId, threadId)) : undefined;
  return remembered ? fingerprintMessages(remembered) : "";
}

/**
 * FORGET EVERY THREAD'S TRANSCRIPT.
 *
 * A browser drops this by closing the tab. A test file that mounts the page many
 * times on the SAME thread id has no such boundary, so it is given one: a suite
 * that means "this page has never seen this thread" says so here.
 */
export function forgetRememberedTranscripts(): void {
  REMEMBERED_TRANSCRIPTS.clear();
}
