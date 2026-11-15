// agent_run_resume's message text and submitted values, read from the resume input
// (moved out of handlers.ts under the file-size ratchet). The precedence is the UI
// approve's: userResponse unchanged, else the trimmed approvalNote, else the fallback.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resumeMessageFromInput } from "../resume-message";

describe("resumeMessageFromInput", () => {
  it("sends userResponse unchanged and takes its JSON object as the submitted values", () => {
    const userResponse = '{ "a": 1 }\n';
    expect(resumeMessageFromInput(userResponse, " note ")).toEqual({
      resumeText: userResponse,
      trimmedNote: "note",
      submittedValues: { a: 1 },
    });
  });

  it("keeps no submitted values when userResponse is no JSON object", () => {
    expect(resumeMessageFromInput("plain text", undefined).submittedValues).toBeNull();
    expect(resumeMessageFromInput("[1, 2]", undefined).submittedValues).toBeNull();
    expect(resumeMessageFromInput("null", undefined).submittedValues).toBeNull();
  });

  it("falls back to the trimmed approvalNote, then to the operator default", () => {
    expect(resumeMessageFromInput("   ", "  ok  ")).toEqual({ resumeText: "ok", trimmedNote: "ok", submittedValues: null });
    expect(resumeMessageFromInput(undefined, "  ")).toEqual({
      resumeText: "[Approved by operator]",
      trimmedNote: "",
      submittedValues: null,
    });
    expect(resumeMessageFromInput(42, { note: "x" })).toEqual({
      resumeText: "[Approved by operator]",
      trimmedNote: "",
      submittedValues: null,
    });
  });

  it("is what agent_run_resume sends", () => {
    const source = readFileSync(path.resolve(__dirname, "../handlers.ts"), "utf8");
    expect(source).toMatch(/= resumeMessageFromInput\(userResponse, approvalNote\);/);
    expect(source).not.toMatch(/resumeText = "\[Approved by operator\]"/);
  });
});
