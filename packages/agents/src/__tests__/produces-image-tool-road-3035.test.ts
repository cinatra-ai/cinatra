/**
 * cinatra#3035 — THE IMAGE STEP IS A MATERIALIZATION ROAD.
 *
 * The host's image tool files a picture only for an extension the running
 * package declares in its produces list. A passthrough step that calls that
 * tool with a literal, declared extension and names itself as the ledger's node
 * therefore IS a road that reaches the entry, and the publish contract (and its
 * advisory mirror) must count it; otherwise a package whose own flow files the
 * picture is refused for a declaration that resolves.
 *
 * The rule is generic: the flow below names only the host's tool, one artifact
 * extension and the step's own id. A step that does not meet the statics — a
 * templated extension, another extension, a ledger identity that is not its
 * own — resolves nothing, and the entry stays refused by the existing finding.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateProducesMaterializationContract } from "../verdaccio/package-contract";
import { scanOasForArtifactParityFindings } from "../validate-oas-runtime-invariants";

const IMAGE = "@cinatra-ai/blog-image-artifact";
const IMAGE_TYPE = "@cinatra-ai/blog-image-artifact:blog-image";
const OTHER = "@cinatra-ai/blog-post-artifact";

const NODE_ID = "file_picture";

function imageStepFlow(
  input: Partial<{ extension: string; node_id: string; title: string; prompt: string }> = {},
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
          tool: "artifact_image_generate",
          agent_run_id: "{{ cinatra_run_id }}",
          input: {
            extension: input.extension ?? IMAGE,
            objectTypeId: IMAGE_TYPE,
            node_id: input.node_id ?? NODE_ID,
            title: input.title ?? "{{ title }}",
            prompt: input.prompt ?? "{{ prompt }}",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cinatra#3035 — an image-tool step is a materialization road", () => {
  it("a produces entry an image-tool step files passes the blocking contract", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [IMAGE],
      oasDoc: imageStepFlow(),
    });
    expect(findings).toEqual([]);
  });

  it("the advisory mirror counts the image-tool step as the entry's road", () => {
    const findings = scanOasForArtifactParityFindings(imageStepFlow(), { produces: [IMAGE] });
    expect(
      findings.filter((f) => f.code === "OAS-RUNTIME-009" && f.message.includes(IMAGE)),
    ).toEqual([]);
  });

  it("an image-tool step with a templated extension resolves nothing", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [IMAGE],
      oasDoc: imageStepFlow({ extension: "{{ extension }}" }),
    });
    expect(findings).toHaveLength(1);
    expect(unmaterializedFor(findings, IMAGE)).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocker");
  });

  it("an image-tool step filing another extension leaves the declared entry refused", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [IMAGE],
      oasDoc: imageStepFlow({ extension: OTHER }),
    });
    expect(findings).toHaveLength(1);
    expect(unmaterializedFor(findings, IMAGE)).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocker");
  });

  it("an image-tool step whose node id differs from its own id resolves nothing", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [IMAGE],
      oasDoc: imageStepFlow({ node_id: "another_node" }),
    });
    expect(findings).toHaveLength(1);
    expect(unmaterializedFor(findings, IMAGE)).toHaveLength(1);
    expect(findings[0]?.severity).toBe("blocker");
  });

  it("an image-tool step with a blank title or prompt resolves nothing", () => {
    // The image tool trims both and refuses a blank one, so such a step files
    // no picture and must not count as the entry's road.
    for (const blank of [{ title: "   " }, { prompt: " \n\t " }]) {
      const findings = evaluateProducesMaterializationContract({
        produces: [IMAGE],
        oasDoc: imageStepFlow(blank),
      });
      expect(findings).toHaveLength(1);
      expect(unmaterializedFor(findings, IMAGE)).toHaveLength(1);
      expect(findings[0]?.severity).toBe("blocker");
      const advisory = scanOasForArtifactParityFindings(imageStepFlow(blank), {
        produces: [IMAGE],
      });
      expect(
        advisory.filter((f) => f.code === "OAS-RUNTIME-009" && f.message.includes(IMAGE)),
      ).toHaveLength(1);
    }
  });
});
