/**
 * cinatra#4264, the reader and dispatch slice: a Regenerate puts the
 * reviewer's note into exactly the input the producing step declares, and
 * nowhere else.
 *
 * The note is the words of the review floor's Note field, as the reviewer left
 * them (the `prompt-window` finding the review store records, read with
 * `readRegenerateNote`). It is never the generic findings text (a lead sentence
 * and numbered lines), and the typed repair request the segment run carries
 * holds no findings, so the note's words appear once in the run's inputs. The
 * drain's own use of the reader is pinned in
 * `lifecycle-repair-dispatch-start-inputs.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import * as lifecyclePolicy from "@/lib/lifecycle/lifecycle-policy";
import { planSegmentDispatch } from "../regenerate-segment";

const PROVENANCE_RUN = "run-provenance";
const LIFECYCLE = JSON.stringify({
  regenerate: [
    { artifactNode: "file_image", step: "image_flow", noteInput: "prompt" },
    { artifactNode: "write_draft", step: "draft_flow", noteInput: "note" },
  ],
});
const NOTE = "a brighter sky over the harbour";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: "repair-1",
    orgId: "org-1",
    regenerateNodeId: "file_image",
    baseArtifactId: "artifact-1",
    baseRepresentationRevisionId: "revision-1",
    ...overrides,
  };
}

/** The findings the review store records for a picture's Regenerate: the note,
 *  and the same words again as the recorded prompt. */
const PICTURE_FINDINGS = [
  { id: "prompt-window", message: NOTE },
  { id: "picture-prompt", message: NOTE },
];

function request(findings: unknown) {
  return { kind: "lifecycle_repair_request", repairId: "repair-1", findings };
}

const deps = (nodeId = "file_image", startOutput: string | null = "imagePrompt") => ({
  readVerifiedFilingNode: vi.fn(async () => ({ runId: PROVENANCE_RUN, nodeId })),
  readNoteStartOutput: vi.fn(async () => startOutput),
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("readRegenerateNote: the reviewer's note of a Regenerate repair", () => {
  it("is the Note field's words, verbatim, from the prompt-window finding", () => {
    const { readRegenerateNote, REVIEW_NOTE_FINDING_ID } = lifecyclePolicy as Record<string, unknown> as {
      readRegenerateNote?: (findings: unknown) => string | null;
      REVIEW_NOTE_FINDING_ID?: string;
    };
    expect(typeof readRegenerateNote).toBe("function");
    expect(REVIEW_NOTE_FINDING_ID).toBe("prompt-window");
    expect(readRegenerateNote!(PICTURE_FINDINGS)).toBe(NOTE);
    expect(readRegenerateNote!([{ id: "prompt-window", message: "line one\nline two" }])).toBe("line one\nline two");
  });

  it("is null when no single non-blank note finding exists; another finding never stands in", () => {
    const { readRegenerateNote } = lifecyclePolicy as Record<string, unknown> as {
      readRegenerateNote?: (findings: unknown) => string | null;
    };
    expect(typeof readRegenerateNote).toBe("function");
    expect(readRegenerateNote!([{ id: "picture-prompt", message: NOTE }])).toBeNull();
    expect(readRegenerateNote!([{ id: "finding-1", message: NOTE }])).toBeNull();
    expect(readRegenerateNote!([{ id: "prompt-window", message: "   " }])).toBeNull();
    expect(readRegenerateNote!([{ id: "prompt-window", message: 7 }])).toBeNull();
    expect(
      readRegenerateNote!([
        { id: "prompt-window", message: "one" },
        { id: "prompt-window", message: "two" },
      ]),
    ).toBeNull();
    expect(readRegenerateNote!(null)).toBeNull();
    expect(readRegenerateNote!("prompt-window")).toBeNull();
  });
});

describe("planSegmentDispatch: the note goes into the declared input and nowhere else", () => {
  it("puts the Note field's words under the start output that feeds the declared input, unwrapped", async () => {
    const d = deps();
    const planned = await planSegmentDispatch(
      {
        repair: intent(),
        templateId: "tpl-1",
        packageName: "@any-vendor/pipeline",
        lifecycleConfig: LIFECYCLE,
        note: NOTE,
        request: request(PICTURE_FINDINGS),
      },
      d,
    );
    expect(planned).toEqual({
      kind: "segment",
      parentRunId: PROVENANCE_RUN,
      inputParams: {
        imagePrompt: NOTE,
        lifecycleRepairRequest: { kind: "lifecycle_repair_request", repairId: "repair-1", findings: [] },
      },
    });
    // The declared step's own input is what the start output was looked up for.
    expect(d.readNoteStartOutput).toHaveBeenCalledWith({
      packageName: "@any-vendor/pipeline",
      step: "image_flow",
      noteInput: "prompt",
    });
  });

  it("carries the note's words exactly once in the whole run input, for the draft step too", async () => {
    const planned = await planSegmentDispatch(
      {
        repair: intent({ regenerateNodeId: "write_draft" }),
        templateId: "tpl-1",
        packageName: "@any-vendor/pipeline",
        lifecycleConfig: LIFECYCLE,
        note: NOTE,
        request: request([{ id: "prompt-window", message: NOTE }]),
      },
      deps("write_draft", "draftNote"),
    );
    expect(planned.kind).toBe("segment");
    if (planned.kind !== "segment") throw new Error("unreachable");
    expect(Object.keys(planned.inputParams).sort()).toEqual(["draftNote", "lifecycleRepairRequest"]);
    expect(planned.inputParams.draftNote).toBe(NOTE);
    expect(occurrences(JSON.stringify(planned.inputParams), NOTE)).toBe(1);
    expect(JSON.stringify(planned.inputParams)).not.toContain(lifecyclePolicy.REPAIR_FINDINGS_TEXT_LEAD);
  });

  it("refuses a Regenerate whose repair carries no note: nothing is dispatched with an empty input", async () => {
    for (const note of [null, "", "   "]) {
      const planned = await planSegmentDispatch(
        {
          repair: intent(),
          templateId: "tpl-1",
          packageName: "@any-vendor/pipeline",
          lifecycleConfig: LIFECYCLE,
          note,
          request: request([]),
        },
        deps(),
      );
      expect(planned.kind, JSON.stringify(note)).toBe("refused");
    }
  });
});
