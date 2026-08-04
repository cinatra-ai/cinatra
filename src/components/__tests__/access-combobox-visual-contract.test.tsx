/**
 * Source-text contract for the flat single-select AccessCombobox, aligned to the
 * ratified permissions spec (the app-permissions design spec, §III /
 * §3.2, @645516f3): NO scope group headings, scope-PREFIXED rows, a hairline
 * separator between consecutive groups, and the §VI containment props. Locks the
 * surgical shape so a regression fails here; live behaviour is exercised in the
 * jsdom suites (selection-mode / disabled-scopes / containment).
 *
 * Superseded contract: pre-#1607 the single mode carried typed group HEADINGS
 * (Projects / Teams / Organization: <name> / Workspace / Admin) and bare,
 * unprefixed rows. The spec merge moved to scope-prefixed rows + separators with
 * no heading; this test now locks that.
 *
 * cinatra#2372 (mkt-install S1): every row's `{type, name}` pair now comes from
 * ONE resolver, `resolveFlatAccessOption` (in access-scope.ts, the pure module
 * the picker already imported), instead of each row hand-writing its own
 * prefix/name pair — this is what makes the trigger's label
 * construction-identical to its matching row (c-3.1), not just coincidentally
 * equal. The "Unknown team"/"Unknown project" fallback (§2.4) moved with it;
 * the full model contract lives in access-scope-flat.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/components/access-combobox";

const SOURCE = readFileSync("src/components/access-combobox.tsx", "utf-8");
const FLAT_MODEL_SOURCE = readFileSync("src/components/access-scope.ts", "utf-8");

describe("AccessCombobox single-mode spec alignment (app-permissions.html §III)", () => {
  it("module still loads and exports AccessCombobox + resolveAccessLabel", () => {
    expect(typeof Mod.AccessCombobox).toBe("function");
    expect(typeof Mod.resolveAccessLabel).toBe("function");
  });

  it("row contract: white idle, distinct muted hover/active + selected (cinatra#1261)", () => {
    expect(SOURCE).toMatch(
      /rounded-none px-3 py-2 cursor-pointer bg-surface-strong hover:bg-surface-muted data-\[selected=true\]:bg-surface-muted/,
    );
    expect(SOURCE).toMatch(/value === itemValue && "bg-surface-muted"/);
    // The old invisible idle==hover token is gone.
    expect(SOURCE).not.toMatch(/bg-surface hover:bg-surface-strong/);
  });

  it("trigger uses the shared Button-default height (no h-9 override)", () => {
    expect(SOURCE).not.toMatch(/w-full h-9 justify-between/);
    expect(SOURCE).toMatch(/w-full justify-between rounded-control border-line font-normal/);
  });

  it("§2.3/§3.2: NO scope group headings — the pre-#1607 heading spans are gone", () => {
    // No heading= props survive, and the specific typed-heading strings are gone.
    expect(SOURCE).not.toMatch(/heading=\{/);
    expect(SOURCE).not.toMatch(/px-3 py-1 block/);
    expect(SOURCE).not.toMatch(/Organization:\s*\{resolvedOrgName\}/);
  });

  it("§2.3/§3.2: every row is scope-PREFIXED via rowLabel(<Scope>, <name>), sourced from the ONE flat-option resolver (cinatra#2372)", () => {
    expect(SOURCE).toMatch(/const rowLabel = \(prefix: string, name: string\)/);
    // Every group resolves its row(s) via resolveRow (= resolveFlatAccessOption)
    // rather than hand-writing a second prefix/name pair — this is the
    // construction that makes the trigger's label identical to the row's.
    expect(SOURCE).toMatch(/const resolveRow = \(rowValue: string\): FlatAccessOption =>\s*\n?\s*resolveFlatAccessOption\(rowValue, availableScopes\)/);
    expect(SOURCE).toMatch(/rowLabel\(personal\.type, personal\.name\)/);
    expect(SOURCE).toMatch(/rowLabel\(row\.type, row\.name\)/); // project + team loops
    expect(SOURCE).toMatch(/rowLabel\(orgRow\.type, orgRow\.name\)/);
    expect(SOURCE).toMatch(/rowLabel\(workspaceRow\.type, workspaceRow\.name\)/);
    expect(SOURCE).toMatch(/rowLabel\(adminRow\.type, adminRow\.name\)/);
    // No literal old-style hand-written row label calls survive.
    expect(SOURCE).not.toMatch(/rowLabel\("Organization", resolvedOrgName\)/);
    expect(SOURCE).not.toMatch(/rowLabel\("Workspace", "All"\)/);
    expect(SOURCE).not.toMatch(/rowLabel\("Workspace", "Admins only"\)/);
    // The org ROW is the bare org name behind an "Organization:" prefix — the
    // old "Anyone in <org>" copy is retired everywhere (trigger AND row now
    // read the same "Organization: <name>" text, per spec §3.1).
    expect(SOURCE).not.toMatch(/Anyone in /);
  });

  it("§2.3: consecutive scope groups are divided by a hairline CommandSeparator", () => {
    expect(SOURCE).toMatch(/CommandSeparator/);
    expect(SOURCE).toMatch(/groupNodes\.map\(\(grp, i\) =>/);
    expect(SOURCE).toMatch(/\{i > 0 && <CommandSeparator \/>\}/);
  });

  it("§3.2: teams still render in their own group above the organization row", () => {
    const teamKey = SOURCE.indexOf('key: "team"');
    const orgKey = SOURCE.indexOf('key: "org"');
    expect(teamKey).toBeGreaterThan(-1);
    expect(orgKey).toBeGreaterThan(-1);
    expect(teamKey).toBeLessThan(orgKey);
    // Team group is conditional on offered teams OR a synthesized team selection.
    expect(SOURCE).toMatch(/offeredTeams\.length > 0 \|\| synthTeamOffered/);
  });

  it("§3.4 / c-3.11: synthesizes a scope-prefixed, checked, non-committable row for an unhydrated team/project OR a degenerate org token (cinatra#2372)", () => {
    expect(SOURCE).toMatch(/const needsSynthTeam =/);
    expect(SOURCE).toMatch(/const needsSynthProject =/);
    expect(SOURCE).toMatch(/const needsSynthOrg =/);
    // All three synth rows render via the SAME selectedOption (the resolver's
    // output for the CURRENT value) rather than three separately-worded calls.
    expect(SOURCE).toMatch(
      /renderSynthRow\(value, selectedOption\.type, selectedOption\.name\)/g,
    );
    expect((SOURCE.match(/renderSynthRow\(value, selectedOption\.type, selectedOption\.name\)/g) ?? []).length).toBe(3);
  });

  it("delegates the unknown-entity fallback to the shared access-scope helper (no id.slice) — relocated to the flat model (cinatra#2372)", () => {
    // The team/project unhydrated-id fallback now lives beside
    // resolveScopeEntityName's OWN definition, in access-scope.ts (same file —
    // no import needed), which access-combobox.tsx consumes via
    // resolveFlatAccessOption rather than calling resolveScopeEntityName itself.
    expect(FLAT_MODEL_SOURCE).toMatch(/export function resolveScopeEntityName/);
    expect(FLAT_MODEL_SOURCE).toMatch(/export function resolveFlatAccessOption/);
    expect(FLAT_MODEL_SOURCE).toMatch(/resolveScopeEntityName\("team", id, team\?\.name\)/);
    expect(FLAT_MODEL_SOURCE).toMatch(/resolveScopeEntityName\("project", id, project\?\.name\)/);
    // No LIVE code path falls back to a truncated id (comments documenting the
    // historical bug this replaced are expected and fine).
    expect(FLAT_MODEL_SOURCE).not.toMatch(/name:\s*id\.slice\(-6\)/);
    expect(SOURCE).not.toMatch(/id\.slice\(-6\)/);
  });

  it("§VI: exposes the typed parentScope + allowedScopes containment props", () => {
    expect(SOURCE).toMatch(/parentScope\?: ScopeIdentity \| null/);
    expect(SOURCE).toMatch(/allowedScopes\?: AllowedScopes/);
    // The picker consults the pure containment algebra + reconciliation.
    expect(SOURCE).toMatch(/isScopeOffered/);
    expect(SOURCE).toMatch(/reconcileSelection/);
  });
});
