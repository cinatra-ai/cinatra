// The declaration-derived passthrough admission (cinatra#3035, epic #3023 W11).
//
// The host admits a pack's own passthrough tool BY THAT PACK'S DECLARATION: the
// calling extension's pinned `cinatra/oas.json` must carry a node that calls the
// passthrough with that tool name. No pack name and no tool name is written in
// core, so the fixtures below are a made-up pack under a made-up vendor — the
// admission has to hold for any pack at all, which is the point.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  declaredPassthroughTools,
  declaresPassthroughTool,
} from "@/lib/extension-scoped-tools";

const FIXTURE_PACK = "@acme/example-pack";

const roots: string[] = [];

function writeFixtureOas(doc: unknown): (packageName: string) => string | null {
  const root = mkdtempSync(path.join(tmpdir(), "declared-passthrough-"));
  roots.push(root);
  const dir = path.join(root, "acme", "example-pack", "cinatra");
  mkdirSync(dir, { recursive: true });
  const oasPath = path.join(dir, "oas.json");
  writeFileSync(oasPath, typeof doc === "string" ? doc : JSON.stringify(doc));
  return (packageName: string) => (packageName === FIXTURE_PACK ? oasPath : null);
}

/** A pack whose flow calls the passthrough twice, plus a node that calls
 *  somewhere else entirely and a nested referenced component. */
const DECLARING_PACK_OAS = {
  component_type: "Flow",
  id: "example_pack_flow",
  nodes: {
    prepare: {
      component_type: "ApiNode",
      id: "prepare",
      url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
      http_method: "POST",
      data: { tool: "example_pack_ideas", input: { op: "prepare" } },
    },
    elsewhere: {
      component_type: "ApiNode",
      id: "elsewhere",
      url: "https://example.invalid/v1/things",
      http_method: "POST",
      data: { tool: "example_pack_offsite" },
    },
    talk: { component_type: "OutputMessageNode", id: "talk" },
  },
  $referenced_components: {
    nested: {
      component_type: "Flow",
      nodes: {
        finish: {
          component_type: "ApiNode",
          id: "finish",
          url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
          data: { tool: "example_pack_finish" },
        },
      },
    },
  },
};

afterEach(() => {
  roots.length = 0;
});

describe("the passthrough admission a pack's own declaration gives", () => {
  it("reads every tool the pack's own nodes call on the passthrough", async () => {
    const oasPathFor = writeFixtureOas(DECLARING_PACK_OAS);
    const declared = await declaredPassthroughTools(FIXTURE_PACK, { oasPathFor });
    expect([...declared].sort()).toEqual(["example_pack_finish", "example_pack_ideas"]);
  });

  it("admits a tool the calling pack declares a node for", async () => {
    const oasPathFor = writeFixtureOas(DECLARING_PACK_OAS);
    await expect(
      declaresPassthroughTool(FIXTURE_PACK, "example_pack_ideas", { oasPathFor }),
    ).resolves.toBe(true);
  });

  it("refuses a tool no node of the calling pack calls", async () => {
    const oasPathFor = writeFixtureOas(DECLARING_PACK_OAS);
    await expect(
      declaresPassthroughTool(FIXTURE_PACK, "example_pack_something_else", { oasPathFor }),
    ).resolves.toBe(false);
  });

  it("refuses a tool the pack names on a node that calls somewhere else", async () => {
    const oasPathFor = writeFixtureOas(DECLARING_PACK_OAS);
    await expect(
      declaresPassthroughTool(FIXTURE_PACK, "example_pack_offsite", { oasPathFor }),
    ).resolves.toBe(false);
  });

  it("refuses every tool for a package with no declaration installed", async () => {
    const oasPathFor = writeFixtureOas(DECLARING_PACK_OAS);
    const declared = await declaredPassthroughTools("@acme/other-pack", { oasPathFor });
    expect([...declared]).toEqual([]);
    await expect(
      declaresPassthroughTool("@acme/other-pack", "example_pack_ideas", { oasPathFor }),
    ).resolves.toBe(false);
  });

  it("refuses every tool when the declaration cannot be read", async () => {
    const oasPathFor = writeFixtureOas("{ this is not json");
    const declared = await declaredPassthroughTools(FIXTURE_PACK, { oasPathFor });
    expect([...declared]).toEqual([]);
  });
});

