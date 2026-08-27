// ---------------------------------------------------------------------------
// THE PLATFORM'S OWN WORDS FOR A START (cinatra#2935, lifecycle-b W5d).
// ---------------------------------------------------------------------------
// Two sentences are asserted here, and each answers a defect seen in the real
// run rather than an invented worry.
//
//  1. THE REPORT. A start answered with machine fields alone — a run id and a
//     status — and an assistant told to report that answer and add nothing to
//     it had, inside a third-party application, only the envelope itself to
//     say: the turn's line was the tool result verbatim. The plan's rule is
//     "The assistant's line reports what came back and adds nothing", which
//     presupposes there is something to say back. So the platform writes the
//     sentence, once, and both doors onto the start road carry it.
//
//  2. THE REFUSAL. A start refused by the agent's own scope answered with the
//     enforcement layer's diagnostic — the stage, the template's id, the
//     machine reason and the scope level — and that diagnostic was read out to
//     the person. The plan: "the platform refuses in its own words and the
//     assistant says those words back." The diagnostic is not those words. It
//     stays where it belongs (the thrown error, and the log) and the person
//     gets the platform's sentence.
//
// The two live in different modules for a reason each states: the report beside
// the run-status vocabulary it is chosen by, the refusal beside the error that
// raises it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  RUN_START_PARKED_CLAUSE,
  RUN_START_STARTED_CLAUSE,
  describeStartedRun,
} from "../run-status";
import {
  AGENT_TEMPLATE_SCOPE_START_REFUSAL,
  AgentTemplateScopeError,
  agentStartRefusalSentence,
  startFailureAnswer,
} from "../auth-policy";

const STARTED = {
  packageName: "@cinatra-ai/blog-draft-writer-agent",
  runId: "06a703fe-e779-4ba5-852c-73c41c513924",
};

/** The diagnostic's own tokens — none of them may reach a person. */
const DIAGNOSTIC_TOKENS = [
  "agent-template-scope",
  "not_project_member",
  "requesting-actor",
  "(scope:",
];

describe("the report a start answers with", () => {
  it("is a SENTENCE, and never the envelope a reader was shown instead", () => {
    const report = describeStartedRun({ ...STARTED, status: "queued" });

    // The defect, stated as an assertion: the line a person reads is not the
    // machine answer. Parsing it as JSON must fail, and none of the envelope's
    // own keys may appear in it.
    expect(() => JSON.parse(report) as unknown).toThrow();
    expect(report).not.toContain('"ok"');
    expect(report).not.toContain('"status":');
    expect(report).not.toContain('"runId":');
    expect(report.trimEnd().endsWith(".")).toBe(true);
  });

  it("is chosen by the STATUS, so the two readings cannot both be true of one turn", () => {
    const parked = describeStartedRun({ ...STARTED, status: "pending_input" });
    const started = describeStartedRun({ ...STARTED, status: "queued" });

    expect(parked).toContain(RUN_START_PARKED_CLAUSE);
    expect(parked).not.toContain(RUN_START_STARTED_CLAUSE);
    expect(started).toContain(RUN_START_STARTED_CLAUSE);
    expect(started).not.toContain(RUN_START_PARKED_CLAUSE);
  });

  it("STAYS TRUE AFTER THE RUN SETTLES, whatever status the start answered", () => {
    // The assistant that says this line back is required to poll the run to a
    // terminal status first, and a start can also answer with a status a
    // concurrent writer already moved on. A line claiming a STATE would be
    // false by the time a person read it; every one of these reports an EVENT,
    // and each still carries the status the answer actually named.
    for (const status of ["queued", "running", "completed", "failed", "stopped"]) {
      const report = describeStartedRun({ ...STARTED, status });
      expect(report).toContain(RUN_START_STARTED_CLAUSE);
      expect(report).toContain(`status: \`${status}\``);
      expect(report).not.toContain("is running");
      expect(report).not.toContain(RUN_START_PARKED_CLAUSE);
    }
  });

  it("names the agent and the run it reports, so the line stands beside the card", () => {
    const report = describeStartedRun({ ...STARTED, status: "queued" });
    expect(report).toContain(STARTED.packageName);
    expect(report).toContain(STARTED.runId);
  });

  it("is PURE — one answer can only produce one wording, so two doors cannot differ", () => {
    // What this proves, exactly: the report is a function of the ANSWER and of
    // nothing else — no clock, no caller, no host. That is what lets the two
    // doors onto the start road carry one wording rather than two readings of
    // it; that they DO carry it is proven where each door is driven.
    expect(describeStartedRun({ ...STARTED, status: "queued" })).toBe(
      describeStartedRun({ ...STARTED, status: "queued" }),
    );
    expect(describeStartedRun({ ...STARTED, status: "queued" })).not.toBe(
      describeStartedRun({ ...STARTED, status: "pending_input" }),
    );
  });
});

