// cinatra#4297, Done-when 2 and 3: every checkbox call site of the application
// and the shared packages has a recorded reading of whether its change takes
// effect at once, and each one that does and is drawn as a checkbox is a
// switch or has a recorded reason it stays.
//
//   pnpm exec vitest run --config vitest.config.ts --no-coverage src/components/ui/__tests__/checkbox-call-site-readings-4297.test.ts
//
// The readings are `checkbox-call-site-readings-4297.data.ts`; the scan and the
// check are `checkbox-call-site-scan.ts`. The first block holds the readings to
// the live tree; the second proves each rule of the scan on small inputs, so a
// weakened scan fails here and not only in a missed site.
import { readFileSync } from "node:fs";
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
  readingProblems,
  scanTree,
  type FileReading,
  type ScannedFile,
} from "./checkbox-call-site-scan.ts";
import { ACCESS_PICKER_CALLERS, CHECKBOX_CALL_SITE_READINGS } from "./checkbox-call-site-readings-4297.data.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const readRepo = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

describe("the recorded readings hold for the live tree", () => {
  const files = listSourceFiles(REPO_ROOT);
  const scanned = scanTree(REPO_ROOT, files);

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
    expect(readingProblems(CHECKBOX_CALL_SITE_READINGS, scanned, readRepo)).toEqual([]);
  });

  it("every caller of the multi-select access picker has a reading", () => {
    const found = findCallers(files, readRepo, "AccessCombobox", 'selectionMode="multiple"');
    expect(found.length).toBeGreaterThan(0);
    expect(callerProblems(ACCESS_PICKER_CALLERS, found, readRepo, "AccessCombobox")).toEqual([]);
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
      ...ACCESS_PICKER_CALLERS.filter((c) => c.effect === "immediate").map((c) => [c.file, Boolean(c.staysBecause)]),
    ];
    expect(stays).toEqual([
      ["packages/agents/src/schema-field-renderer.tsx", true],
      ["packages/skills/src/skills-toolbar.tsx", true],
      ["src/components/scope-filter-combobox.tsx", true],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The rules of the scan, on small inputs
// ---------------------------------------------------------------------------

function scanOne(file: string, text: string): ScannedFile {
  return { file, tokens: countCheckboxTokens(text), sites: findCheckboxSites(text) };
}

function reading(file: string, tokens: number, sites: FileReading["sites"]): FileReading {
  return { file, tokens, sites };
}

const CONFIRMED_A = {
  anchor: 'id="a"',
  tag: "Checkbox",
  drawn: "checkbox" as const,
  effect: "confirmed" as const,
  reading: "a field of a form that only its submit button writes",
  tagIncludes: [],
  fileIncludes: ['type="submit"'],
};

describe("the scan finds every form of a checkbox element", () => {
  it("names the tags of a namespace import and its aliases", () => {
    const text = 'import * as R from "radix-ui";\nconst C = R.Checkbox;\nconst M = R.DropdownMenu;\nexport const X = () => <><C.Root /><M.CheckboxItem /></>;\n';
    expect(findCheckboxSites(text).map((s) => s.tag)).toEqual(["C.Root", "M.CheckboxItem"]);
  });

  it("names a renamed import and a destructured alias", () => {
    const text =
      'import { Checkbox as Tick } from "@/components/ui/checkbox";\nconst { Checkbox: Box } = Primitives;\nexport const X = () => <div><Tick id="t" /><Box /></div>;\n';
    expect(findCheckboxSites(text).map((s) => s.tag)).toEqual(["Tick", "Box"]);
  });

  it("names a raw checkbox input and no other input", () => {
    const text = 'export const X = () => <form><input type="checkbox" name="a" /><input type="text" name="b" /><input type={"checkbox"} /></form>;\n';
    expect(findCheckboxSites(text).map((s) => s.openingTag)).toEqual(['<input type="checkbox" name="a" />', '<input type={"checkbox"} />']);
  });

  it("reads an opening tag across arrow functions and strings", () => {
    const text = 'const X = () => <Checkbox onCheckedChange={(v) => set(v === true ? "a>b" : "c")} id="z" />;\n';
    const [site] = findCheckboxSites(text);
    expect(site.openingTag).toBe('<Checkbox onCheckedChange={(v) => set(v === true ? "a>b" : "c")} id="z" />');
  });

  it("does not take a comment, a generic or a comparison for a site, but counts their tokens", () => {
    const text =
      '// a <Checkbox /> in a line comment\n/* a <Checkbox> in a block */\ntype P = React.ComponentProps<typeof CheckboxPrimitive.Root>;\nconst y = a<Checkbox;\nconst X = () => <div>{/* <Checkbox /> */}</div>;\n';
    expect(findCheckboxSites(text)).toEqual([]);
    expect(countCheckboxTokens(text)).toBe(5);
  });

  it("reads the children of an element, so a switch drawn inside a checkbox-role row is seen", () => {
    const [site] = findCheckboxSites("const X = () => <DropdownMenuCheckboxItem checked={on}>\n  <Switch checked={on} />\n  Row\n</DropdownMenuCheckboxItem>;\n");
    expect(site.body).toContain("<Switch checked={on} />");
  });

  it("leaves test, mock and stub files out and keeps every other file", () => {
    expect(isTestPath("src/components/ui/__tests__/x.test.tsx")).toBe(true);
    expect(isTestPath("packages/agents/src/x.spec.ts")).toBe(true);
    expect(isTestPath("tests/__stubs__/database.ts")).toBe(true);
    expect(isTestPath("src/app/test-run/page.tsx")).toBe(false);
    expect(isTestPath("packages/sdk-ui/src/prompt-field.tsx")).toBe(false);
  });
});

describe("the check refuses every reading that is not true", () => {
  const formText = '<form><Checkbox id="a" />\n<Button type="submit">Save</Button></form>';
  const read = (texts: Record<string, string>) => (file: string) => {
    if (!(file in texts)) throw new Error(`no such file ${file}`);
    return texts[file];
  };

  it("passes a true reading", () => {
    const s = scanOne("f.tsx", formText);
    expect(readingProblems([reading("f.tsx", s.tokens, [CONFIRMED_A])], [s], read({ "f.tsx": formText }))).toEqual([]);
  });

  it("refuses a file that refers to a checkbox and has no reading", () => {
    const s = scanOne("f.tsx", formText);
    expect(readingProblems([], [s], read({ "f.tsx": formText })).join("\n")).toContain("has no recorded reading");
  });

  it("refuses a reading whose file no longer refers to a checkbox", () => {
    expect(readingProblems([reading("f.tsx", 1, [CONFIRMED_A])], [], read({})).join("\n")).toContain("no longer refers to a checkbox");
  });

  it("refuses a changed token count, so an alias the element scan cannot name is read again", () => {
    const text = `${formText}\nconst Hidden = Primitives["Check" + "box"]; // Checkbox`;
    const s = scanOne("f.tsx", text);
    const problems = readingProblems([reading("f.tsx", countCheckboxTokens(formText), [CONFIRMED_A])], [s], read({ "f.tsx": text }));
    expect(problems.join("\n")).toContain("read the file again");
  });

  it("refuses one site swapped for another in the same file (identity, not counts)", () => {
    const text = '<form><Checkbox id="b" onCheckedChange={(v) => save(v)} />\n<Button type="submit">Save</Button></form>';
    const s = scanOne("f.tsx", text);
    const problems = readingProblems([reading("f.tsx", s.tokens, [CONFIRMED_A])], [s], read({ "f.tsx": text }));
    expect(problems.join("\n")).toContain('anchor "id=\\"a\\"" stands in 0 site(s)');
  });

  it("refuses a handler the reading does not name, and a confirm control that is gone", () => {
    const text = '<form><Checkbox id="a" onCheckedChange={(v) => save(v)} /></form>';
    const s = scanOne("f.tsx", text);
    const problems = readingProblems([reading("f.tsx", s.tokens, [CONFIRMED_A])], [s], read({ "f.tsx": text })).join("\n");
    expect(problems).toContain("which the reading must name in tagIncludes");
    expect(problems).toContain('no longer holds "type=\\"submit\\""');
  });

  it("refuses an immediate-effect site drawn as a checkbox with no recorded reason", () => {
    const text = '<Checkbox id="a" onCheckedChange={(v) => saveNow(v)} />';
    const s = scanOne("f.tsx", text);
    const site = {
      ...CONFIRMED_A,
      effect: "immediate" as const,
      reading: "a setting written the moment it changes",
      tagIncludes: ["onCheckedChange={(v) => saveNow(v)}"],
      fileIncludes: [],
    };
    const problems = readingProblems([reading("f.tsx", s.tokens, [site])], [s], read({ "f.tsx": text }));
    expect(problems.join("\n")).toContain("with no recorded reason it stays");
    const withReason = readingProblems([reading("f.tsx", s.tokens, [{ ...site, staysBecause: "a stated reason" }])], [s], read({ "f.tsx": text }));
    expect(withReason).toEqual([]);
  });

  it("refuses a reading that says a switch is drawn when the element draws a checkbox", () => {
    const text = '<DropdownMenuCheckboxItem checked={on} onCheckedChange={(c) => toggle(c)}><Checkbox checked={on} />Row</DropdownMenuCheckboxItem>';
    const s = scanOne("f.tsx", text);
    const row = {
      anchor: "onCheckedChange={(c) => toggle(c)}",
      tag: "DropdownMenuCheckboxItem",
      drawn: "switch" as const,
      effect: "immediate" as const,
      reading: "a menu row whose change applies at once",
      tagIncludes: ["onCheckedChange={(c) => toggle(c)}"],
      fileIncludes: [],
    };
    const inner = { ...CONFIRMED_A, anchor: "<Checkbox checked={on} />", effect: "none" as const, fileIncludes: [] };
    const problems = readingProblems([reading("f.tsx", s.tokens, [row, inner])], [s], read({ "f.tsx": text }));
    expect(problems.join("\n")).toContain("the reading says a switch is drawn, the element draws none");
  });

  it("refuses evidence in another file that no longer stands", () => {
    const s = scanOne("f.tsx", formText);
    const site = { ...CONFIRMED_A, evidence: [{ file: "g.ts", text: "await save(formData);" }] };
    const problems = readingProblems([reading("f.tsx", s.tokens, [site])], [s], read({ "f.tsx": formText, "g.ts": "nothing" }));
    expect(problems.join("\n")).toContain('g.ts no longer holds "await save(formData);"');
  });

  it("finds a caller of a shared component's mode, a dynamic mode included, and refuses an unread one", () => {
    const texts: Record<string, string> = {
      "a.tsx": '<AccessCombobox selectionMode="multiple" onChange={f} />',
      "b.tsx": "<AccessCombobox selectionMode={mode} onChange={f} />",
      "c.tsx": "<AccessCombobox {...props} />",
      "d.tsx": '<AccessCombobox value={v} onValueChange={f} />',
      "e.tsx": "<AccessComboboxMultiSelect {...props} />",
    };
    const found = findCallers(Object.keys(texts), read(texts), "AccessCombobox", 'selectionMode="multiple"');
    expect(found).toEqual(["a.tsx", "b.tsx", "c.tsx"]);
    const problems = callerProblems(
      [{ file: "a.tsx", effect: "immediate", reading: "a filter applied at once", fileIncludes: [] }],
      found,
      read(texts),
      "AccessCombobox",
    ).join("\n");
    expect(problems).toContain("b.tsx: a caller of AccessCombobox with no recorded reading");
    expect(problems).toContain("a.tsx: takes effect at once with no recorded reason the box stays");
  });
});
