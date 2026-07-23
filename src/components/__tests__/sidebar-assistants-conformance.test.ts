/**
 * Source-text conformance for the "Assistants" sidebar entry (cinatra#1879,
 * epic #1873 W4, ratified spec design@f1b000be632aa8d4ec0bc2ea1eaf7c894a7249de
 * `specs/app.html` §IX "The Assistants sidebar entry").
 *
 * §IX pins ONE flat nav entry titled "Assistants" that sits DIRECTLY BELOW Chat
 * and ABOVE Agents. It is one nav entry — NOT a group — and introduces no
 * section heading; it carries the standard sidebar-row treatment (a leading
 * icon + the 13px sans label, the active row on the indigo tint) exactly like
 * the Chat entry above and the Agents entry below. Agents is UNCHANGED — no
 * label or heading is introduced above it. Selecting Assistants opens the
 * Assistants surface, the same way Chat opens chat and Agents opens agents.
 *
 * The spec's machine-readable contract for the surface:
 *   data-conformance-id = "sidebar-assistants-entry"
 *   sole action         = "open-assistants -> assistants"  (open → the
 *                          assistants surface, i.e. the /assistants directory
 *                          built by epic #1873 W3, src/app/assistants/page.tsx)
 *
 * There is no signed-out shell, so this rework carries NO audience/registry
 * fan-out, NO per-assistant rows, and NO hiddenNavTitles wiring — the earlier
 * "Assistants" SidebarGroup design (registry-resolved rows threaded
 * server-side) is explicitly retired here.
 *
 * The repo runs vitest in a node environment without @testing-library/react, so
 * this server/client wiring is pinned via source-text assertions — the
 * established repo pattern (see artifacts/__tests__/surface-conformance.test.ts).
 * The LIVE bidirectional Playwright walk (sidebar at 1440px signed-in showing
 * Chat → Assistants → Agents, plus the click-through to /assistants) is the
 * proof-at-close on the PR.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(path.join(ROOT, rel));

// The exact §IX conformance contract, pinned from design@f1b000be6 specs/app.html.
const CONFORMANCE_ID = "sidebar-assistants-entry";
const CONFORMANCE_ACTION = "open-assistants -> assistants";
const ASSISTANTS_ROUTE = "/assistants";

describe("§IX — one flat 'Assistants' entry carries the pinned conformance surface (spec→render)", () => {
  const SIDEBAR = read("src/components/app-sidebar.tsx");

  it("declares the sidebar-assistants-entry conformance id EXACTLY once", () => {
    const occurrences = SIDEBAR.split(`data-conformance-id="${CONFORMANCE_ID}"`).length - 1;
    expect(occurrences).toBe(1);
  });

  it("its sole action is open-assistants -> assistants, opening the /assistants surface", () => {
    expect(SIDEBAR).toContain(`data-action="${CONFORMANCE_ACTION}"`);
    // Sole action: no other data-action lives on the Assistants entry.
    const actions = SIDEBAR.match(/data-action="[^"]*"/g) ?? [];
    expect(actions).toEqual([`data-action="${CONFORMANCE_ACTION}"`]);
    // The action resolves to the real assistants surface route.
    expect(SIDEBAR).toContain(`href="${ASSISTANTS_ROUTE}"`);
  });

  it("renders the entry with the §IX leading icon (Sparkles) and the 'Assistants' label", () => {
    // `[^}]*` matches across newlines (the import spans multiple lines), so no
    // dotAll flag is needed — and `/s` would trip tsgo's pre-es2018 lib target.
    expect(SIDEBAR).toMatch(/import \{[^}]*\bSparkles\b[^}]*\} from "lucide-react"/);
    expect(SIDEBAR).toMatch(/<Sparkles className="h-4 w-4 shrink-0" \/>/);
    expect(SIDEBAR).toMatch(/<span>Assistants<\/span>/);
  });

  it("wires the active-row state via SidebarMenuButton isActive on the /assistants path", () => {
    expect(SIDEBAR).toMatch(
      /const isActive =\s*pathname === "\/assistants" \|\| pathname\.startsWith\("\/assistants\/"\)/,
    );
    expect(SIDEBAR).toMatch(/<SidebarMenuButton asChild isActive=\{isActive\} tooltip="Assistants">/);
  });

  it("the assistants surface route the entry opens is a real page (epic #1873 W3)", () => {
    expect(exists("src/app/assistants/page.tsx")).toBe(true);
  });
});

describe("§IX — the entry sits directly below Chat and above Agents; Agents is unchanged", () => {
  const SIDEBAR = read("src/components/app-sidebar.tsx");

  it("orders Chat → Assistants → Agents in the sidebar body", () => {
    const idxChat = SIDEBAR.indexOf("<ChatNavItem />");
    const idxAssistants = SIDEBAR.indexOf("<AssistantsNavItem />");
    const idxAgents = SIDEBAR.indexOf('url: "/agents"');
    expect(idxChat).toBeGreaterThan(-1);
    expect(idxAssistants).toBeGreaterThan(-1);
    expect(idxAgents).toBeGreaterThan(-1);
    expect(idxChat).toBeLessThan(idxAssistants);
    expect(idxAssistants).toBeLessThan(idxAgents);
  });

  it("Assistants is one entry inside the existing Intelligence menu — NOT a new group/heading", () => {
    // No "Assistants" SidebarGroup, NavGroup, or SidebarGroupLabel is introduced.
    expect(SIDEBAR).not.toMatch(/title="Assistants"/);
    expect(SIDEBAR).not.toMatch(/<SidebarGroupLabel>Assistants<\/SidebarGroupLabel>/);
    expect(SIDEBAR).not.toMatch(/NavGroup[^>]*title=\{?"Assistants"/);
  });

  it("Agents keeps its existing unlabeled NavGroup form — no heading introduced above it", () => {
    expect(SIDEBAR).toMatch(/title: "Agents"/);
    expect(SIDEBAR).toMatch(/url: "\/agents"/);
    expect(SIDEBAR).toMatch(/icon: domainIcons\.agents/);
    // The Agents group is still rendered WITHOUT a group title (unlabeled), so
    // no "Agents" section heading exists.
    expect(SIDEBAR).not.toMatch(/<SidebarGroupLabel>Agents<\/SidebarGroupLabel>/);
  });
});

describe("§IX — the retired registry/group design is not reintroduced (render→spec)", () => {
  const SIDEBAR = read("src/components/app-sidebar.tsx");
  const SHELL = read("src/components/app-shell.tsx");
  const LAYOUT = read("src/app/layout.tsx");
  const LAYOUT_TYPES = read("src/components/layout-types.ts");
  const NAV_GROUP = read("src/components/nav-group.tsx");

  it("the registry-driven assistant-nav builder + its unit test are gone", () => {
    expect(exists("src/lib/assistant-nav.ts")).toBe(false);
    expect(exists("src/lib/__tests__/assistant-nav.test.ts")).toBe(false);
  });

  it("no server-resolved assistantNav is threaded through the shell", () => {
    for (const src of [SIDEBAR, SHELL, LAYOUT]) {
      expect(src).not.toMatch(/assistantNav/);
      expect(src).not.toMatch(/AssistantNavItem/);
      expect(src).not.toMatch(/resolveAssistantNavItemsForActor/);
    }
  });

  it("no signed-out handling: the entry is never pushed onto hiddenNavTitles", () => {
    expect(LAYOUT).not.toMatch(/hiddenNavTitles\.push\("Assistants"\)/);
  });

  it("the per-assistant logo channel added for the fan-out design is not present", () => {
    expect(LAYOUT_TYPES).not.toMatch(/logo/);
    expect(NAV_GROUP).not.toMatch(/NavLeadingVisual/);
    expect(NAV_GROUP).not.toMatch(/safeAssistantLogoSrc/);
  });
});
