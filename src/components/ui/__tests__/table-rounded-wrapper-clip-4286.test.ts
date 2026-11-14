// ---------------------------------------------------------------------------
// A ROUNDED WRAPPER AROUND THE SHARED TABLE CLIPS IT (cinatra#4286).
// ---------------------------------------------------------------------------
// In the dark palette `Table` lays the page ground (`dark:bg-background`) on
// its own <table>, and the even rows lay the --surface band. Both are square.
// A border radius clips an element's OWN background, not its descendants', so
// a rounded wrapper that does not clip its content shows the table's square
// corners through its curved ones (the Webhooks wrapper, `rounded-card` with
// no overflow clip, was such a wrapper).
//
// THE RULE. For every direct `<Table>` element in the application (`src/`) and
// the shared packages (`packages/`), the NEAREST rounded JSX ancestor in the
// same file clips its content: its class list carries an unconditional
// `overflow-hidden`, `overflow-clip`, `overflow-auto` or `overflow-scroll`
// (an `-x-` or `-y-` form too: a non-visible overflow on either axis clips
// both), OR it pads every side by at least spacing 4 (1rem, the largest
// product radius, --r-card), so the table never reaches its corners (the
// Skills section, `soft-panel rounded-card px-6 py-6`). `Card` counts as a rounded ancestor that clips: its own root is
// `rounded-xl overflow-hidden` (src/components/ui/card.tsx, read below).
// PaginatedTable is not a direct site to the callers: its frame
// (`rounded-md ... overflow-hidden`) is the nearest rounded ancestor of its
// own `<Table>` and is read like every other site.
//
// HOW IT READS. The TypeScript syntax tree of every tracked .tsx file (not its
// text), so a comment or a string that mentions <Table> is no site. A class
// list is every string literal inside the `className` attribute's value
// (`cn("rounded-card", cond && "overflow-hidden")` reads both); a token's
// variant prefix (`sm:rounded-card`) still rounds, while only an unprefixed
// overflow token clips. Not read: a wrapper that lives in another component
// (a Table returned by one component and wrapped by its caller), and a class
// list built from no literal at all.
//
//   pnpm exec vitest run \
//     src/components/ui/__tests__/table-rounded-wrapper-clip-4286.test.ts --maxWorkers=2

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");

/** Ancestor tags whose own primitive is rounded and clips its content. */
const CLIPPING_PRIMITIVES = new Set(["Card"]);

type Site = { file: string; line: number; ok: boolean; wrapper: string };

function classTokens(attr: ts.JsxAttribute | undefined): string[] {
  const init = attr?.initializer;
  if (!init) return [];
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(...n.text.split(/\s+/));
      return;
    }
    if (ts.isTemplateExpression(n)) {
      out.push(...n.head.text.split(/\s+/));
      for (const span of n.templateSpans) {
        visit(span.expression);
        out.push(...span.literal.text.split(/\s+/));
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(init);
  return out.filter(Boolean);
}

function rounds(tokens: string[]): boolean {
  return tokens.some((t) => {
    const base = t.split(":").pop()!;
    return /^rounded(?:-|$)/.test(base) && base !== "rounded-none";
  });
}

function clips(tokens: string[]): boolean {
  return tokens.some((t) => /^overflow(?:-[xy])?-(?:hidden|clip|auto|scroll)$/.test(t));
}

/** Whether unprefixed padding keeps every side at least spacing 4 (1rem). */
function padded(tokens: string[]): boolean {
  const side = { t: 0, r: 0, b: 0, l: 0 };
  for (const t of tokens) {
    const m = /^p([xytrbl]?)-(\d+(?:\.\d+)?)$/.exec(t);
    if (!m) continue;
    const v = Number(m[2]);
    const which = m[1] === "" ? "trbl" : m[1] === "x" ? "rl" : m[1] === "y" ? "tb" : m[1]!;
    for (const k of which) side[k as keyof typeof side] = v;
  }
  return Object.values(side).every((v) => v >= 4);
}

function classNameOf(opening: ts.JsxOpeningLikeElement): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "className",
  );
}

/** Every direct `<Table>` site of one file, each with its nearest rounded
 *  ancestor's verdict. */
