/**
 * blog-text parity gate.
 *
 * For each text product (idea / draft / linkedin-copy), this test asserts
 * parity across five dimensions before the corresponding asset-blog
 * text-generation job can be retired. The agents are OAS-driven leaves executed
 * by the WayFlow runtime (no unit-mockable TS surface), so this is the
 * structural contract parity gate; the full live orchestrator run remains
 * environment-gated.
 *
 * Five dimensions asserted here:
 *  (a) generation rules + their id — the agent ships NO skill bundle and
 *      carries the relocated blog-skills rules INLINE, in its own llm-bridge
 *      node's `data.system`, keyed by `data.agent_id`.
 *  (b) input contract — the agent OAS inputs cover the asset-blog job's
 *      generation inputs.
 *  (c) output schema/shape — the agent OAS outputs + the EndNode's declarative
 *      artifact binding match the product shape EXACTLY.
 *  (d) declared tool wiring — the leaf OAS wires no toolbox, no tool-bearing
 *      component and no endpoint outside the LLM/context allowlist (plus the
 *      ONE brand-voice read of cinatra#4314, below), and its inline
 *      configuration instructs the model not to call tools.
 *  (e) emitted HITL events — leaf gen agents declare hitlScreens=[] (no HITL);
 *      HITL is the orchestrator's reviewer-gate concern.
 *
 * WHY (a) INVERTED (cinatra#2455). This gate used to assert the agent ships its
 * own auto-discovered `skills/<agent-id>/SKILL.md`. All three companions then
 * DELETED that file under cinatra#2086 S2/S3 (companion commits "refactor(skills):
 * #2090 S3 — fold the embedded skill into the agent's own configuration"), whose
 * stated rule is that an agent extension must not ship a skill bundle: a skill is
 * a shareable, uploadable unit, and this one was pure self-instruction. The body
 * moved verbatim into the llm-bridge ApiNode's `data.system` — the same place the
 * bridge previously mounted it from — and `skills` dropped out of
 * `package.json#files`. The old assertion therefore demanded something now
 * FORBIDDEN; the invariant is inverted, not relaxed.
 *
 * WHY (c) MOVED OFF `draft` (cinatra#2455). blog-draft-writer-agent's ratified
 * "feat(artifacts): declarative EndNode binding for the final draft
 * (cinatra#922/#923)" flattened the nested `draft: {title, excerpt, content,
 * sourcesUsed?}` envelope into flat top-level outputs, because a DataFlowEdge's
 * `source_output` must name a plain top-level output. The expected sets below are
 * the post-#922 product shapes and are asserted EXACTLY (not `arrayContaining`),
 * together with the declarative `cinatra.artifact` binding that replaced the
 * inert `cinatra.produces` marker.
 *
 * WHAT (d) DOES AND DOES NOT CLAIM. (d) verifies the companion OAS does not
 * explicitly wire toolboxes or tool-bearing components. This is a STRUCTURAL OAS
 * assertion, not proof of runtime tool isolation: `/api/llm-bridge` defaults an
 * omitted `toolbox_ids` to `["cinatra-mcp"]` (src/app/api/llm-bridge/route.ts),
 * so an OAS that declares nothing still receives the self-MCP suite at runtime.
 * Runtime capability removal would require `data.toolbox_ids: []` on every bridge
 * ApiNode, which is not currently a ratified companion or host invariant — the
 * host's own OAS-RUNTIME-007 blocker deliberately treats an agent that declares
 * no toolboxes as unaffected passthrough, and 24 of the 26 bridge-calling agents
 * in the fleet declare none. So (d) does not name itself "stateless",
 * "tool-free" or "cannot call tools", and it replaces the previous
 * `JSON.stringify(oas)` substring scan for `objects_save`, which after the (a)
 * fold false-positived on the folded PROHIBITION prose ("You MUST NOT call any
 * MCP primitive, `web_search`, `objects_save`, or any other tool") — a scan that
 * reads a ban as a violation is not an invariant.
 *
 * This test is the structural gate for retiring legacy asset-blog
 * text-generation jobs; asset-blog archive work must remain sequenced after
 * these parity assertions.
 *
 *   pnpm --filter @cinatra-ai/extensions exec vitest run \
 *     src/__tests__/blog-text-parity.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const EXT = join(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai");

/**
 * Component types this OAS dialect may use. An ALLOWLIST, not a denylist: a
 * tool-bearing node type (AgentNode / ToolNode / ToolRequestNode / whatever a
 * future agentspec adds) must RED this gate the day it appears in a leaf, and a
 * denylist can only promise that for the spellings someone thought of.
 */
