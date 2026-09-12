/**
 * cinatra#3026 (enabler 0.20) — THE PINNED-TEXT PORT AND THE TRUTH ABOUT
 * TRUNCATION.
 *
 * The artifact page mints an EDITABLE capability only for a document the person
 * can see whole: "an editor must never save a prefix back over the document it
 * was a prefix of". That decision is read off the content projection's
 * `truncated`, and the projection decides it by measuring the text the port
 * hands it. A port that cuts the document ITSELF hands over exactly the cap,
 * the projection measures nothing over the cap, and the page mints an editor
 * whose every save the road then refuses with `over-cap` — an editor that cannot
 * save. So the port hands over the WHOLE document and the projection does the
 * cutting, which is what these tests pin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ARTIFACT_CONTENT_CHANNEL_CAPS } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

const STORAGE_KEY = "storage-key-1";
/** What the blob holds for the next read. */
let blobText = "";

vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused:unused@127.0.0.1:5432/unused",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-async", () => ({
  runPostgresQueriesAsync: async () => [{ rows: [{ storage_key: STORAGE_KEY }] }],
}));
vi.mock("../local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({
    openByStorageKey: async () => ({
      stream: (async function* () {
        yield Buffer.from(blobText, "utf8");
      })(),
    }),
  }),
}));

const { artifactTextChannelPorts, readPinnedArtifactText } = await import(
  "../artifact-pinned-text"
);
const { buildArtifactContentProjection } = await import("../artifact-content-channel");

const CAP = ARTIFACT_CONTENT_CHANNEL_CAPS.text;
const WHERE = {
  orgId: "org-1",
  artifactId: "art-1",
  representationRevisionId: "rev-1",
};

beforeEach(() => {
  blobText = "";
});

describe("the pinned-text port", () => {
  it("hands the channel the WHOLE document, uncut, when it is over the cap", async () => {
    blobText = "x".repeat(CAP + 1_000);
    const substance = await artifactTextChannelPorts.readPinnedSubstance({
      ...WHERE,
      contentClass: "text",
    });
    expect(substance?.class).toBe("text");
    expect(substance?.class === "text" ? substance.text.length : -1).toBe(CAP + 1_000);
  });

  it("so the PROJECTION says the document was truncated — which is what makes the page read-only", async () => {
    blobText = "x".repeat(CAP + 1_000);
    const projection = await buildArtifactContentProjection(
      { ...WHERE, form: "file", mime: "text/markdown" },
      artifactTextChannelPorts,
    );
    expect(projection.kind).toBe("text");
    if (projection.kind !== "text") return;
    expect(projection.truncated).toBe(true);
    expect(projection.byteLength).toBe(CAP + 1_000);
    expect(projection.projectedByteLength).toBe(CAP);
  });

  it("and an ordinary document is still carried whole, and NOT called truncated", async () => {
    blobText = "# A small document\n";
    const projection = await buildArtifactContentProjection(
      { ...WHERE, form: "file", mime: "text/markdown" },
      artifactTextChannelPorts,
    );
    expect(projection.kind).toBe("text");
    if (projection.kind !== "text") return;
    expect(projection.truncated).toBe(false);
    expect(projection.text).toBe(blobText);
  });
});

describe("the save road's own read", () => {
  it("still cuts at the SAME cap and says that it cut", async () => {
    blobText = "x".repeat(CAP + 1_000);
    const read = await readPinnedArtifactText(WHERE);
    expect(read?.truncated).toBe(true);
    expect(Buffer.byteLength(read?.text ?? "", "utf8")).toBe(CAP);
  });

  it("and reads an ordinary document whole, uncut", async () => {
    blobText = "# One\n";
    const read = await readPinnedArtifactText(WHERE);
    expect(read).toEqual({ text: "# One\n", truncated: false });
  });
});
