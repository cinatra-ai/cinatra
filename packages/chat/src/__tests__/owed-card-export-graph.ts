/**
 * WHO CAN REACH THE OWED CARD — an export-level reachability analysis, used by
 * `held-turn-transcript-contract.test.tsx` to hold the one blind spot its DOM
 * assertions cannot see.
 *
 * WHY THIS EXISTS. The transcript suite replaces the inline run panel (its graph
 * reaches the server runtime), so a hold card mounted INSIDE that panel is
 * invisible to every DOM assertion in the file. The compensating check was a
 * source scan: a `from "…run-recommendation-*"` regex over the chat package, the
 * owed symbols as literal substrings, and the two agents barrels. Each of those
 * watches a SPELLING, and a spelling has a way around it — an agents-side module
 * that is neither barrel re-exporting the card under a different name:
 *
 *     // packages/agents/src/<anything>.ts
 *     export { RecommendationHoldCard as HoldPanel } from "./run-recommendation-chip-row";
 *     // packages/chat/src/<anything>.tsx
 *     import { HoldPanel } from "@cinatra-ai/agents/<anything>";
 *
 * No watched module substring, no watched symbol, and not a barrel. The agents
 * package publishes ~90 subpath exports and chat already imports several of
 * them, so this is not a hypothetical shape; it is the shape of the imports
 * already in the tree.
 *
 * WHAT CLOSES IT. Not a longer list of spellings — the NAME the card arrives
 * under stops mattering. This walks the agents package's re-export statements to
 * a fixed point and answers, per module, "which of the names YOU export are the
 * owed card wearing a different hat?". Chat's imports are then checked against
 * that answer. A rename at any depth, through any module, is followed, because
 * a re-export has to name the module it comes from at every hop even when it
 * renames what it takes.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST LIMIT, since a gate that overclaims is worse than none.
 * ---------------------------------------------------------------------------
 * This reads STATEMENTS, not a type-checked module graph. Three things get past
 * it, and each is named rather than implied:
 *
 *   · a specifier that is not a literal — `import(someVariable)`;
 *   · a re-export laundered through a value the analysis cannot follow to a
 *     module — `const X = Card; export { X }`, where `Card` is a local binding
 *     rather than a read off something imported. Two shapes have LEFT this
 *     class: `export default X` (the default route is walked, both hops), and
 *     `const X = ns.default` (a member read off a namespace import is walked
 *     too, whatever property it names);
 *   · a module reached from outside this repo's two packages.
 *
 * The first two still have to write the owed symbol somewhere in the agents
 * package, which the literal-symbol scans beside this one see. The floor under
 * all of it is the transcript suite's own interactive-affordance check: whatever
 * a card is called and however it arrived, an operable one puts something
 * clickable in the held turn's container, and that is asserted directly.
 */

export type SourceGraph = {
  /** Every module in the package being analysed, by whatever key `read` takes. */
  files: readonly string[];
  read: (file: string) => string;
  /** Resolve an import specifier as written in `fromFile`, or null if outside. */
  resolve: (fromFile: string, spec: string) => string | null;
};

/** One `export … from "…"` statement, normalized. */
type ReExport = {
  /** null for `export * from`, which carries every name through unrenamed. */
  names: { imported: string; exported: string }[] | null;
  spec: string;
};

const BLOCK_RE = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const STAR_RE = /export\s*\*\s*from\s*["']([^"']+)["']/g;
const STAR_AS_RE = /export\s*\*\s*as\s+(\w+)\s+from\s*["']([^"']+)["']/g;

/** `A as B, type C, default as D` → the value bindings, imported→exported. */
function parseSpecifiers(clause: string): { imported: string; exported: string }[] {
  const out: { imported: string; exported: string }[] = [];
  for (const raw of clause.split(",")) {
    const piece = raw.trim();
    if (piece.length === 0) continue;
    // A type-only re-export cannot mount anything.
    if (/^type\s/.test(piece)) continue;
    const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(piece);
    if (!m) continue;
    out.push({ imported: m[1]!, exported: m[2] ?? m[1]! });
  }
  return out;
}

function reExportsOf(source: string): ReExport[] {
  const out: ReExport[] = [];
  for (const m of source.matchAll(BLOCK_RE)) {
    out.push({ names: parseSpecifiers(m[1]!), spec: m[2]! });
  }
  for (const m of source.matchAll(STAR_AS_RE)) {
    // `export * as NS from "x"` hands the whole module over under one name. Any
    // owed export inside it is reachable as a property, so the namespace itself
    // is treated as owed.
    out.push({ names: [{ imported: "*", exported: m[1]! }], spec: m[2]! });
  }
  for (const m of source.matchAll(STAR_RE)) {
    if (/export\s*\*\s*as\s/.test(m[0])) continue;
    out.push({ names: null, spec: m[1]! });
  }
  return out;
}

/**
 * Two-hop re-export: `import { A as L } from "x"; export { L as B };`. The
 * binding is renamed on the way in and again on the way out, and no single
 * statement names both ends.
 */
