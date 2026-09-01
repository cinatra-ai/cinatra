// ---------------------------------------------------------------------------
// THE TRANSCRIPT A REBUILT CHAT PAGE ALREADY HAD (cinatra#3007, fix leg 10).
// ---------------------------------------------------------------------------
// `ChatPage` holds the open thread's messages in component state and fills that
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
// So the transcript survives the rebuild. This module is the whole mechanism: a
// per-document, per-thread record of the messages the page last had for a thread,
// written whenever that thread's list is the one on screen and read once, to seed
// the first render of a page opening on the SAME thread. The read the page issues
// anyway still lands and still replaces what is drawn, so nothing here becomes an
// authority — it only decides what is drawn in the gap.
//
// IT IS NOT A CACHE, and the difference matters: nothing is served FROM it, it is
// never consulted for a thread the page is not already opening, it never
// suppresses a read, and it is bounded to the most recent `THREAD_LIMIT` threads
// in insertion order so a long session cannot grow it without limit. It lives in
// the document and dies with the tab.

/** The minimum this module needs from a message: nothing. It stores what it is given. */
export type RememberedTranscript = readonly unknown[];

const TRANSCRIPTS = new Map<string, RememberedTranscript>();
const THREAD_LIMIT = 8;

/** Record the list this page currently has for `threadId`. */
export function rememberThreadTranscript(threadId: string, messages: RememberedTranscript): void {
  if (!threadId) return;
  // An EMPTY list is not remembered. A page mid-rebuild legitimately holds one,
  // and recording it would replace the transcript this module exists to keep.
  if (messages.length === 0) return;
  // Re-insert so the eviction below is genuinely least-recently-seen.
  TRANSCRIPTS.delete(threadId);
  TRANSCRIPTS.set(threadId, messages);
  while (TRANSCRIPTS.size > THREAD_LIMIT) {
    const oldest = TRANSCRIPTS.keys().next();
    if (oldest.done) break;
    TRANSCRIPTS.delete(oldest.value);
  }
}

/** The list this page last had for `threadId`, or `null` if it has never had one. */
export function recallThreadTranscript(threadId: string | null | undefined): RememberedTranscript | null {
  if (!threadId) return null;
  return TRANSCRIPTS.get(threadId) ?? null;
}

/**
 * FORGET EVERY THREAD'S TRANSCRIPT.
 *
 * A browser drops this by closing the tab. A test file that mounts the page many
 * times on the SAME thread id has no such boundary, so it is given one: a suite
 * that means "this page has never seen this thread" says so here.
 */
export function forgetRememberedTranscripts(): void {
  TRANSCRIPTS.clear();
}
