/**
 * cinatra#4223 — THE PAGE CAPTURE STEP IS A MATERIALIZATION ROAD.
 *
 * The host's page capture tool files a screenshot only for an extension the
 * running package declares in its produces list. A passthrough step that calls
 * that tool with a literal, declared extension, a non-blank title and url, and
 * names itself as the ledger's node therefore IS a road that reaches the entry —
 * recognized exactly like the image-tool step (cinatra#3035). A step that does
 * not meet the statics resolves nothing, and the entry stays refused by the
 * existing finding.
 */
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_PAGE_CAPTURE_TOOL,
  collectArtifactImageNodesFromOasDocument,
} from "../artifact-binding";
import { evaluateProducesMaterializationContract } from "../verdaccio/package-contract";
import { scanOasForArtifactParityFindings } from "../validate-oas-runtime-invariants";

// Fixture names no extension lock names.
const SHOT = "@cinatra-ai/fixture-artifact";
const OTHER = "@cinatra-ai/fixture-other-artifact";

const NODE_ID = "capture_page";

function captureStepFlow(
  input: Partial<{ extension: string; node_id: string; title: string; url: string }> = {},
  tool = "artifact_page_capture",
): Record<string, unknown> {
  return {
    component_type: "Flow",
    id: "flow",
    $referenced_components: {
      [NODE_ID]: {
        component_type: "ApiNode",
        id: NODE_ID,
        name: NODE_ID,
        url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
        http_method: "POST",
        data: {
          tool,
          agent_run_id: "{{ cinatra_run_id }}",
          input: {
            extension: input.extension ?? SHOT,
            node_id: input.node_id ?? NODE_ID,
            title: input.title ?? "{{ title }}",
            url: input.url ?? "{{ page_url }}",
          },
        },
      },
    },
  };
}

function unmaterializedFor(
  findings: ReturnType<typeof evaluateProducesMaterializationContract>,
  extension: string,
) {
  return findings.filter(
    (f) =>
      f.code === "ARTIFACT-CONTRACT-PRODUCES-UNMATERIALIZED" && f.message.includes(extension),
  );
}

function parityFor(findings: ReturnType<typeof scanOasForArtifactParityFindings>, extension: string) {
  return findings.filter((f) => f.code === "OAS-RUNTIME-009" && f.message.includes(extension));
}

const UNCOVERED: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["a mismatched node_id", captureStepFlow({ node_id: "another_node" })],
  ["a templated node_id", captureStepFlow({ node_id: "{{ node_id }}" })],
  ["a blank url", captureStepFlow({ url: " \n\t " })],
  ["a blank title", captureStepFlow({ title: "   " })],
  ["a non-literal extension", captureStepFlow({ extension: "{{ extension }}" })],
  ["another extension", captureStepFlow({ extension: OTHER })],
  ['a data.tool of "constructor"', captureStepFlow({}, "constructor")],
];

describe("cinatra#4223 — the compile-time collector recognizes a page capture step", () => {
  it("names the host tool by its passthrough name", () => {
    expect(ARTIFACT_PAGE_CAPTURE_TOOL).toBe("artifact_page_capture");
  });

  it("collects a page capture step whose node_id equals its ApiNode id", () => {
    const { nodes } = collectArtifactImageNodesFromOasDocument(captureStepFlow(), {
      produces: [SHOT],
    });
    expect(nodes).toEqual([{ nodeId: NODE_ID, extension: SHOT }]);
  });

  for (const [label, flow] of UNCOVERED) {
    it(`collects nothing for ${label}`, () => {
      const { nodes } = collectArtifactImageNodesFromOasDocument(flow, { produces: [SHOT] });
      expect(nodes).toEqual([]);
    });
  }
});

describe("cinatra#4223 — the publish contract counts a page capture step as a road", () => {
  it("a produces entry a page capture step files passes the blocking contract", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [SHOT],
      oasDoc: captureStepFlow(),
    });
    expect(findings).toEqual([]);
  });

  for (const [label, flow] of UNCOVERED) {
    it(`a page capture step with ${label} is uncovered and refused`, () => {
      const findings = evaluateProducesMaterializationContract({ produces: [SHOT], oasDoc: flow });
      expect(findings).toHaveLength(1);
      expect(unmaterializedFor(findings, SHOT)).toHaveLength(1);
      expect(findings[0]?.severity).toBe("blocker");
    });
  }

  it("the refusal sentence names the page capture tool as a road", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [SHOT],
      oasDoc: captureStepFlow({ node_id: "another_node" }),
    });
    expect(findings[0]?.message).toContain("artifact_page_capture");
  });
});

describe("cinatra#4223 — the runtime invariants count a page capture step as a road", () => {
  it("the advisory mirror counts the page capture step as the entry's road", () => {
    const findings = scanOasForArtifactParityFindings(captureStepFlow(), { produces: [SHOT] });
    expect(parityFor(findings, SHOT)).toEqual([]);
  });

  for (const [label, flow] of UNCOVERED) {
    it(`a page capture step with ${label} is refused by the advisory mirror`, () => {
      const parity = parityFor(scanOasForArtifactParityFindings(flow, { produces: [SHOT] }), SHOT);
      expect(parity).toHaveLength(1);
      // The runtime-invariants surface is warning-only by design.
      expect(parity[0]?.severity).toBe("warning");
    });
  }

  it("the advisory sentence names the page capture tool as a road", () => {
    const parity = parityFor(
      scanOasForArtifactParityFindings(captureStepFlow({ node_id: "another_node" }), {
        produces: [SHOT],
      }),
      SHOT,
    );
    expect(parity[0]?.message).toContain("artifact_page_capture");
  });
});