const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const BARE_EXPORT_RE = /export\s*\{([^}]*)\}\s*(?!from)/g;

/**
 * THE DEFAULT-EXPORT ROUTE, which the named-binding walk above cannot see.
 *
 * `default` is a name like any other in a module graph, but it is never spelled
 * in a `{ … }` clause on the way in, so an owed card can be laundered through it
 * without any statement this file used to read:
 *
 *     import HoldPanel from "./run-recommendation-chip-row";  // no braces
 *     export default HoldPanel;                               // no `from`
 *
 * Both hops are now edges, carrying the reserved name `default`, so the SAME
 * fixed point walks them. `export { default as X } from "…"` and
 * `export { X as default }` already parsed — `default` matches `\w+` — and now
 * they resolve against a target that can actually owe `default`.
 */
const DEFAULT_IMPORT_RE = /import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g;
const DEFAULT_EXPORT_RE = /export\s+default\s+(\w+)\s*;/g;

/** Words that follow `export default` without naming a local binding. */
const NOT_A_BINDING = new Set(["function", "class", "async", "new", "await", "typeof"]);

/**
 * THE NAMESPACE ROUTE — the same escape one level up, and the `default` slot is
 * where it bites.
 *
 * `export * as NS from "…"` is already an edge: the namespace carries every
 * owed name inside it, so the whole object is treated as owed. The INBOUND
 * spelling of that statement was not:
 *
 *     import * as ns from "./default-hop";   // no braces, no `export … from`
 *     export const Hold = ns.default;        // the owed card, under a third name
 *
 * `ns` binds a module rather than a name, so nothing in the named-binding walk
 * or the default walk above records the hop, and `ns.default` reads an export
 * that no clause ever spells. Three shapes are edges now, mirroring what the
 * outbound star already does:
 *
 *   · `import * as ns` then `export { ns }` / `export default ns` — the WHOLE
 *     namespace leaves, so it carries `*`, exactly as `export * as NS` does;
 *   · `[export] const X = ns.NAME` — a property read off the namespace is the
 *     same hop a named import would have been, `default` included;
 *   · `export default ns.NAME` — the outbound half of that read.
 *
 * The member read is deliberately conservative: it fires only when the object
 * is a namespace this file imported from a specifier that resolves INSIDE the
 * analysed package, so `const x = React.useMemo` and every other member read in
 * the tree is untouched.
 */
const NS_IMPORT_LOCAL_RE = /import\s*\*\s*as\s+(\w+)\s*from\s*["']([^"']+)["']/g;
const NS_MEMBER_RE = /(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*\.\s*(\w+)/g;
const DEFAULT_EXPORT_MEMBER_RE = /export\s+default\s+(\w+)\s*\.\s*(\w+)\s*;/g;

function localReExportsOf(source: string): ReExport[] {
  const locals = new Map<string, { imported: string; spec: string }>();
  for (const m of source.matchAll(IMPORT_RE)) {
    if (/import\s+type\s/.test(m[0])) continue;
    for (const { imported, exported } of parseSpecifiers(m[1]!)) {
      locals.set(exported, { imported, spec: m[2]! });
    }
  }
  // `import X from "spec"` and `import X, { Y } from "spec"` — the default
  // binding arrives under a local name of the importer's choosing.
  for (const m of source.matchAll(DEFAULT_IMPORT_RE)) {
    if (/import\s+type\s/.test(m[0])) continue;
    locals.set(m[1]!, { imported: "default", spec: m[2]! });
  }
  const out: ReExport[] = [];
  // `import * as ns from "spec"` — the whole module under one local name. Sent
  // on as a binding it carries everything the module owes, so it takes `*`.
  const namespaces = new Map<string, string>();
  for (const m of source.matchAll(NS_IMPORT_LOCAL_RE)) {
    if (/import\s+type\s/.test(m[0])) continue;
    namespaces.set(m[1]!, m[2]!);
    locals.set(m[1]!, { imported: "*", spec: m[2]! });
  }
  // `const Hold = ns.default` — a property read off one of those namespaces is
  // the hop a named import would have been. Exported in the same statement it
  // is an edge outright; bound to a local it joins the same alias table the
  // named and default routes are resolved through.
  for (const m of source.matchAll(NS_MEMBER_RE)) {
    const spec = namespaces.get(m[3]!);
    if (spec === undefined) continue;
    locals.set(m[2]!, { imported: m[4]!, spec });
    if (m[1] !== undefined) out.push({ names: [{ imported: m[4]!, exported: m[2]! }], spec });
  }
  // `export default ns.default;` — the read and the outbound hop in one line.
  for (const m of source.matchAll(DEFAULT_EXPORT_MEMBER_RE)) {
    const spec = namespaces.get(m[1]!);
    if (spec === undefined) continue;
    out.push({ names: [{ imported: m[2]!, exported: "default" }], spec });
  }
  for (const m of source.matchAll(BARE_EXPORT_RE)) {
    for (const { imported, exported } of parseSpecifiers(m[1]!)) {
      const via = locals.get(imported);
      if (via) out.push({ names: [{ imported: via.imported, exported }], spec: via.spec });
    }
  }
  // `export default Local;` — the outbound half of the same route.
  for (const m of source.matchAll(DEFAULT_EXPORT_RE)) {
    const local = m[1]!;
    if (NOT_A_BINDING.has(local)) continue;
    const via = locals.get(local);
    if (via) out.push({ names: [{ imported: via.imported, exported: "default" }], spec: via.spec });
  }
  return out;
}

/**
 * The owed exports of every module, to a fixed point.
 *
 * `seeds` maps a module to the exported names that ARE the owed card there. The
 * result maps every module that can hand one of those out to the names it hands
 * it out under — which is the question a chat import has to be checked against.
 */
export function owedExportsByModule(
  graph: SourceGraph,
  seeds: ReadonlyMap<string, readonly string[]>,
): Map<string, Set<string>> {
  const owed = new Map<string, Set<string>>();
  for (const [file, names] of seeds) owed.set(file, new Set(names));

  const statements = new Map<string, ReExport[]>();
  for (const file of graph.files) {
    const source = graph.read(file);
    statements.set(file, [...reExportsOf(source), ...localReExportsOf(source)]);
  }

  // A rename chain can be any depth, and the files are in no useful order, so
  // this runs until nothing new appears rather than in one pass.
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of graph.files) {
      for (const stmt of statements.get(file) ?? []) {
        const target = graph.resolve(file, stmt.spec);
        if (target === null) continue;
        const targetOwed = owed.get(target);
        if (targetOwed === undefined || targetOwed.size === 0) continue;
        const here = owed.get(file) ?? new Set<string>();
        const before = here.size;
        if (stmt.names === null) {
          for (const name of targetOwed) here.add(name);
        } else {
          for (const { imported, exported } of stmt.names) {
            if (imported === "*" || targetOwed.has(imported)) here.add(exported);
          }
        }
        if (here.size !== before) {
          owed.set(file, here);
          changed = true;
        }
      }
    }
  }
  return owed;
}

