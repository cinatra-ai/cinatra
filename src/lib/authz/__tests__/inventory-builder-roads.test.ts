/**
 * cinatra#4895: the authz inventory builder records the passthrough road's
 * allow list, not only the MCP registrations. The reading is deliberately
 * narrow: it accepts exactly the forms the real route uses and refuses every
 * other form with its file, its line and "form not read yet". Each test runs
 * the builder on a fixture tree through `--root`; each tree carries its own
 * small tsconfig, so an import resolves as TypeScript resolves it there.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const BUILDER = resolve(REPO_ROOT, "scripts/build-authz-inventory.mjs");
const ROUTE = "src/app/api/agents/passthrough/route.ts";
const NOT_READ = "form not read yet";
// Built from parts so the builder scanning this repository does not read the
// fixture's registration as a tool of its own.
const SERVER_REGISTER = ["server", "registerTool"].join(".");

/** A route module: `head` lines, then `decl` with the `list` lines, then a handler. */
const route = (list: string[], head: string[] = [], decl = "const ALLOWED_TOOLS = new Set([", close = "]);") =>
  [
    ...head,
    decl,
    ...list,
    close,
    "export async function POST(body: { tool: string }) {",
    "  if (!ALLOWED_TOOLS.has(body.tool)) return { status: 403 };",
    "  return { status: 200 };",
    "}",
    "",
  ].join("\n");

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "esnext",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
    paths: { "@/*": ["./src/*"] },
  },
});

/** The tree with every accepted form. */
const FILES: Record<string, string> = {
  "src/lib/fixture-mcp.ts": [
    "export function register(server: { registerTool: (...a: unknown[]) => void }) {",
    `  ${SERVER_REGISTER}("fixture_mcp_tool", {}, async () => ({}));`,
    "}",
    "",
  ].join("\n"),
  // The shape of the real route's spread sets: an alias import, type
  // arguments on `new Set<T>`, a type annotation, local constants as elements.
  "src/lib/fixture-scoped-tools.ts": [
    'import { FIXTURE_NESTED_TOOLS } from "./fixture-nested-tools";',
    "export const FIXTURE_READ_TOOL = 'fixture_scoped_read';",
    "export const FIXTURE_SCOPED_TOOLS: ReadonlySet<string> = new Set<string>([",
    "  FIXTURE_READ_TOOL,",
    '  "fixture_scoped_write",',
    '  "fixture_two_owners",',
    "  ...FIXTURE_NESTED_TOOLS,",
    "]);",
    "",
  ].join("\n"),
  "src/lib/fixture-nested-tools.ts": "export const FIXTURE_NESTED_TOOLS = [`fixture_nested_tool`] as const;\n",
  "src/lib/fixture-names.ts": [
    'export const FIXTURE_IMPORTED_NAME = "fixture_imported_const";',
    "export const FIXTURE_RENAMED_NAME = `fixture_renamed_const`;",
    "",
  ].join("\n"),
  "extensions/@example-org/fixture-pack/src/names.ts": "export const FIXTURE_PACK_NAME = 'fixture_pack_const';\n",
  [ROUTE]: route(
    [
      '  "fixture_mcp_tool",',
      "  // a comment naming `not_a_tool` is not an entry",
      "  'fixture_single_quoted', `fixture_template`,",
      "  LOCAL_TOOL,",
      "  FIXTURE_IMPORTED_NAME,",
      "  RENAMED,",
      "  FIXTURE_PACK_NAME,",
      '  "fixture_two_owners",',
      "  ...LOCAL_SET,",
      "  ...LOCAL_ARRAY,",
      "  ...LOCAL_CONST_ARRAY,",
      "  ...FIXTURE_SCOPED_TOOLS,",
    ],
    [
      'import { FIXTURE_SCOPED_TOOLS } from "@/lib/fixture-scoped-tools";',
      'import { FIXTURE_IMPORTED_NAME, FIXTURE_RENAMED_NAME as RENAMED } from "@/lib/fixture-names";',
      'import { FIXTURE_PACK_NAME } from "../../../../../extensions/@example-org/fixture-pack/src/names";',
      'const LOCAL_TOOL = "fixture_local_const";',
      'const LOCAL_SET = new Set(["fixture_local_set"]);',
      'const LOCAL_ARRAY = ["fixture_local_array"];',
      'const LOCAL_CONST_ARRAY = ["fixture_local_const_array"] as const;',
    ],
  ),
};

