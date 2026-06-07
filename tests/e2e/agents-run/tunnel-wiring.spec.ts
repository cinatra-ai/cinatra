/**
 * Code-level cinatra_llm wiring spec.
 *
 * Locks the runtime invariant: every ApiNode with `url` pointing at
 * `/api/llm-bridge` MUST have a sibling `data.cinatra_llm` declaration
 * in its source OAS. Without this,
 * WayFlow loads the agent but fails at runtime because the LLM-bridge
 * server-side dispatch requires the field to route to the correct
 * provider.
 *
 * Static — does not run agents. Runs every CI invocation regardless of
 * tunnel state. Complementary to the live UAT specs.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "extensions", "cinatra-ai");

type OasComponent = {
  component_type?: string;
  id?: string;
  url?: string;
  data?: { cinatra_llm?: unknown; [k: string]: unknown };
};

type Oas = {
  $referenced_components?: Record<string, OasComponent>;
};

function listAgentSlugs(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR).filter((entry) => {
    const oasPath = join(AGENTS_DIR, entry, "cinatra", "oas.json");
    return existsSync(oasPath);
  });
}

function loadOas(slug: string): Oas | null {
  const oasPath = join(AGENTS_DIR, slug, "cinatra", "oas.json");
  if (!existsSync(oasPath)) return null;
  try {
    return JSON.parse(readFileSync(oasPath, "utf-8")) as Oas;
  } catch {
    return null;
  }
}

test.describe("tunnel-wiring", () => {
  for (const slug of listAgentSlugs()) {
    test(`${slug}: every /api/llm-bridge ApiNode declares data.cinatra_llm`, () => {
      const oas = loadOas(slug);
      expect(oas, `OAS missing or unparseable for ${slug}`).toBeTruthy();
      const refs = oas?.$referenced_components ?? {};

      const bridgeNodes: string[] = [];
      const offenders: Array<{ id: string; reason: string }> = [];

      for (const [id, node] of Object.entries(refs)) {
        if (node.component_type !== "ApiNode") continue;
        const url = node.url ?? "";
        if (!url.includes("/api/llm-bridge")) continue;
        bridgeNodes.push(id);
        const llm = node.data?.cinatra_llm;
        if (!llm || typeof llm !== "object" || Object.keys(llm as object).length === 0) {
          offenders.push({
            id,
            reason: `data.cinatra_llm is ${llm === undefined ? "missing" : "empty"}`,
          });
        }
      }

      // Agents with zero llm-bridge nodes are trivially compliant and
      // surface as PASS — that's the expected case for HITL-only agents
      // like skill-recommender-agent or trigger-agent's setup-only flow.
      expect(
        offenders,
        offenders.length > 0
          ? `${slug}: ${offenders.length} of ${bridgeNodes.length} llm-bridge ApiNode(s) ` +
              `lack the runtime-required data.cinatra_llm declaration. ` +
              `Offenders: ${offenders.map((o) => `${o.id} (${o.reason})`).join(", ")}. ` +
              `data.cinatra_llm must be declared in the source OAS, not just ` +
              `injected at compile time, because WayFlow loads source.`
          : "",
      ).toEqual([]);
    });
  }
});
