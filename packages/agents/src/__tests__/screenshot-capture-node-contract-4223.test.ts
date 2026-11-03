/**
 * cinatra#4223 — THE SCREENSHOT STEP IS A MATERIALIZATION ROAD.
 *
 * The host's screenshot tool files a screenshot only for an extension the
 * running package declares in its produces list. A passthrough step that calls
 * that tool with a literal, declared extension, a non-blank title and url, and
 * names itself as the ledger's node therefore IS a road that reaches the entry —
 * recognized exactly like the image-tool step (cinatra#3035). A step that does
 * not meet the statics resolves nothing, and the entry stays refused by the
 * existing finding.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_PAGE_CAPTURE_TOOL,
  collectArtifactImageNodesFromOasDocument,
} from "../artifact-binding";
import { evaluateProducesMaterializationContract } from "../verdaccio/package-contract";
import { scanOasForArtifactParityFindings } from "../validate-oas-runtime-invariants";

const SHOT = "@cinatra-ai/screenshot-artifact";
const OTHER = "@cinatra-ai/blog-post-artifact";

const NODE_ID = "capture_page";

function screenshotStepFlow(
  input: Partial<{ extension: string; node_id: string; title: string; url: string }> = {},
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
          tool: "artifact_page_capture",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cinatra#4223 — the compile-time collector recognizes a screenshot step", () => {
  it("names the host tool by its passthrough name", () => {
    expect(ARTIFACT_PAGE_CAPTURE_TOOL).toBe("artifact_page_capture");
  });

  it("collects a screenshot step whose node_id equals its ApiNode id", () => {
    const { nodes } = collectArtifactImageNodesFromOasDocument(screenshotStepFlow(), {
      produces: [SHOT],
    });
    expect(nodes).toEqual([{ nodeId: NODE_ID, extension: SHOT }]);
  });

  it("collects nothing for a mismatched node_id", () => {
    const { nodes } = collectArtifactImageNodesFromOasDocument(
      screenshotStepFlow({ node_id: "another_node" }),
      { produces: [SHOT] },
    );
    expect(nodes).toEqual([]);
  });

  it("collects nothing for a templated node_id", () => {
    const { nodes } = collectArtifactImageNodesFromOasDocument(
      screenshotStepFlow({ node_id: "{{ node_id }}" }),
      { produces: [SHOT] },
    );
    expect(nodes).toEqual([]);
  });
});

describe("cinatra#4223 — the publish contract counts a screenshot step as a road", () => {
  it("(a) a produces entry a screenshot step files passes the blocking contract", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [SHOT],
      oasDoc: screenshotStepFlow(),
    });
    expect(findings).toEqual([]);
  });

  it("(b) a screenshot step whose node id differs from its own id is uncovered and refused", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [SHOT],
      oasDoc: screenshotStepFlow({ node_id: "another_node" }),
    });
    expect(findings).toHaveLength(1);
    expect(unmaterializedFor(findings, SHOT)).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocker");
  });

  it("a screenshot step with a templated extension resolves nothing", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [SHOT],
      oasDoc: screenshotStepFlow({ extension: "{{ extension }}" }),
    });
    expect(findings).toHaveLength(1);
    expect(unmaterializedFor(findings, SHOT)).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocker");
  });

  it("a screenshot step filing another extension leaves the declared entry refused", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [SHOT],
      oasDoc: screenshotStepFlow({ extension: OTHER }),
    });
    expect(findings).toHaveLength(1);
    expect(unmaterializedFor(findings, SHOT)).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocker");
  });

  it("a screenshot step with a blank title or url resolves nothing", () => {
    for (const blank of [{ title: "   " }, { url: " \n\t " }]) {
      const findings = evaluateProducesMaterializationContract({
        produces: [SHOT],
        oasDoc: screenshotStepFlow(blank),
      });
      expect(findings).toHaveLength(1);
      expect(unmaterializedFor(findings, SHOT)).toHaveLength(1);
      expect(findings[0]?.severity).toBe("blocker");
    }
  });
});

describe("cinatra#4223 — the runtime invariants count a screenshot step as a road", () => {
  it("(c) the advisory mirror counts the screenshot step as the entry's road", () => {
    const findings = scanOasForArtifactParityFindings(screenshotStepFlow(), { produces: [SHOT] });
    expect(parityFor(findings, SHOT)).toEqual([]);
  });

  it("(d) a screenshot step whose node id differs from its own id is refused", () => {
    const findings = scanOasForArtifactParityFindings(
      screenshotStepFlow({ node_id: "another_node" }),
      { produces: [SHOT] },
    );
    const parity = parityFor(findings, SHOT);
    expect(parity).toHaveLength(1);
    // The runtime-invariants surface is warning-only by design.
    expect(parity[0]?.severity).toBe("warning");
  });

  it("a screenshot step with a blank title or url is refused by the advisory mirror", () => {
    for (const blank of [{ title: "   " }, { url: " \n\t " }]) {
      const findings = scanOasForArtifactParityFindings(screenshotStepFlow(blank), {
        produces: [SHOT],
      });
      expect(parityFor(findings, SHOT)).toHaveLength(1);
    }
  });
});
