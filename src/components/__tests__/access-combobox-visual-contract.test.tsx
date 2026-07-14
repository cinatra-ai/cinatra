/**
 * Source-text contract test for the flat AccessCombobox visual / heading /
 * synthesis alignment (cinatra#1509 §4.0-c — most of #1508). Locks the surgical
 * changes so a regression on any of them fails here; behaviour of the shared
 * fallback helper is exercised in access-scope-entity-labels.test.ts.
 *
 * Truths locked here:
 *  - the row visual contract matches the hierarchical picker (cinatra#1261):
 *    idle bg-surface-strong, hover/active bg-surface-muted, selected
 *    bg-surface-muted — NOT the old invisible bg-surface hover:bg-surface-strong
 *  - the trigger uses the shared control height (NO h-9 override)
 *  - typed group headings: Projects / Teams / Organization: <name> / Workspace /
 *    Admin (never a bare org name), team rows in their OWN group ABOVE the org
 *  - unhydrated team:/project: selections synthesize a checked "Unknown …" row
 *  - the unknown-entity fallback delegates to the shared access-scope helper
 *    (no local id.slice(-6))
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/components/access-combobox";

const SOURCE = readFileSync("src/components/access-combobox.tsx", "utf-8");

describe("AccessCombobox visual/heading/synthesis contract (cinatra#1509 §4.0-c)", () => {
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

  it("trigger drops the h-9 override → shared Button-default height", () => {
    // The trigger className no longer hard-codes a height.
    expect(SOURCE).not.toMatch(/w-full h-9 justify-between/);
    expect(SOURCE).toMatch(/w-full justify-between rounded-control border-line font-normal/);
  });

  it("uses typed group headings (Projects / Teams / Organization: <name> / Workspace / Admin)", () => {
    expect(SOURCE).toMatch(/>\s*Projects\s*</);
    expect(SOURCE).toMatch(/>\s*Teams\s*</);
    // The org heading is typed, never a bare {resolvedOrgName} divider (#1508).
    expect(SOURCE).toMatch(/Organization:\s*\{resolvedOrgName\}/);
    expect(SOURCE).not.toMatch(/block">\s*\{resolvedOrgName\}\s*</);
    expect(SOURCE).toMatch(/>\s*Workspace\s*</);
    expect(SOURCE).toMatch(/>\s*Admin\s*</);
  });

  it("gives teams their OWN group rendered above the organization group", () => {
    const teamsIdx = SOURCE.indexOf("Teams");
    const orgIdx = SOURCE.indexOf("Organization: {resolvedOrgName}");
    expect(teamsIdx).toBeGreaterThan(-1);
    expect(orgIdx).toBeGreaterThan(-1);
    expect(teamsIdx).toBeLessThan(orgIdx);
    // Teams group is conditional on teams OR a synthesized team selection.
    expect(SOURCE).toMatch(/\(teams\.length > 0 \|\| needsSynthTeam\)/);
  });

  it("synthesizes a checked 'Unknown team' / 'Unknown project' row for unhydrated selections", () => {
    expect(SOURCE).toMatch(/const needsSynthTeam =/);
    expect(SOURCE).toMatch(/const needsSynthProject =/);
    expect(SOURCE).toMatch(/renderSynthRow\(value,\s*unknownScopeEntityName\("team"\)\)/);
    expect(SOURCE).toMatch(/renderSynthRow\(value,\s*unknownScopeEntityName\("project"\)\)/);
    // The synth row is selectable + checkmarked (row value === current value).
    expect(SOURCE).toMatch(/const renderSynthRow = \(rowValue: string, label: string\)/);
  });

  it("delegates the unknown-entity fallback to the shared access-scope helper (no id.slice)", () => {
    expect(SOURCE).toMatch(
      /import \{[\s\S]*resolveScopeEntityName[\s\S]*\} from "@\/components\/access-scope"/,
    );
    expect(SOURCE).toMatch(/resolveScopeEntityName\("team", id, team\?\.name\)/);
    expect(SOURCE).toMatch(/resolveScopeEntityName\("project", id, project\?\.name\)/);
    // No local truncated-id fallback survives.
    expect(SOURCE).not.toMatch(/id\.slice\(-6\)/);
  });
});