const ALLOWED_COMPONENT_TYPES = new Set([
  "ApiNode",
  "BranchingNode",
  "ControlFlowEdge",
  "DataFlowEdge",
  "EndNode",
  "Flow",
  "FlowNode",
  "InputMessageNode",
  "OutputMessageNode",
  "StartNode",
]);

/**
 * Endpoints a text leaf may call. `/api/llm-bridge` is the LLM call itself;
 * `/api/context-resolve` + `/api/context-finalize` belong to the vendored
 * context-selection subflow. Nothing else — in particular nothing that writes
 * the project store.
 *
 * Matched by EXACT equality, never by substring: a substring test would accept
 * `{{CINATRA_BASE_URL}}/api/objects/save?next=/api/llm-bridge` (a store write
 * wearing an allowlisted suffix) and an off-host `https://elsewhere/api/llm-bridge`.
 */
const BASE_URL = "{{CINATRA_BASE_URL}}";
const LLM_BRIDGE_URL = `${BASE_URL}/api/llm-bridge`;
const ALLOWED_API_URLS = new Set([
  LLM_BRIDGE_URL,
  `${BASE_URL}/api/context-resolve`,
  `${BASE_URL}/api/context-finalize`,
]);

/**
 * The ONE further call shape a text leaf may carry (cinatra#4314): a read of the
 * text of the brand voice picked for the run, through the read-only
 * `brand_voice_text` extension tool. That is the typed content read cinatra#4402
 * put on the host (src/lib/extension-scoped-tools.ts); a slot binding is only a
 * reference, and the bridge does not resolve it. It writes nothing to the
 * project store, and it attaches no toolbox to the model's turn.
 *
 * Matched EXACTLY — URL, method and the whole request body — and at most once
 * per leaf: any other passthrough body, tool, tool name, binding source or URL,
 * a toolbox on the node, or a second such read still fails (d).
 */
const BRAND_VOICE_READ = {
  url: `${BASE_URL}/api/agents/passthrough`,
  http_method: "POST",
  data: {
    tool: "extension_tool",
    input: {
      name: "brand_voice_text",
      input: { bindings: "{{ brandVoiceContextSlotBindings }}" },
    },
    agent_run_id: "{{ cinatra_run_id }}",
  },
};

function isBrandVoiceRead(c: Record<string, any>): boolean {
  return (
    c.component_type === "ApiNode" &&
    c.url === BRAND_VOICE_READ.url &&
    c.http_method === BRAND_VOICE_READ.http_method &&
    isDeepStrictEqual(c.data, BRAND_VOICE_READ.data)
  );
}

/** Every endpoint problem of (d) over a leaf's components; empty means clean. */
function endpointProblems(components: Array<Record<string, any>>): string[] {
  const problems: string[] = [];
  let reads = 0;
  for (const c of components) {
    if (c.component_type !== "ApiNode") continue;
    const where = `${c.component_type} ${c.id ?? c.name ?? "<anon>"}`;
    if (isBrandVoiceRead(c)) {
      reads += 1;
      continue;
    }
    // `typeof === "string"` before the Set lookup, never String(c.url): the
    // coercion would let a malformed `"url": ["…/api/context-resolve"]`
    // stringify into an allowlisted value.
    if (!(typeof c.url === "string" && ALLOWED_API_URLS.has(c.url))) {
      problems.push(`${where} calls a non-allowlisted endpoint: ${JSON.stringify(c.url)}`);
    }
    // A toolbox_ids declaration is permitted, but only the empty one.
    if (c.data && typeof c.data === "object" && "toolbox_ids" in c.data) {
      if (!(Array.isArray(c.data.toolbox_ids) && c.data.toolbox_ids.length === 0)) {
        problems.push(`${where} declares a non-empty toolbox`);
      }
    }
  }
  if (reads > 1) problems.push(`${reads} brand-voice reads: a text leaf may carry at most one`);
  return problems;
}

