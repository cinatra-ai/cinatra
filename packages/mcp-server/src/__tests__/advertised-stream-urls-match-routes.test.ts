// ---------------------------------------------------------------------------
// THE ADVERTISED RUN STREAM AND SURFACE KEY MATCH THE CODE (cinatra#4141).
// ---------------------------------------------------------------------------
// Every connected MCP client reads two machine-facing descriptions of the run
// protocols besides the autodiscovery skill: the discovery resources of
// `packages/agents/src/mcp/discovery.ts` (`cinatra://protocols/ag-ui`,
// `cinatra://protocols/a2ui`, `cinatra://protocols/a2a` and each agent's
// manifest) and the `initialize` experimental capability of
// `src/lib/mcp-instructions.ts`. A URL there that no route serves, or a field
// name no event carries, sends a client after something that is not there.
// This file pins those facts to the code that owns each one, read from the
// repository's own source files:
//
//   - every advertised run event stream URL is a real SSE route file (a GET
//     that answers `text/event-stream`), with no query string, and the ag-ui
//     resource, every manifest and the capability name the same one;
//   - the a2ui resource and the capability name the `INTERRUPT` event's
//     `xRenderer` as the surface key, never the compiler's authoring fields;
//   - the a2a resource names the streaming methods the A2A route serves;
//   - the autodiscovery skill (`skills/mcp-autodiscovery/SKILL.md`) names the
//     same stream URL, surface key and JSON-RPC methods as these resources.
//
// THE HONEST LIMIT: this is a lexical contract over source text. It pins the
// facts above against the files that own them; it does not evaluate modules.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/mcp-server/src/__tests__ -> repository root
const REPO_ROOT = path.resolve(HERE, "../../../..");

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const DISCOVERY = "packages/agents/src/mcp/discovery.ts";
const CAPABILITY = "src/lib/mcp-instructions.ts";
const EVENTS = "packages/agent-ui-protocol/src/events.ts";
const A2A_ROUTE = "src/app/api/a2a/route.ts";
const SKILL = "packages/mcp-server/skills/mcp-autodiscovery/SKILL.md";

