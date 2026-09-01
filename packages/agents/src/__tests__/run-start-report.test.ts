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
  LEGAL_TRANSITIONS,
  RUN_START_AWAITING_APPROVAL_CLAUSE,
  RUN_START_AWAITING_TRIGGER_CLAUSE,
  RUN_START_FAILED_CLAUSE,
  RUN_START_NOT_STARTED_CLAUSE,
  RUN_START_PARKED_CLAUSE,
  RUN_START_QUEUED_CLAUSE,
  RUN_START_STARTED_CLAUSE,
  RUN_START_STOPPED_CLAUSE,
  RUN_START_TRIGGER_NOT_SET_CLAUSE,
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
    const started = describeStartedRun({ ...STARTED, status: "running" });

    expect(parked).toContain(RUN_START_PARKED_CLAUSE);
    expect(parked).not.toContain(RUN_START_STARTED_CLAUSE);
    expect(started).toContain(RUN_START_STARTED_CLAUSE);
    expect(started).not.toContain(RUN_START_PARKED_CLAUSE);
  });

  it("STAYS TRUE AFTER THE RUN SETTLES, whatever status the start answered", () => {
    // A start can answer with a status a concurrent writer already moved on.
    // A line claiming a STATE would be false by the time a person read it;
    // every one of these reports an EVENT, and each still carries the status
    // the answer actually named. `queued` is NOT in this set (cinatra#3147):
    // a queued run has not started, so its line is not an event report at all
    // — it is pinned, with the other pre-run statuses, right below. Nor are
    // `failed` and `stopped`, which a run can reach without ever executing;
    // their own event sentences are pinned below too.
    for (const status of ["running", "completed"]) {
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

describe("the dispatch line says what is TRUE at the moment it is composed", () => {
  // cinatra#3147. `describeStartedRun` composes its line from the status the
  // start answered, and the assistant is told to say that line back verbatim
  // without polling the run first — so a status that has not started must not
  // be described with a sentence that says it did.

  it("AC1: `The run started.` is no longer the clause for any pre-running status", () => {
    for (const status of ["queued", "pending_trigger", "pending_approval", "pending_input", "armed"]) {
      const report = describeStartedRun({ ...STARTED, status });
      expect(report).not.toContain(RUN_START_STARTED_CLAUSE);
    }
    // THE STATUS TOKEN, WHERE THE LINE STILL CARRIES ONE (narrowed by
    // cinatra#3174). What #3147 fixed was the CLAUSE — a pre-running status
    // described with a sentence claiming a start — and that half is asserted
    // over all five readings above. The token beside it was never this test's
    // subject, and the two schedule-wait readings have since dropped their whole
    // parenthetical because the card's own section draws those turns in plain
    // prose. Every reading that still prints one is still checked here.
    for (const status of ["queued", "pending_approval", "pending_input"]) {
      expect(describeStartedRun({ ...STARTED, status })).toContain(`status: \`${status}\``);
    }
  });

  it("AC2: pins the sentence for `queued` — the run is queued, and it starts on its own", () => {
    expect(describeStartedRun({ ...STARTED, status: "queued" })).toBe(
      `Dispatched \`${STARTED.packageName}\` (runId: \`${STARTED.runId}\`, ` +
        `status: \`queued\`). ${RUN_START_QUEUED_CLAUSE}`,
    );
  });

  it("AC2: pins the sentence for `pending_input` — the run parked on its recommendation checkpoint", () => {
    expect(describeStartedRun({ ...STARTED, status: "pending_input" })).toBe(
      `Dispatched \`${STARTED.packageName}\` (runId: \`${STARTED.runId}\`, ` +
        `status: \`pending_input\`). ${RUN_START_PARKED_CLAUSE}`,
    );
  });

  it("AC2: pins the sentence for `pending_approval` — the run waits on a decision before it starts", () => {
    expect(describeStartedRun({ ...STARTED, status: "pending_approval" })).toBe(
      `Dispatched \`${STARTED.packageName}\` (runId: \`${STARTED.runId}\`, ` +
        `status: \`pending_approval\`). ${RUN_START_AWAITING_APPROVAL_CLAUSE}`,
    );
  });

  it("AC2: pins the sentence for `running` — this one HAS started, so it may say so", () => {
    expect(describeStartedRun({ ...STARTED, status: "running" })).toBe(
      `Dispatched \`${STARTED.packageName}\` (runId: \`${STARTED.runId}\`, ` +
        `status: \`running\`). ${RUN_START_STARTED_CLAUSE}`,
    );
  });

  it("AC2: none of the non-running sentences claims the run started, and each is true of its status", () => {
    const clauses: Record<string, string> = {
      queued: RUN_START_QUEUED_CLAUSE,
      pending_input: RUN_START_PARKED_CLAUSE,
      pending_approval: RUN_START_AWAITING_APPROVAL_CLAUSE,
      pending_trigger: RUN_START_TRIGGER_NOT_SET_CLAUSE,
      armed: RUN_START_AWAITING_TRIGGER_CLAUSE,
    };
    for (const [status, clause] of Object.entries(clauses)) {
      const report = describeStartedRun({ ...STARTED, status });
      expect(report).toContain(clause);
      expect(report).not.toContain(RUN_START_STARTED_CLAUSE);
      // A sentence, not an envelope, exactly as every other clause here is.
      expect(clause.trimEnd().endsWith(".")).toBe(true);
      expect(clause).not.toMatch(/[{}`]/);
    }
  });

  it("AC1: `pending_trigger` says its trigger is not set, which is what that status MEANS", () => {
    // `pending_trigger` is the form-open state: the person has not chosen a
    // trigger yet. Only `armed` is a run waiting on a trigger that exists, so
    // the two may not share a sentence.
    const formOpen = describeStartedRun({ ...STARTED, status: "pending_trigger" });
    const armed = describeStartedRun({ ...STARTED, status: "armed" });

    expect(formOpen).toContain(RUN_START_TRIGGER_NOT_SET_CLAUSE);
    expect(formOpen).not.toContain(RUN_START_AWAITING_TRIGGER_CLAUSE);
    expect(armed).toContain(RUN_START_AWAITING_TRIGGER_CLAUSE);
    expect(RUN_START_TRIGGER_NOT_SET_CLAUSE).not.toBe(RUN_START_AWAITING_TRIGGER_CLAUSE);
  });

  it("AC1: `failed` and `stopped` report their outcome, because neither implies the run ever ran", () => {
    // `queued->failed`, `pending_input->failed`, `armed->failed`,
    // `pending_trigger->failed` and the matching cancel edges to `stopped` all
    // settle a run that never executed, and the lost-dispatch-race branch can
    // hand a start answer exactly those statuses.
    const failed = describeStartedRun({ ...STARTED, status: "failed" });
    const stopped = describeStartedRun({ ...STARTED, status: "stopped" });

    expect(failed).toContain(RUN_START_FAILED_CLAUSE);
    expect(failed).not.toContain(RUN_START_STARTED_CLAUSE);
    expect(stopped).toContain(RUN_START_STOPPED_CLAUSE);
    expect(stopped).not.toContain(RUN_START_STARTED_CLAUSE);
  });

  it("a status outside the vocabulary lands on the floor, never on a start it cannot vouch for", () => {
    // `status` is widened to `string` on this boundary, so an unknown value can
    // arrive. It gets the floor clause — and the status it named is still
    // printed beside it, so the reader can follow the card from there.
    const report = describeStartedRun({ ...STARTED, status: "a_status_nobody_has_written_yet" });

    expect(report).toContain(RUN_START_NOT_STARTED_CLAUSE);
    expect(report).not.toContain(RUN_START_STARTED_CLAUSE);
    expect(report).toContain("status: `a_status_nobody_has_written_yet`");
  });

  it("EVERY status the transition table names has a sentence of its own — none falls to the floor", () => {
    // The clause table is exhaustive over `AgentRunStatus` by the type checker;
    // this is the runtime half of that guard. A status added to the union and
    // wired into the transitions without a sentence fails here as well as at
    // compile time.
    const statuses = new Set<string>();
    for (const edge of LEGAL_TRANSITIONS) {
      const [from, to] = edge.split("->");
      statuses.add(from);
      statuses.add(to);
    }
    expect(statuses.size).toBeGreaterThan(5);
    for (const status of statuses) {
      expect(describeStartedRun({ ...STARTED, status })).not.toContain(
        RUN_START_NOT_STARTED_CLAUSE,
      );
    }
  });

  it("a run that is already going, or completed, keeps the started clause", () => {
    for (const status of ["running", "waiting_trigger", "completed"]) {
      expect(describeStartedRun({ ...STARTED, status })).toContain(RUN_START_STARTED_CLAUSE);
    }
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

// ---------------------------------------------------------------------------
// THE SCHEDULE-WAIT DISPATCH LINE IS PLAIN PROSE (cinatra#3174, criterion 3).
// ---------------------------------------------------------------------------
// The drawing's own example turns for this card carry plain assistant prose —
// "The card is the scheduling step, in the turn — and it is the only thing
// drawn" — and not one of them prints a machine token beside the sentence. The
// two statuses a schedule waits in are exactly the readings those example lines
// cover: `pending_trigger` (the rows are open and nothing is armed yet) and
// `armed` (the schedule is set and the run is waiting on it). For both, the
// line the assistant says back drops the parenthetical entirely: no `runId:`
// token and no `status:` token.
//
// Every OTHER status keeps the parenthetical it has always had. This is a
// narrowing to the readings the drawing draws, not a rewrite of the line.
// ---------------------------------------------------------------------------

describe("cinatra#3174 — the schedule-wait line carries no machine tokens", () => {
  const SCHEDULE_WAIT = ["armed", "pending_trigger"] as const;

  it("prints neither a runId nor a status token for the readings the drawing draws", () => {
    for (const status of SCHEDULE_WAIT) {
      const report = describeStartedRun({ ...STARTED, status });
      expect(report).not.toMatch(/runId:/);
      expect(report).not.toMatch(/status:/);
      expect(report).not.toContain(STARTED.runId);
      expect(report).not.toContain(status);
    }
  });

  it("pins the two sentences whole, so the shape cannot drift back", () => {
    expect(describeStartedRun({ ...STARTED, status: "armed" })).toBe(
      `Dispatched \`${STARTED.packageName}\`. ${RUN_START_AWAITING_TRIGGER_CLAUSE}`,
    );
    expect(describeStartedRun({ ...STARTED, status: "pending_trigger" })).toBe(
      `Dispatched \`${STARTED.packageName}\`. ${RUN_START_TRIGGER_NOT_SET_CLAUSE}`,
    );
  });

  it("leaves every other status's line exactly as it was", () => {
    for (const status of [
      "queued",
      "pending_input",
      "pending_approval",
      "running",
      "waiting_trigger",
      "completed",
      "failed",
      "stopped",
      "a_status_nobody_has_written_yet",
    ]) {
      const report = describeStartedRun({ ...STARTED, status });
      expect(report).toContain(`runId: \`${STARTED.runId}\``);
      expect(report).toContain(`status: \`${status}\``);
    }
  });
});
