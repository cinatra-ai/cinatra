/**
 * Hermetic regression gate for the media-feed-lister-agent OAS.
 *
 * Loads `extensions/cinatra-ai/media-feed-lister-agent/cinatra/oas.json` from disk
 * and asserts:
 *   - validateOasAgentJson — clean
 *   - scanOasForLlmMetadata — clean
 *   - scanOasForStartNodeInputsWithoutRequired — clean
 *
 * Plus 7 structural pins:
 *   1. agentspec/component_type
 *   2. packageName matches package.json
 *   3. openai/gpt-5 LLM pair, no capabilityRequired
 *   4. toolboxes OMITTED (legacy inject for cinatra-mcp), hitlScreens=[]
 *   5. single ApiNode -> templated /api/llm-bridge, agent_id-driven SKILL.md
 *      auto-discovery (no skill_source_path)
 *   6. StartNode required=['url'] + hidden=['source','latestCount',
 *      'filterMode','dateFrom','dateTo'] cover-set
 *   7. EndNode shape: sourceTitle/sourceUrl/detectedType/episodes/failureCode
 *
 * Plus SKILL contract assertions: SKILL.md MUST mention
 * media_feed_youtube_list, media_feed_podcast_list, the URL classification
 * rules, and MUST NOT mention legacy `transcript`-era helpers like
 * scrapeYouTubeChannelEpisodes (those are package-internal, not MCP names).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  validateOasAgentJson,
} from "../validate-agent-json";

const agentDir = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/media-feed-lister-agent",
);
const oasPath = path.join(agentDir, "cinatra/oas.json");
const skillPath = path.join(agentDir, "skills/media-feed-lister-agent/SKILL.md");
const packageJsonPath = path.join(agentDir, "package.json");

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const skill = fs.readFileSync(skillPath, "utf8");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;

describe("media-feed-lister-agent OAS validates", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
  });

  it("scanOasForLlmMetadata returns []", () => {
    expect(scanOasForLlmMetadata(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns []", () => {
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });
});

describe("media-feed-lister-agent — 7 structural pins", () => {
  it("Pin 1: agentspec_version + component_type", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("Pin 2: packageName matches package.json", () => {
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.packageName).toBe(pkg.name);
    expect(meta.packageName).toBe("@cinatra-ai/media-feed-lister-agent");
  });

  it("Pin 3: openai/gpt-5.5 LLM pair, no capabilityRequired", () => {
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    const llm = meta.llm as Record<string, unknown>;
    expect(llm.preferredProvider).toBe("openai");
    expect(llm.preferredModel).toBe("gpt-5.5");
    expect(llm.capabilityRequired).toBeUndefined();
  });

  it("Pin 4: hitlScreens=[] and toolboxes OMITTED (legacy inject)", () => {
    const meta = (oas.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.hitlScreens).toEqual([]);
    expect(meta.toolboxes).toBeUndefined();
  });

  it("Pin 5: single ApiNode targeting templated /api/llm-bridge, agent_id present, no skill_source_path", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const list = components.list as Record<string, unknown>;
    expect(list.component_type).toBe("ApiNode");
    expect(list.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    const data = list.data as Record<string, unknown>;
    expect(data.agent_id).toBe("media-feed-lister-agent");
    expect(data.skill_source_path).toBeUndefined();
  });

  it("Pin 6: StartNode required=['url'] + hidden=['source','latestCount','filterMode','dateFrom','dateTo']", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = components.start as Record<string, unknown>;
    const meta = (start.metadata as Record<string, unknown>).cinatra as Record<string, unknown>;
    expect(meta.required).toEqual(["url"]);
    expect(meta.hidden).toEqual([
      "source",
      "latestCount",
      "filterMode",
      "dateFrom",
      "dateTo",
    ]);
  });

  it("Pin 7: EndNode outputs cover sourceTitle/sourceUrl/detectedType/episodes/failureCode", () => {
    const components = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const end = components.end as Record<string, unknown>;
    const outputs = end.outputs as Array<{ title: string }>;
    const titles = outputs.map((o) => o.title).sort();
    expect(titles).toEqual([
      "detectedType",
      "episodes",
      "failureCode",
      "sourceTitle",
      "sourceUrl",
    ]);
  });
});

describe("media-feed-lister-agent — SKILL.md contract", () => {
  it("mentions media_feed_youtube_list + media_feed_podcast_list (the only allowed primitives)", () => {
    expect(skill).toContain("media_feed_youtube_list");
    expect(skill).toContain("media_feed_podcast_list");
  });

  it("documents the URL classification allowlist (YouTube channel paths)", () => {
    expect(skill).toContain("/@");
    expect(skill).toContain("/channel/");
    expect(skill).toContain("/user/");
    expect(skill).toContain("/c/");
  });

  it("documents the YouTube non-channel rejection rules", () => {
    expect(skill).toMatch(/\/watch/);
    expect(skill).toMatch(/\/shorts/);
    expect(skill).toMatch(/youtu\.be/);
  });

  it("instructs returning failureCode='UNSUPPORTED_URL' for non-channel YouTube URLs", () => {
    expect(skill).toContain("UNSUPPORTED_URL");
  });

  // The primitive emits `mediaUrl` directly. The SKILL must not ask the LLM
  // to rename `audioUrl → mediaUrl` post-call, which risks contract drift:
  // any run that emits the verbatim shape breaks @cinatra-ai/media-transcript-agent.
  // Assert mediaUrl is documented with no rename guidance.
  it("documents mediaUrl uniformly (no audioUrl rename instruction)", () => {
    expect(skill).toContain("mediaUrl");
    // The output examples must show mediaUrl, not the legacy audioUrl alias.
    expect(skill).not.toMatch(/"mediaUrl":\s*"<audioUrl>"/);
  });

  it("forbids web_search and other non-allowlisted MCP primitives", () => {
    // The SKILL says the LLM may call exactly the two primitives.
    expect(skill).toMatch(/Do not call.*web_search/i);
  });
});
