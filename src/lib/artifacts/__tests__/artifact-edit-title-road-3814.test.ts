// cinatra#3814 — A DISPLAY CAN EDIT THE TITLE OF ITS ARTIFACT.
//
// The acceptance this file pins, in the issue's own words:
//
//   1. "The edit channel lets a display change the title of its artifact, as its
//      own field beside the text … The channel version moves, and a display that
//      declared the older version keeps the contract it has."
//   2. "The artifact page's save route stores a title change as a new revision
//      under the same rules as a text change: the base revision is checked, the
//      actor's write access is checked, and a stale base is refused by name."
//   3. "Tests, red first: a title change through the channel stores the title and
//      leaves the text untouched; a text change leaves the title untouched; a
//      display on the older channel version is handed no title road; a stale base
//      and a missing write access are refused."
//
// WITHOUT A DATABASE: the channel's contract, the props rule that hands an older
// display the older capability, the change-set reader, and the save road's
// decisions over injected ports. The row write and the revision it rides are
// proved against a real Postgres in `lifecycle-c-w2-editor-save.integration.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_EDIT_CHANNEL_VERSION,
  ARTIFACT_EDIT_IDLE_PAUSE_MS,
  ARTIFACT_EDIT_TEXT_CAP_BYTES,
  isArtifactEditGranted,
  isArtifactTitleEditGranted,
  saveArtifactEdit,
  saveArtifactTitleEdit,
  type ArtifactEditCapability,
} from "@cinatra-ai/sdk-extensions/artifact-edit-channel";

import {
  ARTIFACT_EDIT_CHANNEL_VERSION as HOST_EDIT_CHANNEL_VERSION,
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION,
  absentArtifactContent,
  artifactRendererPropsAtVersion,
  buildArtifactRendererProps,
  grantArtifactEdit,
  readOnlyArtifactEdit,
} from "@/lib/artifacts/artifact-renderer-props";
import {
  readArtifactEditChangeSet,
  saveArtifactMarkdownEdit,
  saveArtifactTitleEdit as saveArtifactTitleOnHost,
  type ArtifactTitleEditSavePorts,
} from "@/lib/artifacts/artifact-edit-save";

afterEach(() => {
  vi.restoreAllMocks();
});

const GRANTED = grantArtifactEdit({
  artifactId: "artifact-1",
  baseRevisionId: "rev-1",
  saveUrl: "/api/artifacts/artifact-1/edit",
  idlePauseMs: ARTIFACT_EDIT_IDLE_PAUSE_MS,
  capBytes: ARTIFACT_EDIT_TEXT_CAP_BYTES,
});

const ARTIFACT = {
  artifactId: "artifact-1",
  title: "A draft",
  objectType: "@fixture/text-display:artifact",
  mime: "text/markdown",
  size: 12,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ownerLevel: "user" as const,
  visibility: "private" as const,
  sourceUrl: null,
  effectiveIdentity: { kind: "extension" as const, extension: "@fixture/text-display" },
};

const BASE = {
  artifact: ARTIFACT as never,
  representation: { revisionId: "rev-1", mime: "text/markdown" },
  previewHref: "/api/artifacts/artifact-1/versions/rev-1/preview",
  downloadHref: "/api/artifacts/artifact-1/versions/rev-1/content",
  content: absentArtifactContent("rev-1"),
};

/** Every props version below the one that carries the title road. */
function olderPropsVersions(): number[] {
  const versions: number[] = [];
  for (let v = 1; v < ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION; v += 1) versions.push(v);
  return versions;
}

