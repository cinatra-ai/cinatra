// ---------------------------------------------------------------------------
// A/B measurement: does provider-side MCP tool restriction reduce BILLED
// context, or only invocation eligibility?
//
// THE QUESTION THIS ANSWERS. With a provider-hosted MCP reference the catalog
// does not ride the request body. The provider fetches it on our behalf and
// bills it as input. So "we send fewer tools" is not by itself evidence of a
// cheaper turn. The only honest test is to run the SAME prompts twice against
// the SAME hosted MCP server, changing nothing but the `allowed_tools`
// narrowing, and compare three numbers per turn:
//
//   • input_tokens          : did billed context actually fall?
//   • cached_input_tokens   : did narrowing help or hurt the cache?
//   • the mcp_list_tools inventory the provider returns: did the narrowing
//                             reach the provider at all?
//
// A drop in the returned inventory with no drop in input_tokens would mean
// restriction gates invocation only. That negative result is a real outcome of
// this script and must be reported as such.
//
// ARMS. Arm "full" sends the hosted MCP entry with no allowlist. Arm
// "restricted" sends the identical entry plus the canonical core-tier
// allowlist. Everything else (model, system text, prompt, server URL and
// credentials) is byte-identical between arms.
//
// CACHE INTERACTION. Turns run in a fixed order with a configurable gap so a
// cache read is attributable. Because a provider caches the longest matching
// prefix, the second turn of an arm is the one whose cached_input_tokens is
// informative; the first is the cold-turn floor the narrowing is meant to
// lower.
//
// CREDENTIALS. Read from the environment and never printed, never written to
// the report. The script fails closed with a name-only diagnostic if one is
// absent.
//
// COST. Every turn's estimated spend is printed BEFORE the run and the run
// aborts unless --confirm is passed, so nobody discovers the bill afterwards.
// ---------------------------------------------------------------------------

import { argv, env, exit } from "node:process";
import { writeFileSync } from "node:fs";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

// The canonical core tier. Kept as a literal so the script runs standalone
// (no build step, no workspace resolution); the parity test in
// packages/llm/src/__tests__/chat-mcp-tool-projection.test.ts is what keeps
// the real projection honest, and `--print-tiers` below cross-checks this copy
// against it when the workspace is available.
const CORE_TIER = [
  "agent_get",
  "agent_list",
  "agent_registry_list",
  "agent_run",
  "agent_run_get",
  "agent_run_list",
  "agent_run_messages_list",
  "agent_run_stop",
  "artifact_authoring_emit",
  "artifact_extension_get",
  "artifact_extension_search",
  "artifact_review_gate_render",
  "artifact_review_gates_list",
  "artifacts_get",
  "artifacts_list",
  "blog_project_get",
  "blog_project_list",
  "campaigns_get",
  "campaigns_list",
  "connector_inventory_list",
  "dashboards_get",
  "dashboards_list",
  "drupal_instances_list",
  "extensions_search",
  "metric_cost_summary",
  "metric_usage_summary",
  "objects_get",
  "objects_list",
  "projects_get",
  "projects_list",
  "schedule_proposal_render",
  "skills_catalog_list",
  "skills_installed_list",
  "skills_library_list",
  "skills_personal_list",
  "system_screen_lookup",
  "verification_record_render",
];

const DEFAULT_PROMPTS = [
  "which connectors are active?",
  "which agents are available?",
];

function parseArgs() {
  const args = new Map();
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, "").split("=");
    args.set(key, value ?? "true");
  }
  return args;
}

function requireEnv(name) {
  const value = env[name];
  if (!value || value.trim() === "") {
    console.error(
      `Missing ${name}. Export it in the shell that runs this script. ` +
        "The value is never printed and never written to the report.",
    );
    exit(2);
  }
  return value;
}

