// cinatra#1939 (wave 3 Stage E — "the auth floor", track 3's last piece) —
// the internal `auth.api.*` caller inventory. The write-registry (R4 import
// ban) governs writers the org-write KERNEL wraps; better-auth's organization
// plugin endpoints run their OWN internal transaction and cannot be wrapped
// that way (no seam for `guardOrgMutation`), so this family is deliberately
// OUTSIDE write-registry.ts — a third "family verdict" alongside the edge-
// writer inventory's other two (org-write-edge-writer-inventory.test.ts):
// "flows through an already-registered writer" / "no organization-axis write
// at all" / and this one, "org-axis write present but kernel-unwrappable,
// floored by the DB-level archive-guard triggers (better-auth-migrate.mts)
// plus the app-layer dispatch policy (organization-dispatch-policy.ts,
// cinatra#1942) instead of guardOrgMutation".
//
// This suite pins the EXHAUSTIVE set of internal (non-test) call sites that
// invoke a mutating `auth.api.*` organization-plugin method, so a new one
// added later without updating this inventory fails CI — the same
// "deliberate, reviewed change instead of silent drift" contract the R4
// ratchet gives kernel-wrapped writers. The sweep is REPO-WIDE (src/ +
// packages/ + scripts/, the same roots the boundary gate scans) — an
// inventory that only re-read its own listed files would let a new caller in
// a NEW file sail through, which is exactly the drift this suite exists to
// stop. Each assertion reads the real source (comment-stripped, call anchored
// on `auth.api.<method>(` — never a bare substring match, per the
// org-write-table-sweep lesson that a naive regex is worse than none) so a
// rename or a removed call site fails here instead of going unseen.
//
// Honest detector limits (textual, not AST): an ALIASED binding
// (`const a = auth; a.api.x()`), a destructured `api`, or bracket-notation
// access would evade the anchor. None exists in the tree today, and the
// convention pin below (`auth.api.` is the one sanctioned spelling) makes
// introducing one a reviewable style deviation rather than a silent bypass.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** Every `auth.api.<method>(` call site in a comment-stripped source string,
 *  as `method` names (duplicates preserved — call-SITE count, not method-set). */