function answer(body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

function titlePorts(over: Partial<ArtifactTitleEditSavePorts> = {}): ArtifactTitleEditSavePorts {
  return {
    mayWrite: async () => true,
    readLatest: async () => ({
      revisionId: "rev-1",
      revision: 1,
      resourceId: "resource-1",
      mime: "text/markdown",
      form: "file" as const,
    }),
    readText: async () => ({ text: "# A draft\n", truncated: false }),
    readTitle: async () => "A draft",
    writeBytes: async () => ({ resourceId: "resource-2" }),
    appendWithBase: async () => ({ kind: "appended" as const, revisionId: "rev-2", revision: 2 }),
    ...over,
  };
}

const saveTitle = (title: string, ports: ArtifactTitleEditSavePorts) =>
  saveArtifactTitleOnHost(
    { orgId: "org-1", artifactId: "artifact-1", baseRevisionId: "rev-1", title, actor: "user-1" },
    ports,
  );

describe("cinatra#3814 — the edit channel lets a display change the title of its artifact, as its own field beside the text", () => {
  it("T-a the title road is granted on the artifact page's capability, and never on a refusal", () => {
    expect(ARTIFACT_EDIT_CHANNEL_VERSION).toBe(2);
    expect(HOST_EDIT_CHANNEL_VERSION).toBe(ARTIFACT_EDIT_CHANNEL_VERSION);
    expect(GRANTED.channelVersion).toBe(ARTIFACT_EDIT_CHANNEL_VERSION);
    expect(isArtifactEditGranted(GRANTED)).toBe(true);
    expect(isArtifactTitleEditGranted(GRANTED)).toBe(true);

    const refused = readOnlyArtifactEdit("no-write-rights");
    expect(isArtifactEditGranted(refused)).toBe(false);
    expect(isArtifactTitleEditGranted(refused)).toBe(false);
  });

  it("T-b a display on the older channel version is handed no title road, and keeps its text road", () => {
    expect(ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION).toBe(ARTIFACT_RENDERER_PROPS_API_VERSION);
    expect(olderPropsVersions()).toEqual([1, 2, 3]);

    const ceiling = buildArtifactRendererProps({ ...BASE, edit: GRANTED });
    for (const version of olderPropsVersions()) {
      const narrowed = artifactRendererPropsAtVersion(ceiling, version);
      const built = buildArtifactRendererProps({ ...BASE, edit: GRANTED, propsApiVersion: version });
      for (const handed of [narrowed.edit, built.edit]) {
        expect(handed.channelVersion, `channel at props ${version}`).toBe(1);
        expect(Object.prototype.hasOwnProperty.call(handed, "fields"), `fields at props ${version}`).toBe(
          false,
        );
        expect(isArtifactEditGranted(handed), `text road at props ${version}`).toBe(true);
        expect(isArtifactTitleEditGranted(handed), `title road at props ${version}`).toBe(false);
      }
    }

    const atTitle = buildArtifactRendererProps({
      ...BASE,
      edit: GRANTED,
      propsApiVersion: ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION,
    });
    expect(atTitle.edit).toEqual(GRANTED);
    expect(artifactRendererPropsAtVersion(ceiling, ARTIFACT_RENDERER_PROPS_TITLE_EDIT_VERSION).edit).toEqual(
      GRANTED,
    );
  });

  it("T-c the older contract on the wire: today's text body, no title road, and the host reads it as before", async () => {
    const older = artifactRendererPropsAtVersion(
      buildArtifactRendererProps({ ...BASE, edit: GRANTED }),
      1,
    ).edit as ArtifactEditCapability;

    const fetchText = answer({ outcome: "saved", revisionId: "rev-2", revision: 2 });
    await saveArtifactEdit(older, "# A draft\n", { fetch: fetchText as unknown as typeof fetch });
    const [url, init] = fetchText.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/artifacts/artifact-1/edit");
    expect(JSON.parse(String(init.body))).toEqual({
      channelVersion: 1,
      baseRevisionId: "rev-1",
      text: "# A draft\n",
    });

    const fetchTitle = vi.fn();
    const outcome = await saveArtifactTitleEdit(older, "The subject", {
      fetch: fetchTitle as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ outcome: "refused", reason: "no-write-rights" });
    expect(fetchTitle).not.toHaveBeenCalled();

    expect(readArtifactEditChangeSet({ channelVersion: 1, baseRevisionId: "rev-1", text: "# A draft\n" })).toEqual({
      field: "text",
      baseRevisionId: "rev-1",
      text: "# A draft\n",
    });
    expect(
      readArtifactEditChangeSet({ channelVersion: 1, baseRevisionId: "rev-1", field: "title", title: "The subject" }),
    ).toBeNull();
    expect(
      readArtifactEditChangeSet({
        channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION + 1,
        baseRevisionId: "rev-1",
        text: "# A draft\n",
      }),
    ).toBeNull();
    expect(
      readArtifactEditChangeSet({
        channelVersion: ARTIFACT_EDIT_CHANNEL_VERSION,
        baseRevisionId: "rev-1",
        field: "sender",
        title: "The subject",
      }),
    ).toBeNull();
  });

  it("T-d a title change through the channel stores the title and leaves the text untouched", async () => {
    const fetchImpl = answer({ outcome: "saved", revisionId: "rev-2", revision: 2 });
    const sent = await saveArtifactTitleEdit(GRANTED, "The subject", {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(sent).toEqual({ outcome: "saved", revisionId: "rev-2", revision: 2 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/artifacts/artifact-1/edit");
    expect(JSON.parse(String(init.body))).toEqual({
      channelVersion: 2,
      baseRevisionId: "rev-1",
      field: "title",
      title: "The subject",
    });
    // The host reads the very body the channel sent as a title change set.
    expect(readArtifactEditChangeSet(JSON.parse(String(init.body)))).toEqual({
      field: "title",
      baseRevisionId: "rev-1",
      title: "The subject",
    });

    const order: string[] = [];
    const writeBytes = vi.fn(async () => ({ resourceId: "resource-2" }));
    const appendWithBase = vi.fn(async () => {
      order.push("appendWithBase");
      return { kind: "appended" as const, revisionId: "rev-2", revision: 2 };
    });
    const outcome = await saveTitle(
      "The subject",
      titlePorts({
        mayWrite: async () => {
          order.push("mayWrite");
          return true;
        },
        readLatest: async () => {
          order.push("readLatest");
          return { revisionId: "rev-1", revision: 1, resourceId: "resource-1", mime: "text/markdown", form: "file" };
        },
        writeBytes,
        appendWithBase,
      }),
    );
    expect(outcome).toEqual({ outcome: "saved", revisionId: "rev-2", revision: 2 });
    expect(order[0]).toBe("mayWrite");
    expect(appendWithBase).toHaveBeenCalledTimes(1);
    expect((appendWithBase.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]).toMatchObject({
      orgId: "org-1",
      artifactId: "artifact-1",
      baseRevisionId: "rev-1",
      baseRevision: 1,
      resourceId: "resource-1",
      title: "The subject",
    });
    expect(writeBytes).not.toHaveBeenCalled();

    const writeAgain = vi.fn();
    const appendAgain = vi.fn();
    const same = await saveTitle(
      "The subject",
      titlePorts({ readTitle: async () => "The subject", writeBytes: writeAgain, appendWithBase: appendAgain }),
    );
    expect(same).toEqual({ outcome: "unchanged", revisionId: "rev-1" });
    expect(writeAgain).not.toHaveBeenCalled();
    expect(appendAgain).not.toHaveBeenCalled();
  });

  it("T-e a text change leaves the title untouched", async () => {
    const readTitle = vi.fn(async () => "A draft");
    const appendWithBase = vi.fn(async () => ({ kind: "appended" as const, revisionId: "rev-2", revision: 2 }));
    const outcome = await saveArtifactMarkdownEdit(
      { orgId: "org-1", artifactId: "artifact-1", baseRevisionId: "rev-1", text: "# Two\n", actor: "user-1" },
      titlePorts({ readTitle, appendWithBase }),
    );
    expect(outcome).toEqual({ outcome: "saved", revisionId: "rev-2", revision: 2 });
    expect(appendWithBase).toHaveBeenCalledTimes(1);
    const input = (appendWithBase.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(Object.prototype.hasOwnProperty.call(input, "title")).toBe(false);
    expect(readTitle).not.toHaveBeenCalled();
  });

  it("T-f a stale base and a missing write access are refused", async () => {
    const appendStale = vi.fn();
    const stale = await saveTitle(
      "The subject",
      titlePorts({
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
            : { text: "# A draft\n", truncated: false },
        appendWithBase: appendStale,
      }),
    );
    expect(stale).toEqual({
      outcome: "stale",
      latestRevisionId: "rev-9",
      latestRevision: 9,
      text: "# Nine\n",
      truncated: false,
      title: "A draft",
    });
    expect(appendStale).not.toHaveBeenCalled();

    let latest = { revisionId: "rev-1", revision: 1, resourceId: "resource-1", mime: "text/markdown", form: "file" as const };
    const raced = await saveTitle(
      "The subject",
      titlePorts({
        readLatest: async () => latest,
        readText: async ({ representationRevisionId }) => ({
          text: representationRevisionId === "rev-2" ? "# Someone else\n" : "# A draft\n",
          truncated: false,
        }),
        appendWithBase: async () => {
          latest = { revisionId: "rev-2", revision: 2, resourceId: "resource-2", mime: "text/markdown", form: "file" };
          return { kind: "stale" as const };
        },
      }),
    );
    expect(raced).toMatchObject({
      outcome: "stale",
      latestRevisionId: "rev-2",
      text: "# Someone else\n",
      title: "A draft",
    });

    const readLatest = vi.fn();
    const appendDenied = vi.fn();
    const denied = await saveTitle(
      "The subject",
      titlePorts({ mayWrite: async () => false, readLatest, appendWithBase: appendDenied }),
    );
    expect(denied).toEqual({ outcome: "refused", reason: "no-write-rights" });
    expect(readLatest).not.toHaveBeenCalled();
    expect(appendDenied).not.toHaveBeenCalled();

    const appendOver = vi.fn();
    const over = await saveTitle(
      "x".repeat(ARTIFACT_EDIT_TEXT_CAP_BYTES + 1),
      titlePorts({ appendWithBase: appendOver }),
    );
    expect(over).toEqual({ outcome: "refused", reason: "over-cap" });
    expect(appendOver).not.toHaveBeenCalled();
  });
});
