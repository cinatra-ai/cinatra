import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArgs,
  validateAgent,
  validateWorkflow,
  validateWorkflowPackageShape,
  validateBpmnSanity,
  runGate,
} from "../templates/extension-repo/extension-kind-gate.mjs";

// A minimal, well-formed BPMN sidecar used as the happy-path fixture.
const GOOD_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d1">
  <bpmn:process id="p1" isExecutable="true">
    <bpmn:startEvent id="s1"/>
    <bpmn:endEvent id="e1"/>
  </bpmn:process>
</bpmn:definitions>`;

const GOOD_WORKFLOW_CINATRA = {
  apiVersion: "cinatra.ai/v1",
  kind: "workflow",
  dependencies: [],
  workflowVersion: 1,
};

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "extkind-gate-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writePkg(dir, pkg) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}
function writeCinatra(dir, file, content) {
  mkdirSync(join(dir, "cinatra"), { recursive: true });
  writeFileSync(join(dir, "cinatra", file), content);
}

describe("parseArgs", () => {
  it("defaults to cwd", () => {
    expect(parseArgs([]).packageRoot).toBe(process.cwd());
  });
  it("--package-root <value>", () => {
    expect(parseArgs(["--package-root", "/x/y"]).packageRoot).toBe("/x/y");
  });
  it("--package-root=<value>", () => {
    expect(parseArgs(["--package-root=/a/b"]).packageRoot).toBe("/a/b");
  });
});

describe("validateBpmnSanity (zero-dep XML/BPMN sanity)", () => {
  it("passes a well-formed bpmn:definitions with ≥1 process", () => {
    expect(validateBpmnSanity(GOOD_BPMN)).toEqual([]);
  });
  it("flags empty content", () => {
    expect(validateBpmnSanity("   ")).toContain("cinatra/workflow.bpmn is empty");
  });
  it("flags a non-BPMN root (no MODEL namespace binding)", () => {
    const xml = `<foo:process id="p1"></foo:process>`;
    expect(validateBpmnSanity(xml).join("|")).toContain("does not bind the BPMN 2.0 MODEL namespace");
  });
  it("flags zero processes", () => {
    const xml = `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"><bpmn:collaboration id="c"></bpmn:collaboration></bpmn:definitions>`;
    expect(validateBpmnSanity(xml).join("|")).toContain("at least one");
  });
  it("REJECTS look-alike non-BPMN XML missing the BPMN MODEL namespace", () => {
    // A bypass to guard against: well-formed, has <x:definitions>+<x:process>,
    // but is NOT BPMN (no MODEL namespace URI).
    const xml = `<x:definitions><x:process id="p1"/></x:definitions>`;
    expect(validateBpmnSanity(xml).join("|")).toContain("BPMN 2.0 MODEL namespace");
  });
  it("REJECTS a non-definitions root even with the BPMN namespace present", () => {
    const xml = `<bpmn:process xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="p1"/>`;
    expect(validateBpmnSanity(xml).join("|")).toContain("root must be <definitions>");
  });
  it("REJECTS the URI bound to an UNUSED prefix while root/process use another (namespace-binding aware)", () => {
    // Look-alike #1: URI present but bound to prefix `y`, root/process use `x`.
    const xml = `<x:definitions xmlns:y="http://www.omg.org/spec/BPMN/20100524/MODEL"><x:process id="p1"/></x:definitions>`;
    const errs = validateBpmnSanity(xml).join("|");
    expect(errs).toMatch(/root must be <definitions>|does not bind the BPMN/);
  });
  it("REJECTS the BPMN URI appearing only in a COMMENT (not a real root binding)", () => {
    // Look-alike #2: URI in a comment, no real xmlns binding on root.
    const xml = `<!-- http://www.omg.org/spec/BPMN/20100524/MODEL --><x:definitions><x:process id="p1"/></x:definitions>`;
    expect(validateBpmnSanity(xml).join("|")).toContain("does not bind the BPMN 2.0 MODEL namespace");
  });
  it("ACCEPTS the BPMN MODEL ns bound to the DEFAULT namespace (no prefix)", () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="p1"/></definitions>`;
    expect(validateBpmnSanity(xml)).toEqual([]);
  });
  it("ACCEPTS SINGLE-quoted xmlns (prefixed) — XML permits both quote styles", () => {
    const xml = `<bpmn:definitions xmlns:bpmn='http://www.omg.org/spec/BPMN/20100524/MODEL'><bpmn:process id='p1'/></bpmn:definitions>`;
    expect(validateBpmnSanity(xml)).toEqual([]);
  });
  it("ACCEPTS SINGLE-quoted default-namespace BPMN", () => {
    const xml = `<definitions xmlns='http://www.omg.org/spec/BPMN/20100524/MODEL'><process id='p1'/></definitions>`;
    expect(validateBpmnSanity(xml)).toEqual([]);
  });
  it("flags a mismatched closing tag (malformed)", () => {
    const xml = `<bpmn:definitions><bpmn:process></bpmn:definitions>`;
    expect(validateBpmnSanity(xml).join("|")).toMatch(/malformed BPMN XML/);
  });
  it("flags an unclosed element (truncation)", () => {
    const xml = `<bpmn:definitions><bpmn:process id="p1">`;
    expect(validateBpmnSanity(xml).join("|")).toMatch(/unclosed element/);
  });
  it("tolerates self-closing tags, comments, CDATA, PIs", () => {
    const xml = `<?xml version="1.0"?>
<!-- a comment with <fake> markup -->
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="p1"><bpmn:task id="t"/><![CDATA[ <not-a-tag> ]]></bpmn:process></bpmn:definitions>`;
    expect(validateBpmnSanity(xml)).toEqual([]);
  });
});

describe("validateWorkflowPackageShape (mirror of validateWorkflowExtensionPackage)", () => {
  it("passes a valid workflow package", () => {
    expect(
      validateWorkflowPackageShape({ name: "@cinatra-ai/major-release-workflow", cinatra: GOOD_WORKFLOW_CINATRA }),
    ).toEqual([]);
  });
  it("flags a non -workflow package name", () => {
    expect(
      validateWorkflowPackageShape({ name: "@cinatra-ai/some-agent", cinatra: GOOD_WORKFLOW_CINATRA }).join("|"),
    ).toContain("must match @<scope>/<slug>-workflow");
  });
  it("flags kind != workflow", () => {
    expect(
      validateWorkflowPackageShape({ name: "@x/y-workflow", cinatra: { ...GOOD_WORKFLOW_CINATRA, kind: "agent" } }).join("|"),
    ).toContain('cinatra.kind: "workflow"');
  });
  it("flags inline cinatra.workflow", () => {
    expect(
      validateWorkflowPackageShape({ name: "@x/y-workflow", cinatra: { ...GOOD_WORKFLOW_CINATRA, workflow: {} } }).join("|"),
    ).toContain("inline cinatra.workflow is forbidden");
  });
  it("flags a non-positive-integer workflowVersion", () => {
    expect(
      validateWorkflowPackageShape({ name: "@x/y-workflow", cinatra: { ...GOOD_WORKFLOW_CINATRA, workflowVersion: 0 } }).join("|"),
    ).toContain("positive integer");
  });
  it("flags an unexpected cinatra key", () => {
    expect(
      validateWorkflowPackageShape({ name: "@x/y-workflow", cinatra: { ...GOOD_WORKFLOW_CINATRA, bogus: 1 } }).join("|"),
    ).toContain('unexpected cinatra key "bogus"');
  });
});

describe("validateAgent (cinatra/oas.json retired-primitive scan)", () => {
  it("passes when there is no oas.json (nothing to scan)", () => {
    writePkg(tmp, { name: "@cinatra-ai/x-agent", cinatra: { kind: "agent" } });
    expect(validateAgent(tmp)).toEqual([]);
  });
  it("passes a clean oas.json", () => {
    writeCinatra(tmp, "oas.json", JSON.stringify({ paths: { "/x": { description: "uses crm_account_search" } } }));
    expect(validateAgent(tmp)).toEqual([]);
  });
  it("flags a retired primitive in an LLM-visible field", () => {
    writeCinatra(tmp, "oas.json", JSON.stringify({ nodes: [{ system: "first call accounts_list then proceed" }] }));
    expect(validateAgent(tmp).join("|")).toContain("accounts_list");
  });
  it("flags a legacy entity typeHint", () => {
    writeCinatra(tmp, "oas.json", JSON.stringify({ user: "read @cinatra-ai/entity-contacts:contact" }));
    expect(validateAgent(tmp).join("|")).toContain("entity-contacts:contact");
  });
  it("flags malformed oas.json", () => {
    writeCinatra(tmp, "oas.json", "{ not json ");
    expect(validateAgent(tmp).join("|")).toContain("failed to parse");
  });
  it("does NOT flag a banned token outside an LLM-visible field", () => {
    writeCinatra(tmp, "oas.json", JSON.stringify({ operationId: "accounts_list" }));
    expect(validateAgent(tmp)).toEqual([]);
  });
});

describe("validateWorkflow (package shape + sidecar)", () => {
  it("passes a valid workflow package + bpmn", () => {
    writePkg(tmp, { name: "@cinatra-ai/major-release-workflow", cinatra: GOOD_WORKFLOW_CINATRA });
    writeCinatra(tmp, "workflow.bpmn", GOOD_BPMN);
    expect(validateWorkflow(tmp)).toEqual([]);
  });
  it("flags a missing sidecar", () => {
    writePkg(tmp, { name: "@cinatra-ai/major-release-workflow", cinatra: GOOD_WORKFLOW_CINATRA });
    expect(validateWorkflow(tmp).join("|")).toContain("missing required sidecar cinatra/workflow.bpmn");
  });
  it("flags a malformed sidecar", () => {
    writePkg(tmp, { name: "@cinatra-ai/major-release-workflow", cinatra: GOOD_WORKFLOW_CINATRA });
    writeCinatra(tmp, "workflow.bpmn", "<bpmn:definitions><bpmn:process></bpmn:definitions>");
    expect(validateWorkflow(tmp).join("|")).toMatch(/malformed BPMN XML/);
  });
  it("flags a DUPLICATE nested cinatra/workflow.bpmn (mirror host findAllSidecars)", () => {
    writePkg(tmp, { name: "@cinatra-ai/major-release-workflow", cinatra: GOOD_WORKFLOW_CINATRA });
    writeCinatra(tmp, "workflow.bpmn", GOOD_BPMN);
    // a second sidecar under a nested cinatra/ dir
    mkdirSync(join(tmp, "examples", "cinatra"), { recursive: true });
    writeFileSync(join(tmp, "examples", "cinatra", "workflow.bpmn"), GOOD_BPMN);
    expect(validateWorkflow(tmp).join("|")).toContain("expected exactly one cinatra/workflow.bpmn, found 2");
  });
});

describe("runGate (kind dispatch)", () => {
  it("dispatches kind:agent to the agent gate", () => {
    writePkg(tmp, { name: "@cinatra-ai/x-agent", cinatra: { kind: "agent" } });
    writeCinatra(tmp, "oas.json", JSON.stringify({ system: "uses contacts_delete" }));
    const { kind, errors } = runGate(tmp);
    expect(kind).toBe("agent");
    expect(errors.join("|")).toContain("contacts_delete");
  });
  it("dispatches kind:workflow to the workflow gate", () => {
    writePkg(tmp, { name: "@cinatra-ai/major-release-workflow", cinatra: GOOD_WORKFLOW_CINATRA });
    writeCinatra(tmp, "workflow.bpmn", GOOD_BPMN);
    expect(runGate(tmp)).toEqual({ kind: "workflow", errors: [] });
  });
  it("passes (no gate) for connector / artifact / skill", () => {
    for (const kind of ["connector", "artifact", "skill"]) {
      writePkg(tmp, { name: "@cinatra-ai/x", cinatra: { kind } });
      expect(runGate(tmp)).toEqual({ kind, errors: [] });
    }
  });
  it("fails closed on an unreadable package.json", () => {
    const { errors } = runGate(join(tmp, "does-not-exist"));
    expect(errors.join("|")).toContain("could not read package.json");
  });
});
