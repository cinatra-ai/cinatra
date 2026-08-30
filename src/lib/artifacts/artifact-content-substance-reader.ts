import "server-only";

// THE ONE SERVER READ behind the versioned content channel (enabler 0.3 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// The channel itself (`artifact-content-channel.ts`) is pure over a single
// injected port: `readPinnedSubstance`. Until this module existed there was no
// implementation of that port anywhere in the tree, so EVERY consumer passed
// `absentArtifactContent(...)` and every display that draws from
// `props.content` drew its own "nothing pinned" floor — on a revision that
// holds a real draft. That is the whole of the defect this module closes: the
// channel was defined and never bound.
//
// WHAT IT MAY READ, AND UNDER WHOSE SCOPE. Nothing here authorizes anything.
// The caller has already resolved and authorized the reader and passes its
// TRUSTED organization scope; both resolvers below are tenant-keyed on that
// scope and on the exact (artifact, representation-revision) tuple, so this
// module can only ever read a revision the caller already proved is theirs.
//
// AND IT NEVER READS "LATEST". Both arms take the pinned
// `representationRevisionId` and resolve THAT revision; the channel stamps it
// onto the projection it returns.
//
// PURE OVER ITS OWN PORTS TOO. The two substrate resolvers and the blob store
// are injectable, so the whole matrix — text, configuration, the unreadable
// revision, the over-ceiling file — is provable without a database.

import {
  resolveArtifactVersionForServe,
  resolveNonFileArtifactRevision,
  type NonFileRevisionResolution,
  type ServeResolution,
} from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import type {
  ArtifactContentChannelPorts,
  PinnedRevisionSubstance,
} from "@/lib/artifacts/artifact-content-channel";

/**
 * The READ CEILING for a text substance, mirroring the preview byte cap the
 * markdown/plain-text handlers already read under.
 *
 * It is NOT the channel's cap and does not replace it: the channel caps what is
 * PROJECTED (and reports the true byte length beside a `truncated` flag), while
 * this bounds what is ever pulled into memory. A file over the ceiling is a
 * named absence rather than a streamed-then-discarded read of an arbitrarily
 * large blob.
 */
export const PINNED_TEXT_SUBSTANCE_READ_CEILING_BYTES = 10 * 1024 * 1024;

/** The substrate + storage seams this reader stands on. */
export interface PinnedSubstanceReaderDeps {
  resolveFileRevision(input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    liveOnly?: boolean;
  }): ServeResolution | null;
  resolveNonFileRevision(input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    liveOnly?: boolean;
  }): NonFileRevisionResolution | null;
  openBytes(input: {
    orgId: string;
    storageKey: string;
  }): Promise<{ stream: AsyncIterable<Uint8Array> }>;
}

const defaultDeps: PinnedSubstanceReaderDeps = {
  resolveFileRevision: resolveArtifactVersionForServe,
  resolveNonFileRevision: resolveNonFileArtifactRevision,
  openBytes: (input) => createLocalDiskBlobStore().openByStorageKey(input),
};

/**
 * Build the channel's read port for ONE already-authorized reader.
 *
 * `liveOnly` carries the SAME meaning it carries on the resolvers: a review
 * surface reading a LIVE gate must not resolve a tombstoned-but-pinned
 * revision, while the gate-authorized historical reading (enabler 0.9) may,
 * bounded by the frozen set the gate itself pinned. The caller says which,
 * because only the caller knows which reading it is on.
 */
export function createPinnedSubstanceReader(
  options: {
    liveOnly?: boolean;
    /**
     * The pinned configuration record the CALLER already resolved for this
     * revision, when it has one.
     *
     * The membership answer for a non-file revision carries the record and its
     * digest (enabler 0.10), so re-resolving the same row here would be a second
     * read of one row and a place for the two answers to disagree. Absent, the
     * arm resolves it itself — a caller that holds nothing still gets a
     * projection rather than an absence.
     */
    carriedConfiguration?: { configuration: unknown; digest: string | null } | null;
  } = {},
  deps: PinnedSubstanceReaderDeps = defaultDeps,
): ArtifactContentChannelPorts {
  const liveOnly = options.liveOnly !== false;
  const carried = options.carriedConfiguration ?? null;

  return {
    async readPinnedSubstance({ orgId, artifactId, representationRevisionId, contentClass }) {
      if (contentClass === "text") {
        return readTextSubstance({ orgId, artifactId, representationRevisionId, liveOnly }, deps);
      }
      if (contentClass === "configuration") {
        if (carried) {
          if (carried.configuration === null || carried.digest === null) return null;
          return {
            class: "configuration",
            configuration: carried.configuration,
            digest: carried.digest,
          };
        }
        const nonFile = deps.resolveNonFileRevision({
          orgId,
          artifactId,
          representationRevisionId,
          liveOnly,
        });
        // A dashboard whose twin writer has not written a pinned configuration
        // record for THIS revision has no substance to project. Answering null
        // makes it the channel's named `absent`, never an empty object that
        // would read to a display as a configuration that says nothing.
        if (!nonFile || nonFile.configuration === null || nonFile.configurationDigest === null) {
          return null;
        }
        return {
          class: "configuration",
          configuration: nonFile.configuration,
          digest: nonFile.configurationDigest,
        };
      }
      // THE `page` CLASS HAS NO SUBSTRATE READER IN THIS TREE. A connectorRef
      // revision names remote content whose pinned page body is not recorded
      // anywhere this module could read it, so the honest answer is the
      // channel's named absence — never a fabricated empty page, which a
      // display would draw as "the remote page is blank".
      return null;
    },
  };
}

async function readTextSubstance(
  input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    liveOnly: boolean;
  },
  deps: PinnedSubstanceReaderDeps,
): Promise<PinnedRevisionSubstance | null> {
  const resolved = deps.resolveFileRevision({
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId: input.representationRevisionId,
    liveOnly: input.liveOnly,
  });
  if (!resolved) return null;
  if (resolved.sizeBytes > PINNED_TEXT_SUBSTANCE_READ_CEILING_BYTES) return null;
  try {
    const handle = await deps.openBytes({
      orgId: input.orgId,
      storageKey: resolved.storageKey,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return { class: "text", text: Buffer.concat(chunks).toString("utf8") };
  } catch {
    // A revision the substrate names but whose bytes cannot be opened is an
    // absence, not a throw: one unreadable blob must degrade ONE panel to the
    // channel's named absence rather than fail the whole prepared set.
    return null;
  }
}
