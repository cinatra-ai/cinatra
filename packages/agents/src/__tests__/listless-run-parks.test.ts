/**
 * cinatra#3358 acceptance 2 — A LISTLESS RUN PARKS AT ITS ACCOUNT-SCOPE STEP.
 *
 * "A run started with no list does not walk past its review steps: it parks at
 * the account-scope step until a list exists."
 *
 * WHAT WAS MEASURED, and why this file exists. A run started on an account that
 * holds no list reached its account-scope step and could be continued with
 * nothing chosen: the panel sent `{approved:true}` beside a snapshot naming an
 * EMPTY list, the resume dispatched, and the run walked past that review step
 * and the one after it — completing without ever raising a gate on the missing
 * list. Neither end of the submit asked the one question the step exists to
 * ask. Both ends ask it now, from ONE rule.
 *
 * WHAT IS PINNED HERE:
 *   (1) the rule itself, at both ends — the renderer family the drawn surface
 *       reads, and the answer contract the resume seam reads;
 *   (2) that it is GENERIC: it knows no package, and it leaves every other
 *       gate family, and a bare click-to-approve, untouched;
 *   (3) that both ends are actually WIRED to it, each at the point that keeps
 *       the run where it is — the panel BEFORE its optimistic hand-off, the
 *       resume seam BEFORE the prompt write and the dispatch.
 *
 * (3) is read off the two sources. It is the same idiom the run screen's own
 * step pins use (`instance-screens-input-step-lifecycle-rail.test.ts`), and it
 * is the right one here: what has to hold is an ORDER — a refusal that lands
 * after the optimistic hand-off leaves the reader on a spinner, and one that
 * lands after the dispatch does not keep the run parked at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  gateAnswerIncompleteReason,
  resumeAnswerIncompleteReason,
  LIST_ANSWER_NAMES_NO_LIST,
} from "../hitl-gate-submit";

/** A list-picking step of one package, and of another — the rule knows neither. */
const OUTREACH_LIST_PICKER = "@cinatra-ai/email-outreach-agent:list-picker";
const OTHER_VENDOR_LIST_PICKER = "@another-vendor/some-agent:list-picker";

describe("the drawn surface refuses to continue a list-picking step with no list", () => {
  it("refuses while the step's answer names no list", () => {
    expect(
      gateAnswerIncompleteReason(OUTREACH_LIST_PICKER, {
        approved: true,
        listId: "",
        listName: "",
        memberCount: 0,
      }),
    ).toBe(LIST_ANSWER_NAMES_NO_LIST);
  });

  it("refuses just the same when the reader touched nothing at all", () => {
    expect(gateAnswerIncompleteReason(OUTREACH_LIST_PICKER, {})).toBe(
      LIST_ANSWER_NAMES_NO_LIST,
    );
    expect(gateAnswerIncompleteReason(OUTREACH_LIST_PICKER, undefined)).toBe(
      LIST_ANSWER_NAMES_NO_LIST,
    );
  });

  it("refuses an id that is only whitespace", () => {
    expect(gateAnswerIncompleteReason(OUTREACH_LIST_PICKER, { listId: "   " })).toBe(
      LIST_ANSWER_NAMES_NO_LIST,
    );
  });

  it("lets the step continue once a list is named", () => {
    expect(
      gateAnswerIncompleteReason(OUTREACH_LIST_PICKER, {
        approved: true,
        listId: "list-7",
        listName: "Prospects",
        memberCount: 12,
      }),
    ).toBeNull();
  });

  it("is the same rule for ANY package that declares a list-picking step", () => {
    expect(gateAnswerIncompleteReason(OTHER_VENDOR_LIST_PICKER, { listId: "" })).toBe(
      LIST_ANSWER_NAMES_NO_LIST,
    );
    expect(
      gateAnswerIncompleteReason(OTHER_VENDOR_LIST_PICKER, { listId: "list-1" }),
    ).toBeNull();
  });

  it("does not refuse a list the step already holds and shows as chosen", () => {
    // The card draws its renderer from the gate's values merged with the buffer,
    // and the picker seeds its selection from that value while emitting only on a
    // click — so a step re-drawn with a list already chosen would otherwise be
    // refused for naming nothing while showing the row selected.
    expect(
      gateAnswerIncompleteReason(OUTREACH_LIST_PICKER, {}, { listId: "list-7" }),
    ).toBeNull();
    expect(
      gateAnswerIncompleteReason(OUTREACH_LIST_PICKER, { listId: "" }, { listId: "  " }),
    ).toBe(LIST_ANSWER_NAMES_NO_LIST);
  });

  it("leaves every other gate family alone", () => {
    for (const xRenderer of [
      "@cinatra-ai/email-outreach-agent:setup-form",
      "@cinatra-ai/list-curator-agent:final-list-review",
      "@cinatra-ai/list-curator-agent:scrape-schema-review",
      "@cinatra-ai/email-outreach-agent:drafts-output",
      "@cinatra/agent-builder:schema-field-fallback",
    ]) {
      expect(gateAnswerIncompleteReason(xRenderer, {})).toBeNull();
    }
  });
});

