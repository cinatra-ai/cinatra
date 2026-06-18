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
