// ---------------------------------------------------------------------------
// THE AUTODISCOVERY SKILL MATCHES THE CODE IT DESCRIBES (cinatra#2898).
// ---------------------------------------------------------------------------
// `skills/mcp-autodiscovery/SKILL.md` is handed to every connected MCP client
// as the server's own `initialize.instructions`. A sentence there that names a
// URL, a status or a field the code does not ship sends a client after
// something that is not there. This file pins the page's FACTS to the code that
// owns each one, read from the repository's own source files:
//
//   - the per-run event stream it names is a real SSE route file;
//   - every status of the `AgentRunStatus` union is named, and only the three
//     final ones are called terminal;
//   - every field its A2UI section names is declared by the `INTERRUPT` event
//     or by the run tools' input schemas;
//   - its `DATA_PART` rule says what the conformance corpus delivers: the part
//     arrives during the run, before `RUN_FINISHED`;
//   - a `pending_input` run is described as not yet executing, as the
//     pre-execution status set declares it.
//
// THE HONEST LIMIT: this is a lexical contract over prose. It pins the facts
// above against the files that own them; it does not read every sentence.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/mcp-server/src/__tests__ -> repository root
const REPO_ROOT = path.resolve(HERE, "../../../..");
const SKILL = path.join(HERE, "..", "..", "skills", "mcp-autodiscovery", "SKILL.md");

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const skill = (): string => readFileSync(SKILL, "utf8");

const RUN_STATUS = "packages/agents/src/run-status.ts";
const EVENTS = "packages/agent-ui-protocol/src/events.ts";
const RUN_TOOL_SCHEMAS = "packages/agents/src/mcp/schemas.ts";
const CONFORMANCE_FIXTURES = "packages/agent-ui-protocol/src/conformance-fixtures.ts";

/** The text of the `## <heading>` section, up to the next `## ` heading. */
function section(body: string, heading: string): string {
  const start = body.indexOf(`\n## ${heading}`);
  expect(start, `section '## ${heading}'`).toBeGreaterThanOrEqual(0);
  const next = body.indexOf("\n## ", start + 4);
  return next === -1 ? body.slice(start) : body.slice(start, next);
}

describe("the MCP autodiscovery skill matches the code it describes (cinatra#2898)", () => {
  it("names the per-run event stream at a real SSE route file, with no query string", () => {
    const lines = skill()
      .split("\n")
      .filter((l) => /event stream URL/i.test(l) && l.includes("`{CINATRA_BASE_URL}"));
    expect(lines).toHaveLength(1);
    const url = /`\{CINATRA_BASE_URL\}(\/[^`]*)`/.exec(lines[0])?.[1];
    expect(url, "the stream URL the skill names").toBeDefined();
    expect(url).not.toContain("?");
    const routeFile = path.join("src/app", url!.replace(/\{(\w+)\}/g, "[$1]"), "route.ts");
    expect(existsSync(path.join(REPO_ROOT, routeFile)), routeFile).toBe(true);
    const route = read(routeFile);
    expect(route).toMatch(/export async function GET\b/);
    expect(route).toContain("text/event-stream");
  });

  it("names every status the AgentRunStatus union declares, and calls only the final ones terminal", () => {
    const source = read(RUN_STATUS);
    const start = source.indexOf("export type AgentRunStatus =");
    expect(start).toBeGreaterThanOrEqual(0);
    // The union ends at its last member's `";` — its comments carry semicolons of their own.
    const rest = source.slice(start);
    const union = rest.slice(0, rest.search(/"\s*;/) + 1);
    const statuses = [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(statuses.length).toBeGreaterThanOrEqual(10);
    const body = skill();
    const missing = statuses.filter((s) => !new RegExp("`\"?" + s + "\"?`").test(body));
    expect(missing).toEqual([]);
    expect(body).not.toMatch(/terminal statuses are[^.]*pending_/i);
  });

  it("names in its A2UI section only fields an INTERRUPT event or the run tools declare", () => {
    const a2ui = section(skill(), "A2UI");
    const fields = [...new Set([...a2ui.matchAll(/`([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)`/g)].map((m) => m[1]))];
    expect(fields.length).toBeGreaterThan(0);
    const declared = read(EVENTS) + "\n" + read(RUN_TOOL_SCHEMAS);
    const undeclared = fields.filter((f) => !new RegExp(`\\b${f}\\??:\\s`).test(declared));
    expect(undeclared).toEqual([]);
  });

  it("says DATA_PART arrives during the run, before RUN_FINISHED, as the conformance corpus delivers it", () => {
    const fixtures = read(CONFORMANCE_FIXTURES);
    const turnStart = fixtures.indexOf("export const FIXTURE_FULL_TURN");
    expect(turnStart).toBeGreaterThanOrEqual(0);
    const turn = fixtures.slice(turnStart, fixtures.indexOf("\n];", turnStart));
    const part = turn.indexOf("renderableViewDataPart(");
    const finished = turn.indexOf('type: "RUN_FINISHED"');
    expect(part).toBeGreaterThan(0);
    expect(finished).toBeGreaterThan(part);
    expect(read(EVENTS)).toMatch(/\bpartIndex\?:\s/);
    const body = skill();
    expect(body).not.toMatch(/`?DATA_PART`?[^.]*until after[^.]*RUN_FINISHED/i);
    expect(body).toMatch(/`DATA_PART`[^.]*before `RUN_FINISHED`/);
  });

  it("describes a pending_input run as not yet executing, as the pre-execution status set declares it", () => {
    const source = read(RUN_STATUS);
    const set = source.slice(source.indexOf("export const PRE_EXECUTION_RUN_STATUSES"));
    expect(set.slice(0, set.indexOf("]);"))).toContain('"pending_input"');
    const body = skill();
    expect(body).not.toMatch(/mid-execution/i);
    expect(body).toMatch(/`pending_input`[^.]*before it began executing/);
  });
});