describe("the resume seam refuses an answer that names no list", () => {
  it("refuses the snapshot the submit mints when no list was chosen", () => {
    const approvalNote = JSON.stringify({
      type: "list",
      listId: "",
      listName: "",
      memberCount: 0,
      snapshotAt: "2026-09-12T00:00:00.000Z",
    });
    expect(resumeAnswerIncompleteReason({ approved: true, approvalNote })).toBe(
      LIST_ANSWER_NAMES_NO_LIST,
    );
  });

  it("refuses the same answer when it arrives as the structured userResponse", () => {
    const userResponse = JSON.stringify({ type: "list", listId: "  " });
    expect(resumeAnswerIncompleteReason({ userResponse })).toBe(
      LIST_ANSWER_NAMES_NO_LIST,
    );
  });

  it("resumes once the answer names a list", () => {
    const approvalNote = JSON.stringify({
      type: "list",
      listId: "list-7",
      listName: "Prospects",
      memberCount: 12,
    });
    expect(resumeAnswerIncompleteReason({ approved: true, approvalNote })).toBeNull();
  });

  it("leaves an answer of any other kind, and a bare approval, untouched", () => {
    expect(resumeAnswerIncompleteReason(undefined)).toBeNull();
    expect(resumeAnswerIncompleteReason({ approved: true })).toBeNull();
    expect(
      resumeAnswerIncompleteReason({ approvalNote: "looks good to me" }),
    ).toBeNull();
    expect(
      resumeAnswerIncompleteReason({
        approvalNote: JSON.stringify({ type: "final-list", listName: "", memberRefs: [] }),
      }),
    ).toBeNull();
    expect(
      resumeAnswerIncompleteReason({
        approvalNote: JSON.stringify({ type: "scrape-schema", instructions: "" }),
      }),
    ).toBeNull();
  });

  it("refuses a resume that carries NO answer at all when the GATE asks for a list", () => {
    // The bypass this closes is not hypothetical: the lifecycle card's Continue
    // reaches the resume seam with `values === undefined` (it submits the form as
    // it stands), and a payload-only reading walked a listless run straight past
    // its step on the canonical "[Approved by operator]" marker.
    const gate = { xRenderer: OUTREACH_LIST_PICKER, currentValues: {} };
    expect(resumeAnswerIncompleteReason(undefined, gate)).toBe(LIST_ANSWER_NAMES_NO_LIST);
    expect(resumeAnswerIncompleteReason({ approved: true }, gate)).toBe(
      LIST_ANSWER_NAMES_NO_LIST,
    );
    expect(
      resumeAnswerIncompleteReason(
        { approvalNote: JSON.stringify({ approved: true }) },
        gate,
      ),
    ).toBe(LIST_ANSWER_NAMES_NO_LIST);
    expect(resumeAnswerIncompleteReason({ approvalNote: "looks good" }, gate)).toBe(
      LIST_ANSWER_NAMES_NO_LIST,
    );
  });

  it("is the same gate reading for ANY vendor, and for no other gate family", () => {
    expect(
      resumeAnswerIncompleteReason(undefined, {
        xRenderer: OTHER_VENDOR_LIST_PICKER,
        currentValues: {},
      }),
    ).toBe(LIST_ANSWER_NAMES_NO_LIST);
    expect(
      resumeAnswerIncompleteReason(undefined, {
        xRenderer: "@cinatra-ai/email-outreach-agent:setup-form",
        currentValues: {},
      }),
    ).toBeNull();
    expect(resumeAnswerIncompleteReason(undefined, { xRenderer: null })).toBeNull();
  });

  it("never refuses a gate that ALREADY holds a list", () => {
    const gate = {
      xRenderer: OUTREACH_LIST_PICKER,
      currentValues: { listId: "list-7", listName: "Prospects" },
    };
    expect(resumeAnswerIncompleteReason(undefined, gate)).toBeNull();
    expect(resumeAnswerIncompleteReason({ approved: true }, gate)).toBeNull();
  });

  it("reads the answer the seam will actually send, not every key beside it", () => {
    // The seam's own precedence: `userResponse` wins over `approvalNote`. A
    // superseded note is never what the run receives, so it may not be what a
    // refusal is read off.
    const values = {
      userResponse: JSON.stringify({ type: "list", listId: "list-7" }),
      approvalNote: JSON.stringify({ type: "list", listId: "" }),
    };
    expect(resumeAnswerIncompleteReason(values)).toBeNull();
    expect(
      resumeAnswerIncompleteReason(values, {
        xRenderer: OUTREACH_LIST_PICKER,
        currentValues: {},
      }),
    ).toBeNull();
  });

  it("names no package, no template and no renderer id", () => {
    const RULE_SRC = readFileSync(
      fileURLToPath(new URL("../hitl-gate-submit.ts", import.meta.url)),
      "utf8",
    );
    // The rule has to BE there before its text can be read for what it does
    // not name: an absent rule names nothing either, and would pass silently.
    expect(RULE_SRC).toContain("export function resumeAnswerIncompleteReason");
    const rule = RULE_SRC.slice(
      RULE_SRC.indexOf("export function resumeAnswerIncompleteReason"),
    );
    expect(rule).not.toContain("email-outreach-agent");
    expect(rule).not.toContain("list-curator");
  });
});

