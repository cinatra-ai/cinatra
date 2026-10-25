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
// Six rules keep the scan fail-closed:
//
//   1. THE WHOLE TREE. Files come from `git ls-files --cached --others
//      --exclude-standard` over `src/` and `packages/` (the toast-import-guard
//      road): every tracked or new, not-ignored source file, and never a
//      node_modules tree. A git failure, an empty listing or a listed file that
//      cannot be read throws; it is never an empty result.
//   2. ANY REFERENCE COUNTS. A file is in scope when its text holds any
//      checkbox token (`CHECKBOX_TOKEN`): an identifier that contains
//      `Checkbox`, or the word checkbox in any letter case as a quoted value
//      (`type="CHECKBOX"`, `role='checkbox'`), `menuitemcheckbox`, `=checkbox`,
//      `checkbox]`, a `ui/checkbox` import or `react-checkbox`. It is also in
//      scope when it holds a site of rule 3 without any token. The number of
//      tokens is recorded per file, so any new reference in a read file, an
//      alias the element scan cannot name included, changes the count and fails
//      until the file is read again.
//   3. NAMED ELEMENTS. A site is a JSX opening tag whose name contains
//      `Checkbox`; a tag named by a local alias of such a name (`const C =
//      R.Checkbox`, `import { Checkbox as C }`, `const { Checkbox: C } = R`);
//      a tag named by a name another file exports a checkbox under (`export {
//      Checkbox as Tick }`, `export const Tick = Checkbox`); any element whose
//      `type` or `role` is the word checkbox or menuitemcheckbox in any letter
//      case, or is an expression that holds that word; and an `input` or `Input`
//      whose `type` is an expression, or that has a spread and no literal
//      `type`, because such an element may be a checkbox (it is UNRESOLVED and
//      must be read). An opening tag with no end is a site too, never skipped.
//      A checkbox exported as a default export cannot be followed by name, so
//      it is a problem that no reading clears.
//   4. IDENTITY, NOT COUNTS. Each recorded site names an anchor that must stand
//      in exactly one found site of its file, with the same tag; so removing one
//      checkbox and adding another in the same file fails even though the count
//      of sites is unchanged.
//   5. NO EMPTY READING. Every text a reading holds (anchor, tag, reading,
//      mentions, each pinned text, each evidence entry, the reason a box stays)
//      must hold more than white space; a reading and a reason are sentences of
//      20 characters at least. A pinned text must stand in the CODE of its
//      file, not only in one of its comments.
//   6. CALLERS ARE FOUND BY EVERY NAME. A shared component whose box is read at
//      its callers (`COMPONENT_CALLERS` in the readings) is found under its own
//      name, under a name another file exports it as, under a local alias and
//      as `<X.Name`. Any other use of one of those names in code (a value
//      passed on, a member of an object, a createElement call) is a problem,
//      because a caller could hide behind it.

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

/** The letters of `word` in either case, as a regular expression source. */
function anyCase(word: string): string {
  return [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join("");
}

const CB = anyCase("checkbox");

export const CHECKBOX_TOKEN = new RegExp(
  `Checkbox|["'\`]${CB}["'\`]|${anyCase("menuitem")}${CB}|=${CB}|${CB}\\]|ui\\/${CB}|react-${CB}`,
  "g",
);

export function countCheckboxTokens(text: string): number {
  return (text.match(CHECKBOX_TOKEN) ?? []).length;
}

/** Every tracked or new, not-ignored source file under the scan roots, repo-relative. */
export function listSourceFiles(repoRoot: string): string[] {
  const globs = SCAN_ROOTS.flatMap((root) => SOURCE_EXTENSIONS.map((ext) => `${root}/**/*${ext}`));
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...globs],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
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
  /** The opening tag's text, from `<` to its closing `>` (to the end of the text when it has none). */
  openingTag: string;
  /** The element's children text up to its closing tag (empty when self-closing). */
  body: string;
  /** Why the scan cannot tell whether it draws a checkbox (rule 3), when it cannot. */
  unresolved?: string;
};

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Local names bound to a name for which `isTarget` holds, in this file: renamed
 * imports and exports (`X as Y`), `const Y = <...X...>;` and `const { X: Y } =`,
 * followed until no new name appears.
 */
