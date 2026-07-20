// cinatra#1907 grep gate: entityId() (src/lib/id-policy.ts) is the ONE mint
// for auth entity-row ids (user / organization / member / team / teamMember).
// This static source scan (same idiom as principal-minting-single-caller):
//
//   * inventories every file that INSERTs into an auth entity table and pins
//     the set — a new ad-hoc mint path fails the gate until it either uses
//     entityId() and is added here, or goes through the better-auth API
//     (whose ids the generateId override in src/lib/auth.ts shapes);
//   * asserts each pinned mint path consumes entityId() and no longer calls
//     randomUUID for entity ids (assistant-users.ts legitimately keeps
//     crypto.randomUUID for OAuth clientId/clientSecret — credentials, not
//     entity ids — so it is pinned by its exact userId mint line instead);
//   * asserts the better-auth override itself routes through entityId().

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const SCAN_ROOT = join(REPO_ROOT, "src");

// Drizzle insert targets and raw-SQL insert targets for the auth entity
// tables. NOTE `public.team` appears unquoted in live SQL (teams/new).
const INSERT_SIGNATURE =
  /\.insert\(betterAuth(?:Users|Organizations|Members|Teams|TeamMembers)\)|INSERT INTO public\.(?:"(?:user|organization|member|team|teamMember)"|team\b)/;

const EXPECTED_MINT_FILES = [
  "src/app/teams/[teamId]/settings/member-actions.ts",
  "src/app/teams/new/actions.ts",
  "src/lib/assistant-users.ts",
  "src/lib/better-auth-membership-bootstrap.ts",
  "src/lib/default-organization-bootstrap.ts",
].sort();

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === "generated") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out = out.concat(walk(full));
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      !full.includes("__tests__")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("entity-id mint gate (#1907)", () => {
  const files = walk(SCAN_ROOT);
  const inserters = files
    .filter((f) => INSERT_SIGNATURE.test(readFileSync(f, "utf8")))
    .map((f) => relative(REPO_ROOT, f).replaceAll("\\", "/"))
    .sort();

  it("pins the exact set of auth entity-table insert sites", () => {
    expect(inserters).toEqual(EXPECTED_MINT_FILES);
  });

  it("every pinned mint path consumes entityId() from the id-policy module", () => {
    for (const rel of EXPECTED_MINT_FILES) {
      const content = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(content, rel).toContain('from "@/lib/id-policy"');
      expect(content, rel).toContain("entityId()");
    }
  });

  it("no pinned mint path mints entity ids with randomUUID", () => {
    for (const rel of EXPECTED_MINT_FILES) {
      const content = readFileSync(join(REPO_ROOT, rel), "utf8");
      if (rel === "src/lib/assistant-users.ts") {
        // clientId/clientSecret stay crypto.randomUUID (OAuth credentials);
        // the ENTITY id must come from the policy helper.
        expect(content).toContain("const userId = entityId()");
        continue;
      }
      expect(content, rel).not.toMatch(/randomUUID/);
    }
  });

  it("the better-auth generateId override routes through entityId()", () => {
    const auth = readFileSync(join(REPO_ROOT, "src/lib/auth.ts"), "utf8");
    expect(auth).toContain("generateId: () => entityId()");
  });
});