/** The body of the template literal `const <name> = \`...` up to its closing line. */
function guide(name: string): string {
  const source = read(DISCOVERY);
  const start = source.indexOf(`const ${name} = \``);
  expect(start, `const ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n`;", start);
  expect(end, `the end of ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The text of the `## <heading>` section of a guide, up to the next `## ` heading. */
function section(body: string, heading: string): string {
  const start = body.indexOf(`\n## ${heading}`);
  expect(start, `section '## ${heading}'`).toBeGreaterThanOrEqual(0);
  const next = body.indexOf("\n## ", start + 4);
  return next === -1 ? body.slice(start) : body.slice(start, next);
}

/** The `<name>: { ... }` object of the capability, one member per line, up to its closing brace on a line of its own. */
function capabilityBlock(name: string): string {
  const block = new RegExp(`\\b${name}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(read(CAPABILITY))?.[1];
  expect(block, `the capability's ${name} block`).toBeDefined();
  return block!;
}

/** The stream path must be a real SSE route file: it exists, exports GET and answers text/event-stream. */
function expectSseRoute(url: string | undefined, what: string): void {
  expect(url, what).toBeDefined();
  expect(url, what).not.toContain("?");
  const routeFile = path.join("src/app", url!.replace(/\{(\w+)\}/g, "[$1]"), "route.ts");
  expect(existsSync(path.join(REPO_ROOT, routeFile)), `${what}: ${routeFile}`).toBe(true);
  const route = read(routeFile);
  expect(route, `${what}: ${routeFile} exports GET`).toMatch(/export async function GET\b/);
  expect(route, `${what}: ${routeFile} answers SSE`).toContain("text/event-stream");
}

/** The one stream URL the ag-ui resource's 'Event stream URL' section names. */
function agUiResourceUrl(): string | undefined {
  const urls = [
    ...section(guide("AG_UI_GUIDE"), "Event stream URL").matchAll(/\{CINATRA_BASE_URL\}(\/[^`\\\s]*)/g),
  ].map((m) => m[1]);
  expect(urls).toHaveLength(1);
  return urls[0];
}

describe("the advertised run stream and surface key match the code (cinatra#4141)", () => {
  it("the ag-ui resource names the per-run event stream at a real SSE route file, with no query string", () => {
    expectSseRoute(agUiResourceUrl(), "the ag-ui resource's event stream URL");
  });

  it("every manifest's eventStreamUrl names that same SSE route, and nothing advertises a taskId", () => {
    const source = read(DISCOVERY);
    const urls = [...source.matchAll(/eventStreamUrl:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(urls).toHaveLength(1);
    expectSseRoute(urls[0], "the manifest's eventStreamUrl");
    expect(urls[0]).toBe(agUiResourceUrl());
    expect(source).not.toMatch(/taskId/);
    expect(read(CAPABILITY)).not.toMatch(/taskId/);
  });

  it("the initialize capability's agUi.endpoint names that same SSE route", () => {
    const endpoint = /\bendpoint:\s*"([^"]+)"/.exec(capabilityBlock("agUi"))?.[1];
    expectSseRoute(endpoint, "the capability's agUi.endpoint");
    expect(endpoint).toBe(agUiResourceUrl());
  });

  it("the a2ui resource and the capability name the INTERRUPT event's xRenderer as the surface key", () => {
    const events = read(EVENTS);
    expect(events).toMatch(/export type InterruptEvent\b/);
    const a2ui = capabilityBlock("a2ui");
    expect(/surfaceEvent:\s*"(\w+)"/.exec(a2ui)?.[1]).toBe("INTERRUPT");
    const key = /surfaceKeyField:\s*"(\w+)"/.exec(a2ui)?.[1];
    expect(key, "the capability's a2ui.surfaceKeyField").toBe("xRenderer");
    expect(events).toMatch(new RegExp(`\\b${key}\\??:\\s*string`));
    expect(read(CAPABILITY)).not.toMatch(/a2uiSurfaceId|surfaceIdField|surfaceOverrideField/);
    const source = read(DISCOVERY);
    const start = source.indexOf("export function formatA2uiSurfaceRef(");
    expect(start).toBeGreaterThanOrEqual(0);
    const resource = source.slice(start, source.indexOf("\n}\n", start));
    expect(resource).toContain("INTERRUPT");
    expect(resource).toContain("xRenderer");
    expect(source).not.toMatch(/a2uiSurfaceId/);
  });

  it("the a2a resource names the streaming methods the A2A route serves", () => {
    const methods = section(guide("A2A_GUIDE"), "Supported JSON-RPC methods");
    const route = read(A2A_ROUTE);
    for (const method of ["message/stream", "tasks/resubscribe"]) {
      expect(route, `${A2A_ROUTE} names ${method}`).toContain(method);
      expect(methods, `the a2a resource names ${method}`).toContain(`\\\`${method}\\\``);
    }
    expect(methods).not.toMatch(/sendStreaming/);
  });

  it("the autodiscovery skill names the same stream URL, surface key and streaming methods as these resources", () => {
    const skill = read(SKILL);
    const lines = skill
      .split("\n")
      .filter((l) => /event stream URL/i.test(l) && l.includes("`{CINATRA_BASE_URL}"));
    expect(lines).toHaveLength(1);
    expect(/`\{CINATRA_BASE_URL\}(\/[^`]*)`/.exec(lines[0])?.[1]).toBe(agUiResourceUrl());
    const key = /surfaceKeyField:\s*"(\w+)"/.exec(capabilityBlock("a2ui"))?.[1];
    expect(key, "the capability's a2ui.surfaceKeyField").toBeDefined();
    expect(skill).toContain(`\`${key}\``);
    const methods = [
      ...section(guide("A2A_GUIDE"), "Supported JSON-RPC methods").matchAll(/^- \\`([a-z]+\/[A-Za-z]+)\\`/gm),
    ].map((m) => m[1]);
    expect(methods.length).toBeGreaterThanOrEqual(4);
    expect(methods.filter((m) => !skill.includes(`\`${m}\``))).toEqual([]);
  });
});
