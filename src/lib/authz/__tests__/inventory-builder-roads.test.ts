/**
 * cinatra#4895: the authz inventory builder covers every registration road,
 * not only a literal `server.registerTool(name`. Run on a fixture tree through
 * `--root`: a tool the passthrough route admits (directly, through a spread set
 * and through a constant), and a tool a pack registers through
 * `ctx.mcp.registerTool({ name`, are listed with their road.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const BUILDER = resolve(REPO_ROOT, "scripts/build-authz-inventory.mjs");

const FILES: Record<string, string> = {
  "src/lib/fixture-mcp.ts": [
    "export function register(server: { registerTool: (...a: unknown[]) => void }) {",
    '  server.registerTool("fixture_mcp_tool", {}, async () => ({}));',
    "}",
    "",
  ].join("\n"),
  "src/lib/fixture-scoped-tools.ts": [
    'export const FIXTURE_READ_TOOL = "fixture_scoped_read";',
    "export const FIXTURE_SCOPED_TOOLS = new Set<string>([",
    "  FIXTURE_READ_TOOL,",
    '  "fixture_scoped_write",',
    "]);",
    "",
  ].join("\n"),
  "src/app/api/agents/passthrough/route.ts": [
    'import { FIXTURE_SCOPED_TOOLS } from "@/lib/fixture-scoped-tools";',
    "const ALLOWED_TOOLS = new Set([",
    '  "fixture_mcp_tool",',
    "  // a comment line naming `not_a_tool` is not an entry",
    '  "fixture_route_tool",',
    "  ...FIXTURE_SCOPED_TOOLS,",
    "]);",
    "export { ALLOWED_TOOLS };",
    "",
  ].join("\n"),
  "extensions/example-org/demo-connector/src/register.ts": [
    "export function register(ctx: { mcp: { registerTool: (t: unknown) => void } }) {",
    "  ctx.mcp.registerTool({",
    '    name: "demo_connector_ping",',
    "    handler: async () => ({}),",
    "  });",
    "}",
    "",
  ].join("\n"),
};

type Row = { primitiveName: string; file: string; line: number; road?: string };

let root = "";
let rows: Row[] = [];
let outPath = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "authz-inventory-roads-"));
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, "src/lib/authz/__generated__"), { recursive: true });
  outPath = join(root, "src/lib/authz/__generated__/inventory.json");
  execFileSync(process.execPath, [BUILDER, "--root", root], { stdio: "pipe", cwd: root });
  rows = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")).primitives as Row[]) : [];
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("authz inventory builder roads (cinatra#4895)", () => {
  it("writes the inventory of the --root tree", () => {
    expect(existsSync(outPath)).toBe(true);
  });

  it("lists a tool the passthrough route admits, with its road and file", () => {
    const byName = (n: string) => rows.filter((r) => r.primitiveName === n).map(({ file, road }) => ({ file, road }));
    expect(byName("fixture_route_tool")).toEqual([
      { file: "src/app/api/agents/passthrough/route.ts", road: "passthrough" },
    ]);
    expect(byName("fixture_scoped_read")).toEqual([{ file: "src/lib/fixture-scoped-tools.ts", road: "passthrough" }]);
    expect(byName("fixture_scoped_write")).toEqual([{ file: "src/lib/fixture-scoped-tools.ts", road: "passthrough" }]);
    expect(byName("not_a_tool")).toEqual([]);
  });

  it("keeps an MCP tool the route also admits on its mcp row only", () => {
    expect(rows.filter((r) => r.primitiveName === "fixture_mcp_tool").map(({ file, road }) => ({ file, road }))).toEqual([
      { file: "src/lib/fixture-mcp.ts", road: "mcp" },
    ]);
  });

  it("lists a tool a pack registers through ctx.mcp.registerTool", () => {
    expect(rows.filter((r) => r.primitiveName === "demo_connector_ping").map(({ file, road }) => ({ file, road }))).toEqual([
      { file: "extensions/example-org/demo-connector/src/register.ts", road: "mcp" },
    ]);
  });

  it("--check passes on the tree it just wrote", () => {
    expect(() => execFileSync(process.execPath, [BUILDER, "--root", root, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
