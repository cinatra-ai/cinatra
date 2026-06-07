import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflowBpmnSidecar, BPMN_ERROR_CODES } from "../bpmn";

const MINIMAL_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:cinatra="http://cinatra.ai/schema/bpmn/profile-1.0" id="d">
  <bpmn:process id="my-flow" name="My Flow" isExecutable="false">
    <bpmn:documentation>Sidecar test flow.</bpmn:documentation>
    <bpmn:extensionElements>
      <cinatra:workflowMeta name="My Flow Def" />
    </bpmn:extensionElements>
    <bpmn:startEvent id="s"/>
    <bpmn:manualTask id="m" name="Do it"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="m"/>
    <bpmn:sequenceFlow id="f1" sourceRef="m" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bpmn-sidecar-"));
  await mkdir(join(root, "cinatra"), { recursive: true });
  await writeFile(join(root, "cinatra", "workflow.bpmn"), MINIMAL_BPMN, "utf8");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const cinatra = { kind: "workflow", apiVersion: "cinatra.ai/v1", workflowVersion: 2 };

describe("parseWorkflowBpmnSidecar (BPMN-05)", () => {
  it("happy path: derives a manifest from the canonical sidecar", async () => {
    const r = await parseWorkflowBpmnSidecar({ packageRoot: root, pkgCinatra: cinatra });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.key).toBe("my-flow");
    expect(r.manifest.name).toBe("My Flow"); // process.name
    expect(r.manifest.version).toBe(2); // companion workflowVersion
    expect(r.manifest.description).toBe("Sidecar test flow.");
    expect(r.manifest.definition.name).toBe("My Flow Def"); // workflowMeta.name
  });

  it("rejects inline cinatra.workflow (forbidden)", async () => {
    const r = await parseWorkflowBpmnSidecar({ packageRoot: root, pkgCinatra: { ...cinatra, workflow: { key: "x" } } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.code === BPMN_ERROR_CODES.inlineDefinitionForbidden)).toBe(true);
  });

  it("rejects missing / non-integer workflowVersion", async () => {
    const missing = await parseWorkflowBpmnSidecar({ packageRoot: root, pkgCinatra: { kind: "workflow" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.some((e) => e.code === BPMN_ERROR_CODES.workflowVersionMissing)).toBe(true);
  });

  it("rejects a missing canonical sidecar", async () => {
    const empty = await mkdtemp(join(tmpdir(), "bpmn-empty-"));
    const r = await parseWorkflowBpmnSidecar({ packageRoot: empty, pkgCinatra: cinatra });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === BPMN_ERROR_CODES.sidecarMissing)).toBe(true);
    await rm(empty, { recursive: true, force: true });
  });

  it("rejects a duplicate (nested) sidecar", async () => {
    const dup = await mkdtemp(join(tmpdir(), "bpmn-dup-"));
    await mkdir(join(dup, "cinatra"), { recursive: true });
    await writeFile(join(dup, "cinatra", "workflow.bpmn"), MINIMAL_BPMN, "utf8");
    await mkdir(join(dup, "nested", "cinatra"), { recursive: true });
    await writeFile(join(dup, "nested", "cinatra", "workflow.bpmn"), MINIMAL_BPMN, "utf8");
    const r = await parseWorkflowBpmnSidecar({ packageRoot: dup, pkgCinatra: cinatra });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === BPMN_ERROR_CODES.sidecarDuplicate)).toBe(true);
    await rm(dup, { recursive: true, force: true });
  });
});