function readTableSites(file: string, text: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sites: Site[] = [];
  const judge = (el: ts.Node): { ok: boolean; wrapper: string } => {
    for (let a = el.parent; a !== undefined; a = a.parent) {
      if (!ts.isJsxElement(a)) continue;
      const opening = a.openingElement;
      const tag = opening.tagName.getText(sf);
      if (CLIPPING_PRIMITIVES.has(tag)) return { ok: true, wrapper: tag };
      const tokens = classTokens(classNameOf(opening));
      if (rounds(tokens)) {
        return { ok: clips(tokens) || padded(tokens), wrapper: `${tag} "${tokens.join(" ")}"` };
      }
    }
    return { ok: true, wrapper: "none in this file" };
  };
  const visit = (n: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
      n.tagName.getText(sf) === "Table"
    ) {
      const host = ts.isJsxOpeningElement(n) ? n.parent : n;
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      sites.push({ file, line: line + 1, ...judge(host) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function liveFiles(): string[] {
  const listing = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "packages"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 },
  )
    .split("\n")
    .filter((f) => f.endsWith(".tsx"))
    .filter((f) => !/(^|\/)(node_modules|__tests__)\//.test(f) && !/\.test\.tsx$/.test(f));
  if (listing.length === 0) throw new Error("git listed no .tsx file under src/ or packages/");
  return listing;
}

describe("a rounded wrapper around the shared Table clips it", () => {
  const sites = liveFiles().flatMap((f) =>
    readTableSites(f, readFileSync(path.join(ROOT, f), "utf8")),
  );

  it("finds the direct Table sites (the reading is not empty)", () => {
    const files = new Set(sites.map((s) => s.file));
    expect(files.has("src/app/configuration/webhooks/_components/webhooks-table.tsx")).toBe(true);
    expect(files.has("src/app/configuration/execution/page.tsx")).toBe(true);
    expect(files.has("src/components/ui/paginated-table.tsx")).toBe(true);
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("every direct Table's nearest rounded ancestor clips its content", () => {
    const open = sites
      .filter((s) => !s.ok)
      .map((s) => `${s.file}:${s.line} under ${s.wrapper}`);
    expect(open).toEqual([]);
  });

  it("Card, read as a clipping primitive, is rounded and clips in its own root", () => {
    const card = readFileSync(path.join(ROOT, "src/components/ui/card.tsx"), "utf8");
    const sf = ts.createSourceFile("card.tsx", card, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let root: string[] | undefined;
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "Card") {
        const find = (m: ts.Node): void => {
          if (root === undefined && (ts.isJsxOpeningElement(m) || ts.isJsxSelfClosingElement(m))) {
            root = classTokens(classNameOf(m));
            return;
          }
          ts.forEachChild(m, find);
        };
        find(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(root, "no root element in function Card").toBeDefined();
    expect(rounds(root!)).toBe(true);
    expect(clips(root!)).toBe(true);
  });
});

describe("the reading", () => {
  const one = (src: string) => readTableSites("synthetic.tsx", src);

  it("flags a rounded wrapper with no clip", () => {
    const [site] = one(`const x = <div className="rounded-card border bg-surface"><Table /></div>;`);
    expect(site!.ok).toBe(false);
  });

  it("passes a rounded wrapper that clips, read through cn() and a condition", () => {
    expect(one(`const x = <div className={cn("rounded-card", ok && "overflow-hidden")}><Table></Table></div>;`)[0]!.ok).toBe(true);
    expect(one(`const x = <div className="overflow-x-auto rounded-lg"><Table /></div>;`)[0]!.ok).toBe(true);
  });

  it("judges only the nearest rounded ancestor, past unrounded and clipping-only ones", () => {
    // A square scroller inside an unclipped rounded wrapper still bleeds.
    expect(one(`const x = <div className="rounded-card"><div className="overflow-auto"><Table /></div></div>;`)[0]!.ok).toBe(false);
    expect(one(`const x = <div className="rounded-card"><Card><Table /></Card></div>;`)[0]!.ok).toBe(true);
  });

  it("passes a rounded wrapper whose padding keeps the table off its corners", () => {
    expect(one(`const x = <section className="soft-panel rounded-card px-6 py-6"><div className="overflow-x-auto"><Table /></div></section>;`)[0]!.ok).toBe(true);
    expect(one(`const x = <div className="rounded-card px-6"><Table /></div>;`)[0]!.ok).toBe(false);
    expect(one(`const x = <div className="rounded-card p-2"><Table /></div>;`)[0]!.ok).toBe(false);
  });

  it("counts a variant-prefixed radius but not a variant-prefixed clip", () => {
    expect(one(`const x = <div className="sm:rounded-card md:overflow-hidden"><Table /></div>;`)[0]!.ok).toBe(false);
    expect(one(`const x = <div className="rounded-none"><Table /></div>;`)[0]!.ok).toBe(true);
  });

  it("reads JSX, not text: a comment or string naming <Table> is no site", () => {
    expect(one(`// <div className="rounded-card"><Table /></div>\nconst s = "<Table />";`)).toEqual([]);
  });
});
