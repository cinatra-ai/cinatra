/**
 * ONE NAME, ONE OWNER — the `appointment_schedule_*` primitive family.
 *
 * `collectAllPrimitiveHandlers()` builds ONE flat object by SPREADING the
 * manifest-discovered connector handlers and then the core's own literal
 * handlers. A plain object spread has no collision check: if a connector and
 * the core both registered `appointment_schedule_add`, the later spread would
 * SILENTLY overwrite the earlier one and the surviving implementation would
 * depend on source order in this file — a fault that shows up as "the tool did
 * something else than the connector's tests prove" with nothing failing.
 *
 * cinatra#2367 split appointment schedules into their own connector precisely
 * to give every name in the family exactly one owner:
 *   - `appointment_schedule_list` — owned by the CONNECTOR (its MCP tool). The
 *     redundant core list bridge was REMOVED.
 *   - `appointment_schedule_add`  — owned by the CORE, as an extension-backed
 *     facade (it needs the invoking-user identity the host holds).
 *
 * This test pins that partition against the real tree: the core registry source
 * plus every extension package on disk.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CORE_REGISTRY = "src/lib/primitive-handlers.ts";
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);
const CODE_EXT = /\.(ts|tsx|mts|mjs)$/;

/**
 * A REGISTRATION of a family name: the quoted-key form every registration site
 * in this codebase uses — the handler map key (`"appointment_schedule_add": …`)
 * and the registry's TOOL_META key. Prose mentions in comments are stripped
 * first (see `stripComments`) and never count as ownership.
 */
const FAMILY_KEY_RE = /"(appointment_schedule_[a-z0-9_]+)"\s*:/g;

/** Block comments, plus WHOLE-LINE `//` comments (a trailing `//` inside a
 *  string — e.g. a URL — is left alone rather than risking a truncated line). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
/** The retired spellings this cutover removed — including the double-underscore
 *  drift that matched no registered primitive at all. */
const RETIRED_SPELLINGS = [
  "calendar_appointments_list",
  "calendar_appointments_add",
  "calendar__appointments__add",
  "google_calendar_appointments_list",
];

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

/** `extensions/<vendor>/<package>` for a file inside the extension tree. */
function extensionPackageOf(absFile: string): string {
  const rel = relative(REPO_ROOT, absFile).split("/");
  return rel.slice(0, 3).join("/");
}

function namesIn(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripComments(source).matchAll(FAMILY_KEY_RE)) out.add(m[1]);
  return out;
}

/** name -> the set of owners (one core entry + one entry per extension package). */
function collectOwners(): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  const add = (name: string, owner: string) => {
    const set = owners.get(name) ?? new Set<string>();
    set.add(owner);
    owners.set(name, set);
  };

  for (const name of namesIn(readFileSync(join(REPO_ROOT, CORE_REGISTRY), "utf8"))) {
    add(name, "core");
  }
  if (existsSync(EXTENSIONS_ROOT)) {
    for (const file of walk(EXTENSIONS_ROOT)) {
      // Tests may legitimately mention a name they do not own.
      if (/(^|\/)__tests__\//.test(file) || /\.test\.[a-z]+$/.test(file)) continue;
      for (const name of namesIn(readFileSync(file, "utf8"))) add(name, extensionPackageOf(file));
    }
  }
  return owners;
}

describe("appointment_schedule_* primitive ownership (cinatra#2367)", () => {
  it("the extension tree is materialized (otherwise this gate passes vacuously)", () => {
    expect(existsSync(EXTENSIONS_ROOT)).toBe(true);
    expect(
      existsSync(join(EXTENSIONS_ROOT, "cinatra-ai/google-appointment-schedules-connector")),
    ).toBe(true);
  });

  it("every name in the family has EXACTLY ONE owner", () => {
    const duplicated = [...collectOwners().entries()]
      .filter(([, owners]) => owners.size > 1)
      .map(([name, owners]) => `${name}: ${[...owners].sort().join(" + ")}`);
    expect(duplicated).toEqual([]);
  });

  it("the connector owns the list tool; the core owns only the add bridge", () => {
    const owners = collectOwners();
    expect([...(owners.get("appointment_schedule_list") ?? [])]).toEqual([
      "extensions/cinatra-ai/google-appointment-schedules-connector",
    ]);
    expect([...(owners.get("appointment_schedule_add") ?? [])]).toEqual(["core"]);
  });

  it("the core registry registers no other name in the family", () => {
    const core = namesIn(readFileSync(join(REPO_ROOT, CORE_REGISTRY), "utf8"));
    expect([...core].sort()).toEqual(["appointment_schedule_add"]);
  });

  // The mechanism the invariant protects: the connector spread runs BEFORE the
  // core's literal keys, so a duplicate would resolve to the CORE handler with
  // no error anywhere. Assert the order so a future edit that moves the core
  // keys above the spread (silently flipping which side wins) is caught.
  it("connector handlers are spread BEFORE the core's own family keys", () => {
    const source = readFileSync(join(REPO_ROOT, CORE_REGISTRY), "utf8");
    const spreadAt = source.indexOf("...(await loadConnectorPrimitiveHandlers())");
    const coreKeyAt = source.indexOf('"appointment_schedule_add":');
    expect(spreadAt).toBeGreaterThan(-1);
    expect(coreKeyAt).toBeGreaterThan(spreadAt);
  });

  it("no retired primitive spelling survives in the core registry", () => {
    const source = readFileSync(join(REPO_ROOT, CORE_REGISTRY), "utf8");
    for (const retired of RETIRED_SPELLINGS) {
      expect(source.includes(retired), `${retired} still referenced`).toBe(false);
    }
  });
});
