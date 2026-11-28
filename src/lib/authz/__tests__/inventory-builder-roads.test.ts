/**
 * cinatra#4895: the authz inventory builder covers the passthrough road, not
 * only the MCP registrations. Run on fixture trees through `--root`: the route's
 * allow list is found by the requested tool name it guards and read with the
 * TypeScript parser (any quote form, templates, constants exported or not,
 * spread sets in other files, a `.mjs` module), and anything it cannot resolve
 * fails the builder.
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

/** A route whose allow list is `list` and whose admission guard is `guard`. */
const route = (list: string[], guard: string, head: string[] = []) =>
  [
    ...head,
    "const ALLOWED_TOOLS = new Set([",
    ...list,
    "]);",
    'const SUPPORTED_SHAPES = new Set(["plain"]);',
    "export function handle(body: { tool?: unknown; result_shape?: string }) {",
    '  const requestedTool = typeof body.tool === "string" ? body.tool : "";',
    '  const shape = body.result_shape ?? "plain";',
    "  if (!SUPPORTED_SHAPES.has(shape)) {",
    "    return { error: 'unsupported shape', status: 403 };",
    "  }",
    `  if (${guard}) {`,
    "    return { error: 'not admitted', status: 403 };",
    "  }",
    "  return { status: 200 };",
    "}",
    "",
  ].join("\n");

const FILES: Record<string, string> = {
  "src/lib/fixture-mcp.ts": [
    "export function register(server: { registerTool: (...a: unknown[]) => void }) {",
    `  ${SERVER_REGISTER}("fixture_mcp_tool", {}, async () => ({}));`,
    "}",
    "",
  ].join("\n"),
  "src/lib/fixture-scoped-tools.ts": [
    'import { FIXTURE_NESTED_TOOLS } from "./fixture-nested-tools";',
    'import { FIXTURE_JS_TOOLS } from "./fixture-js-tools.mjs";',
    "export const FIXTURE_READ_TOOL = 'fixture_scoped_read';",
    "export const FIXTURE_SCOPED_TOOLS = new Set<string>([",
    "  FIXTURE_READ_TOOL,",
    '  "fixture_scoped_write",',
    "  ...FIXTURE_NESTED_TOOLS,",
    "  ...FIXTURE_JS_TOOLS,",
    "]);",
    "",
  ].join("\n"),
  "src/lib/fixture-nested-tools.ts": [
    "export const FIXTURE_NESTED_TOOLS: ReadonlySet<string> = new Set([`fixture_nested_tool`]);",
    "",
  ].join("\n"),
  "src/lib/fixture-js-tools.mjs": ["export const FIXTURE_JS_TOOLS = new Set(['fixture_js_tool']);", ""].join("\n"),
  [ROUTE]: route(
    [
      '  "fixture_mcp_tool",',
      "  // a comment naming `not_a_tool` is not an entry",
      "  'fixture_single_quoted', `fixture_template`,",
      "  LOCAL_TOOL,",
      "  /* between entries */ ...FIXTURE_SCOPED_TOOLS,",
    ],
    "!(ALLOWED_TOOLS.has(requestedTool))",
    ['import { FIXTURE_SCOPED_TOOLS } from "@/lib/fixture-scoped-tools";', 'const LOCAL_TOOL = "fixture_local_const";'],
  ),
};

const OK_LIST = ['  "fixture_ok"'];
const TREES: Record<string, Record<string, string>> = {
  equalsFalse: { [ROUTE]: route(OK_LIST, "ALLOWED_TOOLS.has(requestedTool) === false") },
  callEntry: {
    [ROUTE]: route(['  "fixture_ok",', "  buildName(),"], "!ALLOWED_TOOLS.has(requestedTool)", [
      "function buildName() { return 'fixture_built'; }",
    ]),
  },
  builtSpread: {
    [ROUTE]: route(['  "fixture_ok",', "  ...makeSet(),"], "!ALLOWED_TOOLS.has(requestedTool)", [
      "function makeSet() { return new Set(['fixture_built']); }",
    ]),
  },
  letConst: {
    [ROUTE]: route(['  "fixture_ok",', "  LATER,"], "!ALLOWED_TOOLS.has(requestedTool)", ['let LATER = "fixture_let";']),
  },
  noGuard: { [ROUTE]: route(OK_LIST, "!SUPPORTED_SHAPES.has(requestedTool.slice(1))") },
  otherForm: { [ROUTE]: route(OK_LIST, "ALLOWED_TOOLS.has(requestedTool) !== true") },
};