function extractAuthApiCalls(src: string): string[] {
  const stripped = stripComments(src);
  const matches = stripped.matchAll(/\bauth\.api\.([A-Za-z][A-Za-z0-9]*)\s*\(/g);
  return [...matches].map((m) => m[1]);
}

describe("extractAuthApiCalls — positive control (proves the detector works before trusting it)", () => {
  it("finds a real call in a minimal fixture", () => {
    expect(extractAuthApiCalls(`await auth.api.updateMemberRole({ body: {} });`)).toEqual([
      "updateMemberRole",
    ]);
  });

  it("ignores a call site that only appears INSIDE a comment (the sweep-regex lesson: strip comments first)", () => {
    const fixture = [
      "// await auth.api.removeMember({ body: {} });",
      "/* await auth.api.createInvitation({ body: {} }); */",
      "const real = 1;",
    ].join("\n");
    expect(extractAuthApiCalls(fixture)).toEqual([]);
  });

  it("catches a SEEDED violation: an extra call site added to an otherwise-clean fixture changes the detected count", () => {
    const clean = `await auth.api.updateMemberRole({ body: {} });\n`;
    const seeded = clean + `await auth.api.createOrganization({ body: {} });\n`;
    expect(extractAuthApiCalls(clean)).toHaveLength(1);
    expect(extractAuthApiCalls(seeded)).toHaveLength(2);
    expect(extractAuthApiCalls(seeded)).toContain("createOrganization");
  });

  it("does not misfire on an unrelated `.api.` access or a differently-named object", () => {
    const fixture = [
      `someOtherThing.api.updateMemberRole({});`,
      `const x = notAuth.api.removeMember;`,
    ].join("\n");
    // The anchor is `auth.api.` with a word boundary before `auth` — neither
    // line's receiver IS `auth`, so both are correctly excluded.
    expect(extractAuthApiCalls(fixture)).toEqual([]);
  });
});

interface CallerRow {
  readonly file: string;
  /** The exported entry point a caller of this module would import (or, for
   *  an object-literal MCP handler map, the handler key). */
  readonly entryPoint: string;
  readonly method: string;
  /** What table(s) this call ultimately writes and how the archived-org
   *  concern is (or is deliberately not) floored for it. */
  readonly floor:
    | "new-member-invitation-archive-guard" // this stage's new DB trigger
    | "existing-session-activation-guard" // S1's trigger already covers it
    | "cleanup-never-blocked" // DELETE / reject / cancel shape — narrow allowance
    | "org-axis-dispatch-policy-covered" // org-scoped but non-access-granting; the app-layer dispatch policy owns it
    | "no-organization-axis" // genuinely no org-scoped write at all
    | "new-org-cannot-be-archived"; // creates the org; nothing to archive yet
}

// The exhaustive inventory. One row per (file, entryPoint, method) call site.
// A file/method pair NOT in this list that the sweep below finds is a build
// failure (new caller, not yet reviewed); a row here the sweep does NOT find
// is equally a failure (stale inventory — the call site moved or was removed).
const AUTH_API_CALLER_INVENTORY: readonly CallerRow[] = [
  {
    file: "src/app/organizations/new/actions.ts",
    entryPoint: "createOrganizationAction",
    method: "createOrganization",
    floor: "new-org-cannot-be-archived",
  },
  {
    file: "src/app/teams/new/actions.ts",
    entryPoint: "createTeamAction",
    method: "setActiveOrganization",
    floor: "existing-session-activation-guard",
  },
  {
    file: "packages/dashboards/src/screens/organization-manage-actions.ts",
    entryPoint: "updateOrganizationSettingsAction",
    method: "updateOrganization",
    // Organization-scoped, but NON-ACCESS-GRANTING: renaming an org grants no
    // new access, so it does not carry the silent-orphan risk of a new
    // member/invitation row. The archived-org concern for it is the app-layer
    // dispatch policy's job (cinatra#1942 organization-dispatch-policy.ts,
    // "org-settings update" is named explicitly in its endpoint list) — a
    // deliberately different floor than this stage's DB trigger, not an
    // absent one.
    floor: "org-axis-dispatch-policy-covered",
  },
  {
    file: "packages/dashboards/src/screens/organization-manage-actions.ts",
    entryPoint: "updateOrganizationMemberRoleAction",
    method: "updateMemberRole",
    floor: "new-member-invitation-archive-guard",
  },
  {
    file: "packages/dashboards/src/screens/organization-manage-actions.ts",
    entryPoint: "removeOrganizationMemberAction",
    method: "removeMember",
    floor: "cleanup-never-blocked",
  },
  {
    file: "packages/dashboards/src/screens/organization-manage-actions.ts",
    entryPoint: "cancelOrganizationInvitationAction",
    method: "cancelInvitation",
    floor: "cleanup-never-blocked",
  },
  {
    file: "packages/permissions/src/mcp/handlers.ts",
    entryPoint: "permissions_members_invite",
    method: "createInvitation",
    floor: "new-member-invitation-archive-guard",
  },
  {
    file: "packages/permissions/src/mcp/handlers.ts",
    entryPoint: "permissions_members_update_role",
    method: "updateMemberRole",
    floor: "new-member-invitation-archive-guard",
  },
  {
    file: "packages/permissions/src/mcp/handlers.ts",
    entryPoint: "permissions_members_remove",
    method: "removeMember",
    floor: "cleanup-never-blocked",
  },
  {
    file: "packages/permissions/src/mcp/handlers.ts",
    entryPoint: "permissions_invitations_cancel",
    method: "cancelInvitation",
    floor: "cleanup-never-blocked",
  },
  {
    file: "packages/permissions/src/actions.ts",
    entryPoint: "inviteWorkspaceMemberAction",
    method: "createInvitation",
    floor: "new-member-invitation-archive-guard",
  },
  {
    file: "packages/permissions/src/actions.ts",
    entryPoint: "updateWorkspaceMemberRoleAction",
    method: "updateMemberRole",
    floor: "new-member-invitation-archive-guard",
  },
  {
    file: "packages/permissions/src/actions.ts",
    entryPoint: "updateUserPlatformRoleAction",
    method: "setRole",
    // Better Auth's admin-plugin `setRole` sets the GLOBAL public."user".role
    // (platform admin/user), not an organization-scoped field — no org axis.
    floor: "no-organization-axis",
  },
  {
    file: "src/app/configuration/permissions/actions.ts",
    entryPoint: "deleteUserAction",
    method: "removeUser",
    // Account deletion — the exact "can never get stuck" allowance the
    // design calls out by name. removeUser cascades to the user's member /
    // session / account rows; none of this stage's guards intercept DELETE.
    floor: "cleanup-never-blocked",
  },
  {
    file: "src/app/projects/[projectId]/permissions/guest-actions.ts",
    entryPoint: "inviteGuestByEmailAction",
    method: "createUser",
    // Reached via the module-private createGuestAccount() helper. Creates a
    // Better Auth user row with NO member row (project access for a guest is
    // a separate role_grant mechanism, not org membership) — no org axis.
    floor: "no-organization-axis",
  },
  {
    file: "src/app/projects/[projectId]/permissions/guest-actions.ts",
    entryPoint: "inviteGuestByEmailAction",
    method: "requestPasswordReset",
    // Sends an email; better-auth's own request-password-reset endpoint
    // performs no organization-scoped table write at all.
    floor: "no-organization-axis",
  },
];

// auth.api methods that are allowed ANYWHERE without an inventory row — each
// with the reason it is out of this inventory's mutating-org-write scope.
// This IS a functional filter for the repo-wide sweep below: a method not in
// this set and not in the inventory fails the sweep wherever it appears.
const OUT_OF_SCOPE_METHODS = new Set([
  "getSession", // read-only
  "hasPermission", // read-only
  // Dev-only bootstrap seeding (src/lib/dev-auto-setup.ts): DOES create a
  // user, but with no organization axis, on a dev-fixture-gated path.
  "signUpEmail",
]);

// Directory names never descended into. Same name set the previous path-regex
// filtered AFTER the fact — pruning must happen DURING the walk (see below).
const PRUNED_DIR_NAMES = new Set([
  "node_modules",
  "__tests__",
  "__mocks__",
  "dist",
  "build",
  "coverage",
  ".next",
]);

/** Repo-wide walk (the boundary gate's scan roots) yielding every candidate
 *  production source file, repo-relative with forward slashes.
 *
 *  Deliberately a MANUAL stack walk, not `readdirSync(..., { recursive:
 *  true })`: the recursive flag FOLLOWS symlinked directories, so on any
 *  pnpm-installed tree (CI runs `pnpm install` before the suite) every
 *  workspace link `packages/<x>/node_modules/@cinatra-ai/<y>` re-enters a
 *  sibling package — and the third-party links re-enter the pnpm store —
 *  making the traversal combinatorially explosive. In CI that walk allocated
 *  ~4 GB of ever-longer path strings and OOM-killed the vitest worker before
 *  the first assertion could run (post-hoc filtering of the RESULT list never
 *  got the chance to matter). Pruning excluded directories at descent time
 *  and never descending into ANY symlink keeps the walk on real source
 *  directories only, installed tree or not. */
function walkProductionSources(roots: readonly string[] = ["src", "packages", "scripts"]): string[] {
  const out: string[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      // Never follow a symlink — a symlinked dir is how the pnpm-installed
      // tree loops back on itself, and the repo tracks no symlinked sources
      // (so skipping them changes nothing on a clean checkout).
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!PRUNED_DIR_NAMES.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|mts|cts)$/.test(path)) continue;
      if (path.endsWith(".d.ts")) continue;
      if (/\.(test|spec)\.[a-z]+$/.test(path)) continue;
      out.push(path);
    }
  }
  return out;
}

