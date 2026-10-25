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
  exportedAliases,
  findCallers,
  findCheckboxSites,
  isTestPath,
  listSourceFiles,
  readingProblems,
  scanTree,
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
      const found = findCallers(files, readRepo, set.component, set.isCaller);
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
  const map = new Map(Object.entries(texts));
  const { names, defaults } = exportedAliases(map, (n) => n.includes("Checkbox"));
  const files = Object.entries(texts)
    .map(([file, text]) => ({ file, tokens: countCheckboxTokens(text), sites: findCheckboxSites(text, names) }))
    .filter((f) => f.tokens > 0 || f.sites.length > 0);
  return { files, exported: names, defaultExports: defaults };
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

describe("discovery: every form of a checkbox element is found (rule 3)", () => {
  it("names the tags of a namespace import and its aliases", () => {
    const text = 'import * as R from "radix-ui";\nconst C = R.Checkbox;\nconst M = R.DropdownMenu;\nexport const X = () => <><C.Root /><M.CheckboxItem /></>;\n';
    expect(findCheckboxSites(text).map((s) => s.tag)).toEqual(["C.Root", "M.CheckboxItem"]);
  });

  it("names a renamed import and a destructured alias", () => {
    const text =
      'import { Checkbox as Tick } from "@/components/ui/checkbox";\nconst { Checkbox: Box } = Primitives;\nexport const X = () => <div><Tick id="t" /><Box /></div>;\n';
    expect(findCheckboxSites(text).map((s) => s.tag)).toEqual(["Tick", "Box"]);
  });

  it("names a checkbox type or role in any letter case, quoted or in braces, on any element", () => {
    const text =
      'export const X = () => <form><input type="CHECKBOX" name="a" /><input type={\'Checkbox\'} /><div role="checkbox" /><span role=\'MenuItemCheckbox\' /><Input type="checkbox" /><input type="text" /></form>;\n';
    expect(findCheckboxSites(text).map((s) => [s.tag, s.unresolved ?? "checkbox"])).toEqual([
      ["input", "checkbox"],
      ["input", "checkbox"],
      ["div", "checkbox"],
      ["span", "checkbox"],
      ["Input", "checkbox"],
    ]);
    expect(countCheckboxTokens(text)).toBe(5);
  });

  it("names an input whose type is an expression, or that spreads props without a literal type, as unresolved", () => {
    const text =
      'export const X = ({ kind, p }) => <><input type={kind} /><Input {...p} /><SidebarInput {...p} /><input {...p} type="text" /><input type={isOn ? "checkbox" : "text"} /></>;\n';
    expect(findCheckboxSites(text).map((s) => [s.tag, s.unresolved ?? "checkbox"])).toEqual([
      ["input", "its type is the expression {kind}"],
      ["Input", "it has a spread and no literal type"],
      ["SidebarInput", "it has a spread and no literal type"],
      ["input", "checkbox"],
    ]);
  });

  it("follows a name another file exports a checkbox under, and refuses a default export", () => {
    const tree = treeOf({
      "a.tsx": 'export { Checkbox as Tick } from "./checkbox";\nexport const Box = Tick;\n',
      "b.tsx": 'import { Tick } from "./a";\nexport const X = () => <Tick id="t" />;\n',
      "c.tsx": 'import { Box as Square } from "./a";\nexport const Y = () => <Square id="s" />;\n',
      "d.tsx": "import { Checkbox } from './checkbox';\nexport default Checkbox;\n",
    });
    expect([...tree.exported].sort()).toEqual(["Box", "Tick"]);
    expect(tree.files.find((f) => f.file === "b.tsx")?.sites.map((s) => s.tag)).toEqual(["Tick"]);
    expect(tree.files.find((f) => f.file === "c.tsx")?.sites.map((s) => s.tag)).toEqual(["Square"]);
    expect(tree.defaultExports).toEqual(["d.tsx"]);
    expect(readingProblems([], tree, reader({})).join("\n")).toContain("d.tsx: exports a checkbox as its default export");
  });

  it("keeps an opening tag that has no end as a site the check refuses", () => {
    const text = 'const X = () => <Checkbox id="a" onCheckedChange={(v) => set(v)';
    const [site] = findCheckboxSites(text);
    expect(site.unresolved).toBe("its opening tag has no end");
    expect(problemsOf(text, [{ ...CONFIRMED_A, tagIncludes: ["onCheckedChange={(v) => set(v)"], fileIncludes: [], effect: "none" }])).toContain(
      "its opening tag has no end",
    );
  });

  it("reads an opening tag across arrow functions, strings and escaped quotes", () => {
    const text = 'const X = () => <Checkbox onCheckedChange={(v) => set(v === true ? "a>b\\"c" : "c")} id="z" />;\n';
    const [site] = findCheckboxSites(text);
    expect(site.openingTag).toBe('<Checkbox onCheckedChange={(v) => set(v === true ? "a>b\\"c" : "c")} id="z" />');
  });

  it("does not take a comment, a generic or a comparison for a site, but counts their tokens", () => {
    const text = [
      "// a <Checkbox /> in a line comment",
      "/* a <Checkbox> in a block */",
      "type P = React.ComponentProps<typeof CheckboxPrimitive.Root>;",
      "const y = a<Checkbox;",
      "const X = () => <div>{/* <Checkbox /> */}</div>;",
      "const f = <Checkbox,>(value: Checkbox) => value;",
      "const g = <Checkbox extends object>(value: Checkbox) => value;",
      "const x = value// <Checkbox />",
      'const u = "https://example.com/a"; const Z = () => <Checkbox id="real" />;',
    ].join("\n");
    expect(findCheckboxSites(text).map((s) => s.openingTag)).toEqual(['<Checkbox id="real" />']);
    expect(countCheckboxTokens(text)).toBe(11);
  });

  it("reads the children of an element, so a switch drawn inside a checkbox-role row is seen", () => {
    const [site] = findCheckboxSites("const X = () => <DropdownMenuCheckboxItem checked={on}>\n  <Switch checked={on} />\n  Row\n</DropdownMenuCheckboxItem>;\n");
    expect(site.body).toContain("<Switch checked={on} />");
  });

  it("leaves test, mock and stub files out and keeps every other file", () => {
    expect(isTestPath("src/components/ui/__tests__/x.test.tsx")).toBe(true);
    expect(isTestPath("packages/agents/src/x.spec.ts")).toBe(true);
    expect(isTestPath("tests/__stubs__/database.ts")).toBe(true);
    expect(isTestPath("src/__mocks__/next-navigation.ts")).toBe(true);
    expect(isTestPath("src/app/test-run/page.tsx")).toBe(false);
    expect(isTestPath("packages/sdk-ui/src/prompt-field.tsx")).toBe(false);
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

  it("lists a new, untracked source file and leaves an ignored one out", () => {
    inTempRepo((root) => {
      mkdirSync(path.join(root, "src/a"), { recursive: true });
      mkdirSync(path.join(root, "packages/p/src"), { recursive: true });
      writeFileSync(path.join(root, "src/a/new.tsx"), "export const X = () => <Checkbox />;\n");
      writeFileSync(path.join(root, "packages/p/src/b.ts"), "export const y = 1;\n");
      writeFileSync(path.join(root, ".gitignore"), "src/a/ignored.tsx\n");
      writeFileSync(path.join(root, "src/a/ignored.tsx"), "export const Z = () => <Checkbox />;\n");
      expect(listSourceFiles(root)).toEqual(["packages/p/src/b.ts", "src/a/new.tsx"]);
      expect(scanTree(root).files.map((f) => f.file)).toEqual(["src/a/new.tsx"]);
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

describe("the check refuses every reading that is not true (rules 4 and 5)", () => {
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
    expect(problemsOf(`${FORM}\n<Checkbox id="b" />`, [CONFIRMED_A])).toContain("2 checkbox site(s) found, 1 recorded");
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

  it("refuses every handler the reading does not name, a pinned tag text that is gone and a confirm control that is gone", () => {
    for (const handler of ["onCheckedChange", "onChange", "onSelect", "onClick"]) {
      const text = `<form><Checkbox id="a" ${handler}={(v) => save(v)} /></form>`;
      const problems = problemsOf(text, [{ ...CONFIRMED_A, tagIncludes: ["disabled"] }]);
      expect(problems).toContain(`has ${handler}, which the reading must name in tagIncludes`);
      expect(problems).toContain('the opening tag no longer holds "disabled"');
      expect(problems).toContain('f.tsx no longer holds "type=\\"submit\\""');
    }
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

  it("refuses a switch claimed where a checkbox is drawn, a checkbox claimed where a switch is drawn, and no checkbox claimed for a checkbox", () => {
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
    expect(problemsOf(row("<Switch checked={on} />"), [{ ...site, drawn: "checkbox", staysBecause: "a reason that is long enough" }])).toContain(
      "the element draws a switch, the reading says a checkbox",
    );
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, drawn: "no checkbox", effect: "none" }])).toContain('"no checkbox" is only for an unresolved site');
  });

  it("refuses a confirmed reading that pins no confirm, and a reading that is no sentence", () => {
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, fileIncludes: [] }])).toContain("must pin the confirm control");
    expect(problemsOf(FORM, [{ ...CONFIRMED_A, reading: "short" }])).toContain("the reading is not a sentence");
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

  it("refuses a pinned text that stands only in a comment, in the file or in other evidence", () => {
    const text = '<form><Checkbox id="a" />\n{/* the <Button type="submit"> below saves it */}</form>';
    expect(problemsOf(text, [CONFIRMED_A])).toContain("only in a comment; pin the code");
    const site = { ...CONFIRMED_A, fileIncludes: [], evidence: [{ file: "g.ts", text: "await save(formData);" }] };
    expect(problemsOf(FORM, [site], { "g.ts": "// await save(formData);\n" })).toContain("only in a comment; pin the code");
    expect(problemsOf(FORM, [site], { "g.ts": "nothing" })).toContain('g.ts no longer holds "await save(formData);"');
    expect(problemsOf(FORM, [{ ...site, evidence: [{ file: "missing.ts", text: "x" }] }])).toContain("the file missing.ts cannot be read");
  });
});

describe("callers: found under every name, and every reading of one is true (rule 6)", () => {
  const multiple = (tag: string) =>
    /selectionMode\s*=\s*\{?\s*["'`]multiple["'`]/.test(tag) || /selectionMode\s*=\s*\{(?!\s*["'`])/.test(tag) || /\{\s*\.\.\./.test(tag);
  const set = (callers: CallerReading[], why = "the callers of the picker in its multi-select mode"): ComponentCallers => ({
    component: "AccessCombobox",
    isCaller: multiple,
    why,
    callers,
  });
  const caller = (file: string, extra: Partial<CallerReading> = {}): CallerReading => ({
    file,
    effect: "confirmed",
    reading: "a picker whose change the form's Save writes",
    fileIncludes: ["<Save />"],
    ...extra,
  });

  it("finds a caller by its own name, a renamed import, a renamed re-export, a namespace and every mode form", () => {
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
      "j.tsx": "<AccessCombobox selectionMode=\"multiple\"",
    };
    const found = findCallers(Object.keys(texts), reader(texts), "AccessCombobox", multiple);
    expect(found.callers).toEqual(["a.tsx", "b.tsx", "d.tsx", "e.tsx", "f.tsx", "i.tsx", "j.tsx"]);
    expect(found.unresolved).toEqual([]);
  });

  it("refuses a use of the component it cannot follow, and lets an import, a type, a comment and a string pass", () => {
    const texts: Record<string, string> = {
      "a.tsx": "import { AccessCombobox } from './p';\nconst map = { picker: AccessCombobox };",
      "b.tsx": "import React from 'react';\nReact.createElement(AccessCombobox, { selectionMode: 'multiple' });",
      "c.tsx": "import { AccessCombobox } from './p';\ntype P = React.ComponentProps<typeof AccessCombobox>;\n// AccessCombobox in a comment\nconst label = \"the AccessCombobox picker\";",
      "d.tsx": "export function AccessCombobox(props: Props) { return null; }",
    };
    const found = findCallers(Object.keys(texts), reader(texts), "AccessCombobox", multiple);
    expect(found.unresolved).toEqual([
      "a.tsx:2: a use of AccessCombobox that is no JSX tag, import, export, declaration or type",
      "b.tsx:2: a use of AccessCombobox that is no JSX tag, import, export, declaration or type",
    ]);
    expect(callerProblems(set([]), found, reader(texts)).join("\n")).toContain("a.tsx:2: a use of AccessCombobox");
  });

  it("refuses an unread caller, a recorded non-caller, a caller recorded twice and every empty or false caller reading", () => {
    const texts: Record<string, string> = {
      "a.tsx": '<AccessCombobox selectionMode="multiple" />\n<Save />',
      "b.tsx": '<AccessCombobox selectionMode="multiple" />',
      "c.tsx": "<Save />",
    };
    const found = findCallers(Object.keys(texts), reader(texts), "AccessCombobox", multiple);
    const problems = callerProblems(
      set([
        caller("a.tsx"),
        caller("a.tsx", { reading: "" }),
        caller("c.tsx"),
      ]),
      found,
      reader(texts),
    ).join("\n");
    expect(problems).toContain("b.tsx: a caller of AccessCombobox with no recorded reading");
    expect(problems).toContain("a.tsx: recorded twice as a caller of AccessCombobox");
    expect(problems).toContain("c.tsx (caller of AccessCombobox): recorded as a caller, but it is not one");
    expect(problems).toContain("a.tsx (caller of AccessCombobox): the reading is not a sentence");

    const one = (c: CallerReading) => callerProblems(set([c]), findCallers(["a.tsx"], reader(texts), "AccessCombobox", multiple), reader(texts)).join("\n");
    expect(one(caller("a.tsx"))).toBe("");
    expect(one(caller("a.tsx", { fileIncludes: [] }))).toContain("a confirmed reading must pin its confirm");
    expect(one(caller("a.tsx", { fileIncludes: [""] }))).toContain("a pinned text or its file is empty");
    expect(one(caller("a.tsx", { fileIncludes: ["<Gone />"] }))).toContain('a.tsx no longer holds "<Gone />"');
    expect(one(caller("a.tsx", { effect: "immediate", reading: "a filter that applies at once" }))).toContain("no recorded reason the box stays");
    expect(one(caller("a.tsx", { effect: "immediate", reading: "a filter that applies at once", staysBecause: " " }))).toContain(
      "no recorded reason the box stays",
    );
    expect(callerProblems(set([caller("a.tsx")], "short"), findCallers(["a.tsx"], reader(texts), "AccessCombobox", multiple), reader(texts)).join("\n")).toContain(
      "say in a sentence why these are its callers",
    );
  });
});
