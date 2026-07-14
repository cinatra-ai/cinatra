/**
 * Org token-contract regression (cinatra#1526).
 *
 * Multi-scope W1 retired the bare `"org"` visibility token in favour of the
 * id-carrying `org:<id>`. Three consumers never followed: the label resolver,
 * the install dialogs' org-name lookup key, and the flyout org row's own value.
 * This locks the fix:
 *
 *  - `resolveAccessLabel("org:<id>")` resolves to the organization NAME (never
 *    the raw token) — a well-formed org token never reaches the raw-value
 *    fallback.
 *  - The bare `"org"` form is still ACCEPTED (read-compat with any persisted
 *    legacy value — AgentAuthPolicyVisibilitySchema still validates it).
 *  - Malformed / stale / cross-org `org:<id>` degrade safely: the active org
 *    name, no raw-token leak.
 *  - The generic fallback ("your organization") renders ONLY when the org has
 *    no name.
 *  - The flyout org row emits the id-carrying `org:${orgId}` token (never a
 *    hardcoded bare `"org"`), degrading to bare `"org"` only when no org id is
 *    supplied.
 *
 * resolveAccessLabel is a pure exported function so these are BEHAVIORAL
 * assertions; the render contract (row value wiring) is pinned via source-text
 * because the root vitest env is `node` (no DOM render — same convention as
 * access-combobox-disabled-scopes.test.tsx).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { resolveAccessLabel } from "@/components/access-combobox";

const SOURCE = readFileSync("src/components/access-combobox.tsx", "utf-8");

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";

const namedScopes = {
  projects: [],
  teams: [],
  orgName: "Acme Corp",
  orgId: ORG_ID,
  workspaceExposed: false,
};

const namelessScopes = {
  projects: [],
  teams: [],
  orgName: "",
  orgId: ORG_ID,
  workspaceExposed: false,
};

describe("resolveAccessLabel — org token contract (cinatra#1526)", () => {
  it("resolves the id-carrying org:<id> token to the organization name (AC1)", () => {
    const label = resolveAccessLabel(`org:${ORG_ID}`, namedScopes);
    expect(label).toEqual({ type: null, name: "Anyone in Acme Corp" });
    // The raw token must NOT leak into the label.
    expect(label.name).not.toContain(ORG_ID);
  });

  it("still accepts the retired bare 'org' token for read-compat (AC4)", () => {
    expect(resolveAccessLabel("org", namedScopes)).toEqual({
      type: null,
      name: "Anyone in Acme Corp",
    });
  });

  it("renders the generic fallback ONLY when the org has no name (AC2)", () => {
    // org:<id> with a named org → the name.
    expect(resolveAccessLabel(`org:${ORG_ID}`, namedScopes).name).toBe(
      "Anyone in Acme Corp",
    );
    // org:<id> with a genuinely nameless org → the generic fallback, never
    // a hardcoded "Organization" and never the raw token.
    const nameless = resolveAccessLabel(`org:${ORG_ID}`, namelessScopes);
    expect(nameless).toEqual({ type: null, name: "Anyone in your organization" });
    expect(nameless.name).not.toContain("Organization");
    expect(nameless.name).not.toContain(ORG_ID);
  });

  it("degrades a stale / cross-org org:<id> safely — no raw-token leak (AC6)", () => {
    const label = resolveAccessLabel(`org:${OTHER_ORG_ID}`, namedScopes);
    expect(label.type).toBeNull();
    expect(label.name).toBe("Anyone in Acme Corp");
    expect(label.name).not.toContain(OTHER_ORG_ID);
  });

  it("degrades a malformed org: (empty tail) safely — no raw-token leak (AC6)", () => {
    const label = resolveAccessLabel("org:", namedScopes);
    expect(label.type).toBeNull();
    expect(label.name).toBe("Anyone in Acme Corp");
    expect(label.name).not.toBe("org:");
  });

  it("keeps team:/project:/owner/admin/workspace labels intact (no over-capture)", () => {
    expect(resolveAccessLabel("owner", namedScopes).name).toBe("Only me");
    expect(resolveAccessLabel("admin", namedScopes).name).toBe("Admins only");
    expect(resolveAccessLabel("workspace", namedScopes).name).toBe("Whole Workspace");
    expect(resolveAccessLabel("team:abc", namedScopes).type).toBe("Team");
    expect(resolveAccessLabel("project:xyz", namedScopes).type).toBe("Project");
  });
});

describe("AccessCombobox org row — id-carrying value wiring (AC3)", () => {
  it("exposes an optional orgId on availableScopes", () => {
    expect(SOURCE).toMatch(/orgId\?:\s*string/);
  });

  it("derives the org row value from orgId (id-carrying token, bare-org fallback)", () => {
    expect(SOURCE).toMatch(
      /const\s+orgRowValue\s*=\s*orgId\s*\?\s*`org:\$\{orgId\}`\s*:\s*"org"/,
    );
  });

  it("the org row emits orgRowValue — never a hardcoded value=\"org\"", () => {
    // The org CommandItem must bind value / onSelect / itemClass / checkmark to
    // orgRowValue so its selected-state and disabled-scope lookup match an
    // org:<id> selection.
    expect(SOURCE).toMatch(/value=\{orgRowValue\}/);
    expect(SOURCE).toMatch(/onValueChange\(orgRowValue\)/);
    expect(SOURCE).toMatch(/renderTargetRow\(\s*orgRowValue,/);
    expect(SOURCE).toMatch(/itemClass\(orgRowValue\)/);
    expect(SOURCE).toMatch(/renderCheckmark\(orgRowValue\)/);
    // No literal org CommandItem value / onSelect writing the retired token.
    expect(SOURCE).not.toMatch(/value="org"/);
    expect(SOURCE).not.toMatch(/onValueChange\("org"\)/);
  });
});

describe("install dialogs — org-name lookup keyed by the id-carrying token (AC2/AC5)", () => {
  const EXT = readFileSync(
    "packages/extensions/src/screens/extension-install-scope-dialog.tsx",
    "utf-8",
  );
  const AGENT = readFileSync(
    "packages/agents/src/components/install-scope-dialog.tsx",
    "utf-8",
  );

  it("extension install dialog keys orgName on org:${activeOrgId} and passes orgId", () => {
    expect(EXT).toMatch(/ownerEntityNames\[`org:\$\{activeOrgId\}`\]/);
    expect(EXT).toMatch(/orgId:\s*activeOrgId/);
    expect(EXT).not.toMatch(/ownerEntityNames\["org"\]/);
    expect(EXT).not.toMatch(/\?\?\s*"Organization"/);
  });

  it("agent install dialog keys orgName on org:${activeOrgId} and passes orgId", () => {
    expect(AGENT).toMatch(/ownerEntityNames\[`org:\$\{activeOrgId\}`\]/);
    expect(AGENT).toMatch(/orgId:\s*activeOrgId/);
    expect(AGENT).not.toMatch(/ownerEntityNames\["org"\]/);
    expect(AGENT).not.toMatch(/\?\?\s*"Organization"/);
  });

  it("the picker-context builder no longer seeds the org name with a hardcoded \"Organization\"", () => {
    // The hardcoded "Organization" string is also removed at its server-side
    // source: buildInstallTargetPickerContext defaults orgName to "" (the
    // combobox owns the single generic fallback), so a nameless org never has
    // "Organization" stored in ownerEntityNames[`org:<id>`] (cinatra#1526 —
    // codex convergence). A named org still overrides with the real name.
    const PICKER = readFileSync(
      "packages/agents/src/install-target-picker.ts",
      "utf-8",
    );
    expect(PICKER).toMatch(/let\s+orgName\s*=\s*""/);
    expect(PICKER).not.toMatch(/let\s+orgName\s*=\s*"Organization"/);
  });
});