describe("walkProductionSources — positive control (proves the walker survives an installed tree before trusting the sweep)", () => {
  it("terminates on a pnpm-shaped symlink cycle, never descends node_modules or symlinks, and still finds the real sources", () => {
    // A miniature of the layout that OOM'd CI: two workspace packages whose
    // node_modules symlink to each OTHER (pnpm workspace links), plus a
    // symlinked dir at package level. The old recursive readdir followed
    // these links into an unbounded traversal; the pruned walk must return
    // exactly the two real sources and nothing under node_modules.
    const fixtureRoot = mkdtempSync(join(tmpdir(), "auth-api-walk-fixture-"));
    try {
      const pkgs = join(fixtureRoot, "pkgs");
      mkdirSync(join(pkgs, "a", "node_modules", "@org"), { recursive: true });
      mkdirSync(join(pkgs, "b", "node_modules", "@org"), { recursive: true });
      writeFileSync(join(pkgs, "a", "real-a.ts"), "export const a = 1;\n");
      writeFileSync(join(pkgs, "b", "real-b.ts"), "export const b = 1;\n");
      // The trap file: reachable ONLY through a symlink or node_modules —
      // appearing in the result would mean the walk followed one of them.
      writeFileSync(
        join(pkgs, "a", "node_modules", "@org", "trap.ts"),
        "export const trap = 1;\n",
      );
      symlinkSync(join(pkgs, "b"), join(pkgs, "a", "node_modules", "@org", "b"));
      symlinkSync(join(pkgs, "a"), join(pkgs, "b", "node_modules", "@org", "a"));
      symlinkSync(join(pkgs, "a"), join(pkgs, "link-to-a"));

      const found = walkProductionSources([pkgs]).sort();
      expect(found).toEqual([join(pkgs, "a", "real-a.ts"), join(pkgs, "b", "real-b.ts")]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("internal auth.api.* caller inventory — exhaustive REPO-WIDE sweep", () => {
  it("repo-wide: every mutating auth.api.* call site in src/ + packages/ + scripts/ is in the inventory, and no inventory row is stale", () => {
    const files = walkProductionSources();
    // Positive control on the walk itself: a broken walk that returned few
    // files would make this sweep vacuously green.
    expect(files.length).toBeGreaterThan(1000);

    const detectedByFile = new Map<string, string[]>();
    for (const file of files) {
      const calls = extractAuthApiCalls(readFileSync(file, "utf-8")).filter(
        (m) => !OUT_OF_SCOPE_METHODS.has(m),
      );
      if (calls.length > 0) detectedByFile.set(file, calls.sort());
    }

    const expectedByFile = new Map<string, string[]>();
    for (const row of AUTH_API_CALLER_INVENTORY) {
      const list = expectedByFile.get(row.file) ?? [];
      list.push(row.method);
      expectedByFile.set(row.file, list);
    }
    for (const list of expectedByFile.values()) list.sort();

    // Compare as plain objects so a mismatch names the exact file + methods.
    expect(Object.fromEntries([...detectedByFile.entries()].sort())).toEqual(
      Object.fromEntries([...expectedByFile.entries()].sort()),
    );
  });

  const byFile = new Map<string, CallerRow[]>();
  for (const row of AUTH_API_CALLER_INVENTORY) {
    const list = byFile.get(row.file) ?? [];
    list.push(row);
    byFile.set(row.file, list);
  }

  for (const [file, rows] of byFile) {
    it(`${file}: the detected auth.api.* call set matches the inventory exactly`, () => {
      const src = readFileSync(file, "utf-8");
      const detected = extractAuthApiCalls(src)
        .filter((m) => !OUT_OF_SCOPE_METHODS.has(m))
        .sort();
      const expected = rows.map((r) => r.method).sort();
      expect(detected, `${file}: a new or removed auth.api.* call changed the detected set`).toEqual(
        expected,
      );
    });
  }

  it("positive control: the inventory itself is non-empty (a bug that emptied AUTH_API_CALLER_INVENTORY would make every per-file test vacuously pass)", () => {
    expect(AUTH_API_CALLER_INVENTORY.length).toBeGreaterThan(0);
    expect(byFile.size).toBeGreaterThanOrEqual(6);
  });

  it("every inventory row names an entry point that is a real export (function) or a real MCP handler key in its file", () => {
    for (const row of AUTH_API_CALLER_INVENTORY) {
      const src = readFileSync(row.file, "utf-8");
      const isFunctionExport = new RegExp(
        `export (async )?function ${row.entryPoint}\\(`,
      ).test(src);
      const isHandlerKey = new RegExp(`"${row.entryPoint}"\\s*:`).test(src);
      expect(
        isFunctionExport || isHandlerKey,
        `${row.file}#${row.entryPoint} must be a real export or handler key`,
      ).toBe(true);
    }
  });

  it("floor classification is exhaustive over the CallerRow union (a typo'd floor value would silently fall through TypeScript's literal union check at compile time — this runtime check is the belt for that suspenders)", () => {
    const validFloors = new Set([
      "new-member-invitation-archive-guard",
      "existing-session-activation-guard",
      "cleanup-never-blocked",
      "org-axis-dispatch-policy-covered",
      "no-organization-axis",
      "new-org-cannot-be-archived",
    ]);
    for (const row of AUTH_API_CALLER_INVENTORY) {
      expect(validFloors.has(row.floor), `${row.file}#${row.entryPoint} has an unknown floor`).toBe(
        true,
      );
    }
  });

  it("every growth-shaped method routed to the new DB floor is one this stage's triggers actually cover (updateMemberRole/createInvitation only — never setActiveOrganization, which the S1 session guard already floors)", () => {
    const coveredMethods = new Set(["updateMemberRole", "createInvitation"]);
    for (const row of AUTH_API_CALLER_INVENTORY) {
      if (row.floor === "new-member-invitation-archive-guard") {
        expect(coveredMethods.has(row.method), `${row.file}#${row.entryPoint} (${row.method})`).toBe(
          true,
        );
      }
    }
  });

  it("OUT_OF_SCOPE_METHODS and the inventory's mutating methods never overlap (a method in both would let the sweep filter silently swallow real inventory rows)", () => {
    const mutatingMethods = new Set(AUTH_API_CALLER_INVENTORY.map((r) => r.method));
    for (const outOfScope of OUT_OF_SCOPE_METHODS) {
      expect(mutatingMethods.has(outOfScope), `${outOfScope} is listed as both`).toBe(false);
    }
  });
});

describe("disclosed adjacent finding — a DIRECT raw-SQL write to a Better-Auth table bypassing auth.api entirely", () => {
  it("permissions_users_update_platform_role writes public.\"user\" via raw SQL, not auth.api.setRole — named here so it is on the record, not silently unseen (no org axis: global platform role, out of this stage's archived-org scope)", () => {
    const src = readFileSync("packages/permissions/src/mcp/handlers.ts", "utf-8");
    expect(src).toMatch(/UPDATE public\."user" SET role = /);
    // And it deliberately does NOT CALL auth.api.setRole (the source's own
    // comment explains why in prose: no session/headers available in MCP m2m
    // context — comment-stripped so that explanatory prose does not itself
    // register as a call site).
    const handlerBody = stripComments(
      src.slice(
        src.indexOf('"permissions_users_update_platform_role"'),
        src.indexOf('"permissions_invitations_cancel"'),
      ),
    );
    expect(extractAuthApiCalls(handlerBody)).toEqual([]);
  });
});
