// §V "Extension settings" bidirectional-conformance assertions.
//
// Node-env (no jsdom render — the repo proves UI via Playwright + the seeded
// fixtures, and asserts structural invariants against source here, mirroring
// extensions-marketplace-screen-registry-link.test.ts). Each assertion pins a
// §V spec sentence to the shipped surface so a regression that drops or
// mis-wires an element fails the suite.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const read = (rel: string): string =>
  readFileSync(path.resolve(__dirname, rel), "utf8");

const VIEW = read("../extension-settings-view.tsx");
const ACTIONS = read("../extension-settings-actions.tsx");
const ACCESS = read("../extension-access-control.tsx");
const SCREEN = read("../extension-settings-screen.tsx");
const ROWS = read("../installed-rows.ts");

describe("§V — narrow column + §II detail header (nothing top-right)", () => {
  it("holds to the Narrow column (max-width 576)", () => {
    expect(VIEW).toContain("max-w-[576px]");
  });
  it("renders the §II header: 64px rounded icon tile in the extension accent", () => {
    expect(VIEW).toContain("size-16");
    expect(VIEW).toContain("rounded-[15px]");
    expect(VIEW).toContain("extensionKindEmblem");
  });
  it("binds the human displayName (never the package slug) in the italic display title", () => {
    expect(VIEW).toContain("text-modal-title");
    expect(VIEW).toContain("italic");
    expect(VIEW).toContain("{displayName}");
  });
  it("renders the '{Kind} by {Vendor}' byline", () => {
    expect(VIEW).toContain("KIND_LABEL[kind]");
    expect(VIEW).toContain(" by ");
  });
  it("centres the name + byline vertically against the logo (0.5.0 §V/§II)", () => {
    // The header row (the flex carrying the size-16 tile) must vertically centre
    // its name/byline column against the logo — items-center, not the former
    // items-start.
    expect(VIEW).toContain('<div className="flex items-center gap-4.5">');
    expect(VIEW).not.toContain('flex items-start gap-4.5');
  });
  it("separates the header with the double-etched rule", () => {
    expect(VIEW).toContain("border-y border-line-strong");
  });
});

describe("§V — the four groups, safest → most dangerous", () => {
  it("renders Permissions, Marketplace, Maintenance, then a red Danger zone", () => {
    const order = ["Permissions", "Marketplace", "Maintenance", "Danger zone"];
    let last = -1;
    for (const heading of order) {
      const at = VIEW.indexOf(`>${heading}<`);
      expect(at, `${heading} heading present & ordered`).toBeGreaterThan(last);
      last = at;
    }
  });
  it("the Danger zone is a red-bordered box with the alert glyph", () => {
    expect(VIEW).toContain("border-destructive/34");
    expect(VIEW).toContain("bg-destructive/5");
    expect(VIEW).toContain("TriangleAlert");
  });
});

describe("§V — Permissions: 'Who can access this extension?'", () => {
  it("the access control asks the §V question and reuses the unified access picker", () => {
    expect(ACCESS).toContain("Who can access this extension?");
    // cinatra#1607: the two pickers consolidated onto one AccessCombobox driven
    // by selectionMode; this grant surface uses the multi-select mode.
    expect(ACCESS).toContain("AccessCombobox");
    expect(ACCESS).toContain('selectionMode="multiple"');
  });
  it("the loader wires the sanctioned read/save actions with the v1 lockstep policy", () => {
    expect(SCREEN).toContain("readExtensionAccessPolicy");
    expect(SCREEN).toContain("saveExtensionAccessPolicy");
    expect(SCREEN).toContain("runListVisibility");
    expect(SCREEN).toContain("runDataVisibility");
    expect(SCREEN).toContain("runExecuteVisibility");
  });
});

describe("§V — Marketplace: one-way Publish, vendor-gated", () => {
  it("confirms 'Publish on the marketplace?' and states it is one-way", () => {
    expect(VIEW).toContain("Publish on the marketplace?");
    expect(VIEW).toContain("one-way");
  });
  it("shows a Register-for-marketplace link to the registries tab when not a vendor", () => {
    expect(VIEW).toContain("Register for marketplace");
    expect(VIEW).toContain("/configuration/environment?tab=registries");
  });
  it("shows the published state instead of the action once public", () => {
    expect(VIEW).toContain("Published on the marketplace.");
  });
});

