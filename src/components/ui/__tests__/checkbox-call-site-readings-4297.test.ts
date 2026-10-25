// cinatra#4297, Done-when 2 and 3: every checkbox call site of the application
// and the shared packages has a recorded reading of whether its change takes
// effect at once, and each one that does and is drawn as a checkbox is a
// switch or has a recorded reason it stays.
//
//   pnpm exec vitest run --config vitest.config.ts --no-coverage src/components/ui/__tests__/checkbox-call-site-readings-4297.test.ts
//
// The readings are `checkbox-call-site-readings-4297.data.ts`; the scan and the
// check are `checkbox-call-site-scan.ts`. The first block holds the readings to
// the live tree; the others prove each rule of the scan on small inputs, so a
// weakened scan fails here and not only in a missed site.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  callerProblems,
  countCheckboxTokens,
  findCallers,
  findCheckboxSites,
  isTestPath,
  listSourceFiles,
  packageEntriesOf,
  parseSource,
  pathAliasesOf,
  readingProblems,
  scanSources,
  scanTree,
  standsInCode,
  type CallerReading,
  type ComponentCallers,
  type FileReading,
  type ScannedTree,
  type SiteReading,
} from "./checkbox-call-site-scan.ts";
import { CHECKBOX_CALL_SITE_READINGS, COMPONENT_CALLERS } from "./checkbox-call-site-readings-4297.data.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const readRepo = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

