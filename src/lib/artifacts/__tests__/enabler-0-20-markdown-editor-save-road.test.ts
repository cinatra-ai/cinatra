// ENABLER 0.20 — "The markdown editor and its write contract" (PLAN: Agents
// Lifecycle (C) §4.1, cinatra#3026). The contract-level acceptance test §8.8
// asks every enabler to carry.
//
// WHAT IS PROVED HERE, without a database: the edit channel's own contract (the
// capability a display is handed, the outcomes a save can end on, the sentence
// each one is explained with), the save road's decisions over injected ports
// (unchanged writes nothing, a stale base is refused and answers with the newer
// revision, a reader without write rights is refused, a form that is not text is
// refused), and the props rule that makes the review card read-only BY
// CONSTRUCTION — every surface says which capability it mints, and only the
// artifact page mints an editable one.
//
// The store's compare-and-set under the unique index, the audit row and the
// pinned review revision are proved against a REAL POSTGRES in
// `lifecycle-c-w2-editor-save.integration.test.ts` beside this file.

import { describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_EDIT_CHANNEL_VERSION,
  ARTIFACT_EDIT_IDLE_PAUSE_MS,
  ARTIFACT_EDIT_TEXT_CAP_BYTES,
  artifactEditByteLength,
  artifactEditMessage,
  buildArtifactEditRequest,
  isArtifactEditGranted,
  readArtifactEditOutcome,
  saveArtifactEdit,
  type ArtifactEditCapability,
  type ArtifactEditOutcome,
} from "@cinatra-ai/sdk-extensions/artifact-edit-channel";

import {
  buildArtifactRendererProps,
  readOnlyArtifactEdit,
  absentArtifactContent,
} from "@/lib/artifacts/artifact-renderer-props";
import {
  saveArtifactMarkdownEdit,
  type ArtifactEditSavePorts,
} from "@/lib/artifacts/artifact-edit-save";

const EDITABLE: Extract<ArtifactEditCapability, { kind: "editable" }> = {
  kind: "editable",
  channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION,
  artifactId: "artifact-1",
  baseRevisionId: "rev-1",
  saveUrl: "/api/artifacts/artifact-1/edit",
  idlePauseMs: ARTIFACT_EDIT_IDLE_PAUSE_MS,
  capBytes: ARTIFACT_EDIT_TEXT_CAP_BYTES,
};

function ports(over: Partial<ArtifactEditSavePorts> = {}): ArtifactEditSavePorts {
  return {
    mayWrite: async () => true,
    readLatest: async () => ({
      revisionId: "rev-1",
      revision: 1,
      resourceId: "resource-1",
      mime: "text/markdown",
      form: "file" as const,
    }),
    readText: async () => ({ text: "# One\n", truncated: false }),
    writeBytes: async () => ({ resourceId: "resource-2" }),
    appendWithBase: async () => ({ kind: "appended" as const, revisionId: "rev-2", revision: 2 }),
    ...over,
  };
}

const save = (text: string, over: Partial<ArtifactEditSavePorts> = {}) =>
  saveArtifactMarkdownEdit(
    { orgId: "org-1", artifactId: "artifact-1", baseRevisionId: "rev-1", text, actor: "user-1" },
    ports(over),
  );

describe("the edit capability a display is handed", () => {
  it("grants an edit only on a capability minted at this channel version", () => {
    expect(isArtifactEditGranted(EDITABLE)).toBe(true);
    expect(isArtifactEditGranted({ ...EDITABLE, channelVersion: 2 })).toBe(false);
    expect(isArtifactEditGranted({ ...EDITABLE, saveUrl: "" })).toBe(false);
    expect(isArtifactEditGranted({ ...EDITABLE, baseRevisionId: "" })).toBe(false);
  });

  it("never reads a refusal as permission", () => {
    for (const reason of [
      "no-write-rights",
      "read-only-surface",
      "unsupported-form",
      "no-representation",
      "content-truncated",
    ] as const) {
      expect(
        isArtifactEditGranted({
          kind: "read-only",
          channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION,
          reason,
        }),
      ).toBe(false);
    }
    expect(isArtifactEditGranted(null)).toBe(false);
    expect(isArtifactEditGranted(undefined)).toBe(false);
  });

  it("sends the base the editor opened, and the whole document", () => {
    expect(buildArtifactEditRequest(EDITABLE, "# Two\n")).toEqual({
      channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION,
      baseRevisionId: "rev-1",
      text: "# Two\n",
    });
  });
});