/**
 * Keys that declare a tool surface on a component or on its request payload.
 * `toolbox_ids` is deliberately NOT here: it may legitimately appear as an
 * EMPTY list (the sanctioned "no tools" declaration), so it is checked by value
 * rather than by presence.
 */
const TOOL_DECLARING_KEYS = [
  "tools",
  "toolboxes",
  "toolbox",
  "mcp_servers",
  "mcpServers",
  "tool_choice",
  "toolChoice",
];

type Ref = Record<string, any>;

/** Every plain object in the document that declares a `component_type`,
 *  including the ones nested inside an inlined subflow. */
function collectComponents(root: unknown): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<unknown>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return;
    }
    if (x === null || typeof x !== "object") return;
    if (seen.has(x)) return;
    seen.add(x);
    const o = x as Ref;
    if (typeof o.component_type === "string") out.push(o);
    for (const v of Object.values(o)) walk(v);
  };
  walk(root);
  return out;
}

type ArtifactBinding = {
  extension: string;
  /** The exact declared type the bound output materializes into (cinatra#1454). */
  objectTypeId?: string;
  contentFrom: string;
  /** Absent on a fan-out binding: each member titles itself (cinatra#3034). */
  titleFrom?: string;
  declaredMime: string;
  /** One artifact per member of the bound list (cinatra#3034, plan item 0.27). */
  fanOut?: { mode: string; titleFrom: string; titlePrefix: string };
};

/** A flow / EndNode input or output slot. */
type IoSlot = { title: string; cinatra?: { artifact?: ArtifactBinding } };
const slots = (io: unknown): IoSlot[] => (io ?? []) as IoSlot[];
const titles = (io: unknown): string[] => slots(io).map((s) => s.title);

type Product = {
  agent: string;
  requiredInputs: string[];
  /** EXACT, ordered root output titles (and the EndNode's, which mirror them). */
  outputs: string[];
  /** The declarative EndNode artifact binding (cinatra#922/#923), or null when
   *  the product materializes no artifact. */
  artifact: ArtifactBinding | null;
  /** Relocated blog-skills source skill, named in the inline configuration. */
  legacySkill: string;
};

const PRODUCTS: Product[] = [
  {
    agent: "blog-idea-generator-agent",
    requiredInputs: ["brief"],
    // cinatra#3034 re-ratification: the one markdown batch document and its
    // batch title are retired. The ideas are plain text, filed one artifact per
    // idea through the fan-out binding, each titled from its own first line.
    outputs: ["ideas", "notes"],
    artifact: {
      extension: "@cinatra-ai/blog-idea-artifact",
      objectTypeId: "@cinatra-ai/blog-idea-artifact:blog-idea",
      contentFrom: "ideas",
      declaredMime: "text/plain",
      fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "Title:" },
    },
    legacySkill: "generate-blog-ideas",
  },
  {
    agent: "blog-draft-writer-agent",
    requiredInputs: ["idea"],
    outputs: ["title", "excerpt", "content", "sourcesUsed", "notes"],
    artifact: {
      extension: "@cinatra-ai/blog-post-artifact",
      objectTypeId: "@cinatra-ai/blog-post-artifact:post",
      contentFrom: "content",
      declaredMime: "text/markdown",
      titleFrom: "title",
    },
    legacySkill: "generate-blog-post-draft",
  },
  {
    agent: "blog-linkedin-writer-agent",
    requiredInputs: ["postTitle", "blogPostUrl"],
    // cinatra#3034 re-ratification: the LinkedIn post lands as a LinkedIn post
    // draft, and the writer emits the title that draft is filed under.
    outputs: ["post", "title", "notes"],
    artifact: {
      extension: "@cinatra-ai/linkedin-artifacts",
      objectTypeId: "@cinatra-ai/linkedin:post-draft",
      contentFrom: "post",
      declaredMime: "text/plain",
      titleFrom: "title",
    },
    legacySkill: "generate-linkedin-post",
  },
];

