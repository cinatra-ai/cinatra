import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * AI surface regression.
 *
 * drizzle-cube ships a built-in AI surface (AgenticNotebook,
 * ExplainAIPanel, useExplainAI, useAgentChat, default aiEndpoint
 * /api/ai/generate). Cinatra owns LLM via @cinatra-ai/llm;
 * DC's AI path must stay OFF and unreachable from /agents.
 *
 * Setting features.enableAI=false suppresses the AnalysisBuilder AI
 * buttons + short-circuits useExplainAI, but does NOT prevent rendering
 * a standalone AgenticNotebook from our own code. This test is the
 * static regression gate: walks ONLY Cinatra source under
 * packages/dashboards/src/{screens,components} and asserts NO file
 * imports an AI surface or references AI HTTP routes.
 *
 * Scope deliberately EXCLUDES node_modules — drizzle-cube's bundle
 * internally references these names; flagging them would be a false
 * positive. We only flag Cinatra source.
 *
 * Comment stripping (line + block) defends against false-positives on
 * JSDoc that LISTS the names as part of negative documentation.
 */

const DASHBOARDS_SRC = join(__dirname, "..");
const SCOPED_SUBDIRS = ["screens", "components"] as const;

const FORBIDDEN_IMPORTS = [
  "AgenticNotebook",
  "ExplainAIPanel",
  "useExplainAI",
  "useAgentChat",
] as const;

const FORBIDDEN_STRINGS = [
  "/agent/chat",
  "/api/ai/",
  "aiEndpoint",
] as const;

const ENABLE_AI_TRUE_PATTERN = /enableAI\s*:\s*true/;

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "__fixtures__") continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

type Violation = {
  file: string;
  line: number;
  match: string;
};

function stripComments(src: string): string {
  // Strip /* ... */ blocks first (JSDoc + license headers), then //-line
  // comments. Conservative — does not handle strings containing "//"
  // exactly, but our code style does not produce such strings.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const subdir of SCOPED_SUBDIRS) {
    const root = join(DASHBOARDS_SRC, subdir);
    let files: string[];
    try {
      files = walkFiles(root);
    } catch {
      continue;
    }
    for (const file of files) {
      const raw = readFileSync(file, "utf-8");
      const stripped = stripComments(raw);
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const name of FORBIDDEN_IMPORTS) {
          const importStatement = new RegExp(
            `^(?:\\s*)import\\s+(?:type\\s+)?(?:\\*\\s+as\\s+${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\}|${name}\\b)`,
          );
          const jsxRef = new RegExp(`<\\s*${name}\\b`);
          const hookCall = new RegExp(`(?:^|[^a-zA-Z0-9_$])${name}\\s*\\(`);
          if (importStatement.test(line)) {
            violations.push({ file, line: i + 1, match: `import ${name}` });
          } else if (jsxRef.test(line)) {
            violations.push({ file, line: i + 1, match: `<${name}>` });
          } else if (hookCall.test(line)) {
            violations.push({ file, line: i + 1, match: `${name}()` });
          }
        }
        for (const needle of FORBIDDEN_STRINGS) {
          if (line.includes(needle)) {
            violations.push({ file, line: i + 1, match: needle });
          }
        }
        if (ENABLE_AI_TRUE_PATTERN.test(line)) {
          violations.push({ file, line: i + 1, match: "enableAI: true" });
        }
      }
    }
  }
  return violations;
}

describe("AI surface regression in /agents", () => {
  it("does not import AgenticNotebook / ExplainAIPanel / useExplainAI / useAgentChat", () => {
    const v = findViolations();
    const importViolations = v.filter((x) => x.match.startsWith("import "));
    expect(
      importViolations,
      `Found ${importViolations.length} forbidden AI imports:\n` +
        importViolations.map((x) => `  ${x.file}:${x.line} — ${x.match}`).join("\n"),
    ).toEqual([]);
  });

  it("does not call useExplainAI / useAgentChat or render <AgenticNotebook> / <ExplainAIPanel>", () => {
    const v = findViolations();
    const callOrJsx = v.filter(
      (x) =>
        x.match.endsWith("()") ||
        x.match.startsWith("<"),
    );
    expect(
      callOrJsx,
      `Found ${callOrJsx.length} forbidden AI call/JSX sites:\n` +
        callOrJsx.map((x) => `  ${x.file}:${x.line} — ${x.match}`).join("\n"),
    ).toEqual([]);
  });

  it("does not reference /agent/chat, /api/ai/, aiEndpoint, or literal enableAI: true", () => {
    const v = findViolations();
    const stringViolations = v.filter(
      (x) =>
        !x.match.startsWith("import ") &&
        !x.match.endsWith("()") &&
        !x.match.startsWith("<"),
    );
    expect(
      stringViolations,
      `Found ${stringViolations.length} forbidden AI references:\n` +
        stringViolations.map((x) => `  ${x.file}:${x.line} — ${x.match}`).join("\n"),
    ).toEqual([]);
  });

  it("DashboardsClientShell sets enableAI: false (positive evidence the gate is wired)", () => {
    const shell = readFileSync(
      join(DASHBOARDS_SRC, "components", "dashboards-client-shell.tsx"),
      "utf-8",
    );
    expect(shell).toMatch(/enableAI:\s*false/);
    expect(shell).toMatch(/enableBatching=\{false\}/);
  });
});
