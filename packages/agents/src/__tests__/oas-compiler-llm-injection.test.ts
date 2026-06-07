/**
 * Contract tests for `injectCinatraLlmIntoApiNodes`.
 *
 * Locks the per-node fan-out behaviour the bridge route depends on:
 * every ApiNode whose `url` targets `/api/llm-bridge` MUST carry
 * `data.cinatra_llm` matching the OAS root `metadata.cinatra.llm`, at ANY
 * nesting depth (top-level + Flow-embedded subflows). When the OAS does NOT
 * declare `metadata.cinatra.llm`, the helper is a strict no-op.
 *
 * Eleven cases — 8 standard + 3 recursion:
 *   1. INJECT (exact `/api/llm-bridge`)
 *   2. INJECT (templated `{{CINATRA_BASE_URL}}/api/llm-bridge` — current
 *              authored form across all extensions/cinatra-ai/*)
 *   3. PRESERVE — existing data fields untouched
 *   4. SKIP-NO-METADATA — back-compat
 *   5. SKIP-OTHER-URL — non-bridge ApiNode untouched
 *   6. MULTI-NODE — two bridge nodes get injection, third (other URL) does not
 *   7. OVERRIDE-DEFENSIVE — pre-existing `cinatra_llm` preserved
 *   8. TYPE — injected block is a fresh reference, not aliased to the input
 *   9. EMBEDDED-SUBFLOW — FlowNode → Flow subflow → nested ApiNode injection
 *  10. DEEP-NESTED — ≥2 levels of Flow nesting still receives injection
 *  11. NESTED-MIXED — only the bridge ApiNode inside a subflow is injected
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *      src/__tests__/oas-compiler-llm-injection.test.ts
 */
import { describe, expect, it } from "vitest";

import { injectCinatraLlmIntoApiNodes } from "../oas-compiler";
import type { OasCinatraLlm } from "../llm-provider-policy";

// ---------------------------------------------------------------------------
// Shared fixture helpers. Each test mutates `data.cinatra_llm` post-call and
// reads back via `findApiNodeByUrl(...)` which recurses through Flow subflows
// the same way the production walker does.
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

const SAMPLE_LLM: OasCinatraLlm = {
  preferredProvider: "gemini",
  preferredModel: "gemini-2.5-flash",
  capabilityRequired: "media_input",
};

function makeApiNode(id: string, url: string, dataExtra: Record<string, unknown> = {}): Node {
  return {
    component_type: "ApiNode",
    id,
    name: id,
    url,
    http_method: "POST",
    data: {
      system: "you are a test",
      user: "do the thing",
      agent_id: id,
      ...dataExtra,
    },
    outputs: [{ title: "out", type: "string" }],
  };
}

function makeStartNode(): Node {
  return { component_type: "StartNode", id: "start", name: "start", inputs: [] };
}

function makeEndNode(): Node {
  return { component_type: "EndNode", id: "end", name: "end", outputs: [] };
}

// Build a Flow OAS with the supplied $referenced_components map. The shape
// matches what compileOasAgentJson parses — `metadata.cinatra` carries the
// optional `llm` block; the bridge route reads each ApiNode's
// `data.cinatra_llm` directly.
function buildOas(
  refs: Record<string, Node>,
  llm?: OasCinatraLlm,
): Record<string, unknown> {
  const cinatra: Record<string, unknown> = { type: "node" };
  if (llm !== undefined) cinatra.llm = llm;
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    metadata: { cinatra },
    nodes: Object.keys(refs).map((id) => ({ $component_ref: id })),
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: refs,
  };
}

// Build a Flow component (used as the inner subflow of a FlowNode). Same
// shape as a root OAS Flow — agentspec_version + component_type:"Flow" +
// $referenced_components. The walker descends into Flow.$referenced_components.
function buildFlowSubflow(id: string, refs: Record<string, Node>): Node {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id,
    name: id,
    inputs: [],
    outputs: [],
    nodes: Object.keys(refs).map((cid) => ({ $component_ref: cid })),
    start_node: { $component_ref: Object.keys(refs)[0] ?? "start" },
    control_flow_connections: [],
    $referenced_components: refs,
  };
}

