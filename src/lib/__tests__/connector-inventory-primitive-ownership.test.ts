/**
 * ONE NAME, ONE OWNER — `connector_inventory_list` (cinatra#2723).
 *
 * Two registries can claim a primitive name and neither one protects this name
 * by itself:
 *
 *   • `collectAllPrimitiveHandlers()` (src/lib/primitive-handlers.ts) builds one
 *     flat object by SPREADING the manifest-discovered connector handlers over
 *     the core's own literal keys. An object spread has no collision check, so a
 *     duplicate resolves by source order with nothing failing anywhere. The
 *     existing collision guard is scoped to the `appointment_schedule_*` family
 *     and does NOT cover this name.
 *   • the MCP registration pass (src/lib/mcp-server.ts) registers the platform
 *     modules, then the manifest-discovered connector modules, then replays the
 *     extension-registered tools. A host/module name collision there is loud,
 *     but only if the host is the single owner to begin with.
 *
 * So: the core MCP capability module is the sole registrar, `connector_inventory_list`
 * is absent from the spread-composed passthrough registry, and no extension
 * package claims it. Pinned against the real tree.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { CONNECTOR_INVENTORY_TOOL_NAME } from "@/lib/connector-inventory-mcp";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const OWNER_MODULE = "src/lib/connector-inventory-mcp.ts";
const PASSTHROUGH_REGISTRY = "src/lib/primitive-handlers.ts";
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const SCAN_ROOTS = ["src", "packages"];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);
const CODE_EXT = /\.(ts|tsx|mts|mjs)$/;

/**
 * A REGISTRATION of the name — the two forms this codebase uses: a direct
 * `registerTool` call whose first argument is the quoted name, and a quoted
 * handler-map / TOOL_META key. An allowlist ENTRY (the quoted name followed by
 * a comma) and a constant assignment are deliberately NOT registrations.
 *
 * The doc deliberately DESCRIBES rather than quotes the direct-registration
 * form: the authz-inventory builder scans this tree for that literal, and a
 * prose example would enter the generated inventory as a phantom primitive.
 */
function registrationForms(name: string): RegExp[] {
  return [
    new RegExp(`registerTool\\s*\\(\\s*["'\`]${name}["'\`]`),
    new RegExp(`["'\`]${name}["'\`]\\s*:`),
  ];
}

/** Block comments plus WHOLE-LINE `//` comments — prose never owns a name. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walk(full);
    else if (s.isFile() && CODE_EXT.test(full)) yield full;
  }
}

function isTestFile(file: string): boolean {
  return /(^|\/)__tests__\//.test(file) || /\.test\.[a-z]+$/.test(file);
}

/**
 * The names this gate cares about: the one we own, plus the near-miss spellings
 * a future edit might reach for. Scanned in a SINGLE tree walk.
 */
const NEAR_MISS_NAMES = [
  "connectors_list",
  "connections_list",
  "connector_instances_list",
  "connector_connections_list",
] as const;

/** name -> the non-test files that REGISTER it, as repo-relative paths. */
function collectRegistrars(): Map<string, string[]> {
  const names = [CONNECTOR_INVENTORY_TOOL_NAME, ...NEAR_MISS_NAMES];
  const out = new Map<string, string[]>(names.map((n) => [n, []]));
  const roots = [...SCAN_ROOTS.map((r) => join(REPO_ROOT, r))];
  if (existsSync(EXTENSIONS_ROOT)) roots.push(EXTENSIONS_ROOT);
  for (const root of roots) {
    for (const file of walk(root)) {
      if (isTestFile(file)) continue;
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      // Cheap pre-filter: almost every file mentions none of these names.
      if (!names.some((n) => source.includes(n))) continue;
      const body = stripComments(source);
      for (const name of names) {
        if (registrationForms(name).some((re) => re.test(body))) {
          out.get(name)!.push(relative(REPO_ROOT, file));
        }
      }
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}

const REGISTRARS = collectRegistrars();

describe("connector_inventory_list — primitive ownership", () => {
  it("the extension tree is materialized (otherwise the extension half passes vacuously)", () => {
    // Same guard the appointment-schedule ownership gate carries: without the
    // companion extension repos on disk, "no extension claims this name" is
    // true for the wrong reason. CI clones them before this suite runs.
    expect(existsSync(EXTENSIONS_ROOT)).toBe(true);
  });

  it("the exported constant matches the literal the registrar uses", () => {
    expect(CONNECTOR_INVENTORY_TOOL_NAME).toBe("connector_inventory_list");
    const owner = readFileSync(join(REPO_ROOT, OWNER_MODULE), "utf8");
    // A STRING LITERAL, not the constant: the authz-inventory builder scans
    // `server.registerTool("<name>"` statically and cannot follow an identifier.
    expect(
      new RegExp(
        `server\\.registerTool\\(\\s*"${CONNECTOR_INVENTORY_TOOL_NAME}"`,
      ).test(owner),
      "the registrar must pass the tool name as a string literal",
    ).toBe(true);
  });

  it("exactly ONE module registers the name", () => {
    expect(REGISTRARS.get(CONNECTOR_INVENTORY_TOOL_NAME)).toEqual([OWNER_MODULE]);
  });

  it("the spread-composed passthrough registry does not claim the name", () => {
    const source = stripComments(readFileSync(join(REPO_ROOT, PASSTHROUGH_REGISTRY), "utf8"));
    expect(source).not.toContain(CONNECTOR_INVENTORY_TOOL_NAME);
  });

  it("the owner module is composed into the MCP registration pass", () => {
    const server = readFileSync(join(REPO_ROOT, "src/lib/mcp-server.ts"), "utf8");
    expect(server).toContain("createConnectorInventoryMcpModule");
    // PRE-connector block: the host claims the platform-inventory name before
    // any manifest-discovered connector module registers.
    const preAt = server.indexOf("const preConnectorPlatformModules");
    const postAt = server.indexOf("const postConnectorPlatformModules");
    const moduleAt = server.indexOf("createConnectorInventoryMcpModule()");
    expect(preAt).toBeGreaterThan(-1);
    expect(postAt).toBeGreaterThan(preAt);
    expect(moduleAt).toBeGreaterThan(preAt);
    expect(moduleAt).toBeLessThan(postAt);
  });

  it("no competing near-miss spelling is registered anywhere", () => {
    for (const nearMiss of NEAR_MISS_NAMES) {
      expect(REGISTRARS.get(nearMiss), `${nearMiss} is registered`).toEqual([]);
    }
  });
});
