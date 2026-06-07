import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseBpmnXml,
  compileBpmnToWorkflowSpec,
  validateWorkflowSpecAgainstBpmnProfile,
  parseWorkflowBpmnSidecar,
} from "../bpmn";

const MAJOR_RELEASE_ROOT = path.resolve(__dirname, "../../../../extensions/cinatra-ai/major-release-workflow");
const legacy = JSON.parse(
  readFileSync(path.resolve(__dirname, "./fixtures/major-release-workflow.legacy.json"), "utf8"),
) as { key: string; version: number; name: string; description: string; definition: Record<string, unknown> };

const NS = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:cinatra="http://cinatra.ai/schema/bpmn/profile-1.0"`;
function proc(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="defs1"><bpmn:process id="p" name="P" isExecutable="false">${inner}</bpmn:process></bpmn:definitions>`;
}
async function compile(xml: string) {
  const r = await parseBpmnXml(xml);
  if (!r.ok) throw new Error("parse failed: " + r.detail);
  return compileBpmnToWorkflowSpec(r.definitions);
}

describe("compileBpmnToWorkflowSpec — major-release parity", () => {
  it("the migrated sidecar compiles to the legacy WorkflowSpec (full parity)", async () => {
    const result = await parseWorkflowBpmnSidecar({
      packageRoot: MAJOR_RELEASE_ROOT,
      pkgCinatra: { kind: "workflow", apiVersion: "cinatra.ai/v1", workflowVersion: 1 },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const { manifest } = result;

    // Parity assertions.
    expect(manifest.name).toBe("Major Release"); // BPMN process.name
    expect(manifest.key).toBe("major-release"); // BPMN process.id
    expect(manifest.version).toBe(1); // package.json#cinatra.workflowVersion
    expect(manifest.description).toBe(legacy.description); // process.documentation

    const def = manifest.definition;
    expect(def.name).toBe("{{product}} — Major Release"); // cinatra:workflowMeta.name
    expect(def.key).toBe("major-release"); // process.id
    expect(def.product).toBe("{{product}}");
    expect(def.placeholders).toEqual({ product: { type: "string", required: true } });
    expect(def.target).toBeUndefined();
    expect(def.metadata).toBeUndefined(); // no placeholderHints in major-release
    expect(def.tasks).toEqual(legacy.definition.tasks); // full task-array deep-equal

    // The compiled spec is Profile-1.0 lossless.
    expect(validateWorkflowSpecAgainstBpmnProfile(def).ok).toBe(true);
  });
});

describe("compileBpmnToWorkflowSpec — gateway + foreach mapping", () => {
  it("collapses parallelGateway fan-out/join into direct task dependsOn edges", async () => {
    const spec = await compile(
      proc(`
      <bpmn:startEvent id="s"/>
      <bpmn:userTask id="a" name="A"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
      <bpmn:parallelGateway id="split"/>
      <bpmn:userTask id="b" name="B"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
      <bpmn:userTask id="c" name="C"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
      <bpmn:parallelGateway id="join"/>
      <bpmn:userTask id="d" name="D"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
      <bpmn:endEvent id="e"/>
      <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="a"/>
      <bpmn:sequenceFlow id="f1" sourceRef="a" targetRef="split"/>
      <bpmn:sequenceFlow id="f2" sourceRef="split" targetRef="b"/>
      <bpmn:sequenceFlow id="f3" sourceRef="split" targetRef="c"/>
      <bpmn:sequenceFlow id="f4" sourceRef="b" targetRef="join"/>
      <bpmn:sequenceFlow id="f5" sourceRef="c" targetRef="join"/>
      <bpmn:sequenceFlow id="f6" sourceRef="join" targetRef="d"/>
      <bpmn:sequenceFlow id="f7" sourceRef="d" targetRef="e"/>
    `),
    );
    const byKey = Object.fromEntries(spec.tasks.map((t) => [t.key, t]));
    expect(byKey.a.dependsOn).toBeUndefined();
    expect(byKey.b.dependsOn).toEqual([{ taskKey: "a" }]);
    expect(byKey.c.dependsOn).toEqual([{ taskKey: "a" }]);
    expect(byKey.d.dependsOn).toEqual([{ taskKey: "b" }, { taskKey: "c" }]);
  });

  it("maps multiInstanceLoopCharacteristics + foreachSource to a foreach task", async () => {
    const spec = await compile(
      proc(`
      <bpmn:startEvent id="s"/>
      <bpmn:serviceTask id="fan" name="Fan">
        <bpmn:extensionElements><cinatra:agentRef package="@cinatra-ai/x"/></bpmn:extensionElements>
        <bpmn:multiInstanceLoopCharacteristics>
          <bpmn:extensionElements>
            <cinatra:foreachSource source="ideas" as="idea" itemKey="id" rollupPolicy="best_effort" maxFanout="5"/>
          </bpmn:extensionElements>
        </bpmn:multiInstanceLoopCharacteristics>
      </bpmn:serviceTask>
      <bpmn:endEvent id="e"/>
      <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="fan"/>
      <bpmn:sequenceFlow id="f1" sourceRef="fan" targetRef="e"/>
    `),
    );
    const fan = spec.tasks.find((t) => t.key === "fan") as any;
    expect(fan.foreach.source).toBe("ideas");
    expect(fan.foreach.as).toBe("idea");
    expect(fan.foreach.itemKey).toBe("id");
    expect(fan.foreach.rollupPolicy).toBe("best_effort");
    expect(fan.foreach.maxFanout).toBe(5);
    expect(fan.foreach.template).toEqual({ key: "fan", title: "Fan", type: "agent_task", agentRef: { package: "@cinatra-ai/x" } });
  });
});

describe("compileBpmnToWorkflowSpec — fail-closed", () => {
  async function defs(xml: string) {
    const r = await parseBpmnXml(xml);
    if (!r.ok) throw new Error("parse failed: " + r.detail);
    return r.definitions;
  }

  it("rejects a transitionOutcome on a parallelGateway-outbound flow", async () => {
    const d = await defs(
      proc(`
      <bpmn:startEvent id="s"/>
      <bpmn:userTask id="a" name="A"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
      <bpmn:parallelGateway id="g"/>
      <bpmn:userTask id="b" name="B"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
      <bpmn:endEvent id="e"/>
      <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="a"/>
      <bpmn:sequenceFlow id="f1" sourceRef="a" targetRef="g"/>
      <bpmn:sequenceFlow id="f2" sourceRef="g" targetRef="b"><bpmn:extensionElements><cinatra:transitionOutcome outcome="success"/></bpmn:extensionElements></bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="f3" sourceRef="b" targetRef="e"/>
    `),
    );
    expect(() => compileBpmnToWorkflowSpec(d)).toThrow(/parallelGateway-outbound/);
  });

  it("fails closed on conflicting dependency outcomes converging on one upstream task", async () => {
    // a → g1 (success) and a → g2 (failed); both gateways join into d. Resolving d
    // yields two edges to "a" with different outcomes → unrepresentable → reject.
    const d = await defs(
      proc(`
      <bpmn:startEvent id="s"/>
      <bpmn:userTask id="a" name="A"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
      <bpmn:parallelGateway id="g1"/>
      <bpmn:parallelGateway id="g2"/>
      <bpmn:userTask id="dd" name="D"><bpmn:extensionElements><cinatra:taskKind value="checkpoint"/></bpmn:extensionElements></bpmn:userTask>
      <bpmn:endEvent id="e"/>
      <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="a"/>
      <bpmn:sequenceFlow id="f1" sourceRef="a" targetRef="g1"><bpmn:extensionElements><cinatra:transitionOutcome outcome="success"/></bpmn:extensionElements></bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="f2" sourceRef="a" targetRef="g2"><bpmn:extensionElements><cinatra:transitionOutcome outcome="failed"/></bpmn:extensionElements></bpmn:sequenceFlow>
      <bpmn:sequenceFlow id="f3" sourceRef="g1" targetRef="dd"/>
      <bpmn:sequenceFlow id="f4" sourceRef="g2" targetRef="dd"/>
      <bpmn:sequenceFlow id="f5" sourceRef="dd" targetRef="e"/>
    `),
    );
    expect(() => compileBpmnToWorkflowSpec(d)).toThrow(/conflicting dependency outcomes/);
  });

  it("fails closed on a malformed numeric placeholder default", async () => {
    const d = await defs(
      proc(`
      <bpmn:extensionElements>
        <cinatra:placeholders><cinatra:placeholder name="count" type="number" default="abc"/></cinatra:placeholders>
      </bpmn:extensionElements>
      <bpmn:startEvent id="s"/>
      <bpmn:manualTask id="m" name="M"/>
      <bpmn:endEvent id="e"/>
      <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="m"/>
      <bpmn:sequenceFlow id="f1" sourceRef="m" targetRef="e"/>
    `),
    );
    expect(() => compileBpmnToWorkflowSpec(d)).toThrow(/not a valid number/);
  });
});