describe("the recorded readings hold for the live tree", () => {
  const files = listSourceFiles(REPO_ROOT);
  const tree = scanTree(REPO_ROOT, files);

  it("scans the whole application and every shared package", () => {
    // The listing is git's whole index under src/ and packages/; these files
    // stand for both roots and for the package the #4297 row lives in.
    for (const f of [
      "src/components/ui/checkbox.tsx",
      "packages/sdk-ui/src/prompt-field.tsx",
      "packages/chat/src/brokered-composer-inputs.tsx",
      "packages/agents/src/schema-field-renderer.tsx",
    ]) {
      expect(files).toContain(f);
    }
    const packages = new Set(files.filter((f) => f.startsWith("packages/")).map((f) => f.split("/")[1]));
    expect(packages.size).toBeGreaterThan(20);
  });

  it("every file that refers to a checkbox has one true reading, and every reading names a live site", () => {
    expect(readingProblems(CHECKBOX_CALL_SITE_READINGS, tree, readRepo)).toEqual([]);
  });

  it("every caller of each shared component whose box is read at its callers has a reading", () => {
    expect(COMPONENT_CALLERS.map((c) => c.component)).toEqual(["AccessCombobox", "UploadConsentBlock", "PermissionsFormDraft"]);
    for (const set of COMPONENT_CALLERS) {
      const found = findCallers(files, readRepo, set.component, set.callerWhen);
      expect(callerProblems(set, found, readRepo)).toEqual([]);
    }
  });

  it("the Skills autosave row (Done-when 1) is read as an immediate-effect setting drawn as a switch", () => {
    const row = CHECKBOX_CALL_SITE_READINGS.find((r) => r.file === "packages/sdk-ui/src/prompt-field.tsx");
    expect(row?.sites.map((s) => [s.tag, s.drawn, s.effect])).toEqual([["DropdownMenuCheckboxItem", "switch", "immediate"]]);
  });

  it("the immediate-effect sites drawn as a checkbox are exactly the ones with a recorded reason", () => {
    const stays = [
      ...CHECKBOX_CALL_SITE_READINGS.flatMap((r) =>
        r.sites.filter((s) => s.effect === "immediate" && s.drawn === "checkbox").map((s) => [r.file, Boolean(s.staysBecause)]),
      ),
      ...COMPONENT_CALLERS.flatMap((set) => set.callers.filter((c) => c.effect === "immediate").map((c) => [c.file, Boolean(c.staysBecause)])),
    ];
    expect(stays).toEqual([
      ["packages/agents/src/schema-field-renderer.tsx", true],
      ["packages/skills/src/skills-toolbar.tsx", true],
      ["src/components/scope-filter-combobox.tsx", true],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Small inputs
// ---------------------------------------------------------------------------

function treeOf(texts: Record<string, string>): ScannedTree {
  return scanSources(new Map(Object.entries(texts)));
}

function reader(texts: Record<string, string>) {
  return (file: string) => {
    if (!(file in texts)) throw new Error(`no such file ${file}`);
    return texts[file];
  };
}

function reading(file: string, tokens: number, sites: SiteReading[], mentions?: string): FileReading {
  return mentions === undefined ? { file, tokens, sites } : { file, tokens, sites, mentions };
}

const CONFIRMED_A: SiteReading = {
  anchor: 'id="a"',
  tag: "Checkbox",
  drawn: "checkbox",
  effect: "confirmed",
  reading: "a field of a form that only its submit button writes",
  tagIncludes: [],
  fileIncludes: ['type="submit"'],
};

const FORM = '<form><Checkbox id="a" />\n<Button type="submit">Save</Button></form>';

/** The problems of one file's readings against its own text. */
function problemsOf(text: string, sites: SiteReading[], extra: Record<string, string> = {}, mentions?: string): string {
  const texts = { "f.tsx": text, ...extra };
  return readingProblems([reading("f.tsx", countCheckboxTokens(text), sites, mentions)], treeOf({ "f.tsx": text }), reader(texts)).join("\n");
}

const sitesOf = (tree: ScannedTree, file: string) => tree.files.find((f) => f.file === file)?.sites.map((s) => [s.tag, s.unresolved ?? "checkbox"]);

describe("discovery: every form of a checkbox element is found (rules 3 and 4)", () => {
  it("names the tags of a namespace import and its aliases", () => {
    const text = 'import * as R from "radix-ui";\nconst C = R.Checkbox;\nconst M = R.DropdownMenu;\nexport const X = () => <><C.Root /><M.CheckboxItem /></>;\n';
    expect(findCheckboxSites(text).map((s) => s.tag)).toEqual(["C.Root", "M.CheckboxItem"]);
  });

  it("names a renamed import, a destructured alias, a parameter's destructured key and an alias through as, ?: and ??", () => {
    const text = [
      'import { Checkbox as Tick } from "@/components/ui/checkbox";',
      "const { Checkbox: Box } = Primitives;",
      "const Cast = (Primitives.Checkbox as unknown as typeof Tick)!;",
      "const Either = flag ? Primitives.Checkbox : Fallback;",
      "const Or = maybe ?? Box;",
      "export const Row = ({ Checkbox: Mark }: Props) => <Mark />;",
      "export const X = () => <div><Tick id=\"t\" /><Box /><Cast /><Either /><Or /></div>;",
    ].join("\n");
    expect(findCheckboxSites(text).map((s) => s.tag)).toEqual(["Mark", "Tick", "Box", "Cast", "Either", "Or"]);
  });

  it("names every name imported from a module that names a checkbox, by import or require", () => {
    const text = 'import Tock from "react-checkbox";\nconst Tack = require("./ui/checkbox");\nexport const X = () => <><Tock /><Tack.Root /></>;\n';
    expect(findCheckboxSites(text, "f.jsx").map((s) => s.tag)).toEqual(["Tock", "Tack.Root"]);
  });

  it("names a checkbox type or role in any letter case, quoted, in braces or in an object spread, on any element", () => {
    const text =
      'export const X = () => <form><input type="CHECKBOX" name="a" /><input type={\'Checkbox\'} /><div role="checkbox" /><span role=\'MenuItemCheckbox\' /><Input type="checkbox" /><input type="text" /><input {...{ type: "checkbox" }} /><input TYPE="checkbox" /></form>;\n';
    expect(findCheckboxSites(text).map((s) => [s.tag, s.unresolved ?? "checkbox"])).toEqual([
      ["input", "checkbox"],
      ["input", "checkbox"],
      ["div", "checkbox"],
      ["span", "checkbox"],
      ["Input", "checkbox"],
      ["input", "checkbox"],
      ["input", "checkbox"],
    ]);
    expect(countCheckboxTokens(text)).toBe(7);
  });

  it("reads attributes in source order: a later spread makes a literal type or role unresolved, a later literal overrides a spread (MF2)", () => {
    const text = [
      "export const X = ({ kind, p, on }) => <>",
      '<input type="text" {...p} />',
      '<input {...p} type="text" />',
      '<input type="checkbox" {...{ type: "text" }} />',
      '<input type="text" {...{ ...p }} />',
      '<input type="text" {...{ [kind]: "checkbox" }} />',
      '<div role="group" {...p} />',
      '<div {...p} role="group" />',
      "<div {...p} />",
      "<input type={kind} />",
      "<Input {...p} />",
      "<SidebarInput {...p} />",
      '<input type={on ? "password" : "text"} />',
      '<div role={on ? undefined : "button"} />',
      "<div role={kind} />",
      '<input type={isOn ? "checkbox" : "text"} />',
      "</>;",
    ].join("\n");
    expect(findCheckboxSites(text).map((s) => [s.line, s.tag, s.unresolved ?? "checkbox"])).toEqual([
      [2, "input", "the spread {...p} after its type may set it"],
      // line 4 resolves to type text, so it is no site, and its overridden "checkbox" is a word of rule 5
      [4, '"checkbox"', "the word checkbox in a string outside a site's opening tag"],
      [5, "input", "the spread ...p after its type may set it"],
      [6, "input", 'the spread [kind]: "checkbox" after its type may set it'],
      [7, "div", "the spread {...p} after its role may set it"],
      [10, "input", "its type is the expression {kind}"],
      [11, "Input", "it has a spread and no literal type after it"],
      [12, "SidebarInput", "it has a spread and no literal type after it"],
      [15, "div", "its role is the expression {kind}"],
      [16, "input", "checkbox"],
    ]);
  });

  it("follows a name another file exports a checkbox under, also through a local alias, a namespace and .mts or .cts (MF3)", () => {
    const tree = treeOf({
      "a.tsx": 'export { Checkbox as Tick } from "./checkbox";\nexport const Box = Tick;\n',
      "b.tsx": 'import { Tick } from "./a";\nexport const X = () => <Tick id="t" />;\n',
      "c.tsx": 'import { Box as Square } from "./a";\nexport const Y = () => <Square id="s" />;\n',
      "d.mts": 'import { Checkbox } from "./checkbox";\nconst Mark = Checkbox;\nexport { Mark };\n',
      "e.tsx": 'import * as UI from "./d.mjs";\nexport const Z = () => <UI.Mark />;\n',
      "f.cts": "import { Checkbox } from './checkbox';\nconst Dot = Checkbox;\nexport { Dot as Spot };\n",
      "g.tsx": 'import { Spot } from "./f.cjs";\nexport const W = () => <Spot />;\n',
    });
    expect([...tree.exported].sort()).toEqual(["Box", "Mark", "Spot", "Tick"]);
    expect(sitesOf(tree, "b.tsx")).toEqual([["Tick", "checkbox"]]);
    expect(sitesOf(tree, "c.tsx")).toEqual([["Square", "checkbox"]]);
    expect(sitesOf(tree, "e.tsx")).toEqual([["UI.Mark", "checkbox"]]);
    expect(sitesOf(tree, "g.tsx")).toEqual([["Spot", "checkbox"]]);
    expect(tree.defaultExports).toEqual([]);
  });

  it("follows a name re-exported from a module that names a checkbox, and makes a load of one and the word checkbox in a string a site (the same class)", () => {
    const tree = treeOf({
      "a.ts": 'export { Root as Tick } from "@radix-ui/react-checkbox";\nexport * as Boxes from "@radix-ui/react-checkbox";\n',
      "b.tsx": 'import { Tick, Boxes } from "./a";\nexport const X = () => <><Tick /><Boxes.Indicator /></>;\n',
      "c.tsx": [
        'const Lazy = lazy(() => import("@/components/ui/checkbox"));',
        'export const Y = () => React.createElement("input", { type: "checkbox" });',
        'export const Z = () => <Wrapper kind="checkbox" />;',
        'export const W = () => <Checkbox data-slot="checkbox" />;',
      ].join("\n"),
    });
    expect([...tree.exported].sort()).toEqual(["Boxes", "Tick"]);
    expect(sitesOf(tree, "b.tsx")).toEqual([["Tick", "checkbox"], ["Boxes.Indicator", "checkbox"]]);
    expect(tree.files.find((f) => f.file === "c.tsx")?.sites.map((s) => [s.line, s.openingTag, s.unresolved ?? "checkbox"])).toEqual([
      [1, '() => import("@/components/ui/checkbox")', "a load of the module @/components/ui/checkbox, which no name follows"],
      [2, 'type: "checkbox"', "the word checkbox in a string outside a site's opening tag"],
      [3, 'kind="checkbox"', "the word checkbox in a string outside a site's opening tag"],
      [4, '<Checkbox data-slot="checkbox" />', "checkbox"],
    ]);
  });

  it("refuses every default export of a checkbox, whatever its form (MF3)", () => {
    const tree = treeOf({
      "a.tsx": "import { Checkbox } from './checkbox';\nexport default Checkbox;\n",
      "b.tsx": "export default function Checkbox(props: Props) {\n  return <input type=\"checkbox\" {...props} />;\n}\n",
      "c.tsx": "import { Checkbox } from './checkbox';\nconst Tick = Checkbox;\nexport { Tick as default };\n",
      "d.tsx": "export default class FancyCheckbox extends Base {}\n",
      "e.tsx": "export default function Panel() {\n  return null;\n}\n",
    });
    expect(tree.defaultExports).toEqual(["a.tsx:2", "b.tsx:1", "c.tsx:3", "d.tsx:1"]);
    expect(readingProblems([], tree, reader({})).join("\n")).toContain("b.tsx:1: exports a checkbox as its default export");
  });

  it("makes every other use of a checkbox name an unresolved site (rule 5)", () => {
    const text = [
      'import { Checkbox } from "./checkbox";',
      "import type { CheckboxProps } from './checkbox';",
      "type P = React.ComponentProps<typeof Checkbox> & CheckboxProps;",
      "const label = \"a \\\"quoted\\\" Checkbox\"; const map = { box: Checkbox };",
      "export const Memo = memo(Checkbox);",
      "React.createElement(Checkbox, { id: 'x' });",
      "module.exports.Box = Checkbox;",
      "const Shown = { Checkbox };",
      "export class Fancy extends Checkbox {}",
      "export const Generic = Checkbox<Props>;",
      "// Checkbox in a comment, and `${Checkbox}` in a template is a use too:",
      "const t = `${Checkbox}`;",
      "export const Root = memo(CheckboxPrimitive.Root);",
      "register(Checkbox<Props>);",
    ].join("\n");
    expect(findCheckboxSites(text).map((s) => [s.line, s.openingTag])).toEqual([
      [4, "box: Checkbox"],
      [5, "memo(Checkbox)"],
      [6, "React.createElement(Checkbox, { id: 'x' })"],
      [7, "module.exports.Box = Checkbox"],
      [8, "Checkbox"],
      [9, "extends Checkbox"],
      [12, "`${Checkbox}`"],
      [13, "memo(CheckboxPrimitive.Root)"],
      [14, "register(Checkbox<Props>)"],
    ]);
  });

  it("refuses a file that does not parse, and parses a .ts file without JSX", () => {
    const text = 'const X = () => <Checkbox id="a" onCheckedChange={(v) => set(v)';
    const tree = treeOf({ "f.tsx": text, "g.ts": "const n = <number>value;\nexport const Y = n;\n", "h.ts": "export const Z = <Checkbox id=\"z\" />;\n" });
    const problems = readingProblems([], tree, reader({})).join("\n");
    expect(problems).toContain("f.tsx:1: ");
    expect(problems).toContain("the file does not parse, so it cannot be read");
    expect(problems).toContain("h.ts:1: ");
    expect(problems.includes("g.ts:")).toBe(false);
  });

  it("reads an opening tag across arrow functions, strings and escaped quotes", () => {
    const text = 'const X = () => <Checkbox onCheckedChange={(v) => set(v === true ? "a>b\\"c" : "c")} id="z" />;\n';
    const [site] = findCheckboxSites(text);
    expect(site.openingTag).toBe('<Checkbox onCheckedChange={(v) => set(v === true ? "a>b\\"c" : "c")} id="z" />');
    expect(site.mustName).toEqual(['onCheckedChange={(v) => set(v === true ? "a>b\\"c" : "c")}']);
  });

  it("gives each element its own site, two in one line included", () => {
    const sites = findCheckboxSites('export const X = () => <><Checkbox id="one" /><Checkbox id="two" /></>;\n');
    expect(sites.map((s) => s.openingTag)).toEqual(['<Checkbox id="one" />', '<Checkbox id="two" />']);
  });

  it("does not take a comment, a string, a template, a generic or a type for an element, but counts their tokens", () => {
    const text = [
      "// a <Checkbox /> in a line comment",
      "/* a <Checkbox> in a block */",
      "type P = React.ComponentProps<typeof CheckboxPrimitive.Root>;",
      "const s = '<Checkbox />';",
      "const t = `<Checkbox id=\"x\" />`;",
      "const X = () => <div>{/* <Checkbox /> */}</div>;",
      "const f = <Checkbox,>(value: Checkbox) => value;",
      "const g = <Checkbox extends object>(value: Checkbox) => value;",
      "const x = value// <Checkbox />",
      'const u = "https://example.com/a"; const Z = () => <Checkbox id="real" />;',
    ].join("\n");
    expect(findCheckboxSites(text).map((s) => s.openingTag)).toEqual(['<Checkbox id="real" />']);
    expect(countCheckboxTokens(text)).toBe(12);
  });

  it("reads the elements drawn among an element's children, so a switch inside a checkbox-role row is seen and a switch in a string is not", () => {
    const [site] = findCheckboxSites("const X = () => <DropdownMenuCheckboxItem checked={on}>\n  <Switch checked={on} />\n  Row\n</DropdownMenuCheckboxItem>;\n");
    expect(site.childTags).toEqual(["Switch"]);
    const [text] = findCheckboxSites("const X = () => <DropdownMenuCheckboxItem checked={on}>{`<Switch checked={on} />`}Row</DropdownMenuCheckboxItem>;\n");
    expect(text.childTags).toEqual([]);
  });

  it("leaves test, mock and stub files out and keeps every other file", () => {
    expect(isTestPath("src/components/ui/__tests__/x.test.tsx")).toBe(true);
    expect(isTestPath("packages/agents/src/x.spec.ts")).toBe(true);
    expect(isTestPath("packages/agents/src/x.test.mts")).toBe(true);
    expect(isTestPath("tests/__stubs__/database.ts")).toBe(true);
    expect(isTestPath("src/__mocks__/next-navigation.ts")).toBe(true);
    expect(isTestPath("src/app/test-run/page.tsx")).toBe(false);
    expect(isTestPath("packages/sdk-ui/src/prompt-field.tsx")).toBe(false);
  });
});

describe("computed keys and module objects: no value hands a checkbox on unread (G1), and no letter case hides one (G2)", () => {
  const BARREL = { "ui/index.ts": 'export * from "./menu";\n', "ui/menu.tsx": 'export { CheckboxItem as MenuTick } from "@radix-ui/react-dropdown-menu";\n' };
  const lines = (tree: ScannedTree, file: string) =>
    tree.files.find((f) => f.file === file)?.sites.map((s): [number, string, string] => [s.line, s.tag, s.unresolved ?? "checkbox"]);

  it("reads a key the syntax settles as a name on any value: +, a template, a choice and a number", () => {
    const tree = treeOf({
      "a.tsx": [
        'const A = anything["Check" + "box"];',
        "const B = anything[`Check${\"box\"}`];",
        'const C = anything[on ? "Checkbox" : "Radio"];',
        'const { ["Check" + "box"]: D } = anything;',
        "export const X = () => <><A /><B /><C /><D /></>;",
        'const quiet = rows[0] ?? rows["0"] ?? rows[`a${"b"}`] ?? rows[i];',
      ].join("\n"),
    });
    expect(lines(tree, "a.tsx")).toEqual([
      [5, "A", "checkbox"],
      [5, "B", "checkbox"],
      [5, "C", "checkbox"],
      [5, "D", "checkbox"],
    ]);
  });

  it("makes a computed member and a computed destructuring key of a module object that may export a checkbox a site, anywhere in a chain", () => {
    const tree = treeOf({
      ...BARREL,
      "a.tsx": [
        'import * as P from "./ui";',
        "const C = P[k];",
        "const D = P.parts[k];",
        "const { [k]: E } = P;",
        "const { inner: { [k]: F } } = P;",
        "const Q = P;",
        "const G = Q[k];",
        'const H = (await import("./ui"))[k];',
        'const { [k]: I } = await import("./ui");',
        "const named = P.MenuTick;",
        'const zero = P[0] ?? P["0"] ?? P[`${"M"}enuTick`];',
        'import * as P2 from "./ui/index.js";',
        "const J = P2[k];",
      ].join("\n"),
    });
    expect(lines(tree, "a.tsx")?.map(([l, t]) => [l, t])).toEqual([
      [2, "P[k]"],
      [3, "P.parts[k]"],
      [4, "[k]: E"],
      [5, "[k]: F"],
      [7, "Q[k]"],
      [8, 'import("./ui")'],
      [9, "[k]: I"],
      [13, "P2[k]"],
    ]);
  });

  it("makes a module object handed on whole a site: passed, put in an object, exported, spread or a rest", () => {
    const tree = treeOf({
      ...BARREL,
      "a.tsx": [
        'import * as P from "./ui";',
        "register(P);",
        "export const all = { P };",
        "export { P };",
        "export default P;",
        "export const Again = P;",
        "const spread = { ...P };",
        "const { MenuTick, ...rest } = P;",
        "use(rest);",
        'export * as Whole from "./ui";',
        "type T = typeof P;",
      ].join("\n"),
    });
    expect(lines(tree, "a.tsx")?.map(([l, t, why]) => [l, t, why.replace(/^a use of (the module object \w+|the module \S+) /, "")])).toEqual([
      [2, "P", "used as a value, whose exports no name follows"],
      [3, "P", "put in an object, whose exports no name follows"],
      [4, "P", "exported on, whose exports no name follows"],
      [5, "export default P;", "exported as the default export, whose exports no name follows"],
      [6, "Again", "exported on, whose exports no name follows"],
      [7, "P", "used as a value, whose exports no name follows"],
      [9, "rest", "used as a value, whose exports no name follows"],
      [10, 'export * as Whole from "./ui";', "exported whole as Whole, which no name follows"],
    ]);
  });

  it("follows a module outside the tree as one that may export a checkbox, but not a Node built-in, and not a module of the tree that exports none", () => {
    const tree = treeOf({
      "plain.ts": "export const x = 1;\n",
      "a.tsx": [
        'import * as R from "some-kit";',
        'import * as path from "node:path";',
        'import * as fs from "fs";',
        'import * as plain from "./plain";',
        "const C = R[k];",
        "join(path, fs, plain, plain[k]);",
        'const T = require("some-kit")[k];',
        'const L = require("./plain")[k];',
        'const N = await import("some-kit");',
        "use(N[k]);",
      ].join("\n"),
    });
    expect(lines(tree, "a.tsx")?.map(([l, t]) => [l, t])).toEqual([
      [5, "R[k]"],
      [7, 'require("some-kit")[k]'],
      [10, "N[k]"],
    ]);
    // A computed member of a load outside the tree hands its module object on unnamed: a load the reading must name.
    expect(tree.files.find((f) => f.file === "a.tsx")?.loads).toEqual(["some-kit"]);
  });

  it("resolves a workspace specifier through the package's entries, a * entry included, and falls back to the file name", () => {
    const pkg = JSON.stringify({ exports: { ".": "./src/index.ts", "./menu": { types: "./src/menu-parts.tsx", default: "./src/menu-parts.tsx" }, "./x/*": "./src/x/*-part.ts", "./f": "./src/f", "./store": "./src/store.ts" } });
    const texts = {
      "packages/kit/src/menu-parts.tsx": 'export { CheckboxItem as MenuTick } from "@radix-ui/react-dropdown-menu";\n',
      "packages/kit/src/x/tick-part.ts": 'export { Root as Tick } from "@radix-ui/react-checkbox";\n',
      "packages/kit/src/f/index.ts": 'export { Root as FTick } from "@radix-ui/react-checkbox";\n',
      "packages/kit/src/store.ts": "export const read = () => 1;\n",
      "packages/kit/src/index.ts": "export const v = 1;\n",
      "packages/kit/src/menu-parts2.tsx": "export const y = 1;\n",
      "a.tsx": [
        'import * as M from "@cinatra-ai/kit/menu";',
        'import * as T from "@cinatra-ai/kit/x/tick";',
        'import * as S from "@cinatra-ai/kit/store";',
        'import * as K from "@cinatra-ai/kit";',
        'import * as U from "@cinatra-ai/kit/menu-parts";',
        'import * as F from "@cinatra-ai/kit/f";',
        "use(M[k], T[k], S[k], K[k], U[k], F[k]);",
      ].join("\n"),
    };
    const tree = scanSources(new Map(Object.entries(texts)), new Map([["kit", packageEntriesOf("kit", pkg)!]]));
    expect(lines(tree, "a.tsx")?.map(([, t]) => t)).toEqual(["M[k]", "T[k]", "U[k]", "F[k]"]);
    const unknown = scanSources(new Map(Object.entries(texts)));
    expect(lines(unknown, "a.tsx")?.map(([, t]) => t)).toEqual(["M[k]", "T[k]", "S[k]", "K[k]", "U[k]", "F[k]"]);
    expect(packageEntriesOf("kit", "not json")).toBe(null);
    expect([...packageEntriesOf("kit", JSON.stringify({ main: "./src/main.ts" }))!]).toEqual([[".", ["packages/kit/src/main.ts"]]]);
  });

  it("resolves a specifier through the root tsconfig's path aliases first; a target outside src/ and packages/ is outside the tree", () => {
    const tsconfig = '{\n  // aliases\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], "@kit/prims": ["./src/lib/prims.ts"], "@kit/ext": ["./extensions/x/index.ts"], "@kit/plain": ["./src/lib/plain.ts"] } }\n}\n';
    const texts = {
      "src/lib/prims.ts": 'export { Root as Tick } from "@radix-ui/react-checkbox";\n',
      "src/lib/plain.ts": "export const p = 1;\n",
      "src/a.tsx": [
        'import * as A from "@kit/prims";',
        'import * as B from "@kit/ext";',
        'import * as C from "@kit/plain";',
        'import * as D from "@/lib/prims";',
        "use(A[k], B[k], C[k], D[k]);",
      ].join("\n"),
    };
    const tree = scanSources(new Map(Object.entries(texts)), new Map(), pathAliasesOf(tsconfig));
    expect(lines(tree, "src/a.tsx")?.map(([, t]) => t)).toEqual(["A[k]", "B[k]", "D[k]"]);
    expect([...pathAliasesOf("{}")]).toEqual([]);
  });

  it("records every load of a module outside the tree that binds no name, and no other load", () => {
    const text = [
      'const A = lazy(() => import("some-kit/a"));',
      'const list = [import("some-kit/b")];',
      'import("some-kit/c").then((m) => m.run());',
      'const bound = await import("some-kit/d");',
      'const { named } = await import("some-kit/e");',
      'const read = (await import("some-kit/f")).g;',
      'const settled = require("some-kit/h")["i"];',
      'const builtin = () => import("node:fs");',
      "const local = () => import(\"./local\");",
      'const computed = require("some-kit/j")[k];',
    ].join("\n");
    const tree = treeOf({ "a.ts": text, "local.ts": "export const z = 1;\n" });
    expect(tree.files.find((f) => f.file === "a.ts")?.loads).toEqual(["some-kit/a", "some-kit/b", "some-kit/c", "some-kit/j"]);
    expect(tree.files.some((f) => f.file === "local.ts")).toBe(false);
  });

  it("holds a file's loads to its reading: their number, the pattern each matches and a sentence", () => {
    const text = 'export const A = lazy(() => import("some-kit/a"));\nexport const B = lazy(() => import("some-kit/b"));\n';
    const tree = treeOf({ "a.ts": text });
    const check = (loads?: FileReading["loads"]) => readingProblems([{ file: "a.ts", tokens: 0, sites: [], ...(loads ? { loads } : {}) }], tree, reader({ "a.ts": text })).join("\n");
    const good = { count: 2, modules: "some-kit/[ab]", reading: "two lazy pages of the kit, which draw their own rows" };
    expect(check(good)).toBe("");
    expect(check()).toContain("a.ts: loads 2 module(s) outside the tree without a binding, which the reading must name in loads");
    expect(check({ ...good, count: 1 })).toContain("the reading was recorded at 1: read the file again");
    expect(check({ ...good, modules: "some-kit/a" })).toContain("a.ts: loads some-kit/b, which the recorded loads pattern does not cover");
    expect(check({ ...good, modules: "(" })).toContain("a.ts: the loads pattern is no regular expression");
    expect(check({ ...good, modules: " " })).toContain("a.ts: the loads pattern is no regular expression");
    expect(check({ ...good, reading: "lazy" })).toContain("a.ts: the loads reading is not a sentence");
    const none = treeOf({ "b.tsx": '<Checkbox id="a" />;\n' });
    const extra = readingProblems([{ file: "b.tsx", tokens: 1, sites: [{ ...CONFIRMED_A, fileIncludes: [], effect: "none", drawn: "checkbox" }], loads: good }], none, reader({ "b.tsx": '<Checkbox id="a" />;\n' }));
    expect(extra.join("\n")).toContain("b.tsx: the reading records loads, the file loads no module outside the tree without a binding");
  });

  it("finds a call site of a shared component through a computed member of a module object that exports it", () => {
    const files = { "picker.tsx": "export function AccessPicker() { return null; }\n", "a.tsx": 'import * as Kit from "./picker";\nconst C = Kit[k];\nuse(Kit["Access" + "Picker"]);\n' };
    const found = findCallers(Object.keys(files), reader(files), "AccessPicker");
    expect(found.unresolved).toEqual([
      "a.tsx:2: a use of a computed member of the module object Kit, which no name follows",
      "a.tsx:3: a use of Kit[\"Access\" + \"Picker\"] that is no JSX tag, import, export, declaration, type or alias",
    ]);
  });

  it("takes checkbox in any letter case in a tag and a component name, and counts a CheckBox token (G2)", () => {
    const tree = treeOf({
      "a.tsx": 'import { CheckBox as Tick } from "some-kit";\nexport const X = () => <><md-checkbox checked /><sl-checkbox /><CheckBox onChange={f} /><Tick /><UI.CHECKBOX /></>;\nconst checkboxRow = 1;\n',
    });
    expect(lines(tree, "a.tsx")?.map(([, t]) => t)).toEqual(["md-checkbox", "sl-checkbox", "CheckBox", "Tick", "UI.CHECKBOX"]);
    expect(countCheckboxTokens("<CheckBox /><CHECKBOX /><Checkbox /> checkboxRow")).toBe(3);
    // A quoted word in any letter case stays a token by its own rule, also where no capital C starts it.
    expect(countCheckboxTokens("role=\"checkBOX\" type='cHECKBOX'")).toBe(2);
  });
});

describe("values from outside the tree: no import, load or call of one hands a checkbox on unread (GAP 1), and no lower-case name hides one (GAP 2)", () => {
  const tags = (tree: ScannedTree, file: string) => tree.files.find((f) => f.file === file)?.sites.map((s) => s.tag);
  const sitesOf = (tree: ScannedTree, file: string) => tree.files.find((f) => f.file === file)?.sites.map((s): [number, string] => [s.line, s.unresolved ?? "checkbox"]);

  it("makes a computed member of a default or named import, of .default of a load, of a destructured default and of a call result outside the tree a site", () => {
    const tree = treeOf({
      "a.tsx": [
        'import UI from "@acme/ui";',
        'import { registry, makeUi } from "@acme/ui";',
        "const made = makeUi().parts;",
        "use(UI[k], registry[k], made[k]);",
        'const a = async () => (await import("@acme/ui")).default[k];',
        'const b = () => require("@acme/ui").default[k];',
        'const { default: D } = await import("@acme/ui");',
        "use(D[k]);",
        "const { [k]: E } = registry;",
        "const named = registry.Tick ?? UI.parts.Tick ?? registry[0];",
      ].join("\n"),
    });
    expect(sitesOf(tree, "a.tsx")).toEqual([
      [4, "a use of a computed member of UI, a value from outside the tree, which no name follows"],
      [4, "a use of a computed member of registry, a value from outside the tree, which no name follows"],
      [4, "a use of a computed member of made, a value from outside the tree, which no name follows"],
      [5, 'a use of a computed member of (await import("@acme/ui")), a value from outside the tree, which no name follows'],
      [6, 'a use of a computed member of require("@acme/ui"), a value from outside the tree, which no name follows'],
      [8, "a use of a computed member of D, a value from outside the tree, which no name follows"],
      [9, "a use of a computed key destructured from a module object or a value from outside the tree, which no name follows"],
    ]);
  });

  it("follows what React's hooks hand back to their arguments: state of the tree stays out, a context of an outside module is in", () => {
    const tree = treeOf({
      "a.tsx": [
        'import { useState, useMemo, useRef, useContext } from "react";',
        'import { Ctx, makeUi } from "@acme/ui";',
        "const [rows] = useState<Record<string, number>>({});",
        "const memo = useMemo(() => ({ a: 1 }), []);",
        "const ref = useRef(null);",
        "const v = useContext(Ctx);",
        "const parts = useMemo(() => { return makeUi(); }, []);",
        "use(rows[k], memo[k], ref.current[k], v[k], parts[k]);",
      ].join("\n"),
    });
    expect(tags(tree, "a.tsx")).toEqual(["v[k]", "parts[k]"]);
  });

  it("leaves a value of the tree and a Node built-in out", () => {
    const tree = treeOf({
      "plain.ts": "export const table = { a: 1 };\n",
      "a.ts": ['import { table } from "./plain";', 'import { sep } from "node:path";', 'import os from "os";', "const local = { a: 1 };", "use(table[k], sep[k], os[k], local[k], props[k]);"].join("\n"),
    });
    expect(tree.files.some((f) => f.file === "a.ts")).toBe(false);
  });

  it("follows an outside module through a tree barrel and a name a tree file exports an outside value under", () => {
    const tree = treeOf({
      "ui/index.ts": 'export * from "@acme/ui";\n',
      "outer/index.ts": 'export * from "../ui";\n',
      "kit.ts": 'import { makeUi } from "@acme/ui";\nexport const ui = makeUi();\n',
      "re.ts": 'export { registry as reg } from "@acme/ui";\n',
      "whole.ts": 'export * as Whole from "@acme/ui";\n',
      "a.tsx": [
        'import * as UI from "./ui";',
        'import { registry } from "./ui";',
        'import { deep } from "./outer";',
        'import { ui } from "./kit";',
        'import { reg } from "./re";',
        "use(UI[k], registry[k], deep[k], ui[k], reg[k]);",
      ].join("\n"),
    });
    expect(tags(tree, "a.tsx")).toEqual(["UI[k]", "registry[k]", "deep[k]", "ui[k]", "reg[k]"]);
    // The barrel that re-exports an outside module whole may export a checkbox: its namespace import is a module object.
    expect(sitesOf(tree, "a.tsx")?.[0]).toEqual([6, "a use of a computed member of the module object UI, which no name follows"]);
    expect(tags(tree, "whole.ts")).toEqual(['export * as Whole from "@acme/ui";']);
  });

  it("follows a value from outside the tree through each branch of a choice (? :, ||, ??, &&) and through new", () => {
    const tree = treeOf({
      "a.tsx": [
        'import { makeUi, Kit } from "@acme/ui";',
        "const A = on ? makeUi() : null;",
        "const B = on ? null : makeUi();",
        "const C = fallback || makeUi();",
        "const D = makeUi() || fallback;",
        "const E = fallback ?? makeUi();",
        "const F = ready && makeUi();",
        "const G = new Kit();",
        "const H = on ? local : other;",
        "use(A[k], B[k], C[k], D[k], E[k], F[k], G[k], H[k]);",
      ].join("\n"),
    });
    expect(tags(tree, "a.tsx")).toEqual(["A[k]", "B[k]", "C[k]", "D[k]", "E[k]", "F[k]", "G[k]"]);
  });

  it("reads a site in each branch of a choice from its own ? or : on", () => {
    const tree = treeOf({ "a.ts": 'import { UI } from "@acme/ui";\nuse(on ? UI[k] : UI[j]);\n' });
    expect(tree.files.find((f) => f.file === "a.ts")?.sites.map((s) => s.openingTag)).toEqual(["? UI[k]", ": UI[j]"]);
  });

  it("records every load whose specifier is no string, bound or not", () => {
    const tree = treeOf({
      "a.ts": ["const m = await import(spec);", "const n = require(name);", "const L = lazy(() => import(`./pages/${p}`));", "use(m, n, L, m[k]);"].join("\n"),
    });
    expect(tree.files.find((f) => f.file === "a.ts")?.loads).toEqual(["import(spec)", "require(name)", "import(`./pages/${p}`)"]);
    // A module the syntax does not name is from outside the tree: a computed member of it is a site too.
    expect(tags(tree, "a.ts")).toEqual(["m[k]"]);
  });

  it("takes a checkbox name from a lower-case letter: an import, a member, a key and an in-tree export (GAP 2)", () => {
    const tree = treeOf({
      "kit.ts": "export const checkbox = () => null;\n",
      "a.tsx": [
        'import { checkbox as A } from "@acme/kit";',
        'import * as Kit from "@acme/kit";',
        'import { checkbox as D } from "./kit";',
        "const B = Kit.checkbox;",
        "const { checkbox: C } = Kit;",
        "export const X = () => <><A /><B /><C /><D /></>;",
      ].join("\n"),
    });
    expect(tags(tree, "a.tsx")).toEqual(["A", "B", "C", "D"]);
    // The file that defines a lower-case checkbox is in scope though no token spells it.
    expect(tree.files.find((f) => f.file === "kit.ts")).toEqual({ file: "kit.ts", tokens: 0, sites: [], loads: [] });
  });
});

describe("code: a comment, a string or a template is no evidence (MF4)", () => {
  it("finds a pinned text in code, and not in a comment after a label, a block comment, a JSX comment, a string or a template", () => {
    const sf = parseSource(
      "f.tsx",
      [
        "proof:// await save(formData);",
        "/* await send(formData); */",
        "const s = 'await keep(formData);';",
        "const t = `await hold(formData);`;",
        "const X = () => <div>{/* await post(formData); */}https://x // await text(formData);</div>;",
        "await real(formData);",
      ].join("\n"),
    );
    for (const pin of ["await save(formData);", "await send(formData);", "await keep(formData);", "await hold(formData);", "await post(formData);"]) {
      expect([pin, standsInCode(sf, pin)]).toEqual([pin, false]);
    }
    expect(standsInCode(sf, "await real(formData);")).toBe(true);
    expect(standsInCode(sf, "await text(formData);")).toBe(true);
    expect(standsInCode(sf, "const s = 'await keep(formData);';")).toBe(true);
  });
});

describe("the listing: the whole tree or an error, never an empty result (rule 1)", () => {
  function inTempRepo(run: (root: string) => void, init = true) {
    const root = mkdtempSync(path.join(tmpdir(), "cinatra-4297-"));
    try {
      if (init) execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("lists a new, untracked source file of every extension, .mts and .cts included, one right under a root too, and leaves an ignored one out", () => {
    inTempRepo((root) => {
      mkdirSync(path.join(root, "src/a"), { recursive: true });
      mkdirSync(path.join(root, "packages/p/src"), { recursive: true });
      writeFileSync(path.join(root, "src/a/new.tsx"), "export const X = () => <Checkbox />;\n");
      writeFileSync(path.join(root, "packages/p/src/b.ts"), "export const y = 1;\n");
      writeFileSync(path.join(root, "packages/p/src/c.mts"), "export { Checkbox as Tick } from './checkbox';\n");
      writeFileSync(path.join(root, "packages/p/src/d.cts"), "export const z = 1;\n");
      writeFileSync(path.join(root, "src/top.ts"), "export const Tick = Checkbox;\n");
      writeFileSync(path.join(root, ".gitignore"), "src/a/ignored.tsx\n");
      writeFileSync(path.join(root, "src/a/ignored.tsx"), "export const Z = () => <Checkbox />;\n");
      expect(listSourceFiles(root)).toEqual(["packages/p/src/b.ts", "packages/p/src/c.mts", "packages/p/src/d.cts", "src/a/new.tsx", "src/top.ts"]);
      expect(scanTree(root).files.map((f) => f.file)).toEqual(["packages/p/src/c.mts", "src/a/new.tsx", "src/top.ts"]);
    });
  });

  it("throws on a folder that is no git repository, on an empty listing and on a listed file that is gone", () => {
    inTempRepo((root) => expect(() => listSourceFiles(root)).toThrow(), false);
    inTempRepo((root) => expect(() => listSourceFiles(root)).toThrow("listed no source file"));
    inTempRepo((root) => {
      mkdirSync(path.join(root, "src"), { recursive: true });
      expect(() => scanTree(root, ["src/gone.tsx"])).toThrow();
    });
  });
});

describe("the check refuses every reading that is not true (rules 6 and 7)", () => {
  it("passes a true reading", () => {
    expect(problemsOf(FORM, [CONFIRMED_A])).toBe("");
  });

  it("refuses a file that refers to a checkbox and has no reading, and a reading whose file no longer does", () => {
    expect(readingProblems([], treeOf({ "f.tsx": FORM }), reader({ "f.tsx": FORM })).join("\n")).toContain("has no recorded reading");
    expect(readingProblems([reading("f.tsx", 1, [CONFIRMED_A])], treeOf({}), reader({})).join("\n")).toContain("no longer refers to a checkbox");
  });

  it("refuses a file recorded twice, a changed token count and a changed number of sites", () => {
    const text = `${FORM}\nconst Hidden = Primitives["Check" + "box"]; // Checkbox`;
    const tree = treeOf({ "f.tsx": text });
    const r = reading("f.tsx", countCheckboxTokens(FORM), [CONFIRMED_A]);
    const problems = readingProblems([r, r], tree, reader({ "f.tsx": text })).join("\n");
    expect(problems).toContain("f.tsx: recorded twice");
    expect(problems).toContain("read the file again");
    expect(problemsOf(`${FORM}\n;<Checkbox id="b" />`, [CONFIRMED_A])).toContain("2 checkbox site(s) found, 1 recorded");
  });

  it("refuses one site swapped for another in the same file (identity, not counts)", () => {
    const text = '<form><Checkbox id="b" onCheckedChange={(v) => save(v)} />\n<Button type="submit">Save</Button></form>';
    expect(problemsOf(text, [CONFIRMED_A])).toContain('anchor "id=\\"a\\"" stands in 0 site(s)');
  });

  it("refuses an anchor in two sites, two readings of one site and a wrong tag", () => {
    const two = '<form><Checkbox id="a1" /><Checkbox id="a2" />\n<Button type="submit">Save</Button></form>';
    expect(problemsOf(two, [{ ...CONFIRMED_A, anchor: 'id="a' }, { ...CONFIRMED_A, anchor: 'id="a2"' }])).toContain("stands in 2 site(s)");
    expect(problemsOf(two, [{ ...CONFIRMED_A, anchor: 'id="a2"' }, { ...CONFIRMED_A, anchor: "a2" }])).toContain("two readings name the site at line 1");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, tag: "Switch" }])).toContain("the tag is Checkbox, the reading says Switch");
  });

  it("refuses every handler and spread the reading does not name, white space before = included, a pinned tag text that is gone and a confirm control that is gone", () => {
    for (const handler of ["onCheckedChange", "onChange", "onSelect", "onClick", "onKeyDown"]) {
      for (const text of [`<form><Checkbox id="a" ${handler}={(v) => save(v)} /></form>`, `<form><Checkbox id="a" ${handler} = {(v) => save(v)} /></form>`]) {
        const problems = problemsOf(text, [{ ...CONFIRMED_A, tagIncludes: ["disabled"] }]);
        expect(problems).toContain(`has ${handler}, which the reading must name in tagIncludes`);
        expect(problems).toContain('the opening tag no longer holds "disabled"');
        expect(problems).toContain('f.tsx no longer holds "type=\\"submit\\""');
        expect(problemsOf(text, [{ ...CONFIRMED_A, tagIncludes: [`${handler}=`] }])).toContain(`has ${handler}, which`);
      }
    }
    const spread = '<form><Checkbox id="a" {...rest} />\n<Button type="submit">Save</Button></form>';
    expect(problemsOf(spread, [CONFIRMED_A])).toContain("has {...rest}, which the reading must name in tagIncludes");
    expect(problemsOf(spread, [{ ...CONFIRMED_A, tagIncludes: ["{..."] }])).toContain("has {...rest}, which");
    expect(problemsOf(spread, [{ ...CONFIRMED_A, tagIncludes: ["{...rest}"] }])).toBe("");
    expect(problemsOf('<form><Checkbox id="a" onChange = {f} />\n<Button type="submit">Save</Button></form>', [{ ...CONFIRMED_A, tagIncludes: ["onChange = {f}"] }])).toBe("");
  });

  it("refuses an immediate-effect site drawn as a checkbox with no reason, or with a blank one", () => {
    const text = '<Checkbox id="a" onCheckedChange={(v) => saveNow(v)} />';
    const site: SiteReading = {
      ...CONFIRMED_A,
      effect: "immediate",
      reading: "a setting written the moment it changes",
      tagIncludes: ["onCheckedChange={(v) => saveNow(v)}"],
      fileIncludes: [],
    };
    expect(problemsOf(text, [site])).toContain("with no recorded reason it stays");
    expect(problemsOf(text, [{ ...site, staysBecause: "   " }])).toContain("with no recorded reason it stays");
    expect(problemsOf(text, [{ ...site, staysBecause: "a stated reason, long enough to be one" }])).toBe("");
  });

  it("refuses a switch claimed where a checkbox is drawn or a switch stands only in a string, a checkbox claimed where a switch is drawn, and no checkbox claimed for a checkbox (MF4)", () => {
    const row = (inner: string) =>
      `<DropdownMenuCheckboxItem checked={on} onCheckedChange={(c) => toggle(c)}>${inner}Row</DropdownMenuCheckboxItem>`;
    const site: SiteReading = {
      anchor: "onCheckedChange={(c) => toggle(c)}",
      tag: "DropdownMenuCheckboxItem",
      drawn: "switch",
      effect: "immediate",
      reading: "a menu row whose change applies at once",
      tagIncludes: ["onCheckedChange={(c) => toggle(c)}"],
      fileIncludes: [],
    };
    const inner = { ...CONFIRMED_A, anchor: "<Checkbox checked={on} />", effect: "none" as const, fileIncludes: [] };
    expect(problemsOf(row("<Checkbox checked={on} />"), [site, inner])).toContain("the reading says a switch is drawn, the element draws none");
    expect(problemsOf(row("<Switch checked={on} />"), [site])).toBe("");
    const inString = problemsOf(row("{`<Switch checked={on} />`}"), [{ ...site, fileIncludes: ["<Switch checked={on} />"] }]);
    expect(inString).toContain("the reading says a switch is drawn, the element draws none");
    expect(inString).toContain("only in a comment, a string or a template; pin the code");
    expect(problemsOf(row("<Switch checked={on} />"), [{ ...site, drawn: "checkbox", staysBecause: "a reason that is long enough" }])).toContain(
      "the element draws a switch, the reading says a checkbox",
    );
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, drawn: "no checkbox", effect: "none" }])).toContain('"no checkbox" is only for an unresolved site');
  });

  it("refuses a confirmed reading that pins no confirm, a reading that is no sentence, an effect that is none of the three, a no-checkbox reading with an effect, and mentions beside sites", () => {
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, fileIncludes: [] }])).toContain("must pin the confirm control");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, reading: "short" }])).toContain("the reading is not a sentence");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, effect: "later" as never }])).toContain('the effect "later" is not one of immediate, confirmed, none');
    const unresolved = "export const X = ({ p }) => <input {...p} />;";
    const open: SiteReading = { ...CONFIRMED_A, anchor: "{...p}", tag: "input", drawn: "no checkbox", effect: "confirmed", tagIncludes: ["{...p}"], fileIncludes: ["{...p}"] };
    expect(problemsOf(unresolved, [open])).toContain("an element that draws no checkbox has the effect none");
    expect(problemsOf(unresolved, [{ ...open, effect: "none", fileIncludes: [] }])).toBe("");
    expect(problemsOf(FORM, [CONFIRMED_A], {}, "a sentence that is long enough to be one")).toContain("mentions is only for a file with no site");
  });

  it("refuses every empty text: anchor, mentions, a pinned text, a tag text, an evidence entry, a reason", () => {
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, anchor: "" }])).toContain("a reading has an empty anchor");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, anchor: "  " }])).toContain("a reading has an empty anchor");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, fileIncludes: [""] }])).toContain("a pinned text or its file is empty");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, tagIncludes: [" "] }])).toContain("a tagIncludes text is empty");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, evidence: [{ file: "", text: "" }] }])).toContain("a pinned text or its file is empty");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, staysBecause: " " }])).toContain("the reason it stays is not a sentence");
    const mention = "const s = '[role=checkbox]';";
    expect(problemsOf(mention, [], {}, " ")).toContain("must say in a sentence what its tokens are");
    expect(problemsOf(mention, [])).toContain("must say in a sentence what its tokens are");
    expect(problemsOf(mention, [], {}, "a layout selector for a cell that holds a checkbox")).toBe("");
  });

  it("refuses a pinned text that stands only in a comment, a string or a template, in the file or in other evidence (MF4)", () => {
    const text = '<form><Checkbox id="a" />\n{/* the <Button type="submit"> below saves it */}</form>';
    expect(problemsOf(text, [CONFIRMED_A])).toContain("only in a comment, a string or a template; pin the code");
    const site = { ...CONFIRMED_A, fileIncludes: [], evidence: [{ file: "g.ts", text: "await save(formData);" }] };
    expect(problemsOf(FORM, [site], { "g.ts": "// await save(formData);\n" })).toContain("pin the code");
    expect(problemsOf(FORM, [site], { "g.ts": "proof:// await save(formData);\nfoo();\n" })).toContain("pin the code");
    expect(problemsOf(FORM, [site], { "g.ts": "const t = `await save(formData);`;\n" })).toContain("pin the code");
    expect(problemsOf(FORM, [site], { "g.ts": "async function f() {\n  await save(formData);\n}\n" })).toBe("");
    expect(problemsOf(FORM, [site], { "g.ts": "nothing" })).toContain('g.ts no longer holds "await save(formData);"');
    expect(problemsOf(FORM, [{ ...site, evidence: [{ file: "missing.ts", text: "x" }] }])).toContain("the file missing.ts cannot be read");
  });
});

