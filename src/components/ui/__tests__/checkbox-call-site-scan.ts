// The source scan behind `checkbox-call-site-readings-4297.test.ts`
// (cinatra#4297, Done-when 2 and 3).
//
// It finds every place in the application (`src/`) and the shared packages
// (`packages/`) whose code refers to a checkbox, and every checkbox element it
// can name, so the test can hold the recorded readings to the live tree in both
// directions: a site without a reading fails, and a reading whose site is gone
// fails.
//
// Pure functions over file text plus one git listing; only `node:` built-ins
// are imported, so the scan also runs under `node --experimental-strip-types`.
//
// Four rules keep the scan fail-closed:
//
//   1. THE WHOLE TREE. Files come from `git ls-files --cached --others
//      --exclude-standard` over `src/` and `packages/` (the toast-import-guard
//      road): every tracked or new, not-ignored source file, and never a
//      node_modules tree. A git failure throws; it is never an empty list.
//   2. ANY REFERENCE COUNTS. A file is in scope when its text holds any
//      checkbox token (`CHECKBOX_TOKEN`): an identifier that contains
//      `Checkbox` (so `R.Checkbox`, `M.CheckboxItem`, `CheckboxPrimitive` and a
//      renamed import `{ Checkbox as Tick }` all count), a quoted `"checkbox"`
//      (`type="checkbox"`, `role="checkbox"`), `menuitemcheckbox`,
//      `=checkbox`, `checkbox]`, a `ui/checkbox` import or `react-checkbox`. The
//      number of tokens is recorded per file, so any new reference in a read
//      file, an alias the element scan cannot name included, changes the count
//      and fails until the file is read again.
//   3. NAMED ELEMENTS. A site is a JSX opening tag whose name contains
//      `Checkbox`, a tag named by a local alias of such a name (`const C =
//      R.Checkbox`, `import { Checkbox as C }`, `const { Checkbox: C } = R`), or
//      an `<input>` whose opening tag says `type="checkbox"`.
//   4. IDENTITY, NOT COUNTS. Each recorded site names an anchor that must stand
//      in exactly one found site of its file, with the same tag; so removing one
//      checkbox and adding another in the same file fails even though the count
//      of sites is unchanged.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const SCAN_ROOTS = ["src", "packages"] as const;

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** A test, mock or stub file is not a call site of the application. */
export function isTestPath(rel: string): boolean {
  const segments = rel.split("/");
  if (segments.some((s) => s === "__tests__" || s === "__mocks__" || s === "__stubs__")) return true;
  const base = segments[segments.length - 1] ?? "";
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

export const CHECKBOX_TOKEN =
  /Checkbox|["'`]checkbox["'`]|menuitemcheckbox|=checkbox|checkbox\]|ui\/checkbox|react-checkbox/g;

export function countCheckboxTokens(text: string): number {
  return (text.match(CHECKBOX_TOKEN) ?? []).length;
}

/** Every tracked or new, not-ignored source file under the scan roots, repo-relative. */
export function listSourceFiles(repoRoot: string): string[] {
  const globs = SCAN_ROOTS.flatMap((root) => SOURCE_EXTENSIONS.map((ext) => `${root}/**/*${ext}`));
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...globs],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const files = out.split("\0").filter((p) => p.length > 0);
  if (files.length === 0) throw new Error(`git ls-files listed no source file under ${SCAN_ROOTS.join(", ")}`);
  return files.sort();
}

export type FoundSite = {
  /** The tag name as written, for example `Checkbox` or `CheckboxPrimitive.Root`. */
  tag: string;
  /** 1-based line of the `<`. */
  line: number;
  /** The opening tag's text, from `<` to its closing `>`. */
  openingTag: string;
  /** The element's children text up to its closing tag (empty when self-closing). */
  body: string;
};

/** Local names bound to a checkbox identifier in this file (rule 3). */
export function checkboxAliases(text: string): Set<string> {
  const aliases = new Set<string>();
  for (const m of text.matchAll(/(?<![\w$])([\w$]*Checkbox[\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) aliases.add(m[2]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*Checkbox[\w$.]*\s*[;\n]/g)) {
    aliases.add(m[1]);
  }
  for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const pair = part.split(":").map((s) => s.trim());
      if (pair.length === 2 && pair[0].includes("Checkbox") && /^[A-Za-z_$][\w$]*$/.test(pair[1])) aliases.add(pair[1]);
    }
  }
  return aliases;
}

/** The end index (exclusive) of the opening tag that starts at `start` (`<`), or -1. */
function openingTagEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i + 1;
  }
  return -1;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * The text with its comments blanked to spaces (newlines kept, so offsets and
 * line numbers stay): a `<Checkbox>` named in a comment is not a site. A block
 * comment is `/* ... *\/` (the JSX `{/* ... *\/}` form included); a line
 * comment is `//` that follows a line start, a space, a tab or a bracket, so the
 * `//` of a URL inside a string (`https://`) is not one.
 */