// Recursive lookup mirroring the production walker — returns the first
// ApiNode at any depth whose `url` equals or matches the predicate.
function findApiNodeByUrl(
  oas: Record<string, unknown>,
  predicate: (url: unknown) => boolean,
): Node | null {
  function visit(container: unknown): Node | null {
    if (!container || typeof container !== "object") return null;
    for (const entry of Object.values(container as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const node = entry as Node;
      if (node.component_type === "ApiNode" && predicate(node.url)) return node;
      if (node.component_type === "Flow") {
        const nested = node.$referenced_components;
        const hit = visit(nested);
        if (hit) return hit;
      }
    }
    return null;
  }
  return visit(oas.$referenced_components);
}

function findAllApiNodes(oas: Record<string, unknown>): Node[] {
  const out: Node[] = [];
  function visit(container: unknown): void {
    if (!container || typeof container !== "object") return;
    for (const entry of Object.values(container as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const node = entry as Node;
      if (node.component_type === "ApiNode") out.push(node);
      if (node.component_type === "Flow") visit(node.$referenced_components);
    }
  }
  visit(oas.$referenced_components);
  return out;
}

// ---------------------------------------------------------------------------
// Standard cases (8) — flat OAS, no FlowNode subflow recursion.
// ---------------------------------------------------------------------------

describe("injectCinatraLlmIntoApiNodes — flat OAS", () => {
  it("INJECT: ApiNode at exact /api/llm-bridge receives the cinatra_llm block", () => {
    const oas = buildOas(
      {
        start: makeStartNode(),
        draft: makeApiNode("draft", "/api/llm-bridge"),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const draft = findApiNodeByUrl(oas, (u) => u === "/api/llm-bridge");
    expect(draft).not.toBeNull();
    const data = draft!.data as Record<string, unknown>;
    expect(data.cinatra_llm).toEqual(SAMPLE_LLM);
  });

  it("INJECT: ApiNode at {{CINATRA_BASE_URL}}/api/llm-bridge (templated form) receives the block", () => {
    // Every authored OAS today uses the templated form. The matcher must
    // handle it without modification.
    const oas = buildOas(
      {
        start: makeStartNode(),
        draft: makeApiNode("draft", "{{CINATRA_BASE_URL}}/api/llm-bridge"),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const draft = findApiNodeByUrl(
      oas,
      (u) => u === "{{CINATRA_BASE_URL}}/api/llm-bridge",
    );
    expect(draft).not.toBeNull();
    const data = draft!.data as Record<string, unknown>;
    expect(data.cinatra_llm).toEqual(SAMPLE_LLM);
  });

  it("PRESERVE: existing data fields (system/user/agent_id) survive injection", () => {
    const oas = buildOas(
      {
        start: makeStartNode(),
        draft: makeApiNode("draft", "/api/llm-bridge", {
          agent_run_id: "{{ agent_run_id }}",
        }),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const draft = findApiNodeByUrl(oas, (u) => u === "/api/llm-bridge")!;
    const data = draft.data as Record<string, unknown>;
    expect(data.system).toBe("you are a test");
    expect(data.user).toBe("do the thing");
    expect(data.agent_id).toBe("draft");
    expect(data.agent_run_id).toBe("{{ agent_run_id }}");
    expect(draft.url).toBe("/api/llm-bridge");
    expect(draft.http_method).toBe("POST");
    expect(data.cinatra_llm).toEqual(SAMPLE_LLM);
  });

  it("SKIP-NO-METADATA: OAS without metadata.cinatra.llm leaves data untouched for back-compat", () => {
    const oas = buildOas({
      start: makeStartNode(),
      draft: makeApiNode("draft", "/api/llm-bridge"),
      end: makeEndNode(),
    }); // no llm metadata

    injectCinatraLlmIntoApiNodes(oas, undefined);

    const draft = findApiNodeByUrl(oas, (u) => u === "/api/llm-bridge")!;
    const data = draft.data as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(data, "cinatra_llm")).toBe(false);
  });

  it("SKIP-OTHER-URL: ApiNode targeting a non-bridge URL is not modified", () => {
    const oas = buildOas(
      {
        start: makeStartNode(),
        save: makeApiNode("save", "/api/agent-callback"),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const save = findApiNodeByUrl(oas, (u) => u === "/api/agent-callback")!;
    const data = save.data as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(data, "cinatra_llm")).toBe(false);
  });

  it("MULTI-NODE: two bridge ApiNodes injected, third (non-bridge) untouched", () => {
    const oas = buildOas(
      {
        start: makeStartNode(),
        draft: makeApiNode("draft", "/api/llm-bridge"),
        recipients: makeApiNode("recipients", "{{CINATRA_BASE_URL}}/api/llm-bridge"),
        save: makeApiNode("save", "/api/agent-callback"),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const draft = findApiNodeByUrl(oas, (u) => u === "/api/llm-bridge")!;
    const recipients = findApiNodeByUrl(
      oas,
      (u) => u === "{{CINATRA_BASE_URL}}/api/llm-bridge",
    )!;
    const save = findApiNodeByUrl(oas, (u) => u === "/api/agent-callback")!;

    expect((draft.data as Record<string, unknown>).cinatra_llm).toEqual(SAMPLE_LLM);
    expect((recipients.data as Record<string, unknown>).cinatra_llm).toEqual(SAMPLE_LLM);
    expect(
      Object.prototype.hasOwnProperty.call(save.data as Record<string, unknown>, "cinatra_llm"),
    ).toBe(false);
  });

  it("OVERRIDE-DEFENSIVE: ApiNode with pre-existing cinatra_llm preserves the original value", () => {
    const hand = {
      preferredProvider: "anthropic" as const,
      preferredModel: "claude-sonnet-4-6",
    };
    const node = makeApiNode("draft", "/api/llm-bridge");
    (node.data as Record<string, unknown>).cinatra_llm = hand;

    const oas = buildOas(
      { start: makeStartNode(), draft: node, end: makeEndNode() },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const draft = findApiNodeByUrl(oas, (u) => u === "/api/llm-bridge")!;
    expect((draft.data as Record<string, unknown>).cinatra_llm).toBe(hand);
  });

  it("TYPE: injected cinatra_llm is a fresh reference — mutating it does not affect input metadata", () => {
    const oas = buildOas(
      {
        start: makeStartNode(),
        draft: makeApiNode("draft", "/api/llm-bridge"),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const draft = findApiNodeByUrl(oas, (u) => u === "/api/llm-bridge")!;
    const injected = (draft.data as Record<string, unknown>).cinatra_llm as Record<
      string,
      unknown
    >;
    injected.preferredProvider = "openai";

    // The constant input must remain untouched.
    expect(SAMPLE_LLM.preferredProvider).toBe("gemini");
  });
});

// ---------------------------------------------------------------------------
// Recursion cases (3) — FlowNode-embedded Flow subflows.
//
// Real-world reference: extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json
// has five Flow subflows (trigger-subflow, email-recipient-selection-subflow,
// email-drafting-subflow, email-delivery-subflow, plus one more), each
// referenced by a FlowNode at the root and each containing its own ApiNode
// against /api/llm-bridge. Skipping the recursion silently drops the OAS's
// LLM preference for every subflow-routed call.
// ---------------------------------------------------------------------------

describe("injectCinatraLlmIntoApiNodes — FlowNode subflow recursion", () => {
  it("EMBEDDED-SUBFLOW: top-level ApiNode AND nested subflow ApiNode both receive injection", () => {
    // Mirrors the email-outreach-agent shape: a root FlowNode points at a
    // Flow subflow via subflow.$component_ref; the Flow itself lives at the
    // root $referenced_components level and carries its own
    // $referenced_components with the nested ApiNode.
    const oas = buildOas(
      {
        start: makeStartNode(),
        top_draft: makeApiNode("top_draft", "{{CINATRA_BASE_URL}}/api/llm-bridge"),
        trigger_flow: {
          component_type: "FlowNode",
          id: "trigger_flow",
          name: "Schedule trigger",
          subflow: { $component_ref: "trigger-subflow" },
          metadata: { cinatra: { packageName: "@cinatra-ai/trigger-agent" } },
        },
        "trigger-subflow": buildFlowSubflow("trigger-subflow", {
          "trigger-start": makeStartNode(),
          "trigger-persist": makeApiNode(
            "trigger-persist",
            "{{CINATRA_BASE_URL}}/api/llm-bridge",
          ),
          "trigger-end": makeEndNode(),
        }),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const allBridgeNodes = findAllApiNodes(oas).filter((n) => {
      const url = n.url;
      return typeof url === "string" && url.endsWith("/api/llm-bridge");
    });
    expect(allBridgeNodes).toHaveLength(2);
    for (const node of allBridgeNodes) {
      const data = node.data as Record<string, unknown>;
      expect(data.cinatra_llm).toEqual(SAMPLE_LLM);
    }
  });

  it("DEEP-NESTED: bridge ApiNode 2 Flow levels deep still receives injection", () => {
    // Flow A → Flow B → ApiNode. Confirms the traversal is true depth-first
    // recursion, not single-level "look one container down".
    const oas = buildOas(
      {
        start: makeStartNode(),
        outer_flow_node: {
          component_type: "FlowNode",
          id: "outer_flow_node",
          name: "Outer",
          subflow: { $component_ref: "outer-subflow" },
          metadata: { cinatra: {} },
        },
        "outer-subflow": buildFlowSubflow("outer-subflow", {
          "outer-start": makeStartNode(),
          inner_flow_node: {
            component_type: "FlowNode",
            id: "inner_flow_node",
            name: "Inner",
            subflow: { $component_ref: "inner-subflow" },
            metadata: { cinatra: {} },
          },
          "inner-subflow": buildFlowSubflow("inner-subflow", {
            "inner-start": makeStartNode(),
            "deepest-api": makeApiNode(
              "deepest-api",
              "{{CINATRA_BASE_URL}}/api/llm-bridge",
            ),
            "inner-end": makeEndNode(),
          }),
          "outer-end": makeEndNode(),
        }),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const deepest = findApiNodeByUrl(
      oas,
      (u) => u === "{{CINATRA_BASE_URL}}/api/llm-bridge",
    );
    expect(deepest).not.toBeNull();
    const data = deepest!.data as Record<string, unknown>;
    expect(data.cinatra_llm).toEqual(SAMPLE_LLM);
  });

  it("NESTED-MIXED: subflow has two ApiNodes (bridge + non-bridge); only the bridge one gets injection", () => {
    const oas = buildOas(
      {
        start: makeStartNode(),
        "outer_flow_node": {
          component_type: "FlowNode",
          id: "outer_flow_node",
          name: "Outer",
          subflow: { $component_ref: "outer-subflow" },
          metadata: { cinatra: {} },
        },
        "outer-subflow": buildFlowSubflow("outer-subflow", {
          "outer-start": makeStartNode(),
          "bridge-call": makeApiNode(
            "bridge-call",
            "{{CINATRA_BASE_URL}}/api/llm-bridge",
          ),
          "callback-call": makeApiNode("callback-call", "/api/agent-callback"),
          "outer-end": makeEndNode(),
        }),
        end: makeEndNode(),
      },
      SAMPLE_LLM,
    );

    injectCinatraLlmIntoApiNodes(oas, SAMPLE_LLM);

    const bridge = findApiNodeByUrl(
      oas,
      (u) => u === "{{CINATRA_BASE_URL}}/api/llm-bridge",
    )!;
    const callback = findApiNodeByUrl(oas, (u) => u === "/api/agent-callback")!;

    expect((bridge.data as Record<string, unknown>).cinatra_llm).toEqual(SAMPLE_LLM);
    expect(
      Object.prototype.hasOwnProperty.call(
        callback.data as Record<string, unknown>,
        "cinatra_llm",
      ),
    ).toBe(false);
  });
});
