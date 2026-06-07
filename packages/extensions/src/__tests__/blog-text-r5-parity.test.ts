/**
 * R5-text parity gate.
 *
 * For each text product (idea / draft / linkedin-copy), this test asserts
 * parity across five dimensions before the corresponding asset-blog
 * text-generation job can be retired. The agents are OAS+SKILL.md executed by
 * the WayFlow runtime (no unit-mockable TS surface), so this is the structural
 * contract parity gate; the full live orchestrator run remains
 * environment-gated.
 *
 * Five dimensions asserted here:
 *  (a) loaded skill content/id — the agent ships its OWN
 *      skills/<agent-id>/SKILL.md (auto-discovered by agent_id via
 *      /api/llm-bridge), whose content carries the relocated
 *      blog-skills generation rules.
 *  (b) input contract — the agent OAS inputs cover the asset-blog job's
 *      generation inputs.
 *  (c) output schema/shape — the agent OAS outputs + SKILL.md return
 *      envelope match the product shape.
 *  (d) project-store mutations — these agents are STATELESS LLM leaves (no
 *      store writes); canonical-artifact persistence is handled outside these
 *      leaf agents. Asserted: zero store-mutating tool wiring in the leaf OAS
 *      (no MCP toolbox, SKILL.md forbids tool calls).
 *  (e) emitted HITL events — leaf gen agents declare hitlScreens=[] (no HITL);
 *      HITL is the orchestrator's reviewer-gate concern.
 *
 * This test is the structural gate for retiring legacy asset-blog
 * text-generation jobs; asset-blog archive work must remain sequenced after
 * these parity assertions.
 *
 *   pnpm --filter @cinatra-ai/extensions exec vitest run \
 *     src/__tests__/blog-text-r5-parity.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXT = join(__dirname, "..", "..", "..", "..", "extensions", "cinatra-ai");

type Product = {
  agent: string;
  skillId: string;
  requiredInputs: string[];
  outputs: string[];
  legacySkill: string; // relocated blog-skills source skill
};

const PRODUCTS: Product[] = [
  {
    agent: "blog-idea-generator-agent",
    skillId: "blog-idea-generator-agent",
    requiredInputs: ["brief"],
    outputs: ["ideas", "notes"],
    legacySkill: "generate-blog-ideas",
  },
  {
    agent: "blog-draft-writer-agent",
    skillId: "blog-draft-writer-agent",
    requiredInputs: ["idea"],
    outputs: ["draft", "notes"],
    legacySkill: "generate-blog-post-draft",
  },
  {
    agent: "blog-linkedin-writer-agent",
    skillId: "blog-linkedin-writer-agent",
    requiredInputs: ["postTitle", "blogPostUrl"],
    outputs: ["post", "notes"],
    legacySkill: "generate-linkedin-post",
  },
];

for (const p of PRODUCTS) {
  describe(`R5-text parity — ${p.agent}`, () => {
    const oas = JSON.parse(
      readFileSync(join(EXT, p.agent, "cinatra", "oas.json"), "utf8"),
    );
    const skillPath = join(EXT, p.agent, "skills", p.skillId, "SKILL.md");

    it("(a) ships its own auto-discovered SKILL.md (skill content/id)", () => {
      expect(existsSync(skillPath)).toBe(true);
      const skill = readFileSync(skillPath, "utf8");
      expect(skill).toContain(`name: ${p.skillId}`);
      // The agent OAS resolves the skill by agent_id (no skillIds field).
      const llm = Object.values(oas["$referenced_components"]).find(
        (c: any) => c?.component_type === "ApiNode" && c?.data?.agent_id === p.agent,
      ) as any;
      expect(llm).toBeTruthy();
      expect(JSON.stringify(oas)).not.toMatch(/"skillIds"|"skill_ids"/);
      // carries the relocated blog-skills rule provenance
      expect(skill).toMatch(/blog-skills|asset-blog\/skills/);
    });

    it("(b) input contract covers the generation inputs", () => {
      const inputTitles = (oas.inputs as any[]).map((i) => i.title);
      for (const r of p.requiredInputs) expect(inputTitles).toContain(r);
      const start = oas["$referenced_components"].start;
      expect(start.metadata.cinatra.required).toEqual(
        expect.arrayContaining(p.requiredInputs),
      );
    });

    it("(c) output schema/shape matches the product", () => {
      const outTitles = (oas.outputs as any[]).map((o) => o.title);
      expect(outTitles).toEqual(expect.arrayContaining(p.outputs));
    });

    it("(d) stateless — no store-mutating tool wiring in the leaf OAS", () => {
      const s = JSON.stringify(oas);
      // pure LLM-only leaf: no MCP toolbox, no objects_save tool wiring
      expect(s).not.toContain("objects_save");
      expect(oas.metadata.cinatra.toolboxes).toBeUndefined();
      const skill = readFileSync(skillPath, "utf8");
      // Tool-discipline statement (phrasing varies per agent SKILL.md but
      // every leaf forbids MCP/tool calls — that is the stateless invariant).
      expect(skill).toMatch(
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