export function localAliases(text: string, isTarget: (name: string) => boolean): Set<string> {
  const aliases = new Set<string>();
  const hit = (expr: string) =>
    expr.split(/[^\w$]+/).some((part) => part.length > 0 && (isTarget(part) || aliases.has(part)));
  let size = -1;
  while (aliases.size !== size) {
    size = aliases.size;
    for (const m of text.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      if (hit(m[1])) aliases.add(m[2]);
    }
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\w$.]+)\s*[;\n]/g)) {
      if (hit(m[2])) aliases.add(m[1]);
    }
    for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
      for (const part of m[1].split(",")) {
        const pair = part.split(":").map((s) => s.trim());
        if (pair.length === 2 && hit(pair[0]) && IDENT.test(pair[1])) aliases.add(pair[1]);
      }
    }
  }
  return aliases;
}

/** Local names bound to a checkbox identifier in this file (rule 3). */
export function checkboxAliases(text: string, exported: ReadonlySet<string> = new Set()): Set<string> {
  return localAliases(text, (name) => name.includes("Checkbox") || exported.has(name));
}

/**
 * The names other files may import a target under: `export { X as Y }` and
 * `export const Y = X` over every text, followed until no new name appears.
 * `defaults` lists the files that export a target as their default export,
 * which no name follows.
 */
export function exportedAliases(
  texts: ReadonlyMap<string, string>,
  isTarget: (name: string) => boolean,
): { names: Set<string>; defaults: string[] } {
  const names = new Set<string>();
  const defaults = new Set<string>();
  const hit = (expr: string) =>
    expr.split(/[^\w$]+/).some((part) => part.length > 0 && (isTarget(part) || names.has(part)));
  let size = -1;
  while (names.size !== size) {
    size = names.size;
    for (const [file, raw] of texts) {
      const text = blankComments(raw);
      for (const m of text.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g)) {
        for (const part of m[1].split(",")) {
          const pair = part.trim().split(/\s+as\s+/);
          if (pair.length === 2 && hit(pair[0]) && IDENT.test(pair[1].trim()) && pair[1].trim() !== "default") {
            names.add(pair[1].trim());
          }
          if (pair.length === 2 && hit(pair[0]) && pair[1].trim() === "default") defaults.add(file);
        }
      }
      for (const m of text.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\w$.]+)\s*[;\n]/g)) {
        if (hit(m[2])) names.add(m[1]);
      }
      for (const m of text.matchAll(/\bexport\s+default\s+([\w$.]+)\s*[;\n]/g)) {
        if (hit(m[1])) defaults.add(file);
      }
    }
  }
  return { names, defaults: [...defaults].sort() };
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
 * line numbers stay). A block comment is `/* ... *\/` (the JSX `{/* ... *\/}`
 * form included). A line comment is a `//` that does not follow a `:`, so the
 * `//` of a URL (`https://`) is not one. The blanking does not read strings: a
 * `//` inside a string that does not follow a `:` blanks the rest of its line.
 */
export function blankComments(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(?<!:)\/\/[^\n]*/g, blank);
}