// THE CONVERGENCE ROUND'S REFUSALS. Two ways a declaration could once admit a
// name it does not call: a url that merely CARRIES the host path (a longer path,
// a query parameter, somebody else's origin), and an ApiNode-SHAPED object
// sitting in a payload rather than in the flow. Both refuse now, and the nesting
// the packs really use — api nodes under referenced components, to any depth —
// still admits.
const MISLEADING_PACK_OAS = {
  component_type: "Flow",
  id: "misleading_flow",
  nodes: {
    longer_path: {
      component_type: "ApiNode",
      id: "longer_path",
      url: "{{CINATRA_BASE_URL}}/api/agents/passthrough-extra",
      data: { tool: "example_pack_longer_path" },
    },
    in_a_query: {
      component_type: "ApiNode",
      id: "in_a_query",
      url: "{{CINATRA_BASE_URL}}/api/agents/collect?next=/api/agents/passthrough",
      data: { tool: "example_pack_in_a_query" },
    },
    somebody_elses_origin: {
      component_type: "ApiNode",
      id: "somebody_elses_origin",
      url: "https://example.invalid/api/agents/passthrough",
      data: { tool: "example_pack_other_origin" },
    },
    carries_a_payload: {
      component_type: "ApiNode",
      id: "carries_a_payload",
      url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
      data: {
        tool: "example_pack_real_call",
        input: {
          // An ApiNode SHAPE inside the request payload — an example, not a node.
          example: {
            component_type: "ApiNode",
            id: "not_a_node",
            url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
            data: { tool: "example_pack_payload_shape" },
          },
        },
      },
      metadata: {
        sample: {
          component_type: "ApiNode",
          id: "also_not_a_node",
          url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
          data: { tool: "example_pack_metadata_shape" },
        },
      },
    },
  },
  $referenced_components: {
    subflow: {
      component_type: "Flow",
      $referenced_components: {
        deeper: {
          component_type: "Flow",
          $referenced_components: {
            deep_call: {
              component_type: "ApiNode",
              id: "deep_call",
              url: "{{CINATRA_BASE_URL}}/api/agents/passthrough/",
              data: { tool: "example_pack_deep_call" },
            },
          },
        },
      },
    },
  },
};

describe("what a declaration does NOT admit", () => {
  it("reads only the tools of nodes that really call the passthrough path", async () => {
    const oasPathFor = writeFixtureOas(MISLEADING_PACK_OAS);
    const declared = await declaredPassthroughTools(FIXTURE_PACK, { oasPathFor });
    expect([...declared].sort()).toEqual([
      "example_pack_deep_call",
      "example_pack_real_call",
    ]);
  });

  it.each([
    ["a longer path that only starts with it", "example_pack_longer_path"],
    ["the path named in a query parameter", "example_pack_in_a_query"],
    ["the path on somebody else's origin", "example_pack_other_origin"],
    ["an api-node shape inside a request payload", "example_pack_payload_shape"],
    ["an api-node shape inside a node's metadata", "example_pack_metadata_shape"],
  ])("refuses a tool declared behind %s", async (_case, tool) => {
    const oasPathFor = writeFixtureOas(MISLEADING_PACK_OAS);
    await expect(declaresPassthroughTool(FIXTURE_PACK, tool, { oasPathFor })).resolves.toBe(
      false,
    );
  });

  it("still admits a node nested under referenced components to any depth", async () => {
    const oasPathFor = writeFixtureOas(MISLEADING_PACK_OAS);
    await expect(
      declaresPassthroughTool(FIXTURE_PACK, "example_pack_deep_call", { oasPathFor }),
    ).resolves.toBe(true);
  });
});
