/**
 * cinatra#4895: the authz inventory builder records the passthrough road's
 * allow list, not only the MCP registrations. Run on fixture trees through
 * `--root`: the list is found by its declaration (ALLOWED_TOOLS), read with the
 * TypeScript type checker on a program built with the tree's tsconfig (any
 * quote form, templates, constants exported or not, spread sets in other files,
 * a `.mjs` module, an imported list, re-exports, path aliases), and anything it
 * cannot read or prove constant fails the builder.
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

// Each fixture tree has its own small tsconfig, so the builder's program
// resolves the tree as TypeScript does: the `@/` alias and a package alias.
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "esnext",
    moduleResolution: "bundler",
    allowJs: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    paths: {
      "@/*": ["./src/*"],
      "@example-org/fixture-lib/*": ["./packages/fixture-lib/src/*"],
    },
  },
});

const OK_LIST = ['  "fixture_ok"'];
const TREES: Record<string, Record<string, string>> = {
  typed: { [ROUTE]: route(['  "fixture_ok",', "] as const"], [], [], "const ALLOWED_TOOLS: ReadonlySet<string> = new Set<string>([").replace("] as const\n]);", "] as const);") },
  imported: {
    "src/lib/fixture-allow-list.ts": ["export const ALLOWED_TOOLS = new Set(['fixture_moved']);", ""].join("\n"),
    [ROUTE]: route(OK_LIST, ['import { ALLOWED_TOOLS } from "@/lib/fixture-allow-list";'], [], "const OTHER_LIST = new Set(["),
  },
  missing: { [ROUTE]: route(OK_LIST, [], [], "const ALLOWED_NAMES = new Set([") },
  twoScopes: {
    [ROUTE]: route(OK_LIST, [], [
      "function shadow() { const ALLOWED_TOOLS = new Set(['x']); ALLOWED_TOOLS.add('y'); return ALLOWED_TOOLS.size; }",
      "export function param(ALLOWED_TOOLS: Set<string>) { ALLOWED_TOOLS.clear(); }",
    ]),
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
  inObject: { [ROUTE]: route(OK_LIST, [], ["export const BOX = { ALLOWED_TOOLS };"]) },
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
      "export const HAS = ALLOWED_TOOLS.has('fixture_ok');",
      "export const COPY = [...ALLOWED_TOOLS];",
      "export const SAME = new Set(ALLOWED_TOOLS);",
      "export type LIST = typeof ALLOWED_TOOLS;",
    ]),
  },
  // Route tail lines start at line 10 (no head lines, a one-line list).
  forEachUse: { [ROUTE]: route(OK_LIST, [], ["ALLOWED_TOOLS.forEach((n) => void n);"]) },
  sizeWrite: { [ROUTE]: route(OK_LIST, [], ["ALLOWED_TOOLS.size++;"]) },
  ...Object.fromEntries(
    (
      [
        ["namesLengthDecrement", "TOOL_NAMES.length--;"],
        ["namesPush", "TOOL_NAMES.push('fixture_late');"],
        ["namesAlias", "const copy = TOOL_NAMES; void copy;"],
        ["namesPassed", "export const kept = keep(TOOL_NAMES);"],
      ] as const
    ).map(([k, use]) => [
      k,
      {
        "src/lib/tool-names.ts": [
          "export const TOOL_NAMES = ['fixture_names_a', 'fixture_names_b'];",
          `${use}`,
          "function keep(a: unknown) { return a; }",
          "",
        ].join("\n"),
        [ROUTE]: route(['  "fixture_ok",', "  ...TOOL_NAMES,"], ['import { TOOL_NAMES } from "@/lib/tool-names";']),
      },
    ]),
  ),
  namesRead: {
    "src/lib/tool-names.ts": [
      "export const TOOL_NAMES = ['fixture_names_a', 'fixture_names_b'];",
      "export const NAME_SET = new Set([...TOOL_NAMES]);",
      "export const ANY_NAME = NAME_SET.has('fixture_names_a') && NAME_SET.size > 0;",
      "",
    ].join("\n"),
    [ROUTE]: route(
      ['  "fixture_ok",', "  ...TOOL_NAMES,", "  ...NAME_SET,"],
      ['import { NAME_SET, TOOL_NAMES } from "@/lib/tool-names";'],
      ["export const BOTH = NAME_SET.has('fixture_ok') || NAME_SET.size === 0;"],
    ),
  },
  twoOwners: {
    "src/lib/fixture-core-set.ts": "export const CORE_SET = new Set(['fixture_shared', 'fixture_shared']);\n",
    "extensions/@example-org/fixture-pack/src/pack-set.ts": "export const PACK_SET = new Set(['fixture_shared']);\n",
    [ROUTE]: route(
      ['  "fixture_ok",', "  ...CORE_SET,", "  ...PACK_SET,"],
      [
        'import { CORE_SET } from "@/lib/fixture-core-set";',
        'import { PACK_SET } from "../../../../../extensions/@example-org/fixture-pack/src/pack-set";',
      ],
    ),
  },
  reexportNamed: {
    "src/lib/names/source.ts": "export const NAMED_SET = new Set(['fixture_named']);\n",
    "src/lib/names/index.ts": 'export { NAMED_SET } from "./source";\n',
    [ROUTE]: route(['  "fixture_ok",', "  ...NAMED_SET,"], ['import { NAMED_SET } from "@/lib/names";']),
  },
  reexportRenamed: {
    "src/lib/names/source.ts": "export const RENAMED_SOURCE = new Set(['fixture_renamed']);\n",
    "src/lib/names/index.ts": 'export { RENAMED_SOURCE as RENAMED_SET } from "./source";\n',
    [ROUTE]: route(['  "fixture_ok",', "  ...RENAMED_SET,"], ['import { RENAMED_SET } from "@/lib/names";']),
  },
  reexportStar: {
    "src/lib/names/source.ts": "export const STAR_SET = new Set(['fixture_star']);\n",
    "src/lib/names/star-hop.ts": 'export * from "./source";\n',
    "src/lib/names/index.ts": 'export * from "./star-hop";\n',
    [ROUTE]: route(['  "fixture_ok",', "  ...STAR_SET,"], ['import { STAR_SET } from "@/lib/names";']),
  },
  // Review 3 of #4969: a barrel with a private set of the same name and an
  // `export *`: the import names the star module's export, as in TypeScript.
  barrelPrivate: {
    "src/lib/barrel/real.ts": "export const BARREL_TOOLS = new Set(['fixture_barrel_real']);\n",
    "src/lib/barrel/index.ts": [
      "const BARREL_TOOLS = new Set(['fixture_barrel_private']);",
      "export const BARREL_SIZE = BARREL_TOOLS.size;",
      'export * from "./real";',
      "",
    ].join("\n"),
    [ROUTE]: route(['  "fixture_ok",', "  ...BARREL_TOOLS,"], ['import { BARREL_TOOLS } from "@/lib/barrel";']),
  },
  aliasImport: {
    "packages/fixture-lib/src/alias-set.ts": "export const ALIAS_TOOLS = new Set(['fixture_alias']);\n",
    [ROUTE]: route(['  "fixture_ok",', "  ...ALIAS_TOOLS,"], ['import { ALIAS_TOOLS } from "@example-org/fixture-lib/alias-set";']),
  },
  angleConst: {
    [ROUTE]: route(['  "fixture_ok",', "  ANGLE_TOOL,", "  (PAREN_TOOL)!,"], ['const ANGLE_TOOL = <const>"fixture_angle";', 'const PAREN_TOOL = ("fixture_paren" satisfies string);']),
  },
  typeAndConst: {
    "src/lib/dual.ts": [
      "export type DUAL_TOOLS = string;",
      "export const DUAL_TOOLS = new Set(['fixture_dual']);",
      "export const pick = (name: DUAL_TOOLS): DUAL_TOOLS => name;",
      "",
    ].join("\n"),
    [ROUTE]: route(['  "fixture_ok",', "  ...DUAL_TOOLS,"], ['import { DUAL_TOOLS } from "@/lib/dual";']),
  },
  spreadArray: {
    "src/lib/array-tools.ts": "export const ARRAY_TOOLS = ['fixture_array', `fixture_array_tpl`] as const;\n",
    [ROUTE]: route(['  "fixture_ok",', "  ...ARRAY_TOOLS,"], ['import { ARRAY_TOOLS } from "@/lib/array-tools";']),
  },
  reexportCycle: {
    "src/lib/cycle-a.ts": 'export * from "./cycle-b";\n',
    "src/lib/cycle-b.ts": 'export { CYCLE_SET } from "./cycle-a";\n',
    [ROUTE]: route(['  "fixture_ok",', "  ...CYCLE_SET,"], ['import { CYCLE_SET } from "@/lib/cycle-a";']),
  },
};

type Row = { primitiveName: string; file: string; line: number; road?: string };

function writeTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "authz-inventory-roads-"));
  for (const [rel, body] of Object.entries({ "tsconfig.json": TSCONFIG, ...files })) {
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
    // A local variable or parameter of the same name inside a function is
    // another binding: the module-level set is read, the local one ignored.
    expect(builderFailure(trees.twoScopes)).toBe("");
    expect(namesAt(trees.twoScopes)).toEqual(["fixture_ok"]);
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
    expect(builderFailure(trees.inObject)).toContain("is not used as a constant");
    expect(builderFailure(trees.spreadMutated)).toContain("SPREAD_TOOLS.delete('fixture_spread')");
    expect(builderFailure(trees.reads)).toBe("");
    expect(namesAt(trees.reads)).toEqual(["fixture_ok"]);
  });

  it("accepts only the forms known to read a set: any other use fails with its file and line", () => {
    const forEachUse = builderFailure(trees.forEachUse);
    expect(forEachUse).toContain(`${ROUTE}:10`);
    expect(forEachUse).toContain("ALLOWED_TOOLS.forEach((n) => void n)");
    const sizeWrite = builderFailure(trees.sizeWrite);
    expect(sizeWrite).toContain(`${ROUTE}:10`);
    expect(sizeWrite).toContain("ALLOWED_TOOLS.size++");
  });

  it("refuses a change of a spread array in its own module: `.length--`, `.push`, an alias, passing it to a function", () => {
    const at = "src/lib/tool-names.ts:2";
    const decrement = builderFailure(trees.namesLengthDecrement);
    expect(decrement).toContain(at);
    expect(decrement).toContain("TOOL_NAMES.length--");
    const push = builderFailure(trees.namesPush);
    expect(push).toContain(at);
    expect(push).toContain("TOOL_NAMES.push('fixture_late')");
    const alias = builderFailure(trees.namesAlias);
    expect(alias).toContain(at);
    expect(alias).toContain("copy = TOOL_NAMES");
    const passed = builderFailure(trees.namesPassed);
    expect(passed).toContain(at);
    expect(passed).toContain("keep(TOOL_NAMES)");
  });

  it("accepts `.has(...)` and `.size` reads and a spread of a read array in its own module", () => {
    expect(builderFailure(trees.namesRead)).toBe("");
    expect(namesAt(trees.namesRead)).toEqual(["fixture_names_a", "fixture_names_b", "fixture_ok"]);
  });

  it("keeps a passthrough row for each file that admits a name, so a second owner stays visible", () => {
    expect(builderFailure(trees.twoOwners)).toBe("");
    const shared = rowsAt(trees.twoOwners)
      .filter((r) => r.primitiveName === "fixture_shared")
      .map(({ file, road }) => ({ file, road }));
    // A name twice in one set is one row; the same name in a set of another file is a second row.
    expect(shared).toEqual([
      { file: "extensions/@example-org/fixture-pack/src/pack-set.ts", road: "passthrough" },
      { file: "src/lib/fixture-core-set.ts", road: "passthrough" },
    ]);
  });

  it("follows a named re-export to the set it names", () => {
    expect(builderFailure(trees.reexportNamed)).toBe("");
    const named = rowsAt(trees.reexportNamed).filter((r) => r.primitiveName === "fixture_named");
    expect(named.map(({ file, road }) => ({ file, road }))).toEqual([{ file: "src/lib/names/source.ts", road: "passthrough" }]);
  });

  it("follows a renamed re-export to the set under its original name", () => {
    expect(builderFailure(trees.reexportRenamed)).toBe("");
    expect(rowsAt(trees.reexportRenamed).filter((r) => r.primitiveName === "fixture_renamed").map((r) => r.file)).toEqual([
      "src/lib/names/source.ts",
    ]);
  });

  it("follows a chain of star re-exports to the set", () => {
    expect(builderFailure(trees.reexportStar)).toBe("");
    expect(rowsAt(trees.reexportStar).filter((r) => r.primitiveName === "fixture_star").map((r) => r.file)).toEqual([
      "src/lib/names/source.ts",
    ]);
  });

  it("fails the builder on an import the checker cannot resolve (a re-export cycle), naming the entry", () => {
    const failure = builderFailure(trees.reexportCycle);
    expect(failure).toContain("CYCLE_SET does not resolve to a value declaration");
    expect(failure).toContain(ROUTE);
  });

  it("follows an import of a barrel to its `export *` module, not to the barrel's private set of the same name", () => {
    expect(builderFailure(trees.barrelPrivate)).toBe("");
    const names = namesAt(trees.barrelPrivate);
    expect(names).toContain("fixture_barrel_real");
    expect(names).not.toContain("fixture_barrel_private");
    expect(rowsAt(trees.barrelPrivate).filter((r) => r.primitiveName === "fixture_barrel_real").map((r) => r.file)).toEqual([
      "src/lib/barrel/real.ts",
    ]);
  });

  it("follows an import through a tsconfig path alias", () => {
    expect(builderFailure(trees.aliasImport)).toBe("");
    expect(rowsAt(trees.aliasImport).filter((r) => r.primitiveName === "fixture_alias").map((r) => r.file)).toEqual([
      "packages/fixture-lib/src/alias-set.ts",
    ]);
  });

  it("reads a literal constant behind `<const>`, parentheses, `satisfies` and `!`", () => {
    expect(builderFailure(trees.angleConst)).toBe("");
    expect(namesAt(trees.angleConst)).toEqual(["fixture_angle", "fixture_ok", "fixture_paren"]);
  });

  it("reads a set that shares its name with a type, and a type use is not a use of the set", () => {
    expect(builderFailure(trees.typeAndConst)).toBe("");
    expect(rowsAt(trees.typeAndConst).filter((r) => r.primitiveName === "fixture_dual").map((r) => r.file)).toEqual([
      "src/lib/dual.ts",
    ]);
  });

  it("reads a spread array literal `as const`", () => {
    expect(builderFailure(trees.spreadArray)).toBe("");
    expect(namesAt(trees.spreadArray)).toEqual(["fixture_array", "fixture_array_tpl", "fixture_ok"]);
  });

  it("--check passes on the tree it just wrote", () => {
    expect(rows.some((r) => r.road === "passthrough")).toBe(true);
    expect(() => execFileSync(process.execPath, [BUILDER, "--root", root, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
