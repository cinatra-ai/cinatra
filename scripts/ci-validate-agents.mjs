#!/usr/bin/env node
// scripts/ci-validate-agents.mjs
// Validates all agents/cinatra/<slug>-agent/cinatra/oas.json files against
// the AgentJsonV1 schema.
// Usage: node scripts/ci-validate-agents.mjs
// Exit 0: all files valid. Exit 1: one or more files failed validation.
//
// Canonical layout is agents/cinatra/<slug>-agent/cinatra/oas.json.
// The pre-200 cinatra/agent.json filename is probed as a transitional fallback
// so this validator keeps working during migration.

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExtensionsPresent } from "./audit/lib/assert-extensions-cloned.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
// Agents live under extensions/cinatra-ai/<slug>/
const agentsDir = join(projectRoot, "extensions", "cinatra-ai");

function validateAgentJson(content, filePath) {
  const errors = [];

  // Files are authored as compact OAS Flow (agentspec_version
  // 26.1.0). The compact OAS Flow schema is
  // unchanged. Detect format from the agentspec_version field.
  const isOas = typeof content.agentspec_version === "string"
    && content.component_type === "Flow";

  if (isOas) {
    // OAS Flow v26.1.0 schema
    if (!content.id || typeof content.id !== "string") {
      errors.push("id is required and must be a non-empty string");
    }
    if (!content.name || typeof content.name !== "string") {
      errors.push("name is required and must be a non-empty string");
    }
    const cinatra = content.metadata?.cinatra ?? null;
    if (!cinatra || typeof cinatra !== "object" || Array.isArray(cinatra)) {
      errors.push("metadata.cinatra object is required for OAS-format agents");
    } else {
      // packageName/packageVersion in metadata.cinatra are
      // optional — they live in the sibling package.json by convention.
      // When present in metadata.cinatra, validate type only.
      if (cinatra.packageName !== undefined && typeof cinatra.packageName !== "string") {
        errors.push("metadata.cinatra.packageName must be a string when present");
      }
      if (cinatra.packageVersion !== undefined && typeof cinatra.packageVersion !== "string") {
        errors.push("metadata.cinatra.packageVersion must be a string when present");
      }
    }
    if (content.inputs !== undefined && !Array.isArray(content.inputs)) {
      errors.push("inputs must be an array (when present)");
    }
    if (content.outputs !== undefined && !Array.isArray(content.outputs)) {
      errors.push("outputs must be an array (when present)");
    }
  } else {
    // Legacy AgentJsonV1 schema (formatVersion === 1).
    if (content.formatVersion !== 1) {
      errors.push(`formatVersion must be 1 (got ${JSON.stringify(content.formatVersion)})`);
    }
    if (!content.packageName || typeof content.packageName !== "string") {
      errors.push("packageName is required and must be a non-empty string");
    }
    if (!content.packageVersion || typeof content.packageVersion !== "string") {
      errors.push("packageVersion is required and must be a non-empty string (semver, e.g. '1.0.0')");
    }
    if (!content.name || typeof content.name !== "string") {
      errors.push("name is required and must be a non-empty string");
    }
    if (!content.description || typeof content.description !== "string") {
      errors.push("description is required and must be a non-empty string (keep under ~200 chars)");
    }
    if (content.executionMode !== "deterministic" && content.executionMode !== "agentic") {
      errors.push(`executionMode must be "deterministic" or "agentic" (got ${JSON.stringify(content.executionMode)})`);
    }
    const promptField = content.prompt ?? content.taskSpec;
    if (content.executionMode === "agentic" && (!promptField || typeof promptField !== "string")) {
      errors.push("prompt (or taskSpec) is required for agentic executionMode");
    }
    if (!content.inputSchema || typeof content.inputSchema !== "object" || Array.isArray(content.inputSchema)) {
      errors.push("inputSchema is required and must be a JSON Schema object");
    }
    if (!Array.isArray(content.compiledPlan)) {
      errors.push("compiledPlan is required and must be an array (use [] for agentic mode)");
    }
    // Reject __-prefixed inputSchema properties (UI-only fields stripped at export time)
    if (content.inputSchema && typeof content.inputSchema === "object" && !Array.isArray(content.inputSchema)) {
      const props = content.inputSchema.properties;
      if (props && typeof props === "object") {
        const uiKeys = Object.keys(props).filter((k) => k.startsWith("__"));
        if (uiKeys.length > 0) {
          errors.push(`inputSchema.properties must not contain __ prefixed keys (found: ${uiKeys.join(", ")})`);
        }
      }
    }
  }

  return errors;
}

async function main() {
  // Fail-closed (source-relocation cutover): the agent source is cloned back before this gate
  // in CI. If the extension tree is absent/under-populated the gate must NOT
  // greenwash by finding "nothing to validate".
  assertExtensionsPresent(projectRoot, "ci-validate-agents");
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("agents/ directory not found — nothing to validate.");
      process.exit(0);
    }
    throw err;
  }

  let failCount = 0;
  let passCount = 0;
  let skippedNonAgents = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Validate AGENTS only. extensions/cinatra-ai/ holds all five kinds; the
    // non-agent kinds (connector/artifact/skill/workflow) have no
    // cinatra/oas.json by design, so validating them here flags 40+ false
    // "oas.json not found" failures. Read the extension's declared
    // cinatra.kind from package.json and skip anything that isn't an agent.
    let kind;
    try {
      const pkg = JSON.parse(await readFile(join(agentsDir, entry.name, "package.json"), "utf8"));
      kind = pkg?.cinatra?.kind;
    } catch {
      kind = undefined;
    }
    if (kind !== "agent") {
      skippedNonAgents++;
      continue;
    }
    // Prefer extensions/cinatra-ai/<slug>/cinatra/oas.json; fall
    // back to cinatra/agent.json (pre-200 transitional filename).
    const oasPath = join(agentsDir, entry.name, "cinatra", "oas.json");
    const legacyPath = join(agentsDir, entry.name, "cinatra", "agent.json");
    const agentJsonPath = existsSync(oasPath) ? oasPath : legacyPath;
    let raw;
    try {
      raw = await readFile(agentJsonPath, "utf8");
    } catch {
      console.error(`FAIL ${agentJsonPath}: oas.json (or agent.json fallback) not found or unreadable`);
      failCount++;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      console.error(`FAIL ${agentJsonPath}: invalid JSON — ${parseErr.message}`);
      failCount++;
      continue;
    }
    const errors = validateAgentJson(parsed, agentJsonPath);
    if (errors.length > 0) {
      console.error(`FAIL ${agentJsonPath}:`);
      for (const err of errors) {
        console.error(`  - ${err}`);
      }
      failCount++;
    } else {
      console.log(`PASS ${agentJsonPath}`);
      passCount++;
    }
  }

  console.log(`\nResults: ${passCount} passed, ${failCount} failed, ${skippedNonAgents} skipped (non-agent kinds)`);
  if (failCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