function buildRequest({ model, system, prompt, serverUrl, bearer, allowedTools }) {
  const mcpEntry = {
    type: "mcp",
    server_label: "cinatra",
    server_url: serverUrl,
    headers: { Authorization: `Bearer ${bearer}` },
    require_approval: "never",
  };
  if (allowedTools) mcpEntry.allowed_tools = allowedTools;
  return {
    model,
    instructions: system,
    input: [{ role: "user", content: prompt }],
    tools: [mcpEntry],
    store: true,
  };
}

function readUsage(payload) {
  const usage = payload.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

// The provider echoes the catalog it fetched as an `mcp_list_tools` output
// item. Counting it is what proves the narrowing reached the provider rather
// than being silently dropped.
function readListedToolNames(payload) {
  const items = Array.isArray(payload.output) ? payload.output : [];
  const names = [];
  for (const item of items) {
    if (item?.type !== "mcp_list_tools") continue;
    for (const tool of item.tools ?? []) {
      if (typeof tool?.name === "string") names.push(tool.name);
    }
  }
  return names.sort();
}

function estimateCostUsd({ inputTokens, cachedInputTokens, outputTokens }, rates) {
  const uncached = Math.max(inputTokens - cachedInputTokens, 0);
  return (
    (uncached / 1_000_000) * rates.input +
    (cachedInputTokens / 1_000_000) * rates.cachedInput +
    (outputTokens / 1_000_000) * rates.output
  );
}

async function runTurn({ arm, prompt, request, apiKey }) {
  const startedAt = new Date().toISOString();
  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `arm=${arm} prompt=${JSON.stringify(prompt)} -> HTTP ${response.status}: ${body.slice(0, 400)}`,
    );
  }
  const payload = await response.json();
  return {
    arm,
    prompt,
    startedAt,
    model: payload.model ?? null,
    usage: readUsage(payload),
    listedTools: readListedToolNames(payload),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTable(rows, rates) {
  const header =
    "| arm | prompt | input | cached | output | listed tools | est. cost |\n" +
    "|---|---|---:|---:|---:|---:|---:|";
  const body = rows
    .map((row) => {
      const cost = estimateCostUsd(row.usage, rates);
      return `| ${row.arm} | ${row.prompt} | ${row.usage.inputTokens} | ${row.usage.cachedInputTokens} | ${row.usage.outputTokens} | ${row.listedTools.length} | $${cost.toFixed(4)} |`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

async function main() {
  const args = parseArgs();

  if (args.has("help")) {
    console.log(
      [
        "Measure whether provider-side MCP tool restriction reduces billed context.",
        "",
        "Required environment (values are never printed):",
        "  OPENAI_API_KEY        the provider credential",
        "  CINATRA_MCP_BEARER    a delegated chat actor token for the self-MCP server",
        "  CINATRA_MCP_URL       the publicly reachable MCP server URL",
        "",
        "Usage:",
        "  node scripts/measure/mcp-allowlist-ab.mjs --confirm",
        "  node scripts/measure/mcp-allowlist-ab.mjs --confirm --model=gpt-5.5 --gap-ms=5000",
        "  node scripts/measure/mcp-allowlist-ab.mjs --confirm --out=evidence/2771-ab.json",
        "",
        "Flags:",
        "  --confirm       actually spend money (without it the script only estimates)",
        "  --model=ID      model to measure (default gpt-5.5)",
        "  --gap-ms=N      pause between turns (default 0; raise to probe cache expiry)",
        "  --repeat=N      turns per prompt per arm (default 2, so a cache read is visible)",
        "  --out=PATH      write the full JSON record here",
        "  --print-tiers   print the core tier this script measures, then exit",
      ].join("\n"),
    );
    return;
  }

  if (args.has("print-tiers")) {
    console.log(JSON.stringify({ coreTier: CORE_TIER, size: CORE_TIER.length }, null, 2));
    return;
  }

  const model = args.get("model") ?? "gpt-5.5";
  const gapMs = Number(args.get("gap-ms") ?? 0);
  const repeat = Number(args.get("repeat") ?? 2);
  const prompts = args.has("prompt") ? [args.get("prompt")] : DEFAULT_PROMPTS;
  const rates = {
    input: Number(args.get("rate-input") ?? 5),
    cachedInput: Number(args.get("rate-cached-input") ?? 0.5),
    output: Number(args.get("rate-output") ?? 30),
  };

  const totalTurns = prompts.length * repeat * 2;
  // A cold turn on the reported prefix is ~25k input plus a small completion.
  const worstCasePerTurn = estimateCostUsd(
    { inputTokens: 26_000, cachedInputTokens: 0, outputTokens: 1_200 },
    rates,
  );
  const worstCaseTotal = worstCasePerTurn * totalTurns;

  console.log(
    [
      `Plan: ${totalTurns} turns (${prompts.length} prompts x ${repeat} repeats x 2 arms) on ${model}.`,
      `Worst-case estimated spend: $${worstCaseTotal.toFixed(2)} ` +
        `(assumes every turn cold at ~26k input, ~1.2k output).`,
    ].join("\n"),
  );

  if (!args.has("confirm")) {
    console.log(
      "\nDry run. No request was sent. Re-run with --confirm to measure for real.",
    );
    return;
  }

  const apiKey = requireEnv("OPENAI_API_KEY");
  const bearer = requireEnv("CINATRA_MCP_BEARER");
  const serverUrl = requireEnv("CINATRA_MCP_URL");
  const system = args.get("system") ?? "You are Cinatra, an enterprise intelligence assistant.";

  const rows = [];
  for (const arm of ["full", "restricted"]) {
    const allowedTools = arm === "restricted" ? CORE_TIER : null;
    for (const prompt of prompts) {
      for (let i = 0; i < repeat; i += 1) {
        const request = buildRequest({
          model,
          system,
          prompt,
          serverUrl,
          bearer,
          allowedTools,
        });
        const row = await runTurn({ arm, prompt, request, apiKey });
        rows.push(row);
        console.log(
          `${arm} turn ${i + 1} "${prompt}": input=${row.usage.inputTokens} ` +
            `cached=${row.usage.cachedInputTokens} listed=${row.listedTools.length}`,
        );
        if (gapMs > 0) await sleep(gapMs);
      }
    }
  }

  const summarize = (arm) => {
    const armRows = rows.filter((r) => r.arm === arm);
    const total = (pick) => armRows.reduce((sum, r) => sum + pick(r), 0);
    return {
      arm,
      turns: armRows.length,
      inputTokens: total((r) => r.usage.inputTokens),
      cachedInputTokens: total((r) => r.usage.cachedInputTokens),
      outputTokens: total((r) => r.usage.outputTokens),
      listedToolsFirstTurn: armRows[0]?.listedTools.length ?? 0,
      estimatedCostUsd: armRows.reduce(
        (sum, r) => sum + estimateCostUsd(r.usage, rates),
        0,
      ),
    };
  };

  const summary = { full: summarize("full"), restricted: summarize("restricted") };
  const inputDelta = summary.full.inputTokens - summary.restricted.inputTokens;
  const verdict =
    inputDelta > 0
      ? "Restriction REDUCED billed input context."
      : "Restriction did NOT reduce billed input context. It gated invocation eligibility only.";

  console.log(`\n${formatTable(rows, rates)}`);
  console.log(
    [
      "",
      `full:       ${summary.full.inputTokens} input, ${summary.full.cachedInputTokens} cached, ${summary.full.listedToolsFirstTurn} tools listed`,
      `restricted: ${summary.restricted.inputTokens} input, ${summary.restricted.cachedInputTokens} cached, ${summary.restricted.listedToolsFirstTurn} tools listed`,
      `input-token delta: ${inputDelta}`,
      `estimated spend: $${(summary.full.estimatedCostUsd + summary.restricted.estimatedCostUsd).toFixed(4)}`,
      "",
      verdict,
    ].join("\n"),
  );

  const outPath = args.get("out");
  if (outPath) {
    writeFileSync(
      outPath,
      JSON.stringify({ model, rates, prompts, repeat, gapMs, rows, summary, verdict }, null, 2),
    );
    console.log(`\nWrote ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  exit(1);
});
