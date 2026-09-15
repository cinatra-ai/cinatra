import "server-only";

// ---------------------------------------------------------------------------
// THE CONTENT CHANNEL'S HOST PORTS — wave 3 of
// `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087).
//
// The channel (enabler 0.3) shipped with its projection, its caps, its named
// absences and its boundary assertion — and with no way to actually read a
// pinned revision, so it had no callers. This is that read, and it is the whole
// of what wave 3 needs from it: "The three browser fetchers — `json-artifact`,
// `cms-snapshot-artifact`, `text-artifact` — moved onto the content channel."
//
// WHY THIS CLOSES A REAL HOLE. Those three displays fetch their own bytes from
// the browser today. Inside a third-party application that fetch carries no
// cookie and dies, so the display paints nothing — the same blank the six media
// kinds paint, arrived at down a different road. Reading the substance on the
// SERVER and carrying it on the props snapshot removes the fetch rather than
// re-authorizing it.
//
// THE TEXT ARM ONLY, AND THAT IS DELIBERATE. `configuration` is the dashboard's
// (wave 4, over enabler 0.10's non-file reader, which already hands the
// preparation path a pinned configuration record) and `page` is the CMS page
// projection's (wave 4 as well). Answering `null` for them is the channel's own
// named absence, not a gap: a class this port cannot read becomes an honest
// `absent`, never an empty string that would read as "the work is blank".
//
// AND IT READS BYTES SO THAT NOTHING ELSE HAS TO. The read is capped BEFORE the
// projection is built — the stream is abandoned once the cap's worth of bytes
// is in hand — so a large document costs the surface a bounded read rather than
// a full one, and no buffer of the work ever leaves this module: what leaves is
// a string the channel then caps again and stamps.
// ---------------------------------------------------------------------------

import {
  ARTIFACT_CONTENT_CHANNEL_CAPS,
  type ArtifactContentChannelPorts,
  type PinnedRevisionSubstance,
} from "@/lib/artifacts/artifact-content-channel";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";

/**
 * How much of a pinned text revision is ever read.
 *
 * ONE BYTE OVER THE CAP, on purpose: the channel's own truncation needs to be
 * able to tell "exactly at the cap" from "over it", and it can only do that if
 * the read did not stop at precisely the cap. Everything beyond is never
 * touched.
 */
const READ_CEILING_BYTES = ARTIFACT_CONTENT_CHANNEL_CAPS.text + 1;

/**
 * How many trailing bytes of `buf` begin a UTF-8 sequence that the buffer does
 * not finish.
 *
 * WHY THIS IS NEEDED AT ALL. The read stops at a byte offset, and a byte offset
 * has no idea where a character ends: cutting a three-byte character after its
 * first byte and then decoding leaves a replacement character behind, so the
 * projection would carry text that is NOT a prefix of the pinned work. The
 * channel's own truncation is careful about exactly this; a decode that
 * corrupts the string before the channel ever sees it would defeat that care.
 * At most three bytes are ever dropped.
 */
export function incompleteTrailingUtf8Bytes(buf: Buffer): number {
  for (let back = 1; back <= 3 && back <= buf.length; back += 1) {
    const b = buf[buf.length - back];
    if ((b & 0b1100_0000) !== 0b1000_0000) {
      // A lead byte. How many bytes its sequence needs, total.
      const needed =
        (b & 0b1000_0000) === 0 ? 1 : (b & 0b1110_0000) === 0b1100_0000 ? 2 : (b & 0b1111_0000) === 0b1110_0000 ? 3 : (b & 0b1111_1000) === 0b1111_0000 ? 4 : 1;
      return needed > back ? back : 0;
    }
  }
  return 0;
}

/** Read at most `READ_CEILING_BYTES` of a blob stream, then stop pulling. */
export async function readCappedUtf8(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total >= READ_CEILING_BYTES) break;
  }
  const buf = Buffer.concat(chunks, Math.min(total, READ_CEILING_BYTES));
  const trailing = incompleteTrailingUtf8Bytes(buf);
  return buf.subarray(0, buf.length - trailing).toString("utf8");
}

/**
 * The host's content-channel ports for ONE already-authorized reader.
 *
 * AUTHORIZATION IS THE CALLER'S, AND IT HAS ALREADY HAPPENED. This port is
 * handed an org, an artifact and a revision the surface has proven the reader
 * may see — the review preparation path proves exactly that before it builds a
 * single prop — and it re-derives the byte location under `liveOnly`, so a
 * tombstoned pin cannot be replayed through it.
 */
export function hostArtifactContentChannelPorts(): ArtifactContentChannelPorts {
  return {
    async readPinnedSubstance({
      orgId,
      artifactId,
      representationRevisionId,
      contentClass,
    }): Promise<PinnedRevisionSubstance | null> {
      // Only the text arm. The other two classes are wave 4's, and a class this
      // port cannot read is a NAMED absence at the channel, never a guess here.
      if (contentClass !== "text") return null;
      // A NAMED GAP, NOT AN OVERSIGHT: this port resolves `liveOnly`, so a
      // SETTLED reading whose pinned revision has since been tombstoned gets
      // the channel's absence rather than the reviewed text. Widening it would
      // mean this port deciding that a historical read is authorized, and it
      // cannot know that — the proof belongs to the surface that performed the
      // historical authorization, and threading it here is the non-file
      // reader's work in wave 4. The safe reading is the correct default.
      try {
        const resolved = resolveArtifactVersionForServe({
          orgId,
          artifactId,
          representationRevisionId,
          liveOnly: true,
        });
        if (!resolved) return null;
        const store = createLocalDiskBlobStore();
        const handle = await store.openByStorageKey({
          orgId,
          storageKey: resolved.storageKey,
        });
        // THE TRUE FULL SIZE TRAVELS WITH THE PREFIX. The read stops at the cap
        // by design, so the text handed back is not the whole revision and its
        // own length is not the revision's length; the store already knows the
        // real one, and carrying it is what lets a display honestly say "the
        // first N of M" instead of reporting a large document as cap-sized.
        return {
          class: "text",
          text: await readCappedUtf8(handle.stream),
          totalByteLength: handle.sizeBytes,
        };
      } catch {
        // A store failure is an absent projection, not a thrown surface: the
        // reader must still be able to read the decision.
        return null;
      }
    },
  };
}