describe("§V — Maintenance: Update + complementary Archive/Activate", () => {
  const MODEL = read("../extension-settings-model.ts");

  it("the Update row's description carries the §III state spelled out in words (resolveUpdateRow)", () => {
    expect(VIEW).toContain("description={updateRow.description}");
    // The per-state wordings live in the pure model — verbatim per the spec. The
    // "currently on" clause is composed through `installedLabel` since
    // cinatra#2762, which swaps it for a two-version sentence when the installed
    // version is NOT the one in service; both halves are pinned here, and
    // extension-settings-model.test.ts pins the composed output.
    expect(MODEL).toContain("`Currently on version ${installedVersion}`");
    expect(MODEL).toContain("`${installedLabel} — version ${latestVersion} is available.`");
    expect(MODEL).toContain('"Newer version needs a newer Cinatra."');
    expect(MODEL).toContain('"No registry version to compare."');
    expect(MODEL).toContain("`${installedLabel} — up to date.`");
  });
  it("the Update button greys out whenever there is nothing to run", () => {
    expect(VIEW).toContain("updateRow.enabled ? (");
    expect(VIEW).toContain("reason={updateRow.disabledReason}");
  });
  it("the loader derives the update state with the SAME derivation the §III card chip uses", () => {
    expect(SCREEN).toContain("deriveInstalledUpdateChipState");
    expect(SCREEN).toContain("readInstalledUpdateReadouts");
    expect(SCREEN).toContain("deriveExtensionCompatState");
    expect(SCREEN).toContain("resolveUpdateRow");
  });
  it("renders the Archive and Activate complementary pair", () => {
    expect(VIEW).toContain("moves to the Archived tab");
    expect(VIEW).toContain("Reactivate an archived extension");
  });
});

describe("§V — Danger zone: Reinstall latest + Force-delete (typed reason)", () => {
  it("Reinstall latest warns the unused-extension uninstall is a hard delete", () => {
    expect(VIEW).toContain("Reinstall latest");
    expect(VIEW).toContain("hard delete");
  });
  it("Force-delete demands a typed reason for the audit log and warns it bypasses restore", () => {
    expect(VIEW).toContain("requires a typed reason for the audit log");
    expect(ACTIONS).toContain('name="reason"');
    expect(ACTIONS).toContain("required");
    expect(ACTIONS).toContain("bypasses restore");
    expect(ACTIONS).toContain("Recorded in the lifecycle audit log. Required.");
    // Submit stays disabled until a non-empty reason is entered.
    expect(ACTIONS).toContain("disabled={trimmed.length === 0}");
  });
  it("destructive / one-way actions always confirm (a dialog), never a bare submit", () => {
    expect(ACTIONS).toContain("<Dialog");
  });
});

describe("§V — locked / system extensions render disabled-in-place with a reason", () => {
  it("the disabled affordance is a greyed button carrying the reason as its tooltip", () => {
    expect(ACTIONS).toContain('aria-disabled="true"');
    expect(ACTIONS).toContain("title={reason}");
  });
});

describe("card → settings wiring", () => {
  it("the installed card's Settings action targets the per-extension settings route", () => {
    expect(ROWS).toContain("settingsHrefFor(kind, packageName)");
    expect(ROWS).toContain('settingsHrefFor("connector", packageName)');
  });
});

// ---------------------------------------------------------------------------
// §V Skills (cinatra#2349 S4, epic #2345) — the per-agent skill choices.
// ---------------------------------------------------------------------------

