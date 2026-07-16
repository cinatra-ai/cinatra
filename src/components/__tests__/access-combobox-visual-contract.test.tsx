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
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/components/access-combobox";

const SOURCE = readFileSync("src/components/access-combobox.tsx", "utf-8");

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

  it("§2.3/§3.2: every row is scope-PREFIXED via rowLabel(<Scope>, <name>)", () => {
    expect(SOURCE).toMatch(/const rowLabel = \(prefix: string, name: string\)/);
    expect(SOURCE).toMatch(/rowLabel\("Personal", "Only me"\)/);
    expect(SOURCE).toMatch(/rowLabel\("Project", p\.name\)/);
    expect(SOURCE).toMatch(/rowLabel\("Team", t\.name\)/);
    expect(SOURCE).toMatch(/rowLabel\("Organization", resolvedOrgName\)/);
    expect(SOURCE).toMatch(/rowLabel\("Workspace", "All"\)/);
    expect(SOURCE).toMatch(/rowLabel\("Workspace", "Admins only"\)/);
    // The org ROW is the bare org name behind an "Organization:" prefix — the
    // old "Anyone in <org>" ROW copy is gone (that phrasing survives on the
    // TRIGGER only, via resolveAccessLabel, per spec §3.1).
    expect(SOURCE).not.toMatch(/whitespace-nowrap">\s*\n?\s*Anyone in \{resolvedOrgName\}/);
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

  it("§3.4: synthesizes a scope-prefixed, checked Unknown team / Unknown project row", () => {
    expect(SOURCE).toMatch(/const needsSynthTeam =/);
    expect(SOURCE).toMatch(/const needsSynthProject =/);
    expect(SOURCE).toMatch(/renderSynthRow\(value, "Project", unknownScopeEntityName\("project"\)\)/);
    expect(SOURCE).toMatch(/renderSynthRow\(value, "Team", unknownScopeEntityName\("team"\)\)/);
  });

  it("delegates the unknown-entity fallback to the shared access-scope helper (no id.slice)", () => {
    expect(SOURCE).toMatch(
      /import \{[\s\S]*resolveScopeEntityName[\s\S]*\} from "@\/components\/access-scope"/,
    );
    expect(SOURCE).toMatch(/resolveScopeEntityName\("team", id, team\?\.name\)/);
    expect(SOURCE).toMatch(/resolveScopeEntityName\("project", id, project\?\.name\)/);
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