/** A route whose list holds one extra `entry` line after `head`. */
const withEntry = (entry: string, head: string[] = []) => ({ [ROUTE]: route(['  "fixture_ok",', `  ${entry},`], head) });
const NAMES = "src/lib/fixture-names.ts";

/** Each refused form: its tree, and the file and the text whose line the failure names. */
const REFUSED: Array<{ form: string; files: Record<string, string>; file: string; needle: string }> = [
  {
    form: "an imported ALLOWED_TOOLS",
    files: {
      "src/lib/allow.ts": "export const ALLOWED_TOOLS = new Set(['fixture_moved']);\n",
      [ROUTE]: route(['  "fixture_ok",'], ['import { ALLOWED_TOOLS } from "@/lib/allow";'], "const OTHER = new Set(["),
    },
    file: ROUTE,
    needle: "import { ALLOWED_TOOLS }",
  },
  {
    form: "an ALLOWED_TOOLS declared with let",
    files: { [ROUTE]: route(['  "fixture_ok",'], [], "let ALLOWED_TOOLS = new Set([") },
    file: ROUTE,
    needle: "let ALLOWED_TOOLS",
  },
  {
    form: "an ALLOWED_TOOLS initialized from a variable (`new Set(NAMES)`)",
    files: { [ROUTE]: route([], ['const NAMES = ["fixture_ok"];'], "const ALLOWED_TOOLS = new Set(NAMES", ");") },
    file: ROUTE,
    needle: "new Set(NAMES",
  },
  {
    form: "an ALLOWED_TOOLS behind a call (`Object.freeze`)",
    files: { [ROUTE]: route(['  "fixture_ok",'], [], "const ALLOWED_TOOLS = Object.freeze(new Set([", "]));") },
    file: ROUTE,
    needle: "Object.freeze",
  },
  {
    form: "an ALLOWED_TOOLS behind `as`",
    files: { [ROUTE]: route(['  "fixture_ok",'], [], "const ALLOWED_TOOLS = new Set([", "]) as Set<string>;") },
    file: ROUTE,
    needle: "const ALLOWED_TOOLS",
  },
  {
    form: "a second top-level binding of ALLOWED_TOOLS",
    files: { [ROUTE]: route(['  "fixture_ok",'], ["function ALLOWED_TOOLS() {}"]) },
    file: ROUTE,
    needle: "const ALLOWED_TOOLS",
  },
  {
    form: "a type-only import",
    files: {
      [NAMES]: 'export const X = "fixture_x";\n',
      ...withEntry("X", ['import type { X } from "@/lib/fixture-names";']),
    },
    file: ROUTE,
    needle: "import type { X }",
  },
  {
    form: "an inline `type` import specifier",
    files: {
      [NAMES]: 'export const X = "fixture_x";\n',
      ...withEntry("X", ['import { type X } from "@/lib/fixture-names";']),
    },
    file: ROUTE,
    needle: "type X }",
  },
  {
    form: "a default import",
    files: {
      [NAMES]: 'const X = "fixture_x";\nexport default X;\n',
      ...withEntry("X", ['import X from "@/lib/fixture-names";']),
    },
    file: ROUTE,
    needle: "import X from",
  },
  {
    form: "a namespace import",
    files: {
      [NAMES]: 'export const X = ["fixture_x"];\n',
      ...withEntry("...X", ['import * as X from "@/lib/fixture-names";']),
    },
    file: ROUTE,
    needle: "* as X",
  },
  {
    form: "a named re-export between the import and the declaration",
    files: {
      [NAMES]: 'export const X = "fixture_x";\n',
      "src/lib/barrel.ts": 'export { X } from "./fixture-names";\n',
      ...withEntry("X", ['import { X } from "@/lib/barrel";']),
    },
    file: ROUTE,
    needle: "{ X }",
  },
  {
    form: "a star re-export (barrel) between the import and the declaration",
    files: {
      [NAMES]: 'export const X = new Set(["fixture_x"]);\n',
      "src/lib/barrel.ts": 'export * from "./fixture-names";\n',
      ...withEntry("...X", ['import { X } from "@/lib/barrel";']),
    },
    file: ROUTE,
    needle: "{ X }",
  },
  {
    form: "a const exported only through an export list",
    files: {
      [NAMES]: 'const X = "fixture_x";\nexport { X };\n',
      ...withEntry("X", ['import { X } from "@/lib/fixture-names";']),
    },
    file: ROUTE,
    needle: "{ X }",
  },
  {
    form: "an import that does not resolve",
    files: withEntry("X", ['import { X } from "@/lib/nowhere";']),
    file: ROUTE,
    needle: "@/lib/nowhere",
  },
  {
    form: "an element constant declared with let",
    files: withEntry("LATER", ['let LATER = "fixture_let";']),
    file: ROUTE,
    needle: "LATER =",
  },
  {
    form: "an element constant declared with var",
    files: withEntry("LATER", ['var LATER = "fixture_var";']),
    file: ROUTE,
    needle: "LATER =",
  },
  {
    form: "a spread set declared with let in its own module",
    files: {
      [NAMES]: 'export let X = new Set(["fixture_x"]);\n',
      ...withEntry("...X", ['import { X } from "@/lib/fixture-names";']),
    },
    file: ROUTE,
    needle: "{ X }",
  },
  {
    form: "a constant bound by destructuring",
    files: withEntry("X", ['const { X } = { X: "fixture_x" };']),
    file: ROUTE,
    needle: "const { X }",
  },
  {
    form: "an element in parentheses",
    files: withEntry('("fixture_paren")'),
    file: ROUTE,
    needle: '("fixture_paren")',
  },
  {
    form: "an element behind `as`",
    files: withEntry('"fixture_as" as string'),
    file: ROUTE,
    needle: '"fixture_as" as',
  },
  {
    form: "an element behind `<T>`",
    files: withEntry('<string>"fixture_angle"'),
    file: ROUTE,
    needle: "<string>",
  },
  {
    form: "an element behind `satisfies`",
    files: withEntry('"fixture_sat" satisfies string'),
    file: ROUTE,
    needle: "satisfies",
  },
  {
    form: "an element behind `!`",
    files: withEntry("X!", ['const X = "fixture_x";']),
    file: ROUTE,
    needle: "X!",
  },
  {
    form: "a constant whose initializer is wrapped",
    files: withEntry("X", ['const X = ("fixture_x");']),
    file: ROUTE,
    needle: '("fixture_x")',
  },
  {
    form: "a spread array behind `satisfies`",
    files: withEntry("...X", ['const X = ["fixture_x"] satisfies string[];']),
    file: ROUTE,
    needle: '["fixture_x"]',
  },
  {
    form: "a spread set behind `as`",
    files: withEntry("...X", ['const X = new Set(["fixture_x"]) as Set<string>;']),
    file: ROUTE,
    needle: "new Set([\"fixture_x\"]) as",
  },
  {
    form: "an element of an imported set that is not read, named in the set's own file",
    files: {
      [NAMES]: ["export const X = new Set([", '  "fixture_x",', "  String(1),", "]);", ""].join("\n"),
      ...withEntry("...X", ['import { X } from "@/lib/fixture-names";']),
    },
    file: NAMES,
    needle: "String(1)",
  },
  {
    form: "a call element",
    files: withEntry("buildName()", ["function buildName() { return 'fixture_built'; }"]),
    file: ROUTE,
    needle: "buildName(),",
  },
  {
    form: "a spread of a call",
    files: withEntry("...makeSet()", ["function makeSet() { return new Set(['fixture_built']); }"]),
    file: ROUTE,
    needle: "...makeSet()",
  },
  {
    form: "a computed element",
    files: withEntry('"fixture_" + "joined"'),
    file: ROUTE,
    needle: '"fixture_" +',
  },
  {
    form: "a template with a substitution",
    files: withEntry("`fixture_${X}`", ['const X = "x";']),
    file: ROUTE,
    needle: "`fixture_",
  },
  {
    form: "a conditional element",
    files: withEntry('FLAG ? "fixture_a" : "fixture_b"', ["const FLAG = true;"]),
    file: ROUTE,
    needle: "FLAG ?",
  },
  {
    form: "a constant with a non-literal initializer",
    files: withEntry("X", ["const X = String(1);"]),
    file: ROUTE,
    needle: "String(1)",
  },
  {
    form: "a second top-level binding of an element's name",
    files: withEntry("X", ['const X = "fixture_x";', "function X() {}"]),
    file: ROUTE,
    needle: "function X",
  },
  {
    form: "a file that binds `Set` itself",
    files: { [ROUTE]: route(['  "fixture_ok",'], ["class Set<T> { constructor(_a: T[]) {} }"]) },
    file: ROUTE,
    needle: "class Set",
  },
  {
    form: "a self-spread",
    files: withEntry("...LOOP", ['const LOOP: ReadonlySet<string> = new Set(["fixture_loop", ...LOOP]);']),
    file: ROUTE,
    needle: "LOOP:",
  },
];

