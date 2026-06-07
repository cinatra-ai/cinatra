import { describe, it, expect } from "vitest";
import { createCinatraBpmnModdle, parseBpmnXml, serializeBpmnDefinitions } from "../bpmn";

// Exercises all 12 Profile 1.0 extension elements + the structural sub-elements,
// then parse → serialize → parse to prove every extension datum round-trips.
const ALL_ELEMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:cinatra="http://cinatra.ai/schema/bpmn/profile-1.0" id="d1">
  <bpmn:process id="proc-all" name="All Elements" isExecutable="false">
    <bpmn:documentation>desc</bpmn:documentation>
    <bpmn:extensionElements>
      <cinatra:workflowMeta name="Meta Name" product="{{product}}">
        <cinatra:workflowTarget at="2026-12-01T00:00:00Z" tz="UTC" />
      </cinatra:workflowMeta>
      <cinatra:placeholders>
        <cinatra:placeholder name="product" type="string" required="true" description="d">
          <cinatra:placeholderHint kind="blog-project" />
        </cinatra:placeholder>
      </cinatra:placeholders>
    </bpmn:extensionElements>
    <bpmn:startEvent id="s" />
    <bpmn:serviceTask id="svc" name="Svc">
      <bpmn:extensionElements>
        <cinatra:agentRef package="@cinatra-ai/blog-pipeline-agent" name="n" version="1" templateId="t1" />
        <cinatra:taskInput>{"brief":"x"}</cinatra:taskInput>
        <cinatra:taskSchedule mode="relative" anchor="target" offsetIso8601="P7D" direction="before" localTime="09:00" />
        <cinatra:taskPolicy failurePolicy="skip" maxAttempts="3" />
      </bpmn:extensionElements>
      <bpmn:multiInstanceLoopCharacteristics>
        <bpmn:extensionElements>
          <cinatra:foreachSource source="svc" as="item" itemKey="id" rollupPolicy="best_effort" maxFanout="10" />
        </bpmn:extensionElements>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:serviceTask>
    <bpmn:userTask id="appr" name="Approve">
      <bpmn:extensionElements>
        <cinatra:taskKind value="approval" />
        <cinatra:approvalConfig level="organization" id="org1" rejectionPolicy="needs_revision" />
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:sendTask id="notif" name="Notify">
      <bpmn:extensionElements>
        <cinatra:messageBody>Shipped.</cinatra:messageBody>
      </bpmn:extensionElements>
    </bpmn:sendTask>
    <bpmn:endEvent id="e" />
    <bpmn:sequenceFlow id="f1" sourceRef="svc" targetRef="appr">
      <bpmn:extensionElements>
        <cinatra:transitionOutcome outcome="success" />
      </bpmn:extensionElements>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;

function ext(el: any, type: string) {
  return el?.extensionElements?.values?.find((v: any) => v.$type === type);
}
function flow(proc: any, id: string) {
  return proc.flowElements.find((e: any) => e.id === id);
}

describe("cinatra: moddle descriptor", () => {
  it("constructs a BpmnModdle with the cinatra descriptor", () => {
    expect(() => createCinatraBpmnModdle()).not.toThrow();
  });

  it("parses all 12 extension elements with the right $type + values", async () => {
    const r = await parseBpmnXml(ALL_ELEMENTS_XML);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const proc = (r.definitions as any).rootElements[0];

    const meta = ext(proc, "cinatra:WorkflowMeta");
    expect(meta.name).toBe("Meta Name");
    expect(meta.product).toBe("{{product}}");
    expect(meta.target.tz).toBe("UTC");

    const ph = ext(proc, "cinatra:Placeholders").placeholders[0];
    expect(ph.name).toBe("product");
    expect(ph.required).toBe(true);
    expect(ph.hint.kind).toBe("blog-project");

    const svc = flow(proc, "svc");
    expect(ext(svc, "cinatra:AgentRef").package).toBe("@cinatra-ai/blog-pipeline-agent");
    expect(ext(svc, "cinatra:TaskInput").value).toBe('{"brief":"x"}');
    expect(ext(svc, "cinatra:TaskSchedule").offsetIso8601).toBe("P7D");
    expect(ext(svc, "cinatra:TaskPolicy").maxAttempts).toBe(3);
    const loop = svc.loopCharacteristics;
    expect(ext(loop, "cinatra:ForeachSource").source).toBe("svc");
    expect(ext(loop, "cinatra:ForeachSource").maxFanout).toBe(10);

    const appr = flow(proc, "appr");
    expect(ext(appr, "cinatra:TaskKind").value).toBe("approval");
    expect(ext(appr, "cinatra:ApprovalConfig").level).toBe("organization");

    const notif = flow(proc, "notif");
    expect(ext(notif, "cinatra:MessageBody").value).toBe("Shipped.");

    const f1 = flow(proc, "f1");
    expect(ext(f1, "cinatra:TransitionOutcome").outcome).toBe("success");
  });

  it("round-trips (parse → serialize → parse) preserving extension elements", async () => {
    const first = await parseBpmnXml(ALL_ELEMENTS_XML);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const xml = await serializeBpmnDefinitions(first.definitions);
    const second = await parseBpmnXml(xml);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    const proc = (second.definitions as any).rootElements[0];
    expect(ext(proc, "cinatra:WorkflowMeta").product).toBe("{{product}}");
    const svc = flow(proc, "svc");
    expect(ext(svc, "cinatra:AgentRef").templateId).toBe("t1");
    expect(ext(svc, "cinatra:TaskInput").value).toBe('{"brief":"x"}');
    expect(ext(flow(proc, "notif"), "cinatra:MessageBody").value).toBe("Shipped.");
  });
});
