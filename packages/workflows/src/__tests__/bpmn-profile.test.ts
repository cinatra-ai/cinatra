import { describe, it, expect } from "vitest";
import { parseBpmnXml, validateBpmnAgainstProfile, validateWorkflowSpecAgainstBpmnProfile } from "../bpmn";
import type { WorkflowSpec } from "../spec/schema";

const NS = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:cinatra="http://cinatra.ai/schema/bpmn/profile-1.0"`;

function proc(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="d"><bpmn:process id="p" name="P" isExecutable="false">${inner}</bpmn:process></bpmn:definitions>`;
}

async function validateXml(xml: string) {
  const r = await parseBpmnXml(xml);
  if (!r.ok) throw new Error("parse failed: " + r.detail);
  return validateBpmnAgainstProfile(r.definitions);
}

const SUPPORTED = proc(`
  <bpmn:startEvent id="s"/>
  <bpmn:userTask id="u"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
  <bpmn:serviceTask id="svc"><bpmn:extensionElements><cinatra:agentRef package="@cinatra-ai/x"/></bpmn:extensionElements></bpmn:serviceTask>
  <bpmn:manualTask id="m"/>
  <bpmn:sendTask id="snd"/>
  <bpmn:parallelGateway id="g"/>
  <bpmn:endEvent id="e"/>
  <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="u"/>
`);

describe("validateBpmnAgainstProfile (BPMN-03)", () => {
  it("accepts a Profile 1.0 graph", async () => {
    expect((await validateXml(SUPPORTED)).ok).toBe(true);
  });

  it("rejects exclusiveGateway", async () => {
    const r = await validateXml(proc(`<bpmn:startEvent id="s"/><bpmn:exclusiveGateway id="x"/><bpmn:endEvent id="e"/>`));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.elementType === "bpmn:ExclusiveGateway")).toBe(true);
  });

  it("rejects a timer start event (eventDefinition)", async () => {
    const r = await validateXml(
      proc(`<bpmn:startEvent id="s"><bpmn:timerEventDefinition id="t"/></bpmn:startEvent><bpmn:endEvent id="e"/>`),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /eventDefinitions/.test(e.reason))).toBe(true);
  });

  it("rejects businessRuleTask + subProcess + scriptTask", async () => {
    for (const t of ["businessRuleTask", "subProcess", "scriptTask"]) {
      const r = await validateXml(proc(`<bpmn:startEvent id="s"/><bpmn:${t} id="bad"/><bpmn:endEvent id="e"/>`));
      expect(r.ok, t).toBe(false);
    }
  });

  it("rejects a conditionExpression on a sequenceFlow", async () => {
    const r = await validateXml(
      proc(
        `<bpmn:startEvent id="s"/><bpmn:endEvent id="e"/><bpmn:sequenceFlow id="f" sourceRef="s" targetRef="e"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">x</bpmn:conditionExpression></bpmn:sequenceFlow>`,
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /conditionExpression/.test(e.reason))).toBe(true);
  });

  it("rejects a multiInstance loop WITHOUT cinatra:foreachSource (native multi-instance not supported)", async () => {
    const r = await validateXml(
      proc(
        `<bpmn:startEvent id="s"/><bpmn:serviceTask id="svc"><bpmn:extensionElements><cinatra:agentRef package="@cinatra-ai/x"/></bpmn:extensionElements><bpmn:multiInstanceLoopCharacteristics><bpmn:loopCardinality>3</bpmn:loopCardinality></bpmn:multiInstanceLoopCharacteristics></bpmn:serviceTask><bpmn:endEvent id="e"/><bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="svc"/><bpmn:sequenceFlow id="f1" sourceRef="svc" targetRef="e"/>`,
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /foreachSource/.test(e.reason))).toBe(true);
  });

  it("rejects a standard (non-multiInstance) loop", async () => {
    const r = await validateXml(
      proc(
        `<bpmn:startEvent id="s"/><bpmn:serviceTask id="svc"><bpmn:standardLoopCharacteristics id="lc"/></bpmn:serviceTask><bpmn:endEvent id="e"/>`,
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a cinatra:transitionOutcome on a non-task-outbound flow (gateway → end)", async () => {
    const r = await validateXml(
      proc(
        `<bpmn:startEvent id="s"/><bpmn:parallelGateway id="g"/><bpmn:endEvent id="e"/><bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="g"/><bpmn:sequenceFlow id="f1" sourceRef="g" targetRef="e"><bpmn:extensionElements><cinatra:transitionOutcome outcome="success"/></bpmn:extensionElements></bpmn:sequenceFlow>`,
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /transitionOutcome may only appear on a task-outbound/.test(e.reason))).toBe(true);
  });

  it("flags structure errors: no end event, two start events", async () => {
    const noEnd = await validateXml(proc(`<bpmn:startEvent id="s"/><bpmn:manualTask id="m"/>`));
    expect(noEnd.ok).toBe(false);
    const twoStart = await validateXml(proc(`<bpmn:startEvent id="s1"/><bpmn:startEvent id="s2"/><bpmn:endEvent id="e"/>`));
    expect(twoStart.ok).toBe(false);
  });
});

