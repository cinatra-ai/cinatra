/**
 * cinatra#4895: the authz inventory builder covers the passthrough road, not
 * only the MCP registrations. Run on fixture trees through `--root`: the route's
 * allow list is read with the TypeScript parser (any quote form, templates,
 * constants exported or not, spread sets in other files), an entry it cannot
 * resolve fails the builder, and a pack's `register(ctx)` tool is left to the
 * run time.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const BUILDER = resolve(REPO_ROOT, "scripts/build-authz-inventory.mjs");
const ROUTE = "src/app/api/agents/passthrough/route.ts";
// Built from parts so the builder scanning this repository does not read the
// fixture's registration as a tool of its own.
const SERVER_REGISTER = ["server", "registerTool"].join(".");

const FILES: Record<string, string> = {
  "src/lib/fixture-mcp.ts": [
    "export function register(server: { registerTool: (...a: unknown[]) => void }) {",
    `  ${SERVER_REGISTER}("fixture_mcp_tool", {}, async () => ({}));`,
    "}",
    "",
  ].join("\n"),
  "src/lib/fixture-scoped-tools.ts": [
    'import { FIXTURE_NESTED_TOOLS } from "./fixture-nested-tools";',
    "export const FIXTURE_READ_TOOL = 'fixture_scoped_read';",
    "export const FIXTURE_SCOPED_TOOLS = new Set<string>([",
    "  FIXTURE_READ_TOOL,",
    '  "fixture_scoped_write",',
    "  ...FIXTURE_NESTED_TOOLS,",
    "]);",
    "",
  ].join("\n"),
  "src/lib/fixture-nested-tools.ts": [
    "export const FIXTURE_NESTED_TOOLS: ReadonlySet<string> = new Set([`fixture_nested_tool`]);",
    "",
  ].join("\n"),
  [ROUTE]: [
    'import { FIXTURE_SCOPED_TOOLS } from "@/lib/fixture-scoped-tools";',
    'const LOCAL_TOOL = "fixture_local_const";',
    "const ALLOWED_TOOLS = new Set([",
    '  "fixture_mcp_tool",',
    "  // a comment naming `not_a_tool` is not an entry",
    "  'fixture_single_quoted', `fixture_template`,",
    "  LOCAL_TOOL,",
    "  ...FIXTURE_SCOPED_TOOLS,",
    "]);",
    "export function handle(tool: string) {",
    "  if (!ALLOWED_TOOLS.has(tool)) return 403;",
    "  return 200;",
    "}",
    "",
  ].join("\n"),
  "extensions/example-org/demo-connector/src/register.ts": [
    "export function register(ctx: { mcp: { registerTool: (t: unknown) => void } }) {",
    "  ctx.mcp.registerTool({",
    '    description: "a pack tool",',
    '    name: "demo_connector_ping",',
    "  });",
    "}",
    "",
  ].join("\n"),
};

const BAD_ROUTE = [
  "function buildName() { return 'fixture_built'; }",
  "const ALLOWED_TOOLS = new Set([",
  '  "fixture_ok",',
  "  buildName(),",
  "]);",
  "export function handle(tool: string) {",
  "  if (!ALLOWED_TOOLS.has(tool)) return 403;",
  "  return 200;",
  "}",
  "",
].join("\n");

type Row = { primitiveName: string; file: string; line: number; road?: string };

function writeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "authz-inventory-roads-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(join(root, "src/lib/authz/__generated__"), { recursive: true });
  return root;
}

let root = "";
let badRoot = "";
let rows: Row[] = [];
let outPath = "";

beforeAll(() => {
  root = writeTree(FILES);
  badRoot = writeTree({ [ROUTE]: BAD_ROUTE });
  outPath = join(root, "src/lib/authz/__generated__/inventory.json");
  execFileSync(process.execPath, [BUILDER, "--root", root], { stdio: "pipe", cwd: root });
  rows = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")).primitives as Row[]) : [];
});

afterAll(() => {
  for (const dir of [root, badRoot]) if (dir) rmSync(dir, { recursive: true, force: true });
});

const rowsOf = (n: string) => rows.filter((r) => r.primitiveName === n).map(({ file, road }) => ({ file, road }));

describe("authz inventory builder roads (cinatra#4895)", () => {
  it("writes the inventory of the --root tree", () => {
    expect(existsSync(outPath)).toBe(true);
  });

  it("lists every allow-list entry form the route admits, with its road and file", () => {
    const route = { file: ROUTE, road: "passthrough" };
    expect(rowsOf("fixture_single_quoted")).toEqual([route]);
    expect(rowsOf("fixture_template")).toEqual([route]);
    expect(rowsOf("fixture_local_const")).toEqual([route]);
    const scoped = { file: "src/lib/fixture-scoped-tools.ts", road: "passthrough" };
    expect(rowsOf("fixture_scoped_read")).toEqual([scoped]);
    expect(rowsOf("fixture_scoped_write")).toEqual([scoped]);
    expect(rowsOf("fixture_nested_tool")).toEqual([{ file: "src/lib/fixture-nested-tools.ts", road: "passthrough" }]);
    expect(rowsOf("not_a_tool")).toEqual([]);
  });

  it("keeps an MCP tool the route also admits on its mcp row only", () => {
    expect(rowsOf("fixture_mcp_tool")).toEqual([{ file: "src/lib/fixture-mcp.ts", road: "mcp" }]);
  });

  it("leaves a pack's register(ctx) tool to the run time", () => {
    expect(rowsOf("demo_connector_ping")).toEqual([]);
  });

  it("fails the builder on an allow-list entry it cannot resolve, naming it", () => {
    let failure = "";
    try {
      execFileSync(process.execPath, [BUILDER, "--root", badRoot], { stdio: "pipe", cwd: badRoot });
    } catch (err) {
      failure = String((err as { stderr?: Buffer }).stderr ?? "");
    }
    expect(failure).toContain("buildName()");
    expect(failure).toContain(ROUTE);
  });

  it("--check passes on the tree it just wrote", () => {
    expect(() => execFileSync(process.execPath, [BUILDER, "--root", root, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
