/**
 * Hermetic gate for runtime-correctness of `data.cinatra_llm`
 * across all authored cinatra agent OAS files.
 *
 * Why this exists:
 *   WayFlow's loader reads `agents/<vendor>/<slug>/cinatra/oas.json`
 *   directly. The compile-time `injectCinatraLlmIntoApiNodes` only runs during
 *   `agent_source_compile` / `agent_source_publish` — never at WayFlow load
 *   time. Source-as-runtime means runtime-required fields MUST live in source.
 *
 * Rule:
 *   For every authored OAS at `extensions/cinatra-ai/<slug>/cinatra/oas.json` whose
 *   top-level `metadata.cinatra.llm` is set, every `ApiNode` (top-level and
 *   nested-Flow `$referenced_components`) targeting `/api/llm-bridge` MUST
 *   carry `data.cinatra_llm` matching the top-level declaration.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/source-oas-cinatra-llm-injection.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const AGENTS_DIR = path.join(REPO_ROOT, "extensions", "cinatra-ai");

type CinatraLlm = {
  preferredProvider?: string;
  preferredModel?: string;
  capabilityRequired?: string;
};

type AgentRow = {
  slug: string;
  oas: Record<string, unknown>;
  topLevelLlm: CinatraLlm;
};

function listAgents(): AgentRow[] {
  const rows: AgentRow[] = [];
  if (!fs.existsSync(AGENTS_DIR)) return rows;
  for (const slug of fs.readdirSync(AGENTS_DIR)) {
    const oasPath = path.join(AGENTS_DIR, slug, "cinatra", "oas.json");
    if (!fs.existsSync(oasPath)) continue;
    const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
    const md = ((oas.metadata as Record<string, unknown>) ?? {}).cinatra as
      | Record<string, unknown>
      | undefined;
    const llm = md?.llm as CinatraLlm | undefined;
    if (llm && typeof llm === "object") {
      rows.push({ slug, oas, topLevelLlm: llm });
    }
  }
  return rows;
}

function isBridgeApiNode(node: Record<string, unknown>): boolean {
  return (
    node.component_type === "ApiNode" &&
    typeof node.url === "string" &&
    (node.url as string).includes("/api/llm-bridge")
  );
}

function collectBridgeNodes(
  oas: Record<string, unknown>,
): Array<{ id: string; data: Record<string, unknown> }> {
  const out: Array<{ id: string; data: Record<string, unknown> }> = [];
  function visit(container: Record<string, unknown> | undefined, depth: number) {
    if (!container || depth > 8) return;
    for (const [id, entry] of Object.entries(container)) {
      if (!entry || typeof entry !== "object") continue;
      const node = entry as Record<string, unknown>;
      if (isBridgeApiNode(node)) {
        const data = (node.data ?? {}) as Record<string, unknown>;
        out.push({ id, data });
        continue;
      }
      if (node.component_type === "Flow") {
        const nested = node.$referenced_components as Record<string, unknown> | undefined;
        if (nested) visit(nested, depth + 1);
      }
    }
  }
  visit(oas.$referenced_components as Record<string, unknown> | undefined, 0);
  return out;
}

describe("source OAS: cinatra_llm runtime correctness across all bridge-using agents", () => {
  const agents = listAgents();

  it("at least one agent declares metadata.cinatra.llm (sanity)", () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  it.each(agents)(
    "$slug: every /api/llm-bridge ApiNode carries data.cinatra_llm matching the top-level",
    ({ slug, oas, topLevelLlm }) => {
      const bridges = collectBridgeNodes(oas);
      expect(
        bridges.length,
        `${slug}: declares metadata.cinatra.llm but has no /api/llm-bridge ApiNode (orphan declaration)`,
      ).toBeGreaterThan(0);

      for (const { id, data } of bridges) {
        const nodeLlm = data.cinatra_llm as CinatraLlm | undefined;
        expect(
          nodeLlm,
          `${slug}: ApiNode "${id}" missing data.cinatra_llm — WayFlow loads source, so cinatra_llm must live in source to reach the bridge. See packages/agents/src/oas-compiler.ts injectCinatraLlmIntoApiNodes for the expected shape.`,
        ).toBeDefined();
        // Each present field must match the top-level (per-node overrides are
        // allowed in principle but currently no agent uses them; if a future
        // agent does override, this assertion is the place to document the
        // exception).
        if (topLevelLlm.preferredProvider !== undefined) {
          expect(
            nodeLlm!.preferredProvider,
            `${slug} "${id}" preferredProvider must match top-level`,
          ).toBe(topLevelLlm.preferredProvider);
        }
        if (topLevelLlm.preferredModel !== undefined) {
          expect(
            nodeLlm!.preferredModel,
            `${slug} "${id}" preferredModel must match top-level`,
          ).toBe(topLevelLlm.preferredModel);
        }
        if (topLevelLlm.capabilityRequired !== undefined) {
          expect(
            nodeLlm!.capabilityRequired,
            `${slug} "${id}" capabilityRequired must match top-level`,
          ).toBe(topLevelLlm.capabilityRequired);
        }
      }
    },
  );
});
