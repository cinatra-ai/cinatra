#!/usr/bin/env node
// CI gate: cinatra is the open source AI workspace.
// A handful of identity surfaces (chat self-description, MCP server description,
// Next.js metadata, top-level placeholders) must NOT narrowly frame the whole
// platform as a GTM/sales/marketing tool. Individual GTM agents and artifact
// matchers are fine — this gate is scoped to the identity files below.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);

// Files where platform-level identity copy lives. If you add a new
// identity surface, list it here.
const IDENTITY_FILES = [
  "extensions/cinatra-ai/assistant-skills/skills/chat-assistant-core/SKILL.md",
  "src/app/api/chat/runner.ts",
  "packages/llm/src/mcp-access.ts",
  "packages/llm/src/tools/skills.ts",
  "packages/mcp-server/src/delegated-chat-tool-policy.ts",
  "packages/chat/src/chat-page.tsx",
  "src/app/layout.tsx",
  "src/app/configuration/mcp/llm-access/test/route.ts",
];

// Phrases that narrow the whole platform's identity to GTM.
// Each phrase has a one-line reason shown when it's found.
const BANNED_PHRASES = [
  { phrase: "go-to-market motions", reason: "Platform identity must not frame the whole chat as a GTM-only tool." },
  { phrase: "GTM tools", reason: "MCP server description must not call the platform's tool surface 'GTM tools'." },
  { phrase: "campaigns, contacts, or content", reason: "Placeholder must not single out three GTM-flavored object types as the chat's scope." },
  { phrase: "go-to-market strategy, execution, campaigns", reason: "Next.js metadata must not frame the whole product as a GTM tool." },
  { phrase: "innovative style to go-to-market", reason: "The GTM-flavored fake-Sinatra quote was removed; do not reintroduce." },
];

const findings = [];

for (const rel of IDENTITY_FILES) {
  const abs = resolve(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    findings.push({ file: rel, phrase: "<file missing>", reason: "Identity file listed in gate is missing — update IDENTITY_FILES or restore the file." });
    continue;
  }
  const text = readFileSync(abs, "utf8");
  for (const { phrase, reason } of BANNED_PHRASES) {
    if (text.includes(phrase)) {
      const lineIdx = text.split("\n").findIndex((line) => line.includes(phrase));
      findings.push({ file: rel, line: lineIdx >= 0 ? lineIdx + 1 : "?", phrase, reason });
    }
  }
}

if (findings.length === 0) {
  console.log("[identity-copy-gate] OK — no banned identity-narrowing phrases in identity surfaces.");
  process.exit(0);
}

console.error("[identity-copy-gate] FAIL — banned GTM-narrowing phrases detected in platform identity surfaces:");
for (const f of findings) {
  console.error(`  - ${f.file}:${f.line}  "${f.phrase}"`);
  console.error(`      ${f.reason}`);
}
console.error("");
console.error("These files describe the WHOLE platform's identity (chat self-description, MCP server description,");
console.error("Next.js metadata, top-level placeholder). Individual GTM agents/artifacts are fine — the bug is");
console.error("narrowing the entire platform to GTM. Rewrite to reflect that cinatra is the open source");
console.error("AI workspace where GTM is one of many use cases.");
process.exit(1);