/** The value of attribute `name` in an opening tag: a literal string, an expression, or absent. */
function attribute(openingTag: string, name: string): { literal?: string; expression?: string } | undefined {
  const m = new RegExp(`(?<=\\s)${name}\\s*=\\s*`).exec(openingTag);
  if (!m) return undefined;
  const rest = openingTag.slice(m.index + m[0].length);
  const q = /^(["'])([^"']*)\1/.exec(rest);
  if (q) return { literal: q[2] };
  if (!rest.startsWith("{")) return { expression: rest.split(/\s/)[0] ?? "" };
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "{") depth++;
    else if (rest[i] === "}" && --depth === 0) {
      const inner = rest.slice(1, i).trim();
      const lit = /^(["'`])([^"'`$]*)\1$/.exec(inner);
      return lit ? { literal: lit[2] } : { expression: inner };
    }
  }
  return { expression: rest };
}

const CHECKBOX_WORD = /^(checkbox|menuitemcheckbox)$/i;
const CHECKBOX_IN_EXPRESSION = /checkbox/i;

/** Whether an element draws a checkbox, may draw one (unresolved), or does not (null). */
function checkboxByAttributes(tag: string, openingTag: string): "checkbox" | string | null {
  for (const name of ["type", "role"]) {
    const a = attribute(openingTag, name);
    if (a?.literal !== undefined && CHECKBOX_WORD.test(a.literal.trim())) return "checkbox";
    if (a?.expression !== undefined && CHECKBOX_IN_EXPRESSION.test(a.expression)) return "checkbox";
  }
  if (tag === "input" || /(?:^|\.)[A-Za-z_$]*Input$/.test(tag)) {
    const type = attribute(openingTag, "type");
    if (type?.expression !== undefined) return `its type is the expression {${type.expression}}`;
    if (type === undefined && /\{\s*\.\.\./.test(openingTag)) return "it has a spread and no literal type";
  }
  return null;
}

/** Every checkbox element of one file's text (rule 3), in source order; comments are not read. */
export function findCheckboxSites(raw: string, exported: ReadonlySet<string> = new Set()): FoundSite[] {
  const text = blankComments(raw);
  const aliases = checkboxAliases(text, exported);
  const sites: FoundSite[] = [];
  // A JSX tag: `<` not preceded by an identifier, `.`, `)` or `]` (that is a
  // generic or a comparison), then the tag name, not followed by `,` or
  // `extends` (a generic parameter list such as `<T,>(value: T) =>`).
  for (const m of text.matchAll(/(?<![\w$.\])])<([A-Za-z_$][\w$]*(?:\.[\w$]+)*)(?!\s*,|\s+extends\b)/g)) {
    const tag = m[1];
    const head = tag.split(".")[0];
    const byName = tag.includes("Checkbox") || aliases.has(head) || exported.has(head);
    const start = m.index ?? 0;
    const end = openingTagEnd(text, start);
    const openingTag = end < 0 ? text.slice(start) : text.slice(start, end);
    const byAttributes = checkboxByAttributes(tag, openingTag);
    if (!byName && byAttributes === null) continue;
    let body = "";
    if (end >= 0 && !openingTag.endsWith("/>")) {
      const close = text.indexOf(`</${tag}>`, end);
      body = close < 0 ? text.slice(end) : text.slice(end, close);
    }
    const site: FoundSite = { tag, line: lineOf(text, start), openingTag, body };
    if (end < 0) site.unresolved = "its opening tag has no end";
    else if (!byName && byAttributes !== "checkbox") site.unresolved = byAttributes ?? undefined;
    sites.push(site);
  }
  return sites;
}

export type ScannedFile = { file: string; tokens: number; sites: FoundSite[] };

export type ScannedTree = {
  files: ScannedFile[];
  /** Names other files export a checkbox under (rule 3). */
  exported: Set<string>;
  /** Files that export a checkbox as their default export: a problem no reading clears. */
  defaultExports: string[];
};

/** The in-scope files of the tree (rule 2) with their tokens and sites. */
export function scanTree(repoRoot: string, files: string[] = listSourceFiles(repoRoot)): ScannedTree {
  const texts = new Map<string, string>();
  for (const file of files) {
    if (isTestPath(file)) continue;
    texts.set(file, readFileSync(path.join(repoRoot, file), "utf8"));
  }
  const { names: exported, defaults } = exportedAliases(texts, (name) => name.includes("Checkbox"));
  const out: ScannedFile[] = [];
  for (const [file, text] of texts) {
    const tokens = countCheckboxTokens(text);
    const sites = findCheckboxSites(text, exported);
    if (tokens === 0 && sites.length === 0) continue;
    out.push({ file, tokens, sites });
  }
  return { files: out, exported, defaultExports: defaults };
}

// ---------------------------------------------------------------------------
// The recorded readings and their check
// ---------------------------------------------------------------------------

/**
 * `immediate`: the change takes effect at once (it is written, sent or applied
 * when the box changes). `confirmed`: the change is held and only a separate
 * confirm (a form submit, a Continue, a dialog action) applies it. `none`: the
 * element changes nothing itself (a primitive's own definition, a part of it, a
 * static drawing fixture, a decorative box inside a row that is the control, or
 * an element that is not a checkbox).
 */
export type Effect = "immediate" | "confirmed" | "none";

const EFFECTS: readonly string[] = ["immediate", "confirmed", "none"];

export type SiteReading = {
  /** A text that stands in exactly one found site's opening tag of the file. */
  anchor: string;
  tag: string;
  /**
   * What the person sees: a checkbox, a switch drawn inside a checkbox-role
   * row, or, for an unresolved site, no checkbox (`notACheckbox` says why).
   */
  drawn: "checkbox" | "switch" | "no checkbox";
  effect: Effect;
  /** Why: the reading in a sentence, naming what applies the change. */
  reading: string;
  /** Texts that must stand in the opening tag (the change handler, when it has one). */
  tagIncludes: string[];
  /** Texts that must stand in the code of the file: the confirm control, the write, the form. */
  fileIncludes: string[];
  /** Texts that must stand in the code of other files the reading leans on (the surface that applies the change). */
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

const SENTENCE = 20;

function blankText(s: unknown): boolean {
  return typeof s !== "string" || s.trim().length === 0;
}

function shortSentence(s: unknown): boolean {
  return typeof s !== "string" || s.trim().length < SENTENCE;
}

/** Problems of pinned texts: each must hold more than white space and stand in the code (not only a comment). */
function pinProblems(
  at: string,
  pins: { file: string; text: string }[],
  fileText: (file: string) => string,
): string[] {
  const problems: string[] = [];
  for (const pin of pins) {
    if (blankText(pin.file) || blankText(pin.text)) {
      problems.push(`${at}: a pinned text or its file is empty`);
      continue;
    }
    let raw: string;
    try {
      raw = fileText(pin.file);
    } catch {
      problems.push(`${at}: the file ${pin.file} cannot be read`);
      continue;
    }
    if (!raw.includes(pin.text)) problems.push(`${at}: ${pin.file} no longer holds ${JSON.stringify(pin.text)}`);
    else if (!blankComments(raw).includes(pin.text)) {
      problems.push(`${at}: ${pin.file} holds ${JSON.stringify(pin.text)} only in a comment; pin the code`);
    }
  }
  return problems;
}

/**
 * The problems between the recorded readings and the scanned tree; [] means
 * every in-scope file and every site has exactly one true reading.
 */
export function readingProblems(readings: FileReading[], tree: ScannedTree, fileText: (file: string) => string): string[] {
  const problems: string[] = [];
  for (const file of tree.defaultExports) {
    problems.push(`${file}: exports a checkbox as its default export, which no name follows: export it by name`);
  }
  const byFile = new Map(tree.files.map((s) => [s.file, s]));
  const recorded = new Map<string, FileReading>();
  for (const r of readings) {
    if (recorded.has(r.file)) problems.push(`${r.file}: recorded twice`);
    recorded.set(r.file, r);
  }
  for (const s of tree.files) {
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
    if (r.sites.length === 0 && shortSentence(r.mentions)) {
      problems.push(`${r.file}: a file with no site must say in a sentence what its tokens are`);
    }
    if (r.mentions !== undefined && r.sites.length > 0) problems.push(`${r.file}: mentions is only for a file with no site`);
    if (s.sites.length !== r.sites.length) {
      problems.push(`${r.file}: ${s.sites.length} checkbox site(s) found, ${r.sites.length} recorded`);
    }
    const used = new Set<number>();
    for (const site of r.sites) {
      if (blankText(site.anchor)) {
        problems.push(`${r.file}: a reading has an empty anchor`);
        continue;
      }
      const hits = s.sites.map((f, i) => [f, i] as const).filter(([f]) => f.openingTag.includes(site.anchor));
      if (hits.length !== 1) {
        problems.push(`${r.file}: anchor ${JSON.stringify(site.anchor)} stands in ${hits.length} site(s), not one`);
        continue;
      }
      const [found, index] = hits[0];
      if (used.has(index)) problems.push(`${r.file}: two readings name the site at line ${found.line}`);
      used.add(index);
      const at = `${r.file}:${found.line}`;
      if (found.unresolved !== undefined && found.unresolved.startsWith("its opening tag has no end")) {
        problems.push(`${at}: its opening tag has no end, so it cannot be read`);
      }
      if (found.tag !== site.tag) problems.push(`${at}: the tag is ${found.tag}, the reading says ${site.tag}`);
      if (!EFFECTS.includes(site.effect)) problems.push(`${at}: the effect ${JSON.stringify(site.effect)} is not one of ${EFFECTS.join(", ")}`);
      for (const t of site.tagIncludes) {
        if (blankText(t)) problems.push(`${at}: a tagIncludes text is empty`);
        else if (!found.openingTag.includes(t)) problems.push(`${at}: the opening tag no longer holds ${JSON.stringify(t)}`);
      }
      for (const handler of ["onCheckedChange=", "onChange=", "onSelect=", "onClick="]) {
        if (found.openingTag.includes(handler) && !site.tagIncludes.some((t) => typeof t === "string" && t.startsWith(handler))) {
          problems.push(`${at}: the opening tag has ${handler.slice(0, -1)}, which the reading must name in tagIncludes`);
        }
      }
      problems.push(
        ...pinProblems(
          at,
          [...site.fileIncludes.map((text) => ({ file: r.file, text })), ...(site.evidence ?? [])],
          fileText,
        ),
      );
      const drawsSwitch = /<Switch\b/.test(found.body);
      if (site.drawn === "switch" && !drawsSwitch) problems.push(`${at}: the reading says a switch is drawn, the element draws none`);
      if (site.drawn === "checkbox" && drawsSwitch) problems.push(`${at}: the element draws a switch, the reading says a checkbox`);
      if (site.drawn === "no checkbox" && found.unresolved === undefined) {
        problems.push(`${at}: the element is a checkbox by name or attribute; "no checkbox" is only for an unresolved site`);
      }
      if (site.drawn === "no checkbox" && site.effect !== "none") problems.push(`${at}: an element that draws no checkbox has the effect none`);
      if (site.effect === "confirmed" && site.fileIncludes.length + (site.evidence ?? []).length === 0) {
        problems.push(`${at}: a confirmed reading must pin the confirm control (fileIncludes or evidence)`);
      }
      if (site.effect === "immediate" && site.drawn === "checkbox" && shortSentence(site.staysBecause)) {
        problems.push(`${at}: takes effect at once and is drawn as a checkbox, with no recorded reason it stays (the drawing gives a switch)`);
      }
      if (site.staysBecause !== undefined && shortSentence(site.staysBecause)) problems.push(`${at}: the reason it stays is not a sentence`);
      if (shortSentence(site.reading)) problems.push(`${at}: the reading is not a sentence`);
    }
  }
  return problems;
}

/** One caller of a shared component whose rows or children draw the box. */
export type CallerReading = {
  file: string;
  effect: Effect;
  reading: string;
  fileIncludes: string[];
  evidence?: { file: string; text: string }[];
  staysBecause?: string;
};

/** A shared component whose box is read at its callers, with the opening tags that count as a caller. */
export type ComponentCallers = {
  component: string;
  /** Says which opening tags are callers; without it, every use is one. */
  isCaller?: (openingTag: string) => boolean;
  /** Why these are the callers, in a sentence. */
  why: string;
  callers: CallerReading[];
};

export type CallerScan = {
  /** Every name the component is found under (its own, exported and local aliases). */
  names: string[];
  callers: string[];
  /** Uses of one of the names that are neither a JSX tag, an import or export, a declaration nor a type. */
  unresolved: string[];
};

/**
 * The files outside tests that open the component (under any of its names) with
 * an opening tag `isCaller` accepts, and every use of a name the scan cannot
 * follow (rule 6).
 */
export function findCallers(
  scannedFiles: string[],
  fileText: (file: string) => string,
  component: string,
  isCaller: (openingTag: string) => boolean = () => true,
): CallerScan {
  const files = scannedFiles.filter((f) => !isTestPath(f));
  const texts = new Map(files.map((f) => [f, fileText(f)] as const));
  const { names: exported, defaults } = exportedAliases(texts, (name) => name === component);
  const allNames = new Set<string>([component]);
  const callers: string[] = [];
  const unresolved = defaults.map((f) => `${f}: exports ${component} as its default export, which no name follows`);
  for (const [file, raw] of texts) {
    const text = blankComments(raw);
    const local = localAliases(text, (name) => name === component || exported.has(name));
    const names = new Set<string>([component, ...exported, ...local]);
    for (const n of names) allNames.add(n);
    let isCallerFile = false;
    const allowed: [number, number][] = [];
    for (const m of text.matchAll(/\b(?:import|export)\s*(?:type\s*)?\{[^}]*\}/g)) allowed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    for (const name of names) {
      const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
      for (const m of text.matchAll(word)) {
        const i = m.index ?? 0;
        const before = text.slice(Math.max(0, i - 200), i);
        const after = text.slice(i + name.length, i + name.length + 40);
        if (/<\/?(?:[A-Za-z_$][\w$]*\.)*$/.test(before)) {
          if (/<(?:[A-Za-z_$][\w$]*\.)*$/.test(before)) {
            const start = before.lastIndexOf("<") + Math.max(0, i - 200);
            const end = openingTagEnd(text, start);
            const tag = end < 0 ? text.slice(start) : text.slice(start, end);
            if (end < 0 || isCaller(tag)) isCallerFile = true;
          }
          continue;
        }
        if (allowed.some(([a, b]) => i >= a && i < b)) continue;
        // Inside a string literal of its line (an odd number of its quotes
        // before it): a name in a string is no reference. A JSX use was taken
        // above, so this cannot hide a caller.
        const lineStart = text.lastIndexOf("\n", i) + 1;
        const lead = text.slice(lineStart, i);
        if (['"', "'", "`"].some((q) => (lead.split(q).length - 1) % 2 === 1)) continue;
        if (/\b(?:function|class|typeof|keyof)\s+$/.test(before)) continue;
        if (/\bimport\s+(?:type\s+)?$/.test(before) && /^\s*(?:,|from\b)/.test(after)) continue;
        if (/\bimport\s+\*\s+as\s+$/.test(before)) continue;
        if (/\b(?:const|let|var)\s+$/.test(before) && /^\s*[=:(<]/.test(after)) continue;
        if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*$/.test(before) && /^\s*[;\n]/.test(after)) continue;
        unresolved.push(`${file}:${lineOf(text, i)}: a use of ${name} that is no JSX tag, import, export, declaration or type`);
      }
    }
    if (isCallerFile) callers.push(file);
  }
  return { names: [...allNames].sort(), callers: callers.sort(), unresolved };
}

export function callerProblems(
  set: ComponentCallers,
  found: CallerScan,
  fileText: (file: string) => string,
): string[] {
  const problems: string[] = [...found.unresolved];
  const { component, callers } = set;
  if (shortSentence(set.why)) problems.push(`${component}: say in a sentence why these are its callers`);
  const seen = new Set<string>();
  for (const c of callers) {
    if (seen.has(c.file)) problems.push(`${c.file}: recorded twice as a caller of ${component}`);
    seen.add(c.file);
  }
  for (const f of found.callers) if (!seen.has(f)) problems.push(`${f}: a caller of ${component} with no recorded reading`);
  for (const c of callers) {
    const at = `${c.file} (caller of ${component})`;
    if (!found.callers.includes(c.file)) problems.push(`${at}: recorded as a caller, but it is not one`);
    if (!EFFECTS.includes(c.effect)) problems.push(`${at}: the effect ${JSON.stringify(c.effect)} is not one of ${EFFECTS.join(", ")}`);
    problems.push(...pinProblems(at, [...c.fileIncludes.map((text) => ({ file: c.file, text })), ...(c.evidence ?? [])], fileText));
    if (c.effect === "confirmed" && c.fileIncludes.length + (c.evidence ?? []).length === 0) {
      problems.push(`${at}: a confirmed reading must pin its confirm`);
    }
    if (c.effect === "immediate" && shortSentence(c.staysBecause)) problems.push(`${at}: takes effect at once with no recorded reason the box stays`);
    if (c.staysBecause !== undefined && shortSentence(c.staysBecause)) problems.push(`${at}: the reason the box stays is not a sentence`);
    if (shortSentence(c.reading)) problems.push(`${at}: the reading is not a sentence`);
  }
  return problems;
}