/** One import site in the importing package, as written. */
export type ImportSite = { spec: string; names: string[]; whole: boolean };

const NS_IMPORT_RE = /import\s*\*\s*as\s+(\w+)\s*from\s*["']([^"']+)["']/g;
const DEFAULT_OR_NAMED_RE = /import\s+(?!type\s)([^;"']*?)\s*from\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Every import site in a source file, with the value names it binds.
 *
 * `whole: true` means the file took the module rather than named bindings — a
 * namespace import, a re-export star, or a dynamic `import()`. Any owed export
 * in that module is then reachable, so the caller treats it as taking all of
 * them. Conservative on purpose: this arm exists because a name can be changed.
 */
export function importSitesOf(source: string): ImportSite[] {
  const sites: ImportSite[] = [];
  for (const m of source.matchAll(NS_IMPORT_RE)) sites.push({ spec: m[2]!, names: [], whole: true });
  for (const m of source.matchAll(DYNAMIC_RE)) sites.push({ spec: m[1]!, names: [], whole: true });
  for (const m of source.matchAll(DEFAULT_OR_NAMED_RE)) {
    const clause = m[1]!;
    if (/^\s*\*/.test(clause)) continue; // handled as a namespace above
    const braces = /\{([^}]*)\}/.exec(clause);
    const names = braces ? parseSpecifiers(braces[1]!).map((s) => s.imported) : [];
    // A bare default/side-effect import binds no owed name by itself.
    sites.push({ spec: m[2]!, names, whole: false });
  }
  for (const m of source.matchAll(BLOCK_RE)) {
    sites.push({ spec: m[2]!, names: parseSpecifiers(m[1]!).map((s) => s.imported), whole: false });
  }
  for (const m of source.matchAll(STAR_RE)) {
    if (/export\s*\*\s*as\s/.test(m[0])) continue;
    sites.push({ spec: m[1]!, names: [], whole: true });
  }
  return sites;
}

/**
 * Every place the importing package reaches an owed export, by whatever name.
 * Empty means the card cannot be drawn from there.
 */
export function owedReachesFrom(
  graph: SourceGraph,
  importers: readonly string[],
  owed: ReadonlyMap<string, ReadonlySet<string>>,
  label: (file: string) => string = (f) => f,
): string[] {
  const offenders: string[] = [];
  for (const file of importers) {
    for (const site of importSitesOf(graph.read(file))) {
      const target = graph.resolve(file, site.spec);
      if (target === null) continue;
      const targetOwed = owed.get(target);
      if (targetOwed === undefined || targetOwed.size === 0) continue;
      if (site.whole) {
        offenders.push(`${label(file)} → ${site.spec} (whole module; owed: ${[...targetOwed].join(", ")})`);
        continue;
      }
      for (const name of site.names) {
        if (targetOwed.has(name)) offenders.push(`${label(file)} → ${site.spec} as ${name}`);
      }
    }
  }
  return offenders.sort();
}
