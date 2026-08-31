import "server-only";

// THE SERVER READ BEHIND THE CONTENT CHANNEL (enabler 0.3 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023) — the half the
// channel deliberately left injected.
//
// WHY THIS FILE EXISTS. `buildArtifactContentProjection` is pure over one port,
// and until now NOTHING in production supplied that port: both consumers of the
// props builder passed `absentArtifactContent(...)`, so a post whose bytes are
// on disk was told there were none. A display that draws "no text is available
// to show" over a stored draft is not a smaller display, it is a wrong one — the
// reader is deciding on work the surface is hiding from them.
//
// IT SERVES THE TEXT FORM, AND ONLY THE TEXT FORM. The channel's own class
// resolution decides what is a text form (`file` + a projected text mime); this
// module never re-decides it. The other two classes read their substance from
// the revision member the caller already resolved, not from bytes, and wiring
// them is their own enablers' business — asked for a class this port does not
// serve, it answers null, which the channel reports as the named absence it
// already reports today. Nothing degrades.
//
// THE READ IS BOUNDED TWICE. The blob is read only when the resolver's recorded
// size is within `MAX_TEXT_READ_BYTES`, and the decoded string is then handed to
// the channel, which applies the class cap itself and says whether it truncated.
// Bounding here and capping there is the division the enabler names: this module
// must never be able to hand the channel an unbounded string, and the channel
// must remain the only place a cap is decided.

import type {
  ArtifactContentChannelPorts,
  PinnedRevisionSubstance,
} from "@/lib/artifacts/artifact-content-channel";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";

/**
 * The READ CEILING for a text form's bytes.
 *
 * The channel's own text cap is 256 KiB, and everything above it is truncated
 * rather than refused — so this ceiling exists only to keep an accidental
 * multi-megabyte "text" revision from being pulled into memory whole just to
 * throw almost all of it away. It is deliberately far above any document a
 * person reads on a review card, and a revision over it reports the channel's
 * ordinary absence rather than a half-read prefix that would misreport its own
 * byte length.
 */
export const MAX_TEXT_READ_BYTES = 8 * 1024 * 1024;

/** Where one pinned FILE revision's bytes actually live, as the caller's own
 *  member resolution already established. */
export interface PinnedFileBytesLocation {
  readonly storageKey: string;
  readonly sizeBytes: number;
}

/** The blob read, injected so the whole port is provable without a disk. */
export type PinnedBlobOpener = (input: {
  orgId: string;
  storageKey: string;
}) => Promise<{ stream: AsyncIterable<Buffer | Uint8Array> }>;

async function drain(
  stream: AsyncIterable<Buffer | Uint8Array>,
  ceiling: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    // A stream that outruns the ceiling the caller already checked is a
    // disagreement between the recorded size and the bytes on disk. Refusing it
    // is the honest answer: the alternative is a prefix that would be reported
    // as the whole document.
    if (total > ceiling) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Build the channel's one port, bound to a reader's organization and to the
 * caller's OWN revision-member resolution.
 *
 * `locateFile` is deliberately a caller-supplied lookup rather than a second
 * resolver call: the consumer that already authorized the pinned revision knows
 * exactly which storage key it authorized, and re-resolving here could widen the
 * read surface past what that consumer allowed (the live/tombstoned distinction
 * the review binder is careful about, for one).
 */
export function createArtifactContentChannelServerPorts(input: {
  orgId: string;
  locateFile: (representationRevisionId: string) => PinnedFileBytesLocation | null;
  openBlob?: PinnedBlobOpener;
  maxReadBytes?: number;
}): ArtifactContentChannelPorts {
  const ceiling = input.maxReadBytes ?? MAX_TEXT_READ_BYTES;
  const open: PinnedBlobOpener =
    input.openBlob ??
    (async (where) => createLocalDiskBlobStore().openByStorageKey(where));

  return {
    async readPinnedSubstance(request): Promise<PinnedRevisionSubstance | null> {
      if (request.contentClass !== "text") return null;
      const located = input.locateFile(request.representationRevisionId);
      if (!located) return null;
      if (located.sizeBytes > ceiling) return null;
      try {
        const handle = await open({ orgId: input.orgId, storageKey: located.storageKey });
        const bytes = await drain(handle.stream, ceiling);
        if (!bytes) return null;
        return { class: "text", text: bytes.toString("utf8") };
      } catch {
        // An unreadable blob is an ABSENCE, never a throw: the channel's whole
        // contract is that every failure reaches the display as a named state.
        return null;
      }
    },
  };
}
