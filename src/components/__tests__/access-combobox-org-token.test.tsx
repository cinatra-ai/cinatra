/**
 * Org token-contract regression (cinatra#1526), updated for the canonical flat
 * access-option model (cinatra#2372, mkt-install S1).
 *
 * `resolveAccessLabel` is now a thin `{ type, name }` view over
 * `resolveFlatAccessOption` (src/components/access-scope.ts) — the model
 * whose full contract (committability, synthetic rows, all six kinds) is
 * pinned in access-scope-flat.test.ts. This file keeps the org-token-specific
 * regression coverage, updated to the trigger ≡ row vocabulary
 * (app-permissions.html c-3.1): the org token resolves to `Organization:
 * <name>` — never the old bare "Anyone in <org>" phrasing, which was a SECOND,
 * independently-worded trigger string that could (and did) drift from the
 * row's `Organization: <name>` copy.
 *
 *  - `resolveAccessLabel("org:<id>")` resolves to `{ type: "Organization",
 *    name: <org name> }` (never the raw token) — a well-formed org token never
 *    reaches the raw-value fallback.
 *  - The bare `"org"` form is still ACCEPTED (read-compat with any persisted
 *    legacy value — AgentAuthPolicyVisibilitySchema still validates it).
 *  - An id-carrying `org:<id>` token resolves to the active org's NAME only
 *    when its embedded id is CONFIRMED to equal the supplied active `orgId`.
 *    An unconfirmed token — no `orgId` supplied (the read-only Permissions tab,
 *    whose value is the PROJECT's own owning-org token), a different id
 *    (cross-org), or a malformed empty tail — degrades to the neutral,
 *    id-free, NEVER-committable synthetic label `{ type: "Organization", name:
 *    "the organization" }`: never the raw token, and never a possibly-WRONG
 *    specific org name on a permissions-review surface (cinatra#1526 review —
 *    a co-owner of a project owned by another org must not be shown the
 *    viewer's own active-org name for that project's scope).
 *  - The generic fallback (`"Your organization"`, capital Y — matching the
 *    row's own fallback, cinatra#2372) renders ONLY when the CONFIRMED active
 *    org has no name.
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
import { pickerValueToTarget } from "@cinatra-ai/agents/auth-policy-types";

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

describe("resolveAccessLabel — org token contract (cinatra#1526 / cinatra#2372)", () => {
  it("resolves the id-carrying org:<id> token to Organization: <name> (AC1)", () => {
    const label = resolveAccessLabel(`org:${ORG_ID}`, namedScopes);
    expect(label).toEqual({ type: "Organization", name: "Acme Corp" });
    // The raw token must NOT leak into the label.
    expect(label.name).not.toContain(ORG_ID);
  });

  it("still accepts the retired bare 'org' token for read-compat (AC4)", () => {
    expect(resolveAccessLabel("org", namedScopes)).toEqual({
      type: "Organization",
      name: "Acme Corp",
    });
  });

  it("renders the generic 'Your organization' fallback ONLY when the org has no name (AC2)", () => {
    // org:<id> with a named org → the name.
    expect(resolveAccessLabel(`org:${ORG_ID}`, namedScopes).name).toBe("Acme Corp");
    // org:<id> with a genuinely nameless org → the generic fallback, matching
    // the row's own fallback verbatim (capital Y — cinatra#2372 trigger ≡ row),
    // never a raw token.
    const nameless = resolveAccessLabel(`org:${ORG_ID}`, namelessScopes);
    expect(nameless).toEqual({ type: "Organization", name: "Your organization" });
    expect(nameless.name).not.toContain(ORG_ID);
  });

  it("a cross-org org:<id> does NOT claim the active org's name — synthetic neutral label (cinatra#1526 review / cinatra#2372 c-3.11)", () => {
    // The token scopes a DIFFERENT org than the supplied active `orgId`; the
    // active org's name would be a WRONG, confidently-rendered label on a
    // permissions surface. Degrade to a neutral, id-free, display-only label.
    const label = resolveAccessLabel(`org:${OTHER_ORG_ID}`, namedScopes);
    expect(label).toEqual({ type: "Organization", name: "the organization" });
    expect(label.name).not.toContain("Acme Corp");
    expect(label.name).not.toContain(OTHER_ORG_ID);
  });

  it("an id-carrying org:<id> with NO active orgId supplied does NOT claim a specific name (Permissions-tab / cinatra#1526 review)", () => {
    // Reproduces the read-only project Permissions tab: `orgName` is the
    // VIEWER's active org, but the value is the PROJECT's own owning-org token
    // and no `orgId` is supplied, so the id cannot be confirmed. It must NOT be
    // labelled with the (possibly-foreign) active org's name.
    const noOrgIdScopes = {
      projects: [],
      teams: [],
      orgName: "Acme Corp",
      workspaceExposed: false,
    };
    const label = resolveAccessLabel(`org:${OTHER_ORG_ID}`, noOrgIdScopes);
    expect(label).toEqual({ type: "Organization", name: "the organization" });
    expect(label.name).not.toContain("Acme Corp");
    expect(label.name).not.toContain(OTHER_ORG_ID);
  });

  it("degrades a malformed org: (empty tail) safely — no raw-token leak (AC6)", () => {
    const label = resolveAccessLabel("org:", namedScopes);
    expect(label).toEqual({ type: "Organization", name: "the organization" });
    expect(label.name).not.toBe("org:");
  });

  it("keeps team:/project:/owner/admin/workspace labels intact under the new trigger ≡ row vocabulary (no over-capture)", () => {
    expect(resolveAccessLabel("owner", namedScopes)).toEqual({ type: "Personal", name: "Only me" });
    expect(resolveAccessLabel("admin", namedScopes)).toEqual({ type: "Workspace", name: "Admins only" });
    expect(resolveAccessLabel("workspace", namedScopes)).toEqual({ type: "Workspace", name: "All" });
    expect(resolveAccessLabel("team:abc", namedScopes).type).toBe("Team");
    expect(resolveAccessLabel("project:xyz", namedScopes).type).toBe("Project");
  });
});

describe("AccessCombobox org row — id-carrying value wiring (AC3)", () => {
  it("exposes an optional orgId on availableScopes", () => {
    expect(SOURCE).toMatch(/orgId\?:\s*string/);
  });

  it("derives the org row value from orgId, matching the server token even with no active org", () => {
    // `orgId != null` (NOT truthiness): with no active org the caller supplies
    // orgId="" and the server-built install-target row value is `org:` (empty
    // tail) — the row must key on the SAME token or the disabledScopes membership
    // check would miss and render a server-disabled row as clickable. The bare
    // "org" fallback applies only when orgId is undefined (the read-only
    // Permissions tab, popover disabled).
    expect(SOURCE).toMatch(
      /const\s+orgRowValue\s*=\s*orgId\s*!=\s*null\s*\?\s*`org:\$\{orgId\}`\s*:\s*"org"/,
    );
  });

  it("the org row emits orgRowValue — never a hardcoded value=\"org\"", () => {
    // The org CommandItem must bind value / onSelect / itemClass / checkmark to
    // orgRowValue so its selected-state and disabled-scope lookup match an
    // org:<id> selection.
    expect(SOURCE).toMatch(/value=\{orgRowValue\}/);
    // Post-#1607 the row select goes through the `commit` helper (set value +
    // clear any invalidation note + close), so the org row wires commit(orgRowValue).
    expect(SOURCE).toMatch(/commit\(orgRowValue\)/);
    expect(SOURCE).toMatch(/renderTargetRow\(\s*\n?\s*orgRowValue,/);
    expect(SOURCE).toMatch(/itemClass\(orgRowValue\)/);
    expect(SOURCE).toMatch(/renderCheckmark\(orgRowValue\)/);
    // No literal org CommandItem value / onSelect writing the retired token.
    expect(SOURCE).not.toMatch(/value="org"/);
    expect(SOURCE).not.toMatch(/onValueChange\("org"\)/);
    expect(SOURCE).not.toMatch(/commit\("org"\)/);
  });
});

describe("install surfaces — org-name lookup keyed by the id-carrying token (AC2/AC5)", () => {
  // cinatra#2374: the marketplace surface's pre-install popup was deleted (the
  // §II detail modal it served is details-only by owner ruling, 2026-08-04), so
  // the extension-side contract is pinned on the in-card install PANEL that
  // replaced it. The agent-registry dialog is a separate surface and remains.
  const PANEL = readFileSync(
    "packages/extensions/src/screens/extension-install-scope-panel.tsx",
    "utf-8",
  );
  const AGENT = readFileSync(
    "packages/agents/src/components/install-scope-dialog.tsx",
    "utf-8",
  );

  it("the in-card install panel keys orgName on org:${activeOrgId} and passes orgId", () => {
    expect(PANEL).toMatch(/ownerEntityNames\[`org:\$\{activeOrgId\}`\]/);
    expect(PANEL).toMatch(/orgId:\s*activeOrgId/);
    expect(PANEL).not.toMatch(/ownerEntityNames\["org"\]/);
    expect(PANEL).not.toMatch(/\?\?\s*"Organization"/);
  });

  it("agent install dialog keys orgName on org:${activeOrgId} and passes orgId", () => {
    expect(AGENT).toMatch(/ownerEntityNames\[`org:\$\{activeOrgId\}`\]/);
    expect(AGENT).toMatch(/orgId:\s*activeOrgId/);
    expect(AGENT).not.toMatch(/ownerEntityNames\["org"\]/);
    expect(AGENT).not.toMatch(/\?\?\s*"Organization"/);
  });

  it("the canonical value→target adapter rejects an empty-tail org:/team:/project: token (AC5)", () => {
    // Behavioral: the shared, exported adapter (also backing the approval scope
    // step) returns null for an empty id so a stray value can never reach the
    // server action with a malformed {id:""} target. This is the contract the
    // agent dialog's remaining private copy mirrors below.
    expect(pickerValueToTarget("org:", "active-org")).toBeNull();
    expect(pickerValueToTarget("team:", "active-org")).toBeNull();
    expect(pickerValueToTarget("project:", "active-org")).toBeNull();
    // the legacy bare "org" token also yields null when there is no active org
    // so it can never forward an empty id to a server action.
    expect(pickerValueToTarget("org", "")).toBeNull();
    // and a well-formed token still resolves.
    expect(pickerValueToTarget("org:o9", "active-org")).toEqual({
      level: "organization",
      id: "o9",
    });
    expect(pickerValueToTarget("org", "active-org")).toEqual({
      level: "organization",
      id: "active-org",
    });
  });

  it("the marketplace panel uses the SHARED adapter — no private copy left to drift (cinatra#2374)", () => {
    // The deleted popup carried its own unexported duplicate of these rules.
    // The panel imports the shared pure module instead, so the marketplace
    // surface has exactly ONE implementation (behaviourally pinned above and in
    // packages/extensions/src/screens/__tests__/install-picker-target.test.ts).
    expect(PANEL).toMatch(/from\s+["']\.\/install-picker-target["']/);
    expect(PANEL).toMatch(/pickerValueToInstallTarget\(value, activeOrgId\)/);
    // And it declares no local re-implementation of its own.
    expect(PANEL).not.toMatch(/function\s+pickerValueToTarget\b/);
  });

  it("the agent dialog's private adapter copy carries the same empty-id guard (AC5 — the value→target adapter surface)", () => {
    // The agent-registry dialog still declares a local (unexported)
    // pickerValueToTarget copy; it must mirror the canonical guard so the
    // id-carrying token contract holds on EVERY consumer of the access/install
    // surface, not just the exported one. Source-pinned because it is not
    // exported.
    for (const SRC of [AGENT]) {
      expect(SRC).toMatch(/id\s*\?\s*\{\s*level:\s*"organization",\s*id\s*\}\s*:\s*null/);
      expect(SRC).toMatch(/id\s*\?\s*\{\s*level:\s*"team",\s*id\s*\}\s*:\s*null/);
      expect(SRC).toMatch(/id\s*\?\s*\{\s*level:\s*"project",\s*id\s*\}\s*:\s*null/);
      // The legacy bare "org" branch also guards a missing active org.
      expect(SRC).toMatch(
        /value\s*===\s*"org"\)\s*\n?\s*return\s+activeOrgId\s*\?\s*\{\s*level:\s*"organization",\s*id:\s*activeOrgId\s*\}\s*:\s*null/,
      );
      // No unguarded org: slice that would forward an empty id.
      expect(SRC).not.toMatch(
        /return\s*\{\s*level:\s*"organization",\s*id:\s*value\.slice/,
      );
      // No unguarded bare-org branch forwarding activeOrgId without a check.
      expect(SRC).not.toMatch(
        /value\s*===\s*"org"\)\s*return\s+\{\s*level:\s*"organization",\s*id:\s*activeOrgId\s*\}/,
      );
    }
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
