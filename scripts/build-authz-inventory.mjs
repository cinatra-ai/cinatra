#!/usr/bin/env node
/**
 * Authz inventory builder.
 *
 * Statically scans every road by which a tool is registered across
 * `packages/`, `extensions/`, and `src/` and emits a machine-readable JSON
 * matrix consumed by the authz inventory guard test at:
 *   src/lib/authz/__tests__/drift-gate.test.ts
 *
 * Each row records its road (cinatra#4895):
 *   - "mcp": a tool on the MCP server — a literal `server.registerTool(name`,
 *     a `*TOOL_META*` block key, or a pack's `ctx.mcp.registerTool({ name`.
 *   - "passthrough": a name the deterministic passthrough route admits
 *     (`ALLOWED_TOOLS` in src/app/api/agents/passthrough/route.ts, with the sets
 *     it spreads in) that no MCP road registers. A name the route admits that
 *     IS an MCP tool is dispatched to that tool's handler and keeps its mcp row.
 * A row's `file` is its owner: a path under `extensions/<scope>/<pack>/` is
 * that pack, any other path is core.
 *
 * Hand-augmentation of classification per primitive lives in:
 *   src/lib/authz/inventory-augment.ts
 *
 * The classification is split between this generated JSON and the hand-authored TS augmentation.
 *
 * Usage:
 *   pnpm authz:inventory          (rebuild)
 *   pnpm authz:inventory --check  (fail if file is stale)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const check = args.includes("--check");
// `--root <dir>` runs the builder on another tree (a test fixture).
const rootArg = args.indexOf("--root");
const ROOT =
  rootArg === -1 ? resolve(fileURLToPath(import.meta.url), "../..") : resolve(args[rootArg + 1] ?? "");
const ROOTS = ["packages", "extensions", "src"];
const OUT = join(ROOT, "src/lib/authz/__generated__/inventory.json");

const REGISTER_RE = /server\s*\.\s*registerTool\s*\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g;
// Every package registry collects its tool table in a `TOOL_META` (or
// `*_TOOL_META`) `Record<string, { description, inputSchema }>` and then
// iterates it through a single `server.registerTool(name, …)` call. The
// literal primitive names live as object keys inside that block — they
// never appear in a registerTool string arg. Scan for those too.
const TOOL_META_BLOCK_RE = /(?:[A-Z_]*TOOL_META[A-Z_]*)\s*:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\n\}\s*;/g;
const TOOL_META_KEY_RE = /^\s{2,}(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*:\s*\{/gm;
// A pack's `register(ctx)` registers on the host MCP server through its port.
const CTX_REGISTER_RE = /\.mcp\s*\.\s*registerTool\s*\(\s*\{\s*name\s*:\s*["'`]([a-zA-Z0-9_]+)["'`]/g;
// The passthrough road: the route's allow list and the sets it spreads in.
const PASSTHROUGH_ROUTE = "src/app/api/agents/passthrough/route.ts";

/** @param {string} dir */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist" || entry === "__generated__") continue;
    // Test files register fixture tools; they are not registration roads.
    if (entry === "__tests__" || /\.test\.tsx?$/.test(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walk(full);
    else if (s.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) yield full;
  }
}

