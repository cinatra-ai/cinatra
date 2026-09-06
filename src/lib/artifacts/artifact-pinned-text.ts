import "server-only";

// ---------------------------------------------------------------------------
// THE PINNED TEXT READ — the content channel's `readPinnedSubstance` for the
// TEXT class, and the one place the editor's save road and the artifact page
// read a revision's characters.
//
// WHY ONE PLACE. The save road compares a change set against the base's text to
// decide whether anything changed; the page hands that same text to the display
// through the content channel. If those two reads differed by a byte — a
// different cap, a different cut, a different decoding — an unchanged save would
// write a revision, or a changed one would write nothing. So there is one
// function, and both callers take it.
//
// THE CAP IS THE CHANNEL'S. Reading is bounded by the channel's own text cap and
// cut on a whole character (`truncateToUtf8Bytes`), and the read SAYS when it
// cut. A truncated read is why the page mints no edit capability: an editor must
// never save a prefix back over the document it was a prefix of.
// ---------------------------------------------------------------------------

import { ARTIFACT_CONTENT_CHANNEL_CAPS } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

import { runPostgresQueriesAsync } from "@/lib/postgres-async";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

import { createLocalDiskBlobStore } from "./local-disk-blob-store";
import {
  truncateToUtf8Bytes,
  type ArtifactContentChannelPorts,
} from "./artifact-content-channel";

/**
 * One revision's text, tenant-checked by the (organization, artifact, revision)
 * tuple in the statement itself, and null when there is no such revision or its
 * bytes cannot be read.
 */
export async function readPinnedArtifactText(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<{ text: string; truncated: boolean } | null> {
  const whole = await readWholePinnedArtifactText(input);
  if (whole === null) return null;
  const cap = ARTIFACT_CONTENT_CHANNEL_CAPS.text;
  const truncated = Buffer.byteLength(whole, "utf8") > cap;
  return { text: truncated ? truncateToUtf8Bytes(whole, cap) : whole, truncated };
}

/**
 * THE WHOLE DOCUMENT, UNCUT — what the content channel's projection is given.
 *
 * WHY THE PORT DOES NOT CUT IT. The projection is the one place that decides
 * whether a document was truncated, and it decides by measuring the text it is
 * handed against the same cap with the same `truncateToUtf8Bytes`. Handing it an
 * ALREADY-CUT document would measure exactly the cap, report `truncated: false`,
 * and the artifact page would mint an EDITABLE capability for a document the
 * person can only ever see a prefix of — an editor whose every save the road
 * refuses with `over-cap`. So the cut happens once, downstream, and the two
 * readings — the page's and the save road's — still agree byte for byte because
 * they are the same cap and the same function.
 */
export async function readWholePinnedArtifactText(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<string | null> {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT b.storage_key
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r ON r.id = rep.resource_id AND r.org_id = rep.org_id
LEFT JOIN "${schema}"."artifact_blobs" b
  ON b.id = r.metadata->>'blobId' AND b.org_id = r.org_id
WHERE rep.org_id = $1 AND rep.artifact_id = $2 AND rep.id = $3
LIMIT 1`,
        values: [input.orgId, input.artifactId, input.representationRevisionId],
      },
    ],
  });
  const storageKey = (res?.rows?.[0] as { storage_key?: string | null } | undefined)?.storage_key;
  if (!storageKey) return null;

  const store = createLocalDiskBlobStore();
  try {
    const handle = await store.openByStorageKey({ orgId: input.orgId, storageKey: String(storageKey) });
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The channel ports the artifact page passes.
 *
 * TEXT ONLY, AND HONESTLY SO. The other two classes — a dashboard's pinned
 * configuration, a remote page projection — have their own readers and their own
 * consumers; this port answers null for them, and the caller says
 * `unsupported-form` rather than pretending the read failed.
 */
export const artifactTextChannelPorts: ArtifactContentChannelPorts = {
  async readPinnedSubstance(input) {
    if (input.contentClass !== "text") return null;
    // THE WHOLE DOCUMENT, so the projection can tell the truth about truncation
    // (see `readWholePinnedArtifactText`) — it applies the same cap with the
    // same cut, and says so on the projection it builds.
    const whole = await readWholePinnedArtifactText({
      orgId: input.orgId,
      artifactId: input.artifactId,
      representationRevisionId: input.representationRevisionId,
    });
    return whole === null ? null : { class: "text", text: whole };
  },
};