describe("validateWorkflowSpecAgainstBpmnProfile (lossiness guard)", () => {
  const base: WorkflowSpec = {
    name: "W",
    tasks: [{ key: "a", type: "checkpoint", title: "A" }],
  };

  it("accepts an in-subset spec (and task.required:true is the default → accepted)", () => {
    const spec: WorkflowSpec = { name: "W", tasks: [{ key: "a", type: "checkpoint", title: "A", required: true }] };
    expect(validateWorkflowSpecAgainstBpmnProfile(spec).ok).toBe(true);
  });

  it("rejects task.required:false", () => {
    const spec = { name: "W", tasks: [{ key: "a", type: "checkpoint", title: "A", required: false }] } as unknown as WorkflowSpec;
    const r = validateWorkflowSpecAgainstBpmnProfile(spec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].field).toBe("required");
  });

  it("rejects risk / assignee / parent / wait / manual.instructions / approval.solicitation / notification.recipients", () => {
    const cases: Array<Record<string, unknown>> = [
      { key: "a", type: "checkpoint", title: "A", risk: "high" },
      { key: "a", type: "checkpoint", title: "A", assignee: { level: "user", id: "u1" } },
      { key: "a", type: "checkpoint", title: "A", parent: "b" },
      { key: "a", type: "wait", title: "A" },
      { key: "a", type: "manual", title: "A", instructions: "do it" },
      { key: "a", type: "approval", title: "A", requiredScope: { level: "organization" }, solicitation: { mode: "relative", anchor: "target", offsetIso8601: "P1D", direction: "before" } },
      { key: "a", type: "notification", title: "A", recipients: ["x@y.z"] },
    ];
    for (const t of cases) {
      const r = validateWorkflowSpecAgainstBpmnProfile({ name: "W", tasks: [t] } as unknown as WorkflowSpec);
      expect(r.ok, JSON.stringify(t)).toBe(false);
    }
  });

  it("descends into foreach.template", () => {
    const spec = {
      name: "W",
      tasks: [
        {
          key: "outer",
          type: "agent_task",
          title: "Outer",
          agentRef: { package: "@cinatra-ai/x" },
          foreach: { source: "outer", as: "i", template: { key: "inner", type: "checkpoint", title: "Inner", risk: "high" } },
        },
      ],
    } as unknown as WorkflowSpec;
    const r = validateWorkflowSpecAgainstBpmnProfile(spec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.field === "risk" && e.taskKey === "inner")).toBe(true);
  });

  it("baseline checkpoint spec passes", () => {
    expect(validateWorkflowSpecAgainstBpmnProfile(base).ok).toBe(true);
  });
});