for (const p of PRODUCTS) {
  describe(`blog-text parity — ${p.agent}`, () => {
    const pkgRoot = join(EXT, p.agent);
    const oas = JSON.parse(
      readFileSync(join(pkgRoot, "cinatra", "oas.json"), "utf8"),
    ) as Ref;
    const pkg = JSON.parse(
      readFileSync(join(pkgRoot, "package.json"), "utf8"),
    ) as Ref;
    const components = collectComponents(oas);
    /** The agent's OWN llm-bridge call — the node the generation rules live on. */
    const bridge = components.find(
      (c) =>
        c.component_type === "ApiNode" &&
        c.url === LLM_BRIDGE_URL &&
        c?.data?.agent_id === p.agent,
    );

    it("(a) ships NO skill bundle — the rules live in its own configuration", () => {
      // cinatra#2086 S2/S3: an agent extension must not ship a skill bundle.
      expect(existsSync(join(pkgRoot, "skills"))).toBe(false);
      expect(
        (pkg.files as string[] | undefined) ?? [],
        "package.json#files must not re-admit a skills bundle",
      ).not.toContain("skills");

      // The rules moved onto the agent's own llm-bridge node, resolved by
      // agent_id (the OAS still names no skill ids — owner law).
      expect(bridge, `${p.agent} must call /api/llm-bridge under its own agent_id`)
        .toBeTruthy();
      const system = bridge!.data.system;
      expect(typeof system).toBe("string");
      expect(
        (system as string).length,
        "the folded configuration must carry the generation rules, not a stub",
      ).toBeGreaterThan(1000);
      // carries the relocated blog-skills rule provenance BY NAME
      expect(system as string).toContain(p.legacySkill);
      expect(JSON.stringify(oas)).not.toMatch(/"skillIds"|"skill_ids"/);
    });

    it("(b) input contract covers the generation inputs", () => {
      const inputTitles = titles(oas.inputs);
      for (const r of p.requiredInputs) expect(inputTitles).toContain(r);
      const start = oas["$referenced_components"].start;
      expect(start.metadata.cinatra.required).toEqual(
        expect.arrayContaining(p.requiredInputs),
      );
    });

    it("(c) output schema/shape matches the product", () => {
      const end = oas["$referenced_components"].end as Ref;
      const rootTitles = titles(oas.outputs);
      const endTitles = titles(end.outputs);
      // EXACT, not arrayContaining: an added/renamed/removed product output is
      // a parity change and must be re-ratified here.
      expect(rootTitles).toEqual(p.outputs);
      expect(endTitles).toEqual(p.outputs);
      // The pre-cinatra#922/#923 nested envelope is gone for good.
      expect(rootTitles).not.toContain("draft");

      // Declarative EndNode artifact binding (cinatra#922/#923) replaced the
      // inert `metadata.cinatra.produces` marker: assert the binding itself,
      // and that its contentFrom/titleFrom name real outputs.
      const bound = slots(end.outputs).filter((o) => o.cinatra?.artifact);
      if (p.artifact === null) {
        expect(bound).toEqual([]);
        expect(oas.metadata.cinatra.produces).toBeUndefined();
      } else {
        expect(bound).toHaveLength(1);
        expect(bound[0].cinatra?.artifact).toEqual(p.artifact);
        expect(endTitles).toContain(p.artifact.contentFrom);
        // A fan-out binding names no run-level title output: each member's own
        // first line supplies its artifact's title (cinatra#3034).
        if (p.artifact.fanOut === undefined) {
          expect(endTitles).toContain(p.artifact.titleFrom as string);
        } else {
          expect(p.artifact.titleFrom).toBeUndefined();
        }
        const produces = (oas.metadata.cinatra.produces ?? []) as { extension: string }[];
        expect(produces.map((x) => x.extension)).toEqual([p.artifact.extension]);
      }
    });

    it("(d) declares no tool wiring in the leaf OAS", () => {
      // Scope note: OAS wiring only — see "WHAT (d) DOES AND DOES NOT CLAIM"
      // in the file docblock. This is not a runtime tool-isolation proof.
      expect(oas.metadata.cinatra.toolboxes).toBeUndefined();

      const unexpectedTypes = [
        ...new Set(components.map((c) => c.component_type as string)),
      ]
        .filter((t) => !ALLOWED_COMPONENT_TYPES.has(t))
        .sort();
      expect(
        unexpectedTypes,
        "unallowlisted component type — a tool-bearing node in a text leaf?",
      ).toEqual([]);

      for (const c of components) {
        const where = `${c.component_type} ${c.id ?? c.name ?? "<anon>"}`;
        for (const key of TOOL_DECLARING_KEYS) {
          expect(c[key], `${where} declares ${key}`).toBeUndefined();
          if (c.data && typeof c.data === "object") {
            expect(c.data[key], `${where}.data declares ${key}`).toBeUndefined();
          }
        }
      }
      expect(endpointProblems(components)).toEqual([]);

      // Tool-discipline statement, now read from the INLINE configuration the
      // (a) fold moved it into (phrasing varies per agent, but every leaf
      // forbids MCP/tool calls).
      expect(bridge!.data.system as string).toMatch(
        /NO MCP primitives|MUST NOT call any (MCP|tool)|Never call any tool|Do NOT call any (MCP )?tool|Do not call any tool|no MCP primitives/i,
      );
    });

    it("(e) leaf declares no HITL (HITL is the orchestrator reviewer-gate concern)", () => {
      // Filter out HITL entries owned by the context-selection sub-agent;
      // those screens are not part of the leaf agent contract.
      expect(
        oas.metadata.cinatra.hitlScreens.filter(
          (h: string) =>
            !h.includes("context-agent") && !h.includes("context-selection-agent"),
        ),
      ).toEqual([]);
    });
  });
}

