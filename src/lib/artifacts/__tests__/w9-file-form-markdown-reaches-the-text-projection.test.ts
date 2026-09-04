/**
 * THE CONTENT CHANNEL READS A FILE-FORM MARKDOWN REVISION'S BYTES INTO THE TEXT
 * PROJECTION (lifecycle-c W9, cinatra#3033 acceptance 2).
 *
 * The ratified drawing, §I.3 verbatim: "what that display renders is the post
 * itself: its title and its body text."
 *
 * WHAT WAS WRONG. The channel's class resolution was already right — `file` plus
 * `text/markdown` resolves to the `text` class — but NOTHING in production ever
 * supplied the one port that reads the bytes, so every run-produced post reached
 * its display as `kind: "none"`, `reason: "absent"` and drew a content-absent
 * floor over work that was sitting on disk. This file pins the server read
 * itself: given the storage location the caller already authorized, a
 * `text/markdown` file revision must arrive as a `text` projection carrying the
 * document, on the same road every other class already had.
 */
import { describe, expect, it } from "vitest";

import { MAX_AUTHORED_CONTENT_BYTES } from "@/lib/artifacts/artifact-authoring";
import { buildArtifactContentProjection } from "@/lib/artifacts/artifact-content-channel";
import {
  createArtifactContentChannelServerPorts,
  MAX_TEXT_READ_BYTES,
} from "@/lib/artifacts/artifact-content-channel-server";

const ORG = "org_3033";
const ARTIFACT = "art_3033";
const REVISION = "rev_3033";

const POST = "# Why migrations are the hardest part\n\nTeams pick a stack in an afternoon.\n";

function opener(bytes: Buffer, seen?: { storageKey?: string; orgId?: string }) {
  return async (where: { orgId: string; storageKey: string }) => {
    if (seen) {
      seen.orgId = where.orgId;
      seen.storageKey = where.storageKey;
    }
    return {
      stream: (async function* () {
        // Two chunks on purpose: a stream read that only kept the last chunk
        // would still pass a single-chunk fixture.
        yield bytes.subarray(0, 5);
        yield bytes.subarray(5);
      })(),
    };
  };
}

function project(ports: ReturnType<typeof createArtifactContentChannelServerPorts>) {
  return buildArtifactContentProjection(
    {
      orgId: ORG,
      artifactId: ARTIFACT,
      representationRevisionId: REVISION,
      form: "file",
      mime: "text/markdown",
    },
    ports,
  );
}