describe("the refusal a start the person may not make answers with", () => {
  it("is the platform's own sentence, carrying nothing a person cannot act on", () => {
    for (const token of DIAGNOSTIC_TOKENS) {
      expect(AGENT_TEMPLATE_SCOPE_START_REFUSAL).not.toContain(token);
    }
    // No id of any kind, and no code token: this is a sentence, not a record.
    expect(AGENT_TEMPLATE_SCOPE_START_REFUSAL).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(AGENT_TEMPLATE_SCOPE_START_REFUSAL).not.toMatch(/[_{}`]/);
    expect(AGENT_TEMPLATE_SCOPE_START_REFUSAL.trimEnd().endsWith(".")).toBe(true);
  });

  it("is what a scope denial is read back as, whatever the denial's reason was", () => {
    // ONE sentence for every reason, deliberately: a caller able to tell them
    // apart would learn about standing they do not hold. The same rule the
    // schedule card's single authorization refusal states.
    const reasons = ["not_project_member", "not_team_member", "not_owner", "cross_org"] as const;
    const sentences = reasons.map((reason) =>
      agentStartRefusalSentence(
        new AgentTemplateScopeError({
          templateId: "80d761cd-a8eb-4ad0-81e4-288244b79727",
          reason,
          level: "project",
          stage: "create/requesting-actor",
        }),
      ),
    );
    expect(new Set(sentences).size).toBe(1);
    expect(sentences[0]).toBe(AGENT_TEMPLATE_SCOPE_START_REFUSAL);
  });

  it("KEEPS THE DIAGNOSTIC where a diagnostic belongs — on the error itself", () => {
    const err = new AgentTemplateScopeError({
      templateId: "80d761cd-a8eb-4ad0-81e4-288244b79727",
      reason: "not_project_member",
      level: "project",
      stage: "create/requesting-actor",
    });
    // Unchanged: the thrown error still names the stage, the template, the
    // reason and the level, which is what a log and an error record need.
    expect(err.message).toContain("agent-template-scope: create/requesting-actor");
    expect(err.message).toContain("80d761cd-a8eb-4ad0-81e4-288244b79727");
    expect(err.message).toContain("not_project_member");
    expect(err.message).toContain("(scope: project)");
  });

  it("speaks for a SCOPE denial and for nothing else", () => {
    expect(agentStartRefusalSentence(new Error("connection terminated"))).toBeNull();
    expect(agentStartRefusalSentence(null)).toBeNull();
    expect(agentStartRefusalSentence({ code: "SOMETHING_ELSE" })).toBeNull();
  });
});

describe("what a start that threw answers with", () => {
  const scopeDenial = () =>
    new AgentTemplateScopeError({
      templateId: "80d761cd-a8eb-4ad0-81e4-288244b79727",
      reason: "not_project_member",
      level: "project",
      stage: "create/requesting-actor",
    });

  it("a SCOPE DENIAL answers in the platform's sentence, with the diagnostic nowhere in it", () => {
    const answered = startFailureAnswer(scopeDenial(), "@cinatra-ai/lint-policy-agent");

    expect(answered.error).toBe(AGENT_TEMPLATE_SCOPE_START_REFUSAL);
    // The exact string a reader was shown before, named so it cannot come back.
    expect(answered.error).not.toContain("Run failed:");
    for (const token of DIAGNOSTIC_TOKENS) {
      expect(answered.error).not.toContain(token);
    }
    expect(answered.error).not.toContain("80d761cd-a8eb-4ad0-81e4-288244b79727");
    // The stable code still rides along, so a caller can branch on the class
    // without reading the sentence.
    expect(answered.code).toBe("AGENT_TEMPLATE_SCOPE_DENIED");
  });

  it("A FAULT is not dressed up as a decision — it keeps the answer it always had", () => {
    const answered = startFailureAnswer(new Error("connection terminated"), "@cinatra-ai/lint-policy-agent");
    expect(answered.error).toBe("Run failed: connection terminated");
    expect(answered.code).toBeUndefined();
  });

  it("the identifier the start named is NOT put into what the person reads", () => {
    // It goes to the log line, where a diagnostic belongs. A refusal that named
    // the agent back would confirm which names resolve to a template.
    const answered = startFailureAnswer(scopeDenial(), "@cinatra-ai/lint-policy-agent");
    expect(answered.error).not.toContain("@cinatra-ai/lint-policy-agent");
  });
});
