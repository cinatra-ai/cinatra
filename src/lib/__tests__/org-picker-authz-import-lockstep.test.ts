/**
 * cinatra#1942 (archive activation V1, Decision 4) — picker/authz import
 * lockstep.
 *
 * `readOrgsWithTeamsForUser` (better-auth-db.ts) is a MIXED reader: authz
 * code (`build-actor-context-from-run.ts`, `permissions-kind-hooks.ts`) must
 * keep resolving an archived org's membership/role (so authz stays correct
 * and an archived org's owner can still reach Unarchive), while every UI
 * scope picker must exclude archived orgs via the sibling
 * `readOrgsWithTeamsForUserActiveOnly`. The design deliberately rejected a
 * defaulted `includeArchived` boolean on ONE function precisely because a
 * flag default is how an authz call site silently loses an archived org —
 * two named exports keep the choice grep-visible.
 *
 * This is a static source scan (same style as
 * packages/agents/src/__tests__/agent-run-status-write-source-pin.test.ts):
 * it walks src/** and packages/**, finds every real import (static `import
 * {...} from "@/lib/better-auth-db"` AND the dynamic
 * `await import("@/lib/better-auth-db")` destructure shape used by
 * permissions-kind-hooks.ts) of either function, and asserts the two sets
 * never drift — a reverted repoint or a new bad import fails CI immediately
 * instead of silently reintroducing the "archived org leaks into a picker"
 * or "archived org vanishes from authz" bug class.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["src", "packages"];
const EXCLUDE_DIR_NAMES = new Set([
  "node_modules",
  "__tests__",
  "__stubs__",
  ".next",
  "dist",
  "build",
  "coverage",
  ".git",
]);

// Authz readers: MUST stay on the unfiltered `readOrgsWithTeamsForUser` — an
// archived org's own membership/role must still resolve here.
const AUTHZ_ALLOWLIST = new Set<string>([
  "src/lib/authz/build-actor-context-from-run.ts",
  "packages/extensions/src/permissions-kind-hooks.ts",
]);

// UI scope pickers: MUST be on `readOrgsWithTeamsForUserActiveOnly` — an
// archived org must never be offered as a pick target.
const UI_ALLOWLIST = new Set<string>([
  "src/components/extensions/connection-sharing-section.tsx",
  "packages/skills/src/permissions-page-data.ts",
  "packages/skills/src/plugin-pages.tsx",
  "packages/connectors/src/pages.tsx",
  "packages/extensions/src/screens/extension-settings-screen.tsx",
  "packages/agents/src/screens.tsx",
  "packages/agents/src/instance-screens.tsx",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIR_NAMES.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

// Static: `import { a, readOrgsWithTeamsForUser, b } from "@/lib/better-auth-db"`
// (brace list may span multiple lines — no nested `}` occurs in an import list).
const STATIC_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(["'])@\/lib\/better-auth-db\2/g;
// Dynamic: `const { readOrgsWithTeamsForUser, x } = await import(\n  "@/lib/better-auth-db"\n)`
// (permissions-kind-hooks.ts's in-function lazy-load shape).
const DYNAMIC_IMPORT =
  /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*(["'])@\/lib\/better-auth-db\2\s*\)/g;

function importedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

function scan(): { unfiltered: string[]; activeOnly: string[] } {
  const unfiltered: string[] = [];
  const activeOnly: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file).split("\\").join("/");
      const names = importedNames(readFileSync(file, "utf-8"));
      if (names.has("readOrgsWithTeamsForUser")) unfiltered.push(rel);
      if (names.has("readOrgsWithTeamsForUserActiveOnly")) activeOnly.push(rel);
    }
  }
  return { unfiltered: unfiltered.sort(), activeOnly: activeOnly.sort() };
}

describe("org picker vs authz import lockstep (cinatra#1942 archive V1, Decision 4)", () => {
  const { unfiltered, activeOnly } = scan();

  it("every unfiltered readOrgsWithTeamsForUser importer is an authz reader on the allowlist", () => {
    const offenders = unfiltered.filter((f) => !AUTHZ_ALLOWLIST.has(f));
    expect(
      offenders,
      `Unexpected unfiltered readOrgsWithTeamsForUser importer(s) outside the authz ` +
        `allowlist: ${JSON.stringify(offenders)} — a UI scope picker must use ` +
        `readOrgsWithTeamsForUserActiveOnly instead (cinatra#1942 Decision 4).`,
    ).toEqual([]);
  });

  it("every readOrgsWithTeamsForUserActiveOnly importer is a known UI picker on the allowlist", () => {
    const offenders = activeOnly.filter((f) => !UI_ALLOWLIST.has(f));
    expect(
      offenders,
      `Unexpected ...ActiveOnly importer(s) outside the known UI-picker allowlist: ` +
        `${JSON.stringify(offenders)} — add it to UI_ALLOWLIST here if it's a genuine ` +
        `new scope picker, or reconsider if it's actually an authz path.`,
    ).toEqual([]);
  });

  it("no authz allowlist file imports the ActiveOnly variant", () => {
    const leaked = [...AUTHZ_ALLOWLIST].filter((f) => activeOnly.includes(f));
    expect(leaked).toEqual([]);
  });

  it("no UI-picker allowlist file imports the unfiltered variant", () => {
    const leaked = [...UI_ALLOWLIST].filter((f) => unfiltered.includes(f));
    expect(leaked).toEqual([]);
  });

  it("every UI-picker allowlist file DOES import ActiveOnly (non-vacuous)", () => {
    const missing = [...UI_ALLOWLIST].filter((f) => !activeOnly.includes(f));
    expect(missing).toEqual([]);
  });

  it("every authz allowlist file DOES import the unfiltered reader (non-vacuous)", () => {
    const missing = [...AUTHZ_ALLOWLIST].filter((f) => !unfiltered.includes(f));
    expect(missing).toEqual([]);
  });

  it("is non-vacuous overall: the scan actually found both sets", () => {
    expect(unfiltered.length).toBeGreaterThan(0);
    expect(activeOnly.length).toBeGreaterThan(0);
  });
});