describe("the content channel's server read — a file-form text/markdown revision", () => {
  it("projects the post's own text, not an absence", async () => {
    const bytes = Buffer.from(POST, "utf8");
    const seen: { storageKey?: string; orgId?: string } = {};
    const projection = await project(
      createArtifactContentChannelServerPorts({
        orgId: ORG,
        locateFile: (revisionId) =>
          revisionId === REVISION
            ? { storageKey: "blobs/ab/cd", sizeBytes: bytes.byteLength }
            : null,
        openBlob: opener(bytes, seen),
      }),
    );
    expect(projection.kind).toBe("text");
    if (projection.kind !== "text") return;
    expect(projection.text).toBe(POST);
    expect(projection.truncated).toBe(false);
    expect(projection.representationRevisionId).toBe(REVISION);
    // It reads the location the CALLER authorized, under the caller's org.
    expect(seen).toEqual({ orgId: ORG, storageKey: "blobs/ab/cd" });
  });

  it("carries a mime with a charset parameter, as a stored markdown blob does", async () => {
    const bytes = Buffer.from(POST, "utf8");
    const projection = await buildArtifactContentProjection(
      {
        orgId: ORG,
        artifactId: ARTIFACT,
        representationRevisionId: REVISION,
        form: "file",
        mime: "text/markdown; charset=utf-8",
      },
      createArtifactContentChannelServerPorts({
        orgId: ORG,
        locateFile: () => ({ storageKey: "k", sizeBytes: bytes.byteLength }),
        openBlob: opener(bytes),
      }),
    );
    expect(projection.kind).toBe("text");
  });

  it("lets the CHANNEL apply the cap — the read is bounded, the cap is not decided here", async () => {
    const big = Buffer.from("x".repeat(300 * 1024), "utf8");
    const projection = await project(
      createArtifactContentChannelServerPorts({
        orgId: ORG,
        locateFile: () => ({ storageKey: "k", sizeBytes: big.byteLength }),
        openBlob: opener(big),
      }),
    );
    expect(projection.kind).toBe("text");
    if (projection.kind !== "text") return;
    expect(projection.byteLength).toBe(big.byteLength);
    expect(projection.truncated).toBe(true);
    expect(projection.projectedByteLength).toBeLessThanOrEqual(projection.cap);
  });

  it("refuses a revision whose recorded size is past the read ceiling, as an absence", async () => {
    const projection = await project(
      createArtifactContentChannelServerPorts({
        orgId: ORG,
        locateFile: () => ({ storageKey: "k", sizeBytes: MAX_TEXT_READ_BYTES + 1 }),
        openBlob: async () => {
          throw new Error("must not be opened");
        },
      }),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("answers an UNREADABLE blob with a named absence, never a throw", async () => {
    const projection = await project(
      createArtifactContentChannelServerPorts({
        orgId: ORG,
        locateFile: () => ({ storageKey: "k", sizeBytes: 10 }),
        openBlob: async () => {
          throw new Error("gone");
        },
      }),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "absent" });
  });

  it("serves the TEXT form only — a class it does not read stays the absence it already was", async () => {
    const ports = createArtifactContentChannelServerPorts({
      orgId: ORG,
      locateFile: () => ({ storageKey: "k", sizeBytes: 10 }),
      openBlob: opener(Buffer.from("{}", "utf8")),
    });
    await expect(
      ports.readPinnedSubstance({
        orgId: ORG,
        artifactId: ARTIFACT,
        representationRevisionId: REVISION,
        contentClass: "configuration",
      }),
    ).resolves.toBeNull();
  });

  // THE CEILING MAY NOT BE SMALLER THAN WHAT THE PLATFORM ACCEPTS (lifecycle-c
  // W9 convergence). A read ceiling below the authoring ceiling would take a
  // post the platform itself admitted and answer "absent" for it — the very
  // wrong display this wiring exists to remove, reappearing on the largest
  // drafts instead of on all of them. §I.3 verbatim: "what that display renders
  // is the post itself: its title and its body text" — with no size clause.
  it("never refuses a post the platform itself accepts: the read ceiling covers the authoring ceiling", () => {
    expect(MAX_TEXT_READ_BYTES).toBeGreaterThanOrEqual(MAX_AUTHORED_CONTENT_BYTES);
  });

  it("admits a revision recorded just under the authoring ceiling, and projects its text", async () => {
    // The RECORDED size is what the ceiling gate reads, so this proves the gate
    // admits a 9 MiB draft without the test having to allocate one.
    const bytes = Buffer.from(POST, "utf8");
    const projection = await project(
      createArtifactContentChannelServerPorts({
        orgId: ORG,
        locateFile: () => ({ storageKey: "k", sizeBytes: 9 * 1024 * 1024 }),
        openBlob: opener(bytes),
      }),
    );
    expect(projection.kind).toBe("text");
  });

  // A CALLER MAY NOT TALK A NON-FILE REVISION INTO THE TEXT PROJECTION. The
  // channel is told the SUBSTRATE's form, and a dashboard revision resolves to
  // the configuration class whatever its mime says — this port does not serve
  // that class, so the answer is the named absence it already was, never text.
  it("refuses to read bytes for a NON-file substrate form carrying a text mime", async () => {
    let opened = false;
    const projection = await buildArtifactContentProjection(
      {
        orgId: ORG,
        artifactId: ARTIFACT,
        representationRevisionId: REVISION,
        form: "dashboard",
        mime: "text/markdown",
      },
      createArtifactContentChannelServerPorts({
        orgId: ORG,
        locateFile: () => ({ storageKey: "k", sizeBytes: 10 }),
        openBlob: async () => {
          opened = true;
          throw new Error("must not be opened");
        },
      }),
    );
    expect(opened).toBe(false);
    expect(projection.kind).not.toBe("text");
  });

  it("still reports a NON-text file form as unsupported, not as text", async () => {
    const projection = await buildArtifactContentProjection(
      {
        orgId: ORG,
        artifactId: ARTIFACT,
        representationRevisionId: REVISION,
        form: "file",
        mime: "image/png",
      },
      createArtifactContentChannelServerPorts({
        orgId: ORG,
        locateFile: () => ({ storageKey: "k", sizeBytes: 10 }),
        openBlob: opener(Buffer.from("png", "utf8")),
      }),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "unsupported-form" });
  });
});