describe("§V Skills — the slot, its placement, and who gets it", () => {
  it("the view takes the section as an INJECTED node, so it holds no skills-plane dependency", () => {
    expect(VIEW).toContain("skills?: ReactNode");
    expect(VIEW).toContain("{skills}");
    // No skills import reaches this presentational module.
    expect(VIEW).not.toContain("@cinatra-ai/skills");
    expect(VIEW).not.toContain("agent-skills-config");
  });

  it("renders NOTHING at all — heading included — when the section does not apply", () => {
    // The heading lives INSIDE the conditional, so a non-agent page has no
    // empty "Skills" frame (§V: absent entirely).
    const block = VIEW.slice(VIEW.indexOf("{skills ?"), VIEW.indexOf("{/* Marketplace */}"));
    expect(block).toContain('data-slot="settings-skills"');
    expect(block).toContain(">Skills</h2>");
    expect(block).toContain(": null}");
  });

  it("sits LAST in the per-agent configuration run — after Execution, before Marketplace", () => {
    const permissions = VIEW.indexOf('data-slot="settings-permissions"');
    const execution = VIEW.indexOf('data-slot="settings-execution"');
    const skills = VIEW.indexOf('data-slot="settings-skills"');
    const marketplace = VIEW.indexOf('data-slot="settings-marketplace"');
    expect(permissions).toBeGreaterThan(-1);
    expect(execution).toBeGreaterThan(permissions);
    expect(skills).toBeGreaterThan(execution);
    expect(marketplace).toBeGreaterThan(skills);
  });

  it("the screen loads it for AGENT kind only, lazily, and best-effort", () => {
    expect(SCREEN).toContain('if (extKind === "agent")');
    expect(SCREEN).toContain('await import(\n        "@/components/skills/agent-skills-config-section"\n      )');
    expect(SCREEN).toContain("loadAgentSkillsSection({ packageName })");
    // A load failure omits the section rather than blanking the page.
    expect(SCREEN).toContain("could not load the skills config section");
    expect(SCREEN).toContain("skills={skills}");
  });

  it("the screen NEVER decides assistant-ness itself by name or template shape", () => {
    // The authoritative eligibility read lives in the loader; the screen must
    // carry no suffix/template heuristic of its own.
    expect(SCREEN).not.toMatch(/-assistant/);
    expect(SCREEN).not.toContain("agent_kind");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2762 — §V names the INSTALLED-BUT-NOT-ACTIVE state.
//
// The state the issue is titled for had no surface at all: the page derived
// everything from `installed_extension.status` (the LIFECYCLE fact), so a live
// install serving nothing rendered as "Currently on version X — up to date" with
// Activate greyed "Already active". These pin the row that names it, where it
// sits, and — the load-bearing half — that it appears only on a positive,
// server-derived fact.
// ---------------------------------------------------------------------------
describe("§V — the installed-but-not-active state is named", () => {
  it("renders a Maintenance row addressable as `settings-not-in-service`", () => {
    expect(VIEW).toContain('dataSlot="settings-not-in-service"');
    expect(VIEW).toContain("servingState.title");
    expect(VIEW).toContain("servingState.description");
  });

  it("the row is conditional on the NAMED verdict — never on a status guess", () => {
    // `servingState?.named` and nothing else: no `status === "active"`, no
    // version comparison re-derived in the view.
    expect(VIEW).toMatch(/\{servingState\?\.named \?/);
    expect(VIEW).not.toMatch(/servingState[^}]*\.version\s*[!=]==/);
  });

  it("sits FIRST in Maintenance, above Update", () => {
    const maintenance = VIEW.indexOf('data-slot="settings-maintenance"');
    const notInService = VIEW.indexOf('dataSlot="settings-not-in-service"');
    const updateRow = VIEW.indexOf('title="Update"');
    expect(maintenance).toBeGreaterThan(-1);
    expect(notInService).toBeGreaterThan(maintenance);
    expect(updateRow).toBeGreaterThan(notInService);
  });

  it("carries NO action of its own — Retry / Roll back are the affordances", () => {
    const start = VIEW.indexOf('dataSlot="settings-not-in-service"');
    const block = VIEW.slice(start, VIEW.indexOf('title="Update"'));
    expect(block).not.toContain("<form");
    expect(block).not.toContain("actions.");
    // It states the state; the badge is a label, not a control.
    expect(block).toContain("Not in service");
  });

  it("the loader derives it SERVER-SIDE from the activation seams' own record", () => {
    expect(SCREEN).toContain("resolveServingState");
    expect(SCREEN).toContain('await import(\n            "@/lib/extension-capabilities-registry"');
    expect(SCREEN).toContain("readServingRecord(packageName)");
    // The record read is best-effort — a failure must not blank the page.
    expect(SCREEN).toMatch(/readServingRecord\(packageName\);\s*\}\s*catch\s*\{/);
  });

  it("the Update row stops calling the unserved version 'current'", () => {
    expect(SCREEN).toMatch(/servingVersion:\s*servingState\.named \? servingState\.servingVersion : null/);
  });

  it("Activate's reason comes from the same verdict, not from 'Already active'", () => {
    expect(SCREEN).toMatch(
      /activateNotInServiceReason:\s*servingState\.named \? servingState\.activateReason : null/,
    );
  });
});
