/**
 * cinatra#4895: the authz inventory builder records the passthrough road's
 * allow list, not only the MCP registrations. Run on fixture trees through
 * `--root`: the list is found by its declaration (ALLOWED_TOOLS), read with the
 * TypeScript parser (any quote form, templates, constants exported or not,
 * spread sets in other files, a `.mjs` module, an imported list), and anything
 * it cannot read or prove constant fails the builder.
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

/** A route module: `head` lines, the allow list declared as `decl` with `list`, then `tail` lines. */
const route = (list: string[], head: string[] = [], tail: string[] = [], decl = "const ALLOWED_TOOLS = new Set([") =>
  [
    ...head,
    decl,
    ...list,
    "]);",
    'const SUPPORTED_SHAPES = new Set(["plain"]);',
    "export async function POST(body: { tool: string; shape: string }) {",
    "  if (!SUPPORTED_SHAPES.has(body.shape)) return { status: 400 };",
    "  if (!ALLOWED_TOOLS.has(body.tool)) return { status: 403 };",
    "  return { status: 200 };",
    "}",
    ...tail,
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
  "extensions/@example-org/fixture-pack/src/names.ts": ["export const FIXTURE_PACK_NAME = 'fixture_pack_const';", ""].join("\n"),
  [ROUTE]: route(
    [
      '  "fixture_mcp_tool",',
      "  // a comment naming `not_a_tool` is not an entry",
      "  'fixture_single_quoted', `fixture_template`,",
      "  LOCAL_TOOL,",
      "  FIXTURE_PACK_NAME,",
      "  /* between entries */ ...FIXTURE_SCOPED_TOOLS,",
    ],
    [
      'import { FIXTURE_SCOPED_TOOLS } from "@/lib/fixture-scoped-tools";',
      'import { FIXTURE_PACK_NAME } from "../../../../../extensions/@example-org/fixture-pack/src/names";',
      'const LOCAL_TOOL = "fixture_local_const";',
    ],
  ),
};

