/**
 * cinatra#4264, the reader and dispatch slice: a Regenerate puts the
 * reviewer's note into exactly the input the producing step declares, and
 * nowhere else.
 *
 * The note is the words of the review floor's Note field, as the reviewer left
 * them (the `prompt-window` finding the review store records, read with
 * `readRegenerateNote`); a picture's prompt is its own field (`picture-prompt`).
 * Each fills only the input declared for it (`routeRegenerateFindings`). The
 * words are never the generic findings text (a lead sentence and numbered
 * lines), and the typed repair request the segment run carries holds no
 * findings, so the words appear once in the run's inputs. The drain's own use
 * of the routing is pinned in `lifecycle-repair-dispatch-start-inputs.test.ts`.
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
const PROMPT = "a lighthouse at dusk, wide angle";

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
 *  and the picture's prompt, here with other words than the note. */
const PICTURE_FINDINGS = [
  { id: "prompt-window", message: NOTE },
  { id: "picture-prompt", message: PROMPT },
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

describe("routeRegenerateFindings: each review field fills only its own declared input", () => {
  type Route = (findings: unknown, noteInput: string) => { value: string; deliveredFindingIds: string[] } | null;
  const route = () => (lifecyclePolicy as Record<string, unknown>).routeRegenerateFindings as Route | undefined;

  // red-first-expect: expected 'undefined' to be 'function' // Object.is equality
  it("gives a picture's declared input its prompt, and delivers the note only when its words are the same", () => {
    expect(typeof route()).toBe("function");
    expect(route()!(PICTURE_FINDINGS, "prompt")).toEqual({ value: PROMPT, deliveredFindingIds: ["picture-prompt"] });
    // The review floor sends the Note field's words as the prompt too: then
    // both findings are given to the run, in the one input.
    expect(
      route()!([
        { id: "prompt-window", message: PROMPT },
        { id: "picture-prompt", message: PROMPT },
      ], "prompt"),
    ).toEqual({ value: PROMPT, deliveredFindingIds: ["prompt-window", "picture-prompt"] });
    // A picture review with no recorded prompt: its Note fills the prompt.
    expect(route()!([{ id: "prompt-window", message: NOTE }], "prompt")).toEqual({
      value: NOTE,
      deliveredFindingIds: ["prompt-window"],
    });
  });

  it("a picture step's malformed prompt never falls back to the note", () => {
    expect(typeof route()).toBe("function");
    for (const prompt of ["   ", 7]) {
      expect(
        route()!([{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: prompt }], "prompt"),
      ).toBeNull();
    }
    expect(
      route()!([
        { id: "prompt-window", message: NOTE },
        { id: "picture-prompt", message: PROMPT },
        { id: "picture-prompt", message: NOTE },
      ], "prompt"),
    ).toBeNull();
    expect(route()!([{ id: "finding-1", message: NOTE }], "prompt")).toBeNull();
    expect(route()!(null, "prompt")).toBeNull();
  });

  it("gives every other step's declared input the Note: a submitted prompt is never sent and never delivered", () => {
    expect(typeof route()).toBe("function");
    expect(route()!([{ id: "prompt-window", message: NOTE }], "note")).toEqual({
      value: NOTE,
      deliveredFindingIds: ["prompt-window"],
    });
    // The step decides, not the request: a draft's Regenerate that also
    // carries a prompt takes the Note.
    expect(route()!(PICTURE_FINDINGS, "note")).toEqual({ value: NOTE, deliveredFindingIds: ["prompt-window"] });
    // A prompt with the Note's own words is still not delivered to the step.
    expect(
      route()!([{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: NOTE }], "note"),
    ).toEqual({ value: NOTE, deliveredFindingIds: ["prompt-window"] });
    // A malformed prompt does not belong to the step and changes nothing.
    expect(route()!([{ id: "prompt-window", message: NOTE }, { id: "picture-prompt", message: "  " }], "note")).toEqual({
      value: NOTE,
      deliveredFindingIds: ["prompt-window"],
    });
    // A prompt alone gives the step nothing.
    expect(route()!([{ id: "picture-prompt", message: PROMPT }], "note")).toBeNull();
    expect(route()!([{ id: "finding-1", message: NOTE }], "note")).toBeNull();
    expect(route()!(null, "note")).toBeNull();
  });
});

describe("planSegmentDispatch: the declared input's words go there and nowhere else", () => {
  it("puts the routed words under the start output that feeds the declared input, unwrapped; the other field's words appear nowhere", async () => {
    const d = deps();
    const planned = await planSegmentDispatch(
      {
        repair: intent(),
        templateId: "tpl-1",
        packageName: "@any-vendor/pipeline",
        lifecycleConfig: LIFECYCLE,
        // The picture step's declared input takes the picture's prompt.
        findings: PICTURE_FINDINGS,
        request: request(PICTURE_FINDINGS),
      },
      d,
    );
    expect(planned).toEqual({
      kind: "segment",
      parentRunId: PROVENANCE_RUN,
      inputParams: {
        imagePrompt: PROMPT,
        lifecycleRepairRequest: {
          kind: "lifecycle_repair_request",
          repairId: "repair-1",
          findings: [],
          // The declared input the run is made for, with no words.
          regenerateInput: { artifactNode: "file_image", step: "image_flow", noteInput: "prompt", startOutput: "imagePrompt" },
        },
      },
    });
    expect(JSON.stringify(planned)).not.toContain(NOTE);
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
        findings: [{ id: "prompt-window", message: NOTE }],
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

  it("a draft step whose findings also carry a picture prompt takes the Note; the prompt appears nowhere", async () => {
    const planned = await planSegmentDispatch(
      {
        repair: intent({ regenerateNodeId: "write_draft" }),
        templateId: "tpl-1",
        packageName: "@any-vendor/pipeline",
        lifecycleConfig: LIFECYCLE,
        findings: PICTURE_FINDINGS,
        request: request(PICTURE_FINDINGS),
      },
      deps("write_draft", "draftNote"),
    );
    expect(planned.kind).toBe("segment");
    if (planned.kind !== "segment") throw new Error("unreachable");
    expect(planned.inputParams.draftNote).toBe(NOTE);
    expect(JSON.stringify(planned.inputParams)).not.toContain(PROMPT);
  });

  it("refuses a Regenerate whose repair carries no note: nothing is dispatched with an empty input", async () => {
    for (const note of [null, "", "   "]) {
      const findings = note === null ? [] : [{ id: "prompt-window", message: note }];
      const planned = await planSegmentDispatch(
        {
          repair: intent(),
          templateId: "tpl-1",
          packageName: "@any-vendor/pipeline",
          lifecycleConfig: LIFECYCLE,
          findings,
          request: request(findings),
        },
        deps(),
      );
      expect(planned.kind, JSON.stringify(note)).toBe("refused");
    }
  });
});
