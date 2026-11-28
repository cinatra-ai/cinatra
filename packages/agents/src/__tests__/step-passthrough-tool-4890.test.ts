/**
 * cinatra#4890: the fixed host tool a passthrough step of a flow calls, read by
 * the step's id over the steps the run reads. A tool that ends a run is reached
 * only from a step that names it in its own fixed data; a model step, a step
 * whose tool is templated, or ids shared by steps that call different tools
 * name no tool. Plain OAS documents built here drive the real export.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as invariants from "../validate-oas-runtime-invariants";

type Reader = (document: unknown, stepId: string) => string | null | undefined;
const find: Reader =
  (invariants as unknown as { findStepPassthroughTool?: Reader }).findStepPassthroughTool ?? (() => undefined);

const PASSTHROUGH = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
const step = (id: string, data: unknown, url = PASSTHROUGH) => ({
  component_type: "ApiNode",
  id,
  name: id,
  url,
  http_method: "POST",
  data,
});
// Steps sit in the root's `$referenced_components`, as the run reads them; each key is its own.
const flow = (...nodes: unknown[]) => ({
  component_type: "Flow",
  id: "flow",
  name: "flow",
  $referenced_components: Object.fromEntries(nodes.map((node, index) => [`step_${index}`, node])),
});

describe("findStepPassthroughTool", () => {
  it("names the tool a passthrough step calls in its fixed data", () => {
    expect(find(flow(step("stop", { tool: "run_fail", input: {} })), "stop")).toBe("run_fail");
  });

  it("reads data written as JSON text", () => {
    expect(find(flow(step("stop", JSON.stringify({ tool: "run_fail" }))), "stop")).toBe("run_fail");
  });

  it("names no tool for a model step, an unknown id or a step without a fixed tool", () => {
    const doc = flow(
      step("model", { tool: "run_fail" }, "{{CINATRA_BASE_URL}}/api/llm-bridge"),
      step("templated", "{{ payload }}"),
      step("bare", { input: {} }),
    );
    expect(find(doc, "model")).toBe(null);
    expect(find(doc, "templated")).toBe(null);
    expect(find(doc, "bare")).toBe(null);
    expect(find(doc, "missing")).toBe(null);
  });

  it("names no tool when steps that share the id call different tools", () => {
    const doc = flow(step("twin", { tool: "run_fail" }), step("twin", { tool: "extension_data" }));
    expect(find(doc, "twin")).toBe(null);
  });
});

describe("OAS-RUNTIME-017: a step that ends its run never takes bad answers itself", () => {
  const findings = (doc: Record<string, unknown>) =>
    invariants.scanOasForRuntimeInvariantFindings(doc).filter((f) => f.code === "OAS-RUNTIME-017");

  it("refuses a run_fail step that sets ignore_bad_http_requests, and only that step", () => {
    const found = findings(flow({ ...step("stop", { tool: "run_fail" }), ignore_bad_http_requests: true }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "blocker", location: "$.$referenced_components.step_0" });
    expect(found[0]!.message).toContain('Step "stop"');
    expect(findings(flow(step("stop", { tool: "run_fail" })))).toEqual([]);
    expect(findings(flow({ ...step("save", { tool: "objects_save" }), ignore_bad_http_requests: true }))).toEqual([]);
  });

  it("refuses a run_fail step the run time would not read as a passthrough call, or that does not POST", () => {
    const relative = findings(flow(step("stop", { tool: "run_fail" }, "/api/agents/passthrough")));
    expect(relative).toHaveLength(1);
    expect(relative[0]!.message).toContain("is not a URL the run time reads as the host's passthrough");
    const fetched = findings(flow({ ...step("stop", { tool: "run_fail" }), http_method: "GET" }));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.message).toContain("does not POST");
    expect(findings(flow(step("stop", { tool: "run_fail" }, `${PASSTHROUGH}?x=1`)))).toEqual([]);
  });
});

// The same table the loader's tests read (docker/wayflow/tests/fixtures/run_fail_parity.json).
const PARITY = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../docker/wayflow/tests/fixtures/run_fail_parity.json"), "utf8"),
) as { urls: Array<{ url: string; passthrough: boolean }> };

describe("the passthrough call, as the run time reads it", () => {
  type UrlRule = (url: unknown) => boolean | undefined;
  const isPassthroughUrl: UrlRule =
    (invariants as unknown as { isPassthroughUrl?: UrlRule }).isPassthroughUrl ?? (() => undefined);

  it.each(PARITY.urls)("reads $url as a passthrough call: $passthrough", ({ url, passthrough }) => {
    expect(isPassthroughUrl(url)).toBe(passthrough);
    expect(find(flow(step("stop", { tool: "run_fail" }, url)), "stop")).toBe(passthrough ? "run_fail" : null);
  });
});