const OK_LIST = ['  "fixture_ok"'];
const TREES: Record<string, Record<string, string>> = {
  typed: { [ROUTE]: route(['  "fixture_ok",', "] as const"], [], [], "const ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([").replace("] as const\n]);", "] as const);") },
  imported: {
    "src/lib/fixture-allow-list.ts": ["export const ALLOWED_TOOLS = new Set(['fixture_moved']);", ""].join("\n"),
    [ROUTE]: route(OK_LIST, ['import { ALLOWED_TOOLS } from "@/lib/fixture-allow-list";'], [], "const OTHER_LIST = new Set(["),
  },
  missing: { [ROUTE]: route(OK_LIST, [], [], "const ALLOWED_NAMES = new Set([") },
  twoScopes: {
    [ROUTE]: route(OK_LIST, [], ["function shadow() { const ALLOWED_TOOLS = new Set(['x']); return ALLOWED_TOOLS.size; }"]),
  },
  callEntry: { [ROUTE]: route(['  "fixture_ok",', "  buildName(),"], ["function buildName() { return 'fixture_built'; }"]) },
  builtSpread: {
    [ROUTE]: route(['  "fixture_ok",', "  ...makeSet(),"], ["function makeSet() { return new Set(['fixture_built']); }"]),
  },
  letConst: { [ROUTE]: route(['  "fixture_ok",', "  LATER,"], ['let LATER = "fixture_let";']) },
  frozen: { [ROUTE]: route(OK_LIST, [], [], "const ALLOWED_TOOLS = Object.freeze(new Set([").replace("]);\nconst SUPPORTED", "]));\nconst SUPPORTED") },
  fromArray: {
    [ROUTE]: route([], ['const NAMES = ["fixture_ok"] as const;'], [], "const ALLOWED_TOOLS = new Set(NAMES").replace(
      "new Set(NAMES\n]);",
      "new Set(NAMES);",
    ),
  },
  addCall: { [ROUTE]: route(OK_LIST, [], ['ALLOWED_TOOLS.add("fixture_late");']) },
  passedToFn: { [ROUTE]: route(OK_LIST, ["function extend(s: Set<string>) { return s; }"], ["extend(ALLOWED_TOOLS);"]) },
  spreadMutated: {
    "src/lib/fixture-spread.ts": [
      "export const SPREAD_TOOLS = new Set(['fixture_spread']);",
      "SPREAD_TOOLS.delete('fixture_spread');",
      "",
    ].join("\n"),
    [ROUTE]: route(['  "fixture_ok",', "  ...SPREAD_TOOLS,"], ['import { SPREAD_TOOLS } from "@/lib/fixture-spread";']),
  },
  reads: {
    [ROUTE]: route(OK_LIST, [], [
      "export const SIZE = ALLOWED_TOOLS.size;",
      "export const COPY = [...ALLOWED_TOOLS];",
      "export const LISTED = Array.from(ALLOWED_TOOLS);",
      "for (const n of ALLOWED_TOOLS) void n;",
      "ALLOWED_TOOLS.forEach((n) => void n);",
    ]),
  },
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
const namesAt = (dir: string) => rowsAt(dir).map((r) => r.primitiveName);

describe("authz inventory builder roads (cinatra#4895)", () => {
  it("writes the inventory of the --root tree", () => {
    expect(buildFailure).toBe("");
    expect(existsSync(join(root, "src/lib/authz/__generated__/inventory.json"))).toBe(true);
  });

  it("lists every allow-list entry form, with its road and file", () => {
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

  it("names the list that admits an imported constant, not the constant's module", () => {
    // The row's file is its owner (#4874): a pack's constant in the core list stays core.
    expect(rowsOf("fixture_pack_const")).toEqual([{ file: ROUTE, road: "passthrough" }]);
  });

  it("lists a tool admitted on both roads with a row on each", () => {
    expect(rowsOf("fixture_mcp_tool")).toEqual([
      { file: ROUTE, road: "passthrough" },
      { file: "src/lib/fixture-mcp.ts", road: "mcp" },
    ]);
  });

  it("finds the list by its declaration: ALLOWED_TOOLS, declared or imported, and no other set", () => {
    expect(rowsOf("plain")).toEqual([]);
    expect(builderFailure(trees.typed)).toBe("");
    expect(namesAt(trees.typed)).toEqual(["fixture_ok"]);
    expect(builderFailure(trees.imported)).toBe("");
    expect(namesAt(trees.imported)).toEqual(["fixture_moved"]);
    expect(builderFailure(trees.missing)).toContain("expected exactly one declaration or import of ALLOWED_TOOLS, found 0");
    expect(builderFailure(trees.twoScopes)).toContain("expected exactly one declaration or import of ALLOWED_TOOLS, found 2");
  });

  it("fails the builder on a list or an entry it cannot read, naming it", () => {
    const failure = builderFailure(trees.callEntry);
    expect(failure).toContain("buildName()");
    expect(failure).toContain(ROUTE);
    expect(builderFailure(trees.builtSpread)).toContain("makeSet()");
    expect(builderFailure(trees.letConst)).toContain("LATER is not declared with const");
    expect(builderFailure(trees.frozen)).toContain("is not a `new Set([...])`");
    expect(builderFailure(trees.fromArray)).toContain("is not a `new Set([...])`");
  });

  it("refuses a list or a spread set it cannot prove constant, naming the use", () => {
    expect(builderFailure(trees.addCall)).toContain('ALLOWED_TOOLS.add("fixture_late")');
    expect(builderFailure(trees.passedToFn)).toContain("extend(ALLOWED_TOOLS)");
    expect(builderFailure(trees.spreadMutated)).toContain("SPREAD_TOOLS.delete('fixture_spread')");
    expect(builderFailure(trees.reads)).toBe("");
  });

  it("--check passes on the tree it just wrote", () => {
    expect(() => execFileSync(process.execPath, [BUILDER, "--root", root, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
