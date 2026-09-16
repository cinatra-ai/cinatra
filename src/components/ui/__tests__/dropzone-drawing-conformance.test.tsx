// Dropzone — the graded checklist against the components drawing
// (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/dropzone-drawing-conformance.test.tsx
//
// THE DRAWING IS SILENT ON THIS PRIMITIVE, and this file is the record of that
// finding rather than a graded checklist.
//
// The components drawing has forty-seven sections; none of them is a dropzone,
// a file field or an upload area. The nearest neighbours state nothing that
// reaches it: "Input / Textarea" describes a single-line control's chrome,
// "Empty state" describes a surface with no content rather than one waiting for
// a file, and "Progress" — which this component's own InfiniteProgress
// resembles — is the section for the standalone Progress primitive.
//
// So there is no clause to grade and nothing to fix. Filing a departure here
// would mean inventing a rule the drawing does not contain, which the leg's
// brief forbids: a checklist sentence the drawing does not state is a defect of
// the brief, to be recorded rather than built to.
//
// WHY THIS FILE READS SOURCE RATHER THAN RENDERING. Every part of this
// component requires an upload context built by its `useDropzone` hook, which
// takes an `onDropFile` uploader and a validator. Standing one up here would
// put a fake uploader between the assertion and the component, so the test
// would grade the harness. Since the drawing states no clause to render
// AGAINST, the useful record is the chrome the module declares — read as text,
// which is exactly the form the `packages/connectors` suites already use for
// source-level design decisions in this repository.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "dropzone.tsx"),
  "utf8",
);

describe("the drawing states no clause for this primitive", () => {
  // NOT APPLICABLE, with the reason: the components drawing contains no
  // dropzone, file-field or upload section, and no neighbouring section's
  // clauses reach this component. Recorded for leg 2 to put to the drawing.
  it.skip(
    "not applicable: the components drawing contains no dropzone, file-field or upload section — recorded for leg 2 to put to the drawing rather than graded against an invented rule",
    () => {},
  );
});

describe("it borrows the drawn control chrome rather than inventing its own", () => {
  it("draws its drop area on the chrome the 'Input / Textarea' section states", () => {
    // Not a clause ABOUT the dropzone — it has none — but the strongest
    // available evidence that it has not invented a private chrome: it reuses
    // the surface, the control hairline and the 7px corner the drawing states
    // for the control it most resembles.
    expect(SRC).toContain("rounded-[7px]");
    expect(SRC).toContain("border-input");
    expect(SRC).toContain("bg-surface-strong");
  });

  it("raises the shared ring token on focus, as every drawn control does", () => {
    expect(SRC).toContain("ring-ring");
  });

  it("sets its error lines in the destructive ink, as the Form section states for errors", () => {
    // "error swaps helper red" is the one clause anywhere in the drawing that
    // reaches this component's messages, and it is followed.
    expect(SRC).toContain("text-destructive");
  });

  it("draws its progress bar from the shared muted and primary tokens", () => {
    expect(SRC).toContain("bg-muted");
    expect(SRC).toContain("bg-primary");
  });

  it("invents no colour of its own — no literal colour value anywhere in the module", () => {
    // The clearest form of "has not invented a private chrome": every colour it
    // draws comes from the palette, so it will follow the drawing wherever the
    // drawing goes.
    //
    // Comments are stripped before the scan: the module cites two upstream
    // issue numbers ("#1458", "#1430") that a bare hex pattern would read as
    // colours. What is scanned is the code.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(code).not.toMatch(/\b(rgba?|hsla?|oklch)\(/);
  });
});