type Row = { primitiveName: string; file: string; line: number; road?: string };

function writeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "authz-inventory-roads-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  mkdirSync(join(dir, "src/lib/authz/__generated__"), { recursive: true });
  return dir;
}

/** Runs the builder on `dir`; its stderr when it fails, "" when it succeeds. */
function builderFailure(dir: string): string {
  try {
    execFileSync(process.execPath, [BUILDER, "--root", dir], { stdio: "pipe", cwd: dir });
    return "";
  } catch (err) {
    return String((err as { stderr?: Buffer }).stderr ?? "");
  }
}

function rowsAt(dir: string): Row[] {
  const out = join(dir, "src/lib/authz/__generated__/inventory.json");
  return existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")).primitives as Row[]) : [];
}

let root = "";
let rows: Row[] = [];
let buildFailure = "";
const trees: Record<string, string> = {};

beforeAll(() => {
  root = writeTree(FILES);
  buildFailure = builderFailure(root);
  rows = rowsAt(root);
  for (const [k, files] of Object.entries(TREES)) trees[k] = writeTree(files);
});

afterAll(() => {
  for (const dir of [root, ...Object.values(trees)]) if (dir) rmSync(dir, { recursive: true, force: true });
});

const rowsOf = (n: string) => rows.filter((r) => r.primitiveName === n).map(({ file, road }) => ({ file, road }));

describe("authz inventory builder roads (cinatra#4895)", () => {
  it("writes the inventory of the --root tree", () => {
    expect(buildFailure).toBe("");
    expect(existsSync(join(root, "src/lib/authz/__generated__/inventory.json"))).toBe(true);
  });

  it("lists every allow-list entry form the route admits, with its road and file", () => {
    const atRoute = { file: ROUTE, road: "passthrough" };
    expect(rowsOf("fixture_single_quoted")).toEqual([atRoute]);
    expect(rowsOf("fixture_template")).toEqual([atRoute]);
    expect(rowsOf("fixture_local_const")).toEqual([atRoute]);
    const scoped = { file: "src/lib/fixture-scoped-tools.ts", road: "passthrough" };
    expect(rowsOf("fixture_scoped_read")).toEqual([scoped]);
    expect(rowsOf("fixture_scoped_write")).toEqual([scoped]);
    expect(rowsOf("fixture_nested_tool")).toEqual([{ file: "src/lib/fixture-nested-tools.ts", road: "passthrough" }]);
    expect(rowsOf("fixture_js_tool")).toEqual([{ file: "src/lib/fixture-js-tools.mjs", road: "passthrough" }]);
    expect(rowsOf("not_a_tool")).toEqual([]);
  });

  it("keeps an MCP tool the route also admits on its mcp row only", () => {
    expect(rowsOf("fixture_mcp_tool")).toEqual([{ file: "src/lib/fixture-mcp.ts", road: "mcp" }]);
  });

  it("finds the allow list by the tool name it guards, beside an unrelated .has guard", () => {
    expect(rowsOf("plain")).toEqual([]);
    expect(builderFailure(trees.equalsFalse)).toBe("");
    expect(rowsAt(trees.equalsFalse).map((r) => r.primitiveName)).toEqual(["fixture_ok"]);
  });

  it("fails the builder on an allow-list entry it cannot resolve, naming it", () => {
    const failure = builderFailure(trees.callEntry);
    expect(failure).toContain("buildName()");
    expect(failure).toContain(ROUTE);
    expect(builderFailure(trees.builtSpread)).toContain("makeSet()");
    expect(builderFailure(trees.letConst)).toContain("LATER is not declared with const");
  });

  it("fails closed when the admission guard is not found", () => {
    expect(builderFailure(trees.noGuard)).toContain("the allow-list guard was not found");
    expect(builderFailure(trees.otherForm)).toContain("the allow-list guard was not found");
  });

  it("--check passes on the tree it just wrote", () => {
    expect(() => execFileSync(process.execPath, [BUILDER, "--root", root, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
