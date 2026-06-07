/**
 * Hermetic validator coverage.
 *
 * Two test groups:
 *   1. POSITIVE: every authored `extensions/cinatra-ai/<slug>/cinatra/oas.json` in
 *      the repo must produce ZERO blocker findings. New agents are
 *      automatically covered.
 *   2. NEGATIVE: forge five deliberately-broken OAS shapes (one per
 *      invariant) and assert the scanner emits the expected code with a
 *      message that names the offending element.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { describe, it, expect } from "vitest";

import { scanOasForRuntimeInvariantFindings } from "../validate-oas-runtime-invariants";
import type { ReviewFinding } from "../validate-agent-json";
import { KNOWN_BROKEN_AGENTS } from "./__fixtures__/known-broken-agents";

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/agents/src/__tests__/ → cinatra repo root
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const AGENTS_DIR = join(REPO_ROOT, "extensions", "cinatra-ai");

/**
 * Agents known to violate runtime invariants. Each entry documents the
 * expected scanner findings so the validator can ship independently while
 * each known violation remains explicit and bounded.
 *
 * All authored agents should pass without an allowlist entry unless a
 * deliberate runtime-backed exception is documented here. Keep this map
 * intact — the "unexpected clean" + expectedCodes assertions
 * below stay armed for the next agent that breaks.
 */
// `KNOWN_BROKEN_AGENTS` lives in `__fixtures__/known-broken-agents.ts` so the
// same allowlist is honored by the parity test and blog-*-validates tests too
// (single source of truth for the documented runtime-backed-agent exception).

async function loadAuthoredOas(): Promise<Array<{ slug: string; oas: Record<string, unknown> }>> {
  if (!existsSync(AGENTS_DIR)) return [];
  const slugs = await readdir(AGENTS_DIR, { withFileTypes: true });
  const out: Array<{ slug: string; oas: Record<string, unknown> }> = [];
  for (const dirent of slugs) {
    if (!dirent.isDirectory()) continue;
    const oasPath = join(AGENTS_DIR, dirent.name, "cinatra", "oas.json");
    if (!existsSync(oasPath)) continue;
    const raw = await readFile(oasPath, "utf8");
    const oas = JSON.parse(raw) as Record<string, unknown>;
    out.push({ slug: dirent.name, oas });
  }
  return out;
}

const formatFindings = (findings: ReviewFinding[]): string =>
  findings
    .map((f) => `  [${f.code}] ${f.location ?? "<top>"}: ${f.message.split(".")[0]}.`)
    .join("\n");