describe("both ends are wired where they keep the run parked", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  /**
   * Anchored on STATEMENTS, never on prose: every one of these names is also
   * written about in the comments around it, and a pin that matched a sentence
   * would read the explanation instead of the code.
   */
  const statementAt = (src: string, statement: string): number => {
    const at = src.indexOf(`\n    ${statement}`);
    expect(at, `no statement \`${statement}\``).toBeGreaterThan(-1);
    return at;
  };

  it("the panel refuses BEFORE it hands the step over as approved", () => {
    const SRC = read("../orchestrator-stepper-panel.tsx");
    const handleContinue = SRC.slice(
      SRC.indexOf("const handleContinue = async () => {"),
    );
    const refusal = statementAt(handleContinue, "const incompleteAnswer = gateAnswerIncompleteReason(");
    const optimisticHandOff = statementAt(handleContinue, "onApproved?.();");
    expect(refusal).toBeLessThan(optimisticHandOff);
  });

  it("the resume seam refuses BEFORE the prompt write and the dispatch", () => {
    const SRC = read("../review-task-actions.ts");
    const refusal = statementAt(SRC, "const incompleteAnswer = resumeAnswerIncompleteReason(values, resumeGate);");
    const promptWrite = statementAt(SRC, "await writeHitlPrompt({");
    const dispatch = statementAt(SRC, "const { createExternalA2AClient } = await import(");
    expect(refusal).toBeLessThan(promptWrite);
    expect(refusal).toBeLessThan(dispatch);
  });

  it("the OTHER resume dispatch refuses before ITS prompt write and sendTask", () => {
    // A second, independent resume seam exists (the run-resume primitive's own
    // WayFlow branch). It mirrors the first seam's message precedence, and while
    // it did not ask the rule, acceptance 2 stayed reachable through it for the
    // very payload the first seam refuses.
    const SRC = read("../mcp/handlers.ts");
    const refusal = SRC.indexOf("const incompleteAnswer = resumeAnswerIncompleteReason(");
    expect(refusal, "the run-resume seam does not ask the rule").toBeGreaterThan(-1);
    const promptWrite = SRC.indexOf("await writeHitlPrompt({", refusal);
    const dispatch = SRC.indexOf("await client.sendTask({", refusal);
    expect(promptWrite).toBeGreaterThan(refusal);
    expect(dispatch).toBeGreaterThan(refusal);
  });

  it("the refusal is not the stale-gate block the review surface draws", () => {
    const SRC = read("../review-task-actions.ts");
    const seam = SRC.slice(
      SRC.indexOf("const incompleteAnswer = resumeAnswerIncompleteReason(values, resumeGate)"),
      SRC.indexOf("await writeHitlPrompt({"),
    );
    expect(seam).toContain("throw new Error(");
    expect(seam).not.toContain("GateNotPendingError");
  });
});
