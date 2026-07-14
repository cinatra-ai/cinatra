/**
 * Source-text contract test for the #1503 project-agents bind UX (design
 * cinatra#1509 §4.4). Component tests in this repo lock wiring via
 * source-file text assertions (the access-combobox-*.test.tsx convention);
 * the BEHAVIOUR of the pure candidate/authority helpers lives in
 * bindable-templates.test.ts and the action test.
 *
 * Truths locked here:
 *  - the bind form's PRIMARY path is the shared EntitySearchCombobox (no raw
 *    template-id Input as the default), rows name-first with the package id
 *    demoted to font-mono;
 *  - the raw-id path survives as the "Enter ID manually" ADVANCED toggle
 *    (template ids are legitimately an open set);
 *  - bound rows are name-first via the shared unknown-entity helper
 *    ("Unknown template" fallback — never id-only);
 *  - the empty state adopts the ui/empty kit with a primary "Add agent"
 *    action (no bare "No agent template bindings yet." paragraph);
 *  - the create path links to the canonical /chat?mode=create-agent flow and
 *    NEVER auto-binds (return/preselect only — owner-gated Open Decision 2);
 *  - read-only viewers get the explanatory permissions sentence;
 *  - page.tsx mounts the "Add agent" header action for editors inside the
 *    BindPanelProvider, and resolves the ?bindTemplate deep-link preselect
 *    server-side from the same catalog map (batched — no per-row lookups);
 *  - the conformance testids (`project-bind-form`, `project-bindings-list`)
 *    stay stable.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const CLIENT = readFileSync(
  "src/app/projects/[projectId]/agents/bindings-client.tsx",
  "utf-8",
);
const PAGE = readFileSync(
  "src/app/projects/[projectId]/agents/page.tsx",
  "utf-8",
);
const CONTEXT = readFileSync(
  "src/app/projects/[projectId]/agents/bind-panel-context.tsx",
  "utf-8",
);

describe("bindings-client — searchable template picker (§4.4)", () => {
  it("mounts the shared EntitySearchCombobox as the primary bind path", () => {
    expect(CLIENT).toMatch(
      /import \{\s*EntitySearchCombobox,[\s\S]*?\} from "@\/components\/entity-search-combobox"/,
    );
    expect(CLIENT).toMatch(/<EntitySearchCombobox/);
    // Candidates are server-listed (the gated action), filtered client-side
    // via the pure helper.
    expect(CLIENT).toMatch(/listBindableAgentTemplatesAction\(projectId\)/);
    expect(CLIENT).toMatch(/filterBindableTemplates\(/);
    // Already-bound ids are excluded client-side too (fresh binds disappear
    // without waiting for the server refresh).
    expect(CLIENT).toMatch(
      /excludeIds=\{bindings\.map\(\(b\) => b\.agentTemplateId\)\}/,
    );
  });

  it("renders picker rows name-first with the package id demoted to font-mono", () => {
    const renderRow = CLIENT.slice(
      CLIENT.indexOf("renderRow={(item)"),
      CLIENT.indexOf("disabled={pending}", CLIENT.indexOf("renderRow={(item)")),
    );
    expect(renderRow).toMatch(/\{item\.name\}/);
    expect(renderRow).toMatch(/font-mono[^"]*text-muted-foreground/);
    expect(renderRow).toMatch(/\{item\.id\}/);
  });

  it("keeps the raw-id path behind the 'Enter ID manually' advanced toggle", () => {
    expect(CLIENT).toMatch(/Enter ID manually/);
    expect(CLIENT).toMatch(/Choose from installed templates/);
    // The raw Input renders ONLY in the manual branch…
    expect(CLIENT).toMatch(/\{manualMode \? \(/);
    expect(CLIENT).toMatch(/id="new-template-id"/);
    // …and the legacy placeholder survives there for unlisted/remote ids.
    expect(CLIENT).toMatch(/@cinatra-ai\/agent-scrape/);
  });

  it("renders bound rows name-first via the shared unknown-entity helper", () => {
    expect(CLIENT).toMatch(
      /import \{ resolveScopeEntityName \} from "@\/components\/access-scope"/,
    );
    expect(CLIENT).toMatch(
      /resolveScopeEntityName\(\s*"template",\s*binding\.agentTemplateId,\s*binding\.templateName,?\s*\)/,
    );
    // The raw id stays visible but demoted (font-mono secondary), so an
    // unresolved template reads "Unknown template" + id — never id-only.
    expect(CLIENT).toMatch(/font-mono text-xs text-muted-foreground">\s*\{binding\.agentTemplateId\}/);
  });

  it("adopts the ui/empty kit with a primary 'Add agent' action", () => {
    expect(CLIENT).toMatch(/from "@\/components\/ui\/empty"/);
    expect(CLIENT).toMatch(/<EmptyTitle>No agents bound yet<\/EmptyTitle>/);
    expect(CLIENT).toMatch(/<EmptyContent>/);
    expect(CLIENT).toMatch(/Add agent/);
    // The bare pre-#1503 empty paragraph is gone.
    expect(CLIENT).not.toMatch(/No agent template bindings yet\./);
  });

  it("links the create path to the canonical flow and never auto-binds", () => {
    expect(CLIENT).toMatch(/href="\/chat\?mode=create-agent"/);
    expect(CLIENT).toMatch(/Create new agent/);
    // Return/preselect only (Open Decision 2): the preselect needs ONE
    // explicit Bind click — no bind call outside the user-invoked onBind.
    const bindCallSites =
      CLIENT.match(/createProjectAgentTemplateBindingAction/g) ?? [];
    expect(bindCallSites).toHaveLength(2); // 1 import + 1 call inside onBind
    expect(CLIENT).toMatch(/initialTemplate\?:/);
  });

  it("tells read-only viewers why the form is absent (permission-clarity AC)", () => {
    expect(CLIENT).toMatch(
      /Only project owners\/admins can manage agent bindings — ask a\s+project admin for access\./,
    );
    expect(CLIENT).toMatch(/\{!canEdit && \(/);
  });

  it("keeps the conformance testids stable", () => {
    expect(CLIENT).toMatch(/data-testid="project-bind-form"/);
    expect(CLIENT).toMatch(/data-testid="project-bindings-list"/);
  });
});

describe("agents page — header action + preselect deep link (§4.4)", () => {
  it("mounts the 'Add agent' header action for editors inside BindPanelProvider", () => {
    expect(PAGE).toMatch(
      /import \{ AddAgentHeaderButton, BindPanelProvider \} from "\.\/bind-panel-context"/,
    );
    expect(PAGE).toMatch(/<BindPanelProvider initialOpen=\{initialTemplate !== null\}>/);
    expect(PAGE).toMatch(/actions=\{canEdit \? <AddAgentHeaderButton \/> : undefined\}/);
  });

  it("resolves bound-row names in ONE batched catalog read (no N+1)", () => {
    expect(PAGE).toMatch(
      /import \{ readAgentsForSkillMatching \} from "@\/lib\/agents-store"/,
    );
    expect(PAGE).toMatch(/templateNameById/);
    expect(PAGE).toMatch(/templateName: templateNameById\.get\(b\.agentTemplateId\) \?\? null/);
  });

  it("honors the ?bindTemplate deep link for editors only (return/preselect)", () => {
    expect(PAGE).toMatch(/searchParams: Promise<\{ bindTemplate\?: string \| string\[\] \}>/);
    expect(PAGE).toMatch(/canEdit && typeof bindTemplate === "string"/);
  });
});

describe("bind-panel context — degradable route-local coordination", () => {
  it("provides open state + opener, degrading to always-open without a provider", () => {
    expect(CONTEXT).toMatch(/createContext<BindPanelContextValue>\(\{\s*open: true,/);
    expect(CONTEXT).toMatch(/export function useBindPanel/);
    expect(CONTEXT).toMatch(/export function BindPanelProvider/);
    expect(CONTEXT).toMatch(/export function AddAgentHeaderButton/);
    expect(CONTEXT).toMatch(/data-testid="add-agent-header-action"/);
  });
});