describe("pyagentspec runtime invariants", () => {
  // -------------------------------------------------------------------------
  // POSITIVE — every shipped OAS must pass.
  // -------------------------------------------------------------------------
  describe("authored OAS files in extensions/cinatra-ai/**/cinatra/oas.json", () => {
    it("produces zero blocker findings for every authored agent", async () => {
      const authored = await loadAuthoredOas();
      expect(authored.length).toBeGreaterThan(0); // sanity: discovery worked

      const breakdown: Array<{
        slug: string;
        blockers: ReviewFinding[];
      }> = [];

      const unexpectedClean: string[] = [];
      const codeDrift: Array<{
        slug: string;
        expected: string[];
        actual: string[];
      }> = [];
      const countDrift: Array<{
        slug: string;
        expectedCount: number;
        actualCount: number;
      }> = [];
      for (const { slug, oas } of authored) {
        const findings = scanOasForRuntimeInvariantFindings(oas);
        const blockers = findings.filter((f) => f.severity === "blocker");
        const allowlistEntry = KNOWN_BROKEN_AGENTS[slug];
        if (blockers.length > 0) {
          if (allowlistEntry) {
            // Tighten: the actual codes must exactly match the allowlist's
            // expectedCodes (set equality). A new code = new bug surfacing
            // through the allowlist — fail loudly so the operator updates
            // the entry rather than silently masking the regression.
            const actualCodes = [...new Set(blockers.map((b) => b.code))].sort();
            const expected = [...new Set(allowlistEntry.expectedCodes)].sort();
            if (
              actualCodes.length !== expected.length ||
              actualCodes.some((c, i) => c !== expected[i])
            ) {
              codeDrift.push({ slug, expected, actual: actualCodes });
            }
            // Also track count. Set-equality on unique codes hides
            // "3 of 4 blockers disappeared" — useful for catching partial
            // regressions in agents with multiple instances of the same code
            // (e.g. 4 A2AAgents = 4 OAS-RUNTIME-008 blockers).
            if (blockers.length !== allowlistEntry.expectedBlockerCount) {
              countDrift.push({
                slug,
                expectedCount: allowlistEntry.expectedBlockerCount,
                actualCount: blockers.length,
              });
            }
            continue; // intentional, tracked.
          }
          breakdown.push({ slug, blockers });
        } else if (allowlistEntry) {
          unexpectedClean.push(slug);
        }
      }

      if (breakdown.length > 0) {
        const detail = breakdown
          .map(
            (b) =>
              `${b.slug}:\n${formatFindings(b.blockers)}`,
          )
          .join("\n\n");
        throw new Error(
          `${breakdown.length} authored agent(s) produced blocker ` +
            `findings — the live runtime will reject them at mount. Fix the ` +
            `OAS or update the scanner if the case is a false positive:\n\n${detail}`,
        );
      }

      // If any known-broken agent now passes cleanly, the entry in
      // KNOWN_BROKEN_AGENTS must be removed in the same PR. This prevents
      // the allowlist from rotting into a permanent hide-the-bug map.
      if (unexpectedClean.length > 0) {
        throw new Error(
          `The following agent(s) listed in KNOWN_BROKEN_AGENTS ` +
            `now pass cleanly. Delete their KNOWN_BROKEN_AGENTS entries in ` +
            `this PR so the allowlist stays minimal: ` +
            unexpectedClean.join(", "),
        );
      }

      // If an allowed agent's blocker codes drifted from the tracked set
      // (new code surfaced OR one of the expected codes stopped firing),
      // fail so the entry is reviewed before continuing.
      if (codeDrift.length > 0) {
        const detail = codeDrift
          .map(
            (d) =>
              `${d.slug}: expected codes [${d.expected.join(", ")}], ` +
              `actual codes [${d.actual.join(", ")}].`,
          )
          .join("\n");
        throw new Error(
          `The following allowlisted agent(s) emit a different set ` +
            `of blocker codes than declared in KNOWN_BROKEN_AGENTS.expectedCodes. ` +
            `Update the entry (or fix the agent) so the allowlist remains a ` +
            `precise, intentional record of what's tracked:\n${detail}`,
        );
      }

      // Count drift catches the case where some (but not all) blocker
      // instances were silently fixed. Set-equality on codes wouldn't notice.
      if (countDrift.length > 0) {
        const detail = countDrift
          .map(
            (d) =>
              `${d.slug}: expectedBlockerCount=${d.expectedCount}, actualBlockerCount=${d.actualCount}.`,
          )
          .join("\n");
        throw new Error(
          `The following allowlisted agent(s) emit a different ` +
            `number of blocker findings than declared in ` +
            `KNOWN_BROKEN_AGENTS.expectedBlockerCount. Update the entry (or ` +
            `fix the remaining blockers) so the allowlist tracks the real ` +
            `regression scope:\n${detail}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // NEGATIVE — forged fixtures, one per code. Each fixture is the MINIMUM
  // shape that triggers the invariant; the assertion checks that the
  // expected code is emitted and that the message names the offender.
  // -------------------------------------------------------------------------
  describe("negative fixtures (each invariant code triggers as expected)", () => {
    it("OAS-RUNTIME-001 — extra input not in placeholder set", () => {
      const oas = baseFlow({
        flowInputs: [
          { title: "seedUrls", type: "string" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "seedUrls", type: "string" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "seedUrls", type: "string" },
          // dead input — not referenced as bare {{ extraInput }}
          { title: "extraInput", type: "string" },
          { title: "agent_run_id", type: "string" },
        ],
        apiData: {
          // Only references {{ seedUrls }} but NOT {{ extraInput }}; the
          // filtered `{{ seedUrls | tojson }}` is invisible to the regex,
          // but the bare placeholder above keeps seedUrls in the inferred
          // set.
          user: "scrape {{ seedUrls }} via {{ seedUrls | tojson }}; agent_run_id={{ agent_run_id }}",
        },
        dfes: [
          {
            name: "start_seedUrls_to_api_seedUrls",
            source: "start",
            sourceOutput: "seedUrls",
            destination: "api",
            destinationInput: "seedUrls",
          },
          {
            name: "start_cinatra_run_id_to_api_agent_run_id",
            source: "start",
            sourceOutput: "cinatra_run_id",
            destination: "api",
            destinationInput: "agent_run_id",
          },
        ],
      });
      const findings = scanOasForRuntimeInvariantFindings(oas);
      const codes = findings.map((f) => f.code);
      expect(codes).toContain("OAS-RUNTIME-001");
      const msg = findings.find((f) => f.code === "OAS-RUNTIME-001")!.message;
      expect(msg).toContain("extraInput");
    });

    it("OAS-RUNTIME-001 — sentinel comment SHOULD pass (filtered + sentinel = valid)", () => {
      const oas = baseFlow({
        flowInputs: [
          { title: "seedUrls", type: "array" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "seedUrls", type: "array" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "seedUrls", type: "array" },
          { title: "agent_run_id", type: "string" },
        ],
        apiData: {
          user:
            "{# pyagentspec-input-hint: {{ seedUrls }} #}scrape {{ seedUrls | tojson }} runId={{ agent_run_id }}",
        },
        dfes: [
          {
            name: "start_seedUrls_to_api_seedUrls",
            source: "start",
            sourceOutput: "seedUrls",
            destination: "api",
            destinationInput: "seedUrls",
          },
          {
            name: "start_cinatra_run_id_to_api_agent_run_id",
            source: "start",
            sourceOutput: "cinatra_run_id",
            destination: "api",
            destinationInput: "agent_run_id",
          },
        ],
      });
      const findings = scanOasForRuntimeInvariantFindings(oas);
      expect(findings.filter((f) => f.severity === "blocker")).toEqual([]);
    });

    it("OAS-RUNTIME-002 — JS-style ternary in template body", () => {
      const oas = baseFlow({
        flowInputs: [
          { title: "title", type: "string", default: "" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "title", type: "string", default: "" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "title", type: "string" },
          { title: "agent_run_id", type: "string" },
        ],
        apiData: {
          // JS-style ternary — invalid Jinja AND invisible to regex.
          user: "Transcribe.{{ title ? ' Title: ' + title : '' }} runId={{ agent_run_id }}",
        },
        dfes: [
          {
            name: "start_title_to_api_title",
            source: "start",
            sourceOutput: "title",
            destination: "api",
            destinationInput: "title",
          },
          {
            name: "start_cinatra_run_id_to_api_agent_run_id",
            source: "start",
            sourceOutput: "cinatra_run_id",
            destination: "api",
            destinationInput: "agent_run_id",
          },
        ],
      });
      const findings = scanOasForRuntimeInvariantFindings(oas);
      const codes = findings.map((f) => f.code);
      expect(codes).toContain("OAS-RUNTIME-002");
    });

    it("OAS-RUNTIME-003 — number type with integer literal default", () => {
      const oas = baseFlow({
        flowInputs: [
          { title: "count", type: "number", default: 5 },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "count", type: "number", default: 5 },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "count", type: "number" },
          { title: "agent_run_id", type: "string" },
        ],
        apiData: {
          user: "count={{ count }} runId={{ agent_run_id }}",
        },
        dfes: [
          {
            name: "start_count_to_api_count",
            source: "start",
            sourceOutput: "count",
            destination: "api",
            destinationInput: "count",
          },
          {
            name: "start_cinatra_run_id_to_api_agent_run_id",
            source: "start",
            sourceOutput: "cinatra_run_id",
            destination: "api",
            destinationInput: "agent_run_id",
          },
        ],
      });
      const findings = scanOasForRuntimeInvariantFindings(oas);
      const codes = findings.map((f) => f.code);
      expect(codes).toContain("OAS-RUNTIME-003");
      const msg = findings.find((f) => f.code === "OAS-RUNTIME-003")!.message;
      expect(msg).toContain('"count"');
    });

    it("OAS-RUNTIME-003 — integer type passes; same default integer 5", () => {
      const oas = baseFlow({
        flowInputs: [
          { title: "count", type: "integer", default: 5 },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "count", type: "integer", default: 5 },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "count", type: "integer" },
          { title: "agent_run_id", type: "string" },
        ],
        apiData: {
          user: "count={{ count }} runId={{ agent_run_id }}",
        },
        dfes: [
          {
            name: "start_count_to_api_count",
            source: "start",
            sourceOutput: "count",
            destination: "api",
            destinationInput: "count",
          },
          {
            name: "start_cinatra_run_id_to_api_agent_run_id",
            source: "start",
            sourceOutput: "cinatra_run_id",
            destination: "api",
            destinationInput: "agent_run_id",
          },
        ],
      });
      const findings = scanOasForRuntimeInvariantFindings(oas);
      expect(findings.filter((f) => f.severity === "blocker")).toEqual([]);
    });

    it("OAS-RUNTIME-004 — agent_run_id in template but no DFE feeds it", () => {
      const oas = baseFlow({
        flowInputs: [
          { title: "x", type: "string" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "x", type: "string" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "x", type: "string" },
          { title: "agent_run_id", type: "string" },
        ],
        apiData: {
          user: "x={{ x }} runId={{ agent_run_id }}",
        },
        // Deliberately MISSING the DFE that would source agent_run_id.
        dfes: [
          {
            name: "start_x_to_api_x",
            source: "start",
            sourceOutput: "x",
            destination: "api",
            destinationInput: "x",
          },
        ],
      });
      const findings = scanOasForRuntimeInvariantFindings(oas);
      const codes = findings.map((f) => f.code);
      expect(codes).toContain("OAS-RUNTIME-004");
    });

    it("OAS-RUNTIME-005 — EndNode declares output with no source", () => {
      const oas = baseFlow({
        flowInputs: [
          { title: "x", type: "string" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "x", type: "string" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "x", type: "string" },
          { title: "agent_run_id", type: "string" },
        ],
        apiOutputs: [{ title: "result", type: "string" }],
        // EndNode declares "ghost" but nothing produces it.
        endOutputs: [
          { title: "result", type: "string" },
          { title: "ghost", type: "string" },
        ],
        apiData: {
          user: "x={{ x }} runId={{ agent_run_id }}",
        },
        dfes: [
          {
            name: "start_x_to_api_x",
            source: "start",
            sourceOutput: "x",
            destination: "api",
            destinationInput: "x",
          },
          {
            name: "start_cinatra_run_id_to_api_agent_run_id",
            source: "start",
            sourceOutput: "cinatra_run_id",
            destination: "api",
            destinationInput: "agent_run_id",
          },
          {
            name: "api_result_to_end_result",
            source: "api",
            sourceOutput: "result",
            destination: "end",
            destinationInput: "result",
          },
        ],
      });
      const findings = scanOasForRuntimeInvariantFindings(oas);
      const codes = findings.map((f) => f.code);
      expect(codes).toContain("OAS-RUNTIME-005");
      const msg = findings.find((f) => f.code === "OAS-RUNTIME-005")!.message;
      expect(msg).toContain('"ghost"');
    });

    it("nested-subflow recursion — invariant violation inside a Flow nested in $referenced_components is caught", () => {
      // The OUTER Flow is clean. The INNER Flow (a subflow stored under
      // outer.$referenced_components.inner_flow) carries a deliberate
      // OAS-RUNTIME-003 violation: `count` with "type":"number" + integer
      // default. Without recursive subflow traversal, the inner violation
      // is invisible.
      const innerFlow: Record<string, unknown> = {
        agentspec_version: "26.1.0",
        component_type: "Flow",
        id: "inner-flow",
        name: "Inner",
        inputs: [
          { title: "count", type: "number", default: 7 }, // OAS-RUNTIME-003
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        outputs: [{ title: "result", type: "string" }],
        start_node: { $component_ref: "inner_start" },
        nodes: [
          { $component_ref: "inner_start" },
          { $component_ref: "inner_end" },
        ],
        control_flow_connections: [],
        data_flow_connections: [
          {
            component_type: "DataFlowEdge",
            name: "trivial",
            source_node: { $component_ref: "inner_start" },
            source_output: "cinatra_run_id",
            destination_node: { $component_ref: "inner_end" },
            destination_input: "result",
          },
        ],
        $referenced_components: {
          inner_start: {
            component_type: "StartNode",
            id: "inner_start",
            name: "Inner inputs",
            inputs: [
              { title: "count", type: "number", default: 7 },
              { title: "cinatra_run_id", type: "string", default: "" },
            ],
          },
          inner_end: {
            component_type: "EndNode",
            id: "inner_end",
            name: "Inner end",
            outputs: [{ title: "result", type: "string" }],
          },
        },
      };
      const outerOas = baseFlow({
        flowInputs: [
          { title: "x", type: "string" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "x", type: "string" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "x", type: "string" },
          { title: "agent_run_id", type: "string" },
        ],
        apiData: {
          user: "x={{ x }} runId={{ agent_run_id }}",
        },
        dfes: [
          {
            name: "start_x_to_api_x",
            source: "start",
            sourceOutput: "x",
            destination: "api",
            destinationInput: "x",
          },
          {
            name: "start_cinatra_run_id_to_api_agent_run_id",
            source: "start",
            sourceOutput: "cinatra_run_id",
            destination: "api",
            destinationInput: "agent_run_id",
          },
        ],
      });
      const refs = outerOas.$referenced_components as Record<string, unknown>;
      refs.inner_flow = innerFlow;

      const findings = scanOasForRuntimeInvariantFindings(outerOas);
      const codes = findings.map((f) => f.code);
      expect(codes).toContain("OAS-RUNTIME-003");
      const msg = findings.find((f) => f.code === "OAS-RUNTIME-003")!.message;
      // The message names the offending input title — proves traversal
      // reached into the inner flow.
      expect(msg).toContain('"count"');
    });

    it("OAS-RUNTIME-005 — EndNode output trickled via Flow input + StartNode passes", () => {
      const oas = baseFlow({
        flowInputs: [
          { title: "x", type: "string" },
          { title: "kind", type: "string", default: "" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        startInputs: [
          { title: "x", type: "string" },
          { title: "kind", type: "string", default: "" },
          { title: "cinatra_run_id", type: "string", default: "" },
        ],
        apiInputs: [
          { title: "x", type: "string" },
          { title: "agent_run_id", type: "string" },
        ],
        apiOutputs: [{ title: "result", type: "string" }],
        endOutputs: [
          { title: "result", type: "string" },
          { title: "kind", type: "string" },
        ],
        apiData: {
          user: "x={{ x }} runId={{ agent_run_id }}",
        },
        dfes: [
          {
            name: "start_x_to_api_x",
            source: "start",
            sourceOutput: "x",
            destination: "api",
            destinationInput: "x",
          },
          {
            name: "start_cinatra_run_id_to_api_agent_run_id",
            source: "start",
            sourceOutput: "cinatra_run_id",
            destination: "api",
            destinationInput: "agent_run_id",
          },
          {
            name: "api_result_to_end_result",
            source: "api",
            sourceOutput: "result",
            destination: "end",
            destinationInput: "result",
          },
          // Explicit passthrough — same name on both sides.
          {
            name: "start_kind_to_end_kind",
            source: "start",
            sourceOutput: "kind",
            destination: "end",
            destinationInput: "kind",
          },
        ],
      });
      const findings = scanOasForRuntimeInvariantFindings(oas);
      expect(findings.filter((f) => f.severity === "blocker")).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Invariant 6 — cinatra_llm in source for every /api/llm-bridge ApiNode
// ---------------------------------------------------------------------------

describe("OAS-RUNTIME-006 — cinatra_llm must live in source for bridge ApiNodes (when top-level llm declared)", () => {
  function addTopLevelLlm(oas: Record<string, unknown>): void {
    oas.metadata = {
      cinatra: {
        llm: {
          preferredProvider: "openai",
          preferredModel: "gpt-5",
        },
      },
    };
  }

  it("emits a blocker when top-level llm IS declared but a /api/llm-bridge ApiNode lacks data.cinatra_llm", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: { agent_id: "test", user: "x={{ x }}" },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    addTopLevelLlm(oas);
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.api.url = "{{CINATRA_BASE_URL}}/api/llm-bridge";
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code006 = findings.filter((f) => f.code === "OAS-RUNTIME-006");
    expect(code006).toHaveLength(1);
    expect(code006[0]!.severity).toBe("blocker");
    expect(code006[0]!.message).toContain("data.cinatra_llm");
    expect(code006[0]!.message).toContain("top-level metadata.cinatra.llm");
    expect(code006[0]!.location).toContain("$referenced_components.api");
  });

  it("passes when /api/llm-bridge ApiNode declares data.cinatra_llm in source", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: {
        agent_id: "test",
        user: "x={{ x }}",
        cinatra_llm: { preferredProvider: "openai", preferredModel: "gpt-5" },
      },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    addTopLevelLlm(oas);
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.api.url = "{{CINATRA_BASE_URL}}/api/llm-bridge";
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code006 = findings.filter((f) => f.code === "OAS-RUNTIME-006");
    expect(code006).toEqual([]);
  });

  it("does NOT fire when top-level metadata.cinatra.llm is absent (legitimate passthrough)", () => {
    // 12 cinatra agents (agent-code-reviewer, email-drafting, reviewer-agent,
    // etc.) call /api/llm-bridge WITHOUT declaring metadata.cinatra.llm —
    // they use the OpenAI passthrough default deliberately. The rule only
    // fires when top-level llm IS declared (then source-side data.cinatra_llm
    // must mirror it).
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: { agent_id: "test", user: "x={{ x }}" },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    // NO addTopLevelLlm call — passthrough is fine here.
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.api.url = "{{CINATRA_BASE_URL}}/api/llm-bridge";
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code006 = findings.filter((f) => f.code === "OAS-RUNTIME-006");
    expect(code006).toEqual([]);
  });

  it("does not fire on non-bridge ApiNodes (other URLs are out of scope)", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: { user: "x={{ x }}" },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    addTopLevelLlm(oas);
    // baseFlow defaults to `http://example/api` — confirm OAS-RUNTIME-006
    // never fires when the URL isn't the bridge.
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code006 = findings.filter((f) => f.code === "OAS-RUNTIME-006");
    expect(code006).toEqual([]);
  });

  it("emits one finding per missing-cinatra_llm bridge ApiNode at any nesting depth (when top-level llm declared)", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: { user: "x={{ x }}" },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    addTopLevelLlm(oas);
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.api.url = "http://localhost:3000/api/llm-bridge";
    refs.api2 = {
      component_type: "ApiNode",
      id: "api2",
      name: "Second bridge",
      url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
      http_method: "POST",
      data: { user: "y={{ x }}" },
      inputs: [{ title: "x", type: "string" }],
      outputs: [{ title: "result", type: "string" }],
    };
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code006 = findings.filter((f) => f.code === "OAS-RUNTIME-006");
    expect(code006.map((f) => f.location).sort()).toEqual([
      "$.$referenced_components.api",
      "$.$referenced_components.api2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 7 — toolbox_ids in source for every /api/llm-bridge ApiNode
// ---------------------------------------------------------------------------

describe("OAS-RUNTIME-007 — toolbox_ids must live in source when top-level toolboxes declared", () => {
  function addTopLevelToolboxes(oas: Record<string, unknown>, toolboxes: string[]): void {
    const md = (oas.metadata as Record<string, unknown> | undefined) ?? {};
    const cinatra = (md.cinatra as Record<string, unknown> | undefined) ?? {};
    cinatra.toolboxes = toolboxes;
    md.cinatra = cinatra;
    oas.metadata = md;
  }

  it("emits a blocker when top-level toolboxes IS declared but a /api/llm-bridge ApiNode lacks data.toolbox_ids", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: { agent_id: "test", user: "x={{ x }}" },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    addTopLevelToolboxes(oas, ["web_search"]);
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.api.url = "{{CINATRA_BASE_URL}}/api/llm-bridge";
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code007 = findings.filter((f) => f.code === "OAS-RUNTIME-007");
    expect(code007).toHaveLength(1);
    expect(code007[0]!.severity).toBe("blocker");
    expect(code007[0]!.message).toContain("data.toolbox_ids");
    expect(code007[0]!.message).toContain("top-level metadata.cinatra.toolboxes");
    expect(code007[0]!.location).toContain("$referenced_components.api");
  });

  it("passes when /api/llm-bridge ApiNode declares data.toolbox_ids in source", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: {
        agent_id: "test",
        user: "x={{ x }}",
        toolbox_ids: ["web_search"],
      },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    addTopLevelToolboxes(oas, ["web_search"]);
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.api.url = "{{CINATRA_BASE_URL}}/api/llm-bridge";
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-007")).toEqual([]);
  });

  it("does NOT fire when top-level metadata.cinatra.toolboxes is absent (passthrough default)", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: { agent_id: "test", user: "x={{ x }}" },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    // NO addTopLevelToolboxes — agent defaults to ["cinatra-mcp"] at runtime.
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.api.url = "{{CINATRA_BASE_URL}}/api/llm-bridge";
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-007")).toEqual([]);
  });

  it("does not fire on non-bridge ApiNodes", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: { user: "x={{ x }}" },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    addTopLevelToolboxes(oas, ["web_search"]);
    // baseFlow url default is http://example/api — not the bridge.
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-007")).toEqual([]);
  });

  it("ignores an empty toolboxes array (treated as no declaration)", () => {
    const oas = baseFlow({
      flowInputs: [{ title: "x", type: "string" }],
      startInputs: [{ title: "x", type: "string" }],
      apiInputs: [{ title: "x", type: "string" }],
      apiData: { agent_id: "test", user: "x={{ x }}" },
      dfes: [
        { name: "start_x_to_api", source: "start", sourceOutput: "x", destination: "api", destinationInput: "x" },
      ],
    });
    addTopLevelToolboxes(oas, []);
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.api.url = "{{CINATRA_BASE_URL}}/api/llm-bridge";
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-007")).toEqual([]);
  });
});

describe("OAS-RUNTIME-008 — internal A2AAgent composition forbidden (use FlowNode inlining or MCP primitive)", () => {
  function flowWithA2a(agentUrl: string): Record<string, unknown> {
    return {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: "a2a-fixture-flow",
      name: "A2A Fixture",
      inputs: [],
      outputs: [{ title: "result", type: "string" }],
      start_node: { $component_ref: "start" },
      nodes: [
        { $component_ref: "start" },
        { $component_ref: "agent_node" },
        { $component_ref: "end" },
      ],
      control_flow_connections: [],
      data_flow_connections: [],
      $referenced_components: {
        start: {
          component_type: "StartNode",
          id: "start",
          name: "Inputs",
          inputs: [],
        },
        agent_node: {
          component_type: "AgentNode",
          id: "agent_node",
          name: "Run external agent",
          agent: { $component_ref: "external_a2a" },
        },
        external_a2a: {
          component_type: "A2AAgent",
          id: "external_a2a",
          name: "External A2A target",
          agent_url: agentUrl,
        },
        end: {
          component_type: "EndNode",
          id: "end",
          name: "End",
          outputs: [{ title: "result", type: "string" }],
        },
      },
    };
  }

  it("flags A2AAgent targeting {{CINATRA_BASE_URL}} as blocker", () => {
    const oas = flowWithA2a("{{CINATRA_BASE_URL}}/api/a2a/extensions/cinatra-ai/lint-policy-agent");
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code008 = findings.filter((f) => f.code === "OAS-RUNTIME-008");
    expect(code008).toHaveLength(1);
    expect(code008[0]?.severity).toBe("blocker");
    expect(code008[0]?.message).toMatch(/internal sub-agent composition/i);
    expect(code008[0]?.message).toMatch(/FlowNode/);
  });

  it("flags A2AAgent targeting localhost as blocker", () => {
    const oas = flowWithA2a("http://localhost:3000/api/a2a/extensions/cinatra-ai/planner-agent");
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code008 = findings.filter((f) => f.code === "OAS-RUNTIME-008");
    expect(code008).toHaveLength(1);
    expect(code008[0]?.severity).toBe("blocker");
  });

  it("flags A2AAgent targeting 127.0.0.1 as blocker", () => {
    const oas = flowWithA2a("http://127.0.0.1:3000/api/a2a/extensions/cinatra-ai/planner-agent");
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-008" && f.severity === "blocker")).toHaveLength(1);
  });

  it("flags A2AAgent targeting host.docker.internal as blocker", () => {
    const oas = flowWithA2a("http://host.docker.internal:3000/api/a2a/extensions/cinatra-ai/x");
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-008" && f.severity === "blocker")).toHaveLength(1);
  });

  it("flags A2AAgent targeting IPv6 loopback ([::1]) as blocker", () => {
    const oas = flowWithA2a("http://[::1]:3000/api/a2a/extensions/cinatra-ai/planner-agent");
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-008" && f.severity === "blocker")).toHaveLength(1);
  });

  it("flags /api/a2a/agents/ on ANY host as blocker (Cinatra internal proxy route)", () => {
    // The scanner matches the literal /api/a2a/agents/ route prefix used by
    // the Cinatra internal WayFlow proxy at src/app/api/a2a/agents/[...slug],
    // not an /api/a2a/extensions/ path (which mirrors the on-disk layout,
    // not a route).
    const oas = flowWithA2a("https://otherinstance.example.com/api/a2a/agents/cinatra-ai/planner-agent");
    const findings = scanOasForRuntimeInvariantFindings(oas);
    const code008 = findings.filter((f) => f.code === "OAS-RUNTIME-008");
    expect(code008).toHaveLength(1);
    expect(code008[0]?.severity).toBe("blocker");
  });

  it("flags relative /api/a2a/agents/ URLs (no scheme) as blocker", () => {
    const oas = flowWithA2a("/api/a2a/agents/cinatra-ai/planner-agent");
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-008" && f.severity === "blocker")).toHaveLength(1);
  });

  it("does NOT flag a genuinely external A2AAgent (no Cinatra route prefix, no local host)", () => {
    const oas = flowWithA2a("https://external-agent.example.com/agent-api");
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-008")).toEqual([]);
  });

  it("walks INLINE A2AAgent (under AgentNode.agent, not in $referenced_components)", () => {
    const oas = {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: "inline-fixture",
      name: "Inline A2A Fixture",
      start_node: { $component_ref: "start" },
      nodes: [{ $component_ref: "start" }],
      control_flow_connections: [],
      data_flow_connections: [],
      $referenced_components: {
        start: { component_type: "StartNode", id: "start", name: "S", inputs: [] },
        wrapper_node: {
          component_type: "AgentNode",
          id: "wrapper_node",
          name: "wrapper",
          // Inline A2AAgent — NOT a $component_ref. Must still be flagged.
          agent: {
            component_type: "A2AAgent",
            id: "inline_a2a",
            name: "Inline A2A",
            agent_url: "{{CINATRA_BASE_URL}}/api/a2a/extensions/cinatra-ai/planner-agent",
          },
        },
      },
    };
    const findings = scanOasForRuntimeInvariantFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-008" && f.severity === "blocker")).toHaveLength(1);
  });

  it("walks nested $referenced_components (subflow-embedded A2AAgent)", () => {
    const inner = flowWithA2a("{{CINATRA_BASE_URL}}/api/a2a/extensions/cinatra-ai/planner-agent");
    const wrappingFlow = {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: "wrapper",
      name: "Wrapper",
      start_node: { $component_ref: "wrapper_start" },
      nodes: [{ $component_ref: "wrapper_start" }],
      control_flow_connections: [],
      data_flow_connections: [],
      $referenced_components: {
        wrapper_start: {
          component_type: "StartNode",
          id: "wrapper_start",
          name: "Inputs",
          inputs: [],
        },
        sub: inner,
      },
    };
    const findings = scanOasForRuntimeInvariantFindings(wrappingFlow);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-008" && f.severity === "blocker")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers — build minimal Flow shapes for negative fixtures.
// ---------------------------------------------------------------------------

interface Descriptor {
  title: string;
  type: string;
  default?: unknown;
}

interface DataFlowEdgeSpec {
  name: string;
  source: string;
  sourceOutput: string;
  destination: string;
  destinationInput: string;
}

interface BaseFlowSpec {
  flowInputs: Descriptor[];
  startInputs: Descriptor[];
  apiInputs: Descriptor[];
  apiOutputs?: Descriptor[];
  endOutputs?: Descriptor[];
  apiData: Record<string, unknown>;
  dfes: DataFlowEdgeSpec[];
}

function baseFlow(spec: BaseFlowSpec): Record<string, unknown> {
  // Always wire the default api.result → end.result edge unless the test
  // explicitly provided it or overrode `apiOutputs` / `endOutputs`. This
  // makes the negative fixtures focus on the invariant under test.
  const defaultDfes: DataFlowEdgeSpec[] = [];
  const userDfes = spec.dfes;
  const hasApiResultEdge = userDfes.some(
    (e) =>
      e.source === "api" &&
      e.sourceOutput === "result" &&
      e.destination === "end" &&
      e.destinationInput === "result",
  );
  if (!hasApiResultEdge && !spec.apiOutputs && !spec.endOutputs) {
    defaultDfes.push({
      name: "api_result_to_end_result",
      source: "api",
      sourceOutput: "result",
      destination: "end",
      destinationInput: "result",
    });
  }
  const finalDfes = [...userDfes, ...defaultDfes];
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "negative-fixture-flow",
    name: "Negative Fixture",
    inputs: spec.flowInputs,
    outputs: spec.endOutputs ?? [{ title: "result", type: "string" }],
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "api" },
      { $component_ref: "end" },
    ],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start_to_api",
        from_node: { $component_ref: "start" },
        to_node: { $component_ref: "api" },
      },
      {
        component_type: "ControlFlowEdge",
        name: "api_to_end",
        from_node: { $component_ref: "api" },
        to_node: { $component_ref: "end" },
      },
    ],
    data_flow_connections: finalDfes.map((e) => ({
      component_type: "DataFlowEdge",
      name: e.name,
      source_node: { $component_ref: e.source },
      source_output: e.sourceOutput,
      destination_node: { $component_ref: e.destination },
      destination_input: e.destinationInput,
    })),
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Inputs",
        inputs: spec.startInputs,
      },
      api: {
        component_type: "ApiNode",
        id: "api",
        name: "Call bridge",
        url: "http://example/api",
        http_method: "POST",
        data: spec.apiData,
        inputs: spec.apiInputs,
        outputs: spec.apiOutputs ?? [{ title: "result", type: "string" }],
      },
      end: {
        component_type: "EndNode",
        id: "end",
        name: "End",
        outputs: spec.endOutputs ?? [{ title: "result", type: "string" }],
      },
    },
  };
}