export function blankComments(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s({[;,])(\/\/[^\n]*)/g, (_m, lead: string, comment: string) => lead + blank(comment));
}

/** Every checkbox element of one file's text (rule 3), in source order; comments are not read. */
export function findCheckboxSites(raw: string): FoundSite[] {
  const text = blankComments(raw);
  const aliases = checkboxAliases(text);
  const sites: FoundSite[] = [];
  // A JSX tag: `<` not preceded by an identifier, `.`, `)` or `]` (that is a
  // generic or a comparison), then the tag name.
  for (const m of text.matchAll(/(?<![\w$.\])])<([A-Za-z_$][\w$]*(?:\.[\w$]+)*)/g)) {
    const tag = m[1];
    const head = tag.split(".")[0];
    const named = tag.includes("Checkbox") || aliases.has(head) || tag === "input";
    if (!named) continue;
    const start = m.index ?? 0;
    const end = openingTagEnd(text, start);
    if (end < 0) continue;
    const openingTag = text.slice(start, end);
    if (tag === "input" && !/type\s*=\s*\{?\s*["'`]checkbox["'`]/.test(openingTag)) continue;
    let body = "";
    if (!openingTag.endsWith("/>")) {
      const close = text.indexOf(`</${tag}>`, end);
      body = close < 0 ? text.slice(end) : text.slice(end, close);
    }
    sites.push({ tag, line: lineOf(text, start), openingTag, body });
  }
  return sites;
}

export type ScannedFile = { file: string; tokens: number; sites: FoundSite[] };

/** The in-scope files of the tree (rule 2) with their tokens and sites. */
export function scanTree(repoRoot: string, files: string[] = listSourceFiles(repoRoot)): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const file of files) {
    if (isTestPath(file)) continue;
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    const tokens = countCheckboxTokens(text);
    if (tokens === 0) continue;
    out.push({ file, tokens, sites: findCheckboxSites(text) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The recorded readings and their check
// ---------------------------------------------------------------------------

/**
 * `immediate`: the change takes effect at once (it is written, sent or applied
 * when the box changes). `confirmed`: the change is held and only a separate
 * confirm (a form submit, a Continue, a dialog action) applies it. `none`: the
 * element changes nothing itself (a primitive's own definition, a part of it, a
 * static drawing fixture, or a decorative box inside a row that is the control).
 */
export type Effect = "immediate" | "confirmed" | "none";

export type SiteReading = {
  /** A text that stands in exactly one found site's opening tag of the file. */
  anchor: string;
  tag: string;
  /** What the person sees: a checkbox, or a switch drawn inside a checkbox-role row. */
  drawn: "checkbox" | "switch";
  effect: Effect;
  /** Why: the reading in a sentence, naming what applies the change. */
  reading: string;
  /** Texts that must stand in the opening tag (the change handler, when it has one). */
  tagIncludes: string[];
  /** Texts that must stand elsewhere in the file: the confirm control, the write, the form. */
  fileIncludes: string[];
  /** Texts that must stand in other files the reading leans on (the surface that applies the change). */
  evidence?: { file: string; text: string }[];
  /** Required when an immediate-effect site is drawn as a checkbox: why it stays a checkbox. */
  staysBecause?: string;
};

export type FileReading = {
  file: string;
  /** `countCheckboxTokens` of the file as read. */
  tokens: number;
  /** For a file with no site: what its checkbox tokens are. */
  mentions?: string;
  sites: SiteReading[];
};

/**
 * The problems between the recorded readings and the scanned tree; [] means
 * every in-scope file and every site has exactly one true reading.
 */
export function readingProblems(readings: FileReading[], scanned: ScannedFile[], fileText: (file: string) => string): string[] {
  const problems: string[] = [];
  const byFile = new Map(scanned.map((s) => [s.file, s]));
  const recorded = new Map<string, FileReading>();
  for (const r of readings) {
    if (recorded.has(r.file)) problems.push(`${r.file}: recorded twice`);
    recorded.set(r.file, r);
  }
  for (const s of scanned) {
    if (!recorded.has(s.file)) {
      problems.push(`${s.file}: refers to a checkbox (${s.tokens} token(s), ${s.sites.length} site(s)) but has no recorded reading`);
    }
  }
  for (const r of readings) {
    const s = byFile.get(r.file);
    if (!s) {
      problems.push(`${r.file}: has a recorded reading but no longer refers to a checkbox (or is gone)`);
      continue;
    }
    if (s.tokens !== r.tokens) {
      problems.push(`${r.file}: holds ${s.tokens} checkbox token(s), the reading was recorded at ${r.tokens}: read the file again`);
    }
    if (r.sites.length === 0 && !r.mentions) problems.push(`${r.file}: a file with no site must say what its tokens are`);
    if (s.sites.length !== r.sites.length) {
      problems.push(`${r.file}: ${s.sites.length} checkbox site(s) found, ${r.sites.length} recorded`);
    }
    const used = new Set<number>();
    const text = fileText(r.file);
    for (const site of r.sites) {
      const hits = s.sites.map((f, i) => [f, i] as const).filter(([f]) => f.openingTag.includes(site.anchor));
      if (hits.length !== 1) {
        problems.push(`${r.file}: anchor ${JSON.stringify(site.anchor)} stands in ${hits.length} site(s), not one`);
        continue;
      }
      const [found, index] = hits[0];
      if (used.has(index)) problems.push(`${r.file}: two readings name the site at line ${found.line}`);
      used.add(index);
      const at = `${r.file}:${found.line}`;
      if (found.tag !== site.tag) problems.push(`${at}: the tag is ${found.tag}, the reading says ${site.tag}`);
      for (const t of site.tagIncludes) {
        if (!found.openingTag.includes(t)) problems.push(`${at}: the opening tag no longer holds ${JSON.stringify(t)}`);
      }
      for (const handler of ["onCheckedChange=", "onChange=", "onSelect=", "onClick="]) {
        if (found.openingTag.includes(handler) && !site.tagIncludes.some((t) => t.startsWith(handler))) {
          problems.push(`${at}: the opening tag has ${handler.slice(0, -1)}, which the reading must name in tagIncludes`);
        }
      }
      for (const t of site.fileIncludes) {
        if (!text.includes(t)) problems.push(`${at}: the file no longer holds ${JSON.stringify(t)}`);
      }
      for (const e of site.evidence ?? []) {
        let other = "";
        try {
          other = fileText(e.file);
        } catch {
          problems.push(`${at}: the evidence file ${e.file} cannot be read`);
          continue;
        }
        if (!other.includes(e.text)) problems.push(`${at}: ${e.file} no longer holds ${JSON.stringify(e.text)}`);
      }
      const drawsSwitch = /<Switch\b/.test(found.body);
      if (site.drawn === "switch" && !drawsSwitch) problems.push(`${at}: the reading says a switch is drawn, the element draws none`);
      if (site.drawn === "checkbox" && drawsSwitch) problems.push(`${at}: the element draws a switch, the reading says a checkbox`);
      if (site.effect === "confirmed" && site.fileIncludes.length === 0) {
        problems.push(`${at}: a confirmed reading must name the confirm control in fileIncludes`);
      }
      if (site.effect === "immediate" && site.drawn === "checkbox" && !site.staysBecause) {
        problems.push(`${at}: takes effect at once and is drawn as a checkbox, with no recorded reason it stays (the drawing gives a switch)`);
      }
      if (site.reading.trim().length < 20) problems.push(`${at}: the reading is not a sentence`);
    }
  }
  return problems;
}

/** A shared component's callers whose rows draw the box (the multi-select access picker). */
export type CallerReading = {
  file: string;
  effect: Effect;
  reading: string;
  fileIncludes: string[];
  staysBecause?: string;
};

/**
 * The files outside tests that open `<${component}` with `mode` in the same
 * opening tag: the callers of one mode of a shared component.
 */
export function findCallers(scannedFiles: string[], fileText: (file: string) => string, component: string, mode: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`(?<![\\w$.\\])])<${component}\\b`, "g");
  for (const file of scannedFiles) {
    if (isTestPath(file)) continue;
    const text = fileText(file);
    for (const m of text.matchAll(open)) {
      const start = m.index ?? 0;
      const end = openingTagEnd(text, start);
      const tag = end > 0 ? text.slice(start, end) : "";
      // A mode passed as an expression or through a spread may be this mode:
      // such a caller must be read too (fail closed).
      if (tag.includes(mode) || /selectionMode=\{|\{\s*\.\.\./.test(tag)) {
        out.push(file);
        break;
      }
    }
  }
  return out.sort();
}

export function callerProblems(
  callers: CallerReading[],
  found: string[],
  fileText: (file: string) => string,
  component: string,
): string[] {
  const problems: string[] = [];
  const listed = callers.map((c) => c.file).sort();
  for (const f of found) if (!listed.includes(f)) problems.push(`${f}: a caller of ${component} with no recorded reading`);
  for (const c of callers) {
    if (!found.includes(c.file)) problems.push(`${c.file}: recorded as a caller of ${component}, but it is not one`);
    for (const t of c.fileIncludes) {
      if (!fileText(c.file).includes(t)) problems.push(`${c.file}: no longer holds ${JSON.stringify(t)}`);
    }
    if (c.effect === "confirmed" && c.fileIncludes.length === 0) problems.push(`${c.file}: a confirmed reading must name its confirm`);
    if (c.effect === "immediate" && !c.staysBecause) problems.push(`${c.file}: takes effect at once with no recorded reason the box stays`);
  }
  return problems;
}
