/**
 * Hermetic regression gate for the media-transcript-agent OAS.
 *
 * Loads `extensions/cinatra-ai/media-transcript-agent/cinatra/oas.json` from disk and
 * asserts that the authored OAS validates clean against both:
 *   - validateOasAgentJson (agent JSON validator)
 *   - scanOasForStartNodeInputsWithoutRequired (StartNode input coverage invariant)
 *
 * Additionally enforces the locked Gemini/media_input triple, the templated
 * /api/llm-bridge URL, the StartNode required+hidden coverage, and
 * the strict start-conversation contract that EVERY input listed in
 * `metadata.cinatra.hidden` carries `default: ""`. Flow inputs without
 * defaults must be present at conversation start, so hidden optional inputs
 * need `default: ""` to remain dispatchable with only the `required` keys
 * (e.g. mediaUrl-only direct runs).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/media-transcript-agent-validates.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  scanOasForStartNodeInputsWithoutRequired,
  validateOasAgentJson,
} from "../validate-agent-json";

const oasPath = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/media-transcript-agent/cinatra/oas.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;

describe("media-transcript-agent OAS validates against agent JSON and StartNode coverage checks", () => {
  it("validateOasAgentJson returns [] (no L1 findings)", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
  });

  it("scanOasForStartNodeInputsWithoutRequired returns [] when required+hidden cover omitted inputs", () => {
    expect(scanOasForStartNodeInputsWithoutRequired(oas)).toEqual([]);
  });

  it("declares agentspec_version 26.1.0 + component_type Flow", () => {
    expect(oas.agentspec_version).toBe("26.1.0");
    expect(oas.component_type).toBe("Flow");
  });

  it("declares the locked Gemini/media_input triple with no extra keys in metadata.cinatra.llm", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    const llm = cinatra.llm as Record<string, unknown>;
    expect(llm).toEqual({
      preferredProvider: "gemini",
      preferredModel: "gemini-2.5-flash",
      capabilityRequired: "media_input",
    });
  });

  it("declares metadata.cinatra.packageName matching the package.json name", () => {
    const metadata = oas.metadata as Record<string, unknown>;
    const cinatra = metadata.cinatra as Record<string, unknown>;
    expect(cinatra.packageName).toBe("@cinatra-ai/media-transcript-agent");
  });

  it("has exactly one ApiNode targeting templated /api/llm-bridge with media.url + media.kind template fields", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const apiNodes = Object.values(refs).filter((c) => c.component_type === "ApiNode");
    expect(apiNodes).toHaveLength(1);
    const apiNode = apiNodes[0]!;
    expect(apiNode.url).toBe("{{CINATRA_BASE_URL}}/api/llm-bridge");
    expect(apiNode.http_method).toBe("POST");
    const data = apiNode.data as Record<string, unknown>;
    const media = data.media as Record<string, unknown>;
    expect(media).toBeDefined();
    expect(typeof media.url).toBe("string");
    expect(typeof media.kind).toBe("string");
  });

  it("declares mediaUrl in StartNode inputs AND in metadata.cinatra.required", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    expect(start).toBeDefined();
    const inputs = start!.inputs as Array<Record<string, unknown>>;
    const titles = inputs.map((i) => i.title);
    expect(titles).toContain("mediaUrl");
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(meta?.required).toEqual(["mediaUrl"]);
  });

  it("declares metadata.cinatra.hidden = [title, description, kind] on StartNode", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    expect(Array.isArray(meta?.hidden)).toBe(true);
    const hidden = meta!.hidden as string[];
    expect(hidden).toContain("title");
    expect(hidden).toContain("description");
    expect(hidden).toContain("kind");
  });

  it("every input listed in metadata.cinatra.hidden carries `default: \"\"` for strict start_conversation validation", () => {
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    const hidden = (meta?.hidden ?? []) as string[];
    expect(hidden.length).toBeGreaterThan(0);
    const inputs = start!.inputs as Array<Record<string, unknown>>;
    const inputsByName = new Map(inputs.map((i) => [i.title as string, i]));
    for (const name of hidden) {
      const input = inputsByName.get(name);
      expect(input, `hidden input "${name}" must be declared in StartNode inputs[]`).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(input, "default"),
        `hidden input "${name}" must declare a default for strict start_conversation(inputs=...) validation`,
      ).toBe(true);
      expect(
        input!.default,
        `hidden input "${name}" default must be empty string`,
      ).toBe("");
    }
  });

  it("media-transcript-agent specifically: mediaUrl-only direct dispatch never trips start_conversation validation", () => {
    // Scoped to this agent's current contract — every input that the
    // dispatcher might omit when only `mediaUrl` is supplied must have a
    // default. For media-transcript that's exactly the three `hidden`
    // inputs. NOT a general rule for future agents with visible optionals
    // (those would still need defaults to dispatch with required-only,
    // but the rule SHAPE is "anything the dispatcher might omit needs a
    // default" — not "every non-required input has a default" as a
    // global invariant). Keep the scope narrow.
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const start = refs.start;
    const meta = (start!.metadata as Record<string, unknown> | undefined)?.cinatra as
      | Record<string, unknown>
      | undefined;
    const required = new Set((meta?.required ?? []) as string[]);
    const hidden = new Set((meta?.hidden ?? []) as string[]);
    const inputs = oas.inputs as Array<Record<string, unknown>>;
    // For this agent the union of required+hidden equals the input set.
    const inputNames = new Set(inputs.map((i) => i.title as string));
    const covered = new Set<string>([...required, ...hidden]);
    expect(covered, "media-transcript-agent: every Flow input must be covered by required or hidden").toEqual(inputNames);
    // The 3 hidden inputs must carry defaults (asserted by the test above)
    // — combined with `mediaUrl` being required, a caller passing only
    // mediaUrl satisfies start_conversation strict validation.
    for (const input of inputs) {
      const name = input.title as string;
      if (required.has(name)) continue;
      expect(
        Object.prototype.hasOwnProperty.call(input, "default"),
        `media-transcript Flow input "${name}" (hidden) must declare a default`,
      ).toBe(true);
    }
  });
});