/** @returns {Array<{primitiveName:string,file:string,line:number}>} */
function scan() {
  const records = [];
  for (const root of ROOTS) {
    const abs = join(ROOT, root);
    let exists = true;
    try {
      statSync(abs);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for (const file of walk(abs)) {
      let body;
      try {
        body = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      REGISTER_RE.lastIndex = 0;
      let m;
      while ((m = REGISTER_RE.exec(body)) !== null) {
        const upto = body.slice(0, m.index);
        const line = upto.split("\n").length;
        records.push({
          primitiveName: m[1],
          file: relative(ROOT, file),
          line,
        });
      }
      CTX_REGISTER_RE.lastIndex = 0;
      while ((m = CTX_REGISTER_RE.exec(body)) !== null) {
        records.push({ primitiveName: m[1], file: relative(ROOT, file), line: lineAt(body, m.index) });
      }
      // Also collect TOOL_META block keys — these are the canonical primitive
      // names every registry exposes through the per-handler iterator.
      TOOL_META_BLOCK_RE.lastIndex = 0;
      let block;
      while ((block = TOOL_META_BLOCK_RE.exec(body)) !== null) {
        const blockStart = block.index;
        const lineOfBlock = body.slice(0, blockStart).split("\n").length;
        const blockBody = block[1];
        TOOL_META_KEY_RE.lastIndex = 0;
        let kMatch;
        while ((kMatch = TOOL_META_KEY_RE.exec(blockBody)) !== null) {
          const name = kMatch[1] ?? kMatch[2];
          if (!name) continue;
          // Skip pseudo-identifiers used inside zod schemas / handler maps.
          if (name === "description" || name === "inputSchema" || name === "title") continue;
          const innerOffset = blockStart + (block[0].indexOf(blockBody) ?? 0) + kMatch.index;
          const lineNum = body.slice(0, innerOffset).split("\n").length;
          records.push({
            primitiveName: name,
            file: relative(ROOT, file),
            line: lineNum,
          });
        }
      }
    }
  }
  // De-duplicate by (primitiveName, file): a primitive can appear both as a
  // TOOL_META key AND inside a single inline `server.registerTool(name, …)`
  // line — only keep the smallest line number per pair.
  const dedupe = new Map();
  for (const r of records) {
    const key = `${r.primitiveName}::${r.file}`;
    const prev = dedupe.get(key);
    if (!prev || prev.line > r.line) dedupe.set(key, r);
  }
  const mcpNames = new Set(records.map((r) => r.primitiveName));
  for (const r of dedupe.values()) r.road = "mcp";
  for (const r of scanPassthrough()) {
    if (mcpNames.has(r.primitiveName)) continue;
    const key = `${r.primitiveName}::${r.file}`;
    if (!dedupe.has(key)) dedupe.set(key, { ...r, road: "passthrough" });
  }
  const deduped = [...dedupe.values()].map(({ primitiveName, file, line, road }) => ({ primitiveName, file, road, line }));
  deduped.sort((a, b) =>
    a.primitiveName === b.primitiveName ? a.file.localeCompare(b.file) : a.primitiveName.localeCompare(b.primitiveName),
  );
  return deduped;
}

/** @param {string} body @param {number} index */
function lineAt(body, index) {
  return body.slice(0, index).split("\n").length;
}

/** @param {string} rel */
function readRel(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
}

/**
 * The names in one `NAME = new Set...([ ... ])` block of `rel`: string
 * literals, constants declared in the same file as `export const X = "name"`,
 * and `...SET` spreads followed to the file `rel` imports them from (`@/` is
 * `src/`).
 * @param {string} rel @param {string} setName @param {Set<string>} seen
 * @returns {Array<{primitiveName:string,file:string,line:number}>}
 */
function namesOfSet(rel, setName, seen) {
  const key = `${rel}::${setName}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const body = readRel(rel);
  if (body === null) return [];
  const block = new RegExp(`\\b${setName}\\b[^=\\n]*=\\s*new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`).exec(body);
  if (!block) return [];
  const blockStart = block.index + block[0].indexOf(block[1]);
  const out = [];
  const entryRe = /^\s*(?:"([a-z_][a-z0-9_]*)"|\.\.\.([A-Za-z_][A-Za-z0-9_]*)|([A-Z_][A-Z0-9_]*))\s*,?\s*(?:\/\/.*)?$/gm;
  let e;
  while ((e = entryRe.exec(block[1])) !== null) {
    if (e[1]) {
      out.push({ primitiveName: e[1], file: rel, line: lineAt(body, blockStart + e.index + e[0].indexOf('"')) });
    } else if (e[2]) {
      const imp = new RegExp(`import\\s*\\{[^}]*\\b${e[2]}\\b[^}]*\\}\\s*from\\s*["']@/([^"']+)["']`).exec(body);
      out.push(...namesOfSet(imp ? `src/${imp[1]}.ts` : rel, e[2], seen));
    } else if (e[3]) {
      const decl = new RegExp(`export const ${e[3]}\\s*=\\s*"([a-z_][a-z0-9_]*)"`).exec(body);
      if (decl) out.push({ primitiveName: decl[1], file: rel, line: lineAt(body, decl.index) });
    }
  }
  return out;
}

function scanPassthrough() {
  return namesOfSet(PASSTHROUGH_ROUTE, "ALLOWED_TOOLS", new Set());
}

function emit() {
  const records = scan();
  const out = {
    // NO generatedAt / timestamp here: this file is byte-compared by `--check`,
    // so any volatile field makes the gate fail the day after it was committed
    // (a recurring RBAC CI red — fixed for good by removing the date, not by
    // re-regenerating). Keep the emitted JSON deterministic.
    generatedBy: "scripts/build-authz-inventory.mjs",
    note: "DO NOT EDIT BY HAND. Re-run `pnpm authz:inventory`. Classification lives in src/lib/authz/inventory-augment.ts.",
    primitives: records,
  };
  return JSON.stringify(out, null, 2) + "\n";
}

const next = emit();
if (check) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== next) {
    console.error("authz inventory drift: " + OUT + " is stale. Run `pnpm authz:inventory` to refresh.");
    process.exit(1);
  }
  console.log("authz inventory check: ok (" + JSON.parse(next).primitives.length + " primitives)");
} else {
  writeFileSync(OUT, next);
  console.log("authz inventory: wrote " + OUT + " (" + JSON.parse(next).primitives.length + " primitives)");
}