/* ------------------------------------------------------------------------- *
 * The one added call shape of (d) still refuses everything else
 * (cinatra#4314). Synthetic components, so the refusals do not move with the
 * pins.
 * ------------------------------------------------------------------------- */
describe("blog-text parity (d): the brand-voice read is the only added call shape", () => {
  const read = (over: Record<string, any> = {}, data: Record<string, any> = {}) => ({
    component_type: "ApiNode",
    id: "read_brand_voice",
    url: BRAND_VOICE_READ.url,
    http_method: "POST",
    ...over,
    data: { ...structuredClone(BRAND_VOICE_READ.data), ...data },
  });
  const bridgeNode = { component_type: "ApiNode", id: "write", url: LLM_BRIDGE_URL, data: {} };
  const passthrough = `${BASE_URL}/api/agents/passthrough`;
  const refused = (where: string, url: string) =>
    `ApiNode ${where} calls a non-allowlisted endpoint: ${JSON.stringify(url)}`;

  it("accepts exactly one brand-voice read beside the bridge", () => {
    expect(endpointProblems([bridgeNode, read()])).toEqual([]);
  });

  it("refuses a second brand-voice read", () => {
    expect(endpointProblems([bridgeNode, read(), read({ id: "read_again" })])).toEqual([
      "2 brand-voice reads: a text leaf may carry at most one",
    ]);
  });

  it("refuses any other passthrough body, tool, tool name or binding source", () => {
    const others = [
      read({}, { tool: "objects_save" }),
      read({}, { input: { name: "objects_save", input: { bindings: "{{ brandVoiceContextSlotBindings }}" } } }),
      read({}, { input: { name: "brand_voice_text", input: { bindings: "{{ draftContextContextSlotBindings }}" } } }),
      read({}, { input: { name: "brand_voice_text", input: { bindings: "{{ brandVoiceContextSlotBindings }}", extra: 1 } } }),
      read({}, { agent_run_id: "" }),
      read({}, { extra: true }),
      read({}, { toolbox_ids: [] }),
      read({}, { toolbox_ids: ["cinatra-mcp"] }),
      read({ http_method: "GET" }),
    ];
    for (const c of others) {
      expect(endpointProblems([bridgeNode, c])).toContain(refused("read_brand_voice", passthrough));
    }
    const noTool = read();
    delete (noTool.data as Record<string, any>).tool;
    expect(endpointProblems([noTool])).toContain(refused("read_brand_voice", passthrough));
  });

  it("refuses the same body at any other URL", () => {
    for (const url of [
      `${passthrough}?next=/api/objects/save`,
      `${BASE_URL}/api/objects/save`,
      "https://elsewhere/api/agents/passthrough",
      `${BASE_URL}/api/agents/passthrough/`,
    ]) {
      expect(endpointProblems([read({ url })])).toEqual([refused("read_brand_voice", url)]);
    }
  });

  it("keeps refusing a non-empty toolbox on any other node", () => {
    expect(
      endpointProblems([{ ...bridgeNode, data: { toolbox_ids: ["cinatra-mcp"] } }]),
    ).toEqual(["ApiNode write declares a non-empty toolbox"]);
  });
});