type Row = { primitiveName: string; file: string; line: number; road?: string };

function writeTree(files: Record<string, string>, at?: string): string {
  const dir = at ?? mkdtempSync(join(tmpdir(), "authz-inventory-roads-"));
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

/** The 1-based line of the first occurrence of `needle` in `text`. */
function lineOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`fixture has no ${needle}`);
  return text.slice(0, i).split("\n").length;
}

let root = "";
let rows: Row[] = [];
let buildFailure = "";
const refusedDirs: string[] = [];

beforeAll(() => {
  root = writeTree(FILES);
  buildFailure = builderFailure(root);
  rows = rowsAt(root);
});

afterAll(() => {
  for (const dir of [root, ...refusedDirs]) if (dir) rmSync(dir, { recursive: true, force: true });
});

const rowsOf = (n: string) => rows.filter((r) => r.primitiveName === n).map(({ file, road }) => ({ file, road }));
const AT_ROUTE = { file: ROUTE, road: "passthrough" };

describe("authz inventory builder: the accepted forms (cinatra#4895)", () => {
  it("writes the inventory of the --root tree", () => {
    expect(buildFailure).toBe("");
    expect(rows.some((r) => r.road === "passthrough")).toBe(true);
  });

  it("reads a string literal element, in either quote form", () => {
    expect(rowsOf("fixture_single_quoted")).toEqual([AT_ROUTE]);
    expect(rowsOf("not_a_tool")).toEqual([]);
  });

  it("reads a template element without substitution", () => {
    expect(rowsOf("fixture_template")).toEqual([AT_ROUTE]);
  });

  it("reads an identifier bound by a top-level const with a literal in the same file", () => {
    expect(rowsOf("fixture_local_const")).toEqual([AT_ROUTE]);
  });

  it("reads an identifier bound by a named value import of an `export const` literal", () => {
    expect(rowsOf("fixture_imported_const")).toEqual([AT_ROUTE]);
  });

  it("reads an identifier bound by a renamed value import (`import { X as Y }`)", () => {
    expect(rowsOf("fixture_renamed_const")).toEqual([AT_ROUTE]);
  });

  it("names the list that admits an imported constant, not the constant's module", () => {
    // The row's file is its owner (#4874): a pack's constant in the core list stays core.
    expect(rowsOf("fixture_pack_const")).toEqual([AT_ROUTE]);
  });

  it("reads a spread of a top-level const `new Set([...])` in the same file", () => {
    expect(rowsOf("fixture_local_set")).toEqual([AT_ROUTE]);
  });

  it("reads a spread of a top-level const array literal in the same file", () => {
    expect(rowsOf("fixture_local_array")).toEqual([AT_ROUTE]);
  });

  it("reads a spread of a top-level const array literal `as const`", () => {
    expect(rowsOf("fixture_local_const_array")).toEqual([AT_ROUTE]);
  });

  it("reads a spread of an imported `export const` set with a type annotation and `new Set<T>`, recursively", () => {
    const scoped = { file: "src/lib/fixture-scoped-tools.ts", road: "passthrough" };
    expect(rowsOf("fixture_scoped_read")).toEqual([scoped]);
    expect(rowsOf("fixture_scoped_write")).toEqual([scoped]);
    expect(rowsOf("fixture_nested_tool")).toEqual([{ file: "src/lib/fixture-nested-tools.ts", road: "passthrough" }]);
  });

  it("keeps a passthrough row for each of two owners in two files", () => {
    expect(rowsOf("fixture_two_owners")).toEqual([AT_ROUTE, { file: "src/lib/fixture-scoped-tools.ts", road: "passthrough" }]);
  });

  it("lists a tool admitted on both roads with a row on each", () => {
    expect(rowsOf("fixture_mcp_tool")).toEqual([AT_ROUTE, { file: "src/lib/fixture-mcp.ts", road: "mcp" }]);
  });

  it("records the line of the element in the set that holds it", () => {
    const row = rows.find((r) => r.primitiveName === "fixture_scoped_write");
    expect(row?.line).toBe(lineOf(FILES["src/lib/fixture-scoped-tools.ts"], '"fixture_scoped_write"'));
  });

  it("--check passes on the tree it just wrote", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(() => execFileSync(process.execPath, [BUILDER, "--root", root, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

describe("authz inventory builder: every other form fails (cinatra#4895)", () => {
  it("fails the builder when the route has no ALLOWED_TOOLS", () => {
    const dir = writeTree({ [ROUTE]: route(['  "fixture_ok",'], [], "const ALLOWED_NAMES = new Set([") });
    refusedDirs.push(dir);
    expect(builderFailure(dir)).toContain(`${ROUTE}: no top-level binding of ALLOWED_TOOLS`);
  });

  it.each(REFUSED)("refuses $form with its file, its line and the words", ({ files, file, needle }) => {
    const dir = writeTree(files);
    refusedDirs.push(dir);
    const failure = builderFailure(dir);
    expect(failure).toContain(`${file}:${lineOf(files[file], needle)}: `);
    expect(failure).toContain(NOT_READ);
  });
});

describe("authz inventory builder: an import counts by the real path of its file (cinatra#4895)", () => {
  // A workspace package as the repository resolves one: a package under
  // packages/ with an `exports` map to its TypeScript source, reached through a
  // `node_modules/<scope>/<name>` symlink, the way `@cinatra-ai/mcp-server/...`
  // resolves in src/app/api/llm-bridge/route.ts. TypeScript marks it
  // `isExternalLibraryImport`; its real path is inside the root.
  const WS_PKG = "packages/fixture-names-pkg";
  const WS_FILE = `${WS_PKG}/src/tools.ts`;
  const workspaceFiles: Record<string, string> = {
    [`${WS_PKG}/package.json`]: JSON.stringify({
      name: "@example-org/fixture-names",
      private: true,
      exports: { "./tools": "./src/tools.ts" },
    }),
    [WS_FILE]: 'export const FIXTURE_WS_TOOLS = new Set(["fixture_workspace_tool"]);\n',
    [ROUTE]: route(['  "fixture_ok",', "  ...FIXTURE_WS_TOOLS,"], [
      'import { FIXTURE_WS_TOOLS } from "@example-org/fixture-names/tools";',
    ]),
  };

  it("reads a set of a workspace package reached through a node_modules symlink, by its real path", () => {
    const dir = writeTree(workspaceFiles);
    refusedDirs.push(dir);
    mkdirSync(join(dir, "node_modules/@example-org"), { recursive: true });
    symlinkSync("../../" + WS_PKG, join(dir, "node_modules/@example-org/fixture-names"), "dir");
    expect(builderFailure(dir)).toBe("");
    const ws = rowsAt(dir).filter((r) => r.primitiveName === "fixture_workspace_tool");
    expect(ws.map(({ file, road }) => ({ file, road }))).toEqual([{ file: WS_FILE, road: "passthrough" }]);
  });

  it("refuses an import whose real path lies outside the repository root, with its file and line", () => {
    // The fixture root is <parent>/root; the imported file is <parent>/outside/names.ts.
    const parent = mkdtempSync(join(tmpdir(), "authz-inventory-roads-outside-"));
    refusedDirs.push(parent);
    mkdirSync(join(parent, "outside"), { recursive: true });
    writeFileSync(join(parent, "outside/names.ts"), 'export const OUTSIDE_TOOLS = new Set(["fixture_outside_tool"]);\n');
    const needle = 'import { OUTSIDE_TOOLS } from "../../../../../../outside/names";';
    const files = { [ROUTE]: route(['  "fixture_ok",', "  ...OUTSIDE_TOOLS,"], [needle]) };
    const dir = writeTree(files, join(parent, "root"));
    const failure = builderFailure(dir);
    expect(failure).toContain(`${ROUTE}:${lineOf(files[ROUTE], needle)}: `);
    expect(failure).toContain("does not resolve to a source module of the repository");
    expect(failure).toContain(NOT_READ);
    expect(rowsAt(dir).some((r) => r.primitiveName === "fixture_outside_tool")).toBe(false);
  });

  it("refuses an import whose real path lies inside a node_modules directory of the root", () => {
    const needle = 'import { MODULE_TOOLS } from "@example-org/fixture-installed";';
    const files = {
      "node_modules/@example-org/fixture-installed/package.json": JSON.stringify({
        name: "@example-org/fixture-installed",
        exports: { ".": "./index.ts" },
      }),
      "node_modules/@example-org/fixture-installed/index.ts": 'export const MODULE_TOOLS = new Set(["fixture_installed_tool"]);\n',
      [ROUTE]: route(['  "fixture_ok",', "  ...MODULE_TOOLS,"], [needle]),
    };
    const dir = writeTree(files);
    refusedDirs.push(dir);
    const failure = builderFailure(dir);
    expect(failure).toContain(`${ROUTE}:${lineOf(files[ROUTE], needle)}: `);
    expect(failure).toContain(NOT_READ);
  });
});