describe("callers: each call site is found under every name, and every reading of one is true (MF1)", () => {
  const MULTIPLE = { attribute: "selectionMode", values: ["multiple"] };
  const set = (callers: CallerReading[], why = "the callers of the picker in its multi-select mode"): ComponentCallers => ({
    component: "AccessCombobox",
    callerWhen: MULTIPLE,
    why,
    callers,
  });
  const caller = (file: string, extra: Partial<CallerReading> = {}): CallerReading => ({
    file,
    anchor: 'id="one"',
    effect: "confirmed",
    reading: "a picker whose change the form's Save writes",
    fileIncludes: ["<Save />"],
    ...extra,
  });

  it("finds a call site by its own name, a renamed import, a renamed re-export, a namespace, a local alias and every mode form", () => {
    const texts: Record<string, string> = {
      "a.tsx": "<AccessCombobox selectionMode=\"multiple\" onChange={f} />",
      "b.tsx": "import { AccessCombobox as ScopePicker } from './p';\n<ScopePicker selectionMode='multiple' />",
      "c.tsx": "export { AccessCombobox as Picker } from './p';",
      "d.tsx": "import { Picker } from './c';\n<Picker selectionMode={'multiple'} />",
      "e.tsx": "import * as UI from './p';\n<UI.AccessCombobox selectionMode={mode} />",
      "f.tsx": "<AccessCombobox {...props} />",
      "g.tsx": "<AccessCombobox value={v} onValueChange={f} />",
      "h.tsx": "<AccessComboboxMultiSelect {...props} />",
      "i.tsx": "const Local = AccessCombobox;\nexport const X = () => <Local selectionMode=\"multiple\" />;",
      "k.tsx": "<AccessCombobox {...props} selectionMode=\"single\" />",
      "l.tsx": "<AccessCombobox selectionMode={wide ? \"multiple\" : \"single\"} />",
      "m.tsx": "<AccessCombobox selectionMode={wide ? \"single\" : undefined} />",
      "n.mts": "import { AccessCombobox } from './p';\nexport const Wide = AccessCombobox;",
      "o.tsx": "import { Wide } from './n.mjs';\n<Wide selectionMode=\"multiple\" />",
    };
    const found = findCallers(Object.keys(texts), reader(texts), "AccessCombobox", MULTIPLE);
    expect(found.sites.map((s) => `${s.file}:${s.line} <${s.tag}`)).toEqual([
      "a.tsx:1 <AccessCombobox",
      "b.tsx:2 <ScopePicker",
      "d.tsx:2 <Picker",
      "e.tsx:2 <UI.AccessCombobox",
      "f.tsx:1 <AccessCombobox",
      "i.tsx:2 <Local",
      "l.tsx:1 <AccessCombobox",
      "o.tsx:2 <Wide",
    ]);
    expect(found.exported).toEqual(["Picker", "Wide"]);
    expect(found.unresolved).toEqual([]);
  });

  it("refuses a use of the component it cannot follow and a default export, and lets an import, a type, a comment and a string pass", () => {
    const texts: Record<string, string> = {
      "a.tsx": "import { AccessCombobox } from './p';\nconst map = { picker: AccessCombobox };",
      "b.tsx": "import React from 'react';\nReact.createElement(AccessCombobox, { selectionMode: 'multiple' });",
      "c.tsx": "import { AccessCombobox } from './p';\ntype P = React.ComponentProps<typeof AccessCombobox>;\n// AccessCombobox in a comment\nconst label = \"the AccessCombobox picker\";",
      "d.tsx": "export function AccessCombobox(props: Props) { return null; }",
      "e.tsx": 'const s = "a\\"b"; const m = { picker: AccessCombobox };',
      "f.tsx": "export default AccessCombobox;",
      "g.tsx": "<AccessCombobox selectionMode=\"multiple\"",
    };
    const found = findCallers(Object.keys(texts), reader(texts), "AccessCombobox", MULTIPLE);
    const use = "a use of AccessCombobox that is no JSX tag, import, export, declaration, type or alias";
    expect(found.unresolved.filter((u) => !u.startsWith("g.tsx"))).toEqual([
      "f.tsx:1: exports AccessCombobox as its default export, which no name follows",
      `a.tsx:2: ${use}`,
      `b.tsx:2: ${use}`,
      `e.tsx:1: ${use}`,
    ]);
    expect(found.unresolved.some((u) => u.startsWith("g.tsx:1: ") && u.endsWith("the file does not parse"))).toBe(true);
    expect(callerProblems(set([]), found, reader(texts)).join("\n")).toContain(`a.tsx:2: ${use}`);
  });

  it("needs one reading per call site: two calls in one file are two readings (MF1)", () => {
    const texts: Record<string, string> = {
      "a.tsx": '<><AccessCombobox selectionMode="multiple" id="one" />\n<AccessCombobox selectionMode="multiple" id="two" onChange={saveNow} /></>;\n<Save />',
    };
    const found = findCallers(["a.tsx"], reader(texts), "AccessCombobox", MULTIPLE);
    expect(found.sites.map((s) => s.line)).toEqual([1, 2]);
    expect(callerProblems(set([caller("a.tsx")]), found, reader(texts)).join("\n")).toContain("a.tsx:2: a call site of AccessCombobox with no recorded reading");
    const both = [caller("a.tsx"), caller("a.tsx", { anchor: 'id="two"', effect: "immediate", reading: "a filter that applies at once", staysBecause: "a stated reason, long enough to be one" })];
    expect(callerProblems(set(both), found, reader(texts))).toEqual([]);
    expect(callerProblems(set([caller("a.tsx"), caller("a.tsx", { anchor: "one" })]), found, reader(texts)).join("\n")).toContain(
      "a.tsx:1: two readings name this call site of AccessCombobox",
    );
    expect(callerProblems(set([caller("a.tsx", { anchor: "selectionMode" })]), found, reader(texts)).join("\n")).toContain("stands in 2 call site(s), not one");
  });

  it("refuses an unread call site, a recorded non-caller and every empty or false caller reading", () => {
    const texts: Record<string, string> = {
      "a.tsx": '<AccessCombobox selectionMode="multiple" id="one" />;\n<Save />',
      "b.tsx": '<AccessCombobox selectionMode="multiple" />',
      "c.tsx": "<Save />",
    };
    const found = findCallers(Object.keys(texts), reader(texts), "AccessCombobox", MULTIPLE);
    const problems = callerProblems(set([caller("a.tsx", { reading: "" }), caller("c.tsx")]), found, reader(texts)).join("\n");
    expect(problems).toContain("b.tsx:1: a call site of AccessCombobox with no recorded reading");
    expect(problems).toContain("c.tsx (caller of AccessCombobox): recorded as a caller, but it is not one");
    expect(problems).toContain("a.tsx (caller of AccessCombobox): the reading is not a sentence");

    const one = (c: CallerReading) => callerProblems(set([c]), findCallers(["a.tsx"], reader(texts), "AccessCombobox", MULTIPLE), reader(texts)).join("\n");
    expect(one(caller("a.tsx"))).toBe("");
    expect(one(caller("a.tsx", { anchor: " " }))).toContain("a caller reading has an empty anchor");
    expect(one(caller("a.tsx", { anchor: 'id="gone"' }))).toContain("stands in 0 call site(s), not one");
    expect(one(caller("a.tsx", { effect: "later" as never }))).toContain('the effect "later" is not one of immediate, confirmed, none');
    expect(one(caller("a.tsx", { fileIncludes: [] }))).toContain("a confirmed reading must pin its confirm");
    expect(one(caller("a.tsx", { fileIncludes: [""] }))).toContain("a pinned text or its file is empty");
    expect(one(caller("a.tsx", { fileIncludes: ["<Gone />"] }))).toContain('a.tsx no longer holds "<Gone />"');
    expect(one(caller("a.tsx", { effect: "immediate", reading: "a filter that applies at once" }))).toContain("no recorded reason the box stays");
    expect(one(caller("a.tsx", { effect: "immediate", reading: "a filter that applies at once", staysBecause: " " }))).toContain(
      "no recorded reason the box stays",
    );
    expect(callerProblems(set([caller("a.tsx")], "short"), findCallers(["a.tsx"], reader(texts), "AccessCombobox", MULTIPLE), reader(texts)).join("\n")).toContain(
      "say in a sentence why these are its callers",
    );
  });
});