describe("what a reader is told", () => {
  it("says nothing when the work is stored — the indicator already said it", () => {
    expect(artifactEditMessage({ outcome: "saved", revisionId: "rev-2", revision: 2 })).toBeNull();
    expect(artifactEditMessage({ outcome: "unchanged", revisionId: "rev-1" })).toBeNull();
  });

  it("explains a refused save, and names the newer revision on a stale one", () => {
    const stale = artifactEditMessage({
      outcome: "stale",
      latestRevisionId: "rev-9",
      latestRevision: 9,
      text: "# Nine\n",
      truncated: false,
    });
    expect(stale).toContain("moved to a newer revision");
    expect(stale).toContain("refused rather than written over");
    expect(artifactEditMessage({ outcome: "refused", reason: "no-write-rights" })).toContain(
      "do not have rights",
    );
    expect(artifactEditMessage({ outcome: "failed", reason: "transport" })).toContain(
      "could not be reached",
    );
  });

  it("gives every outcome a distinct sentence, so two refusals never read alike", () => {
    const sentences = (
      [
        { outcome: "stale", latestRevisionId: "r", latestRevision: 2, text: "", truncated: false },
        { outcome: "refused", reason: "no-write-rights" },
        { outcome: "refused", reason: "over-cap" },
        { outcome: "refused", reason: "unsupported-form" },
        { outcome: "refused", reason: "no-representation" },
        { outcome: "refused", reason: "unknown-base" },
        { outcome: "refused", reason: "malformed" },
        { outcome: "failed", reason: "transport" },
        { outcome: "failed", reason: "malformed-answer" },
        { outcome: "failed", reason: "server" },
      ] as ArtifactEditOutcome[]
    ).map((o) => artifactEditMessage(o));
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});

describe("the one road a display has to the host", () => {
  it("posts the change set to the address the capability carries, and nowhere else", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ outcome: "saved", revisionId: "rev-2", revision: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const outcome = await saveArtifactEdit(EDITABLE, "# Two\n", {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ outcome: "saved", revisionId: "rev-2", revision: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(EDITABLE.saveUrl);
    expect(JSON.parse(String(init.body))).toEqual({
      channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION,
      baseRevisionId: "rev-1",
      text: "# Two\n",
    });
  });

  it("never throws — a network that is not there is an outcome", async () => {
    const outcome = await saveArtifactEdit(EDITABLE, "# Two\n", {
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ outcome: "failed", reason: "transport" });
  });

  it("never invents a success out of an answer it cannot read", async () => {
    const outcome = await saveArtifactEdit(EDITABLE, "# Two\n", {
      fetch: (async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ outcome: "failed", reason: "malformed-answer" });
    expect(readArtifactEditOutcome({ outcome: "saved" })).toEqual({
      outcome: "failed",
      reason: "malformed-answer",
    });
  });

  it("refuses a change set over the cap before it reaches the host at all", async () => {
    const fetchImpl = vi.fn();
    const outcome = await saveArtifactEdit(
      { ...EDITABLE, capBytes: 8 },
      "far more than eight bytes",
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(outcome).toEqual({ outcome: "refused", reason: "over-cap" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(artifactEditByteLength("é")).toBe(2);
  });

  it("refuses to send under a capability that does not grant the edit", async () => {
    const fetchImpl = vi.fn();
    const outcome = await saveArtifactEdit(
      { kind: "read-only", channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION, reason: "read-only-surface" },
      "# Two\n",
      { fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(outcome).toEqual({ outcome: "refused", reason: "no-write-rights" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the save road's decisions", () => {
  it("writes ONE new revision for a change set", async () => {
    const writeBytes = vi.fn(async () => ({ resourceId: "resource-2" }));
    const appendWithBase = vi.fn(async () => ({
      kind: "appended" as const,
      revisionId: "rev-2",
      revision: 2,
    }));
    const outcome = await save("# Two\n", { writeBytes, appendWithBase });
    expect(outcome).toEqual({ outcome: "saved", revisionId: "rev-2", revision: 2 });
    expect(appendWithBase).toHaveBeenCalledTimes(1);
    expect((appendWithBase.mock.calls as unknown as Array<[{ baseRevisionId: string }]>)[0][0]).toMatchObject({
      baseRevisionId: "rev-1",
    });
  });

  it("writes NOTHING when the change set equals the base — an unchanged save", async () => {
    const writeBytes = vi.fn(async () => ({ resourceId: "resource-2" }));
    const appendWithBase = vi.fn();
    const outcome = await save("# One\n", { writeBytes, appendWithBase });
    expect(outcome).toEqual({ outcome: "unchanged", revisionId: "rev-1" });
    expect(writeBytes).not.toHaveBeenCalled();
    expect(appendWithBase).not.toHaveBeenCalled();
  });

  it("refuses a save over a newer revision and answers with that revision's text", async () => {
    const appendWithBase = vi.fn();
    const outcome = await save("# Two\n", {
      readLatest: async () => ({
        revisionId: "rev-9",
        revision: 9,
        resourceId: "resource-9",
        mime: "text/markdown",
        form: "file" as const,
      }),
      readText: async ({ representationRevisionId }) =>
        representationRevisionId === "rev-9"
          ? { text: "# Nine\n", truncated: false }
          : { text: "# One\n", truncated: false },
      appendWithBase,
    });
    expect(outcome).toEqual({
      outcome: "stale",
      latestRevisionId: "rev-9",
      latestRevision: 9,
      text: "# Nine\n",
      truncated: false,
    });
    expect(appendWithBase).not.toHaveBeenCalled();
  });

  it("refuses a save the index refused, and reloads rather than overwriting", async () => {
    let latest = { revisionId: "rev-1", revision: 1, resourceId: "r", mime: "text/markdown", form: "file" as const };
    const outcome = await save("# Two\n", {
      readLatest: async () => latest,
      readText: async ({ representationRevisionId }) => ({
        text: representationRevisionId === "rev-2" ? "# Someone else\n" : "# One\n",
        truncated: false,
      }),
      appendWithBase: async () => {
        // The race the unique index catches: another save committed revision 2
        // between the read above and this insert.
        latest = { revisionId: "rev-2", revision: 2, resourceId: "r2", mime: "text/markdown", form: "file" };
        return { kind: "stale" as const };
      },
    });
    expect(outcome).toMatchObject({ outcome: "stale", latestRevisionId: "rev-2", text: "# Someone else\n" });
  });

  it("refuses a reader without write rights before it reads or writes anything", async () => {
    const readLatest = vi.fn();
    const writeBytes = vi.fn();
    const outcome = await save("# Two\n", { mayWrite: async () => false, readLatest, writeBytes });
    expect(outcome).toEqual({ outcome: "refused", reason: "no-write-rights" });
    expect(readLatest).not.toHaveBeenCalled();
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it("refuses an artifact with nothing stored, and a form that is not text", async () => {
    await expect(save("# Two\n", { readLatest: async () => null })).resolves.toEqual({
      outcome: "refused",
      reason: "no-representation",
    });
    await expect(
      save("# Two\n", {
        readLatest: async () => ({
          revisionId: "rev-1",
          revision: 1,
          resourceId: "r",
          mime: "image/png",
          form: "file" as const,
        }),
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "unsupported-form" });
    await expect(
      save("# Two\n", {
        readLatest: async () => ({
          revisionId: "rev-1",
          revision: 1,
          resourceId: "r",
          mime: "text/markdown",
          form: "dashboard" as const,
        }),
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "unsupported-form" });
  });

  it("refuses a change set over the cap, and one whose base is not stored", async () => {
    await expect(save("x".repeat(ARTIFACT_EDIT_TEXT_CAP_BYTES + 1))).resolves.toEqual({
      outcome: "refused",
      reason: "over-cap",
    });
    await expect(
      save("# Two\n", { appendWithBase: async () => ({ kind: "unknown-base" as const }) }),
    ).resolves.toEqual({ outcome: "refused", reason: "unknown-base" });
  });

  it("never saves over a document the channel only carried a prefix of", async () => {
    await expect(
      save("# Two\n", { readText: async () => ({ text: "# One\n", truncated: true }) }),
    ).resolves.toEqual({ outcome: "refused", reason: "over-cap" });
  });
});

describe("the props say which surface this is", () => {
  const artifact = {
    artifactId: "artifact-1",
    title: "A draft",
    objectType: "@cinatra-ai/markdown-artifact:artifact",
    mime: "text/markdown",
    size: 12,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ownerLevel: "user" as const,
    visibility: "private" as const,
    sourceUrl: null,
    effectiveIdentity: { kind: "extension" as const, extension: "@cinatra-ai/markdown-artifact" },
  };

  it("carries a NAMED refusal when a surface does not mint an edit", () => {
    const props = buildArtifactRendererProps({
      artifact: artifact as never,
      representation: { revisionId: "rev-1", mime: "text/markdown" },
      previewHref: null,
      downloadHref: null,
      content: absentArtifactContent("rev-1"),
      edit: readOnlyArtifactEdit("read-only-surface"),
    });
    expect(props.edit).toEqual({
      kind: "read-only",
      channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION,
      reason: "read-only-surface",
    });
    expect(isArtifactEditGranted(props.edit)).toBe(false);
  });

  it("carries the capability whole when a surface does mint one", () => {
    const props = buildArtifactRendererProps({
      artifact: artifact as never,
      representation: { revisionId: "rev-1", mime: "text/markdown" },
      previewHref: null,
      downloadHref: null,
      content: absentArtifactContent("rev-1"),
      edit: EDITABLE,
    });
    expect(props.edit).toEqual(EDITABLE);
    expect(isArtifactEditGranted(props.edit)).toBe(true);
  });
});
