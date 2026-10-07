// @vitest-environment jsdom
//
// Configuration > Skills > Matches: accessible names of the agent sections,
// their skill pickers and their "Add skill" buttons (cinatra#3778).
//
//   pnpm exec vitest run src/app/configuration/skills/__tests__/matches-accessible-names.test.tsx
//
// The sentences this file pins, quoted from the issue:
//
//   "each section's picker carries a name that says what it picks and for
//    which agent (for example "Skill for Blog Draft Writer Agent"), and the
//    "Add skill" button is named per section the same way, as the product's
//    other pickers are"
//
//   "A heading or `aria-labelledby` per section (the agent's name) fixes both
//    this and the picker's name above."
//
// Nothing a person sees changes: the button still reads "Add skill" and the
// picker still shows its "Add a skill…" placeholder. Those two readings are
// pinned here too.
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/configuration/skills",
  useSearchParams: () => new URLSearchParams("tab=matches"),
}));

vi.mock("@/context/notification-context", () => ({
  useNotify: () => ({ addNotification: vi.fn() }),
}));

vi.mock("../actions", () => ({
  saveSkillsDataPathAction: vi.fn(),
  saveGitHubRepoFromSkillsAction: vi.fn(),
  saveSkillAutosaveAction: vi.fn(),
  saveGitHubPersonalAccessTokenAction: vi.fn(),
  matchAgentsToSkillsAction: vi.fn(),
  refreshAgentsAndMatchAction: vi.fn(),
  getScheduleAction: vi.fn(),
  setScheduleAction: vi.fn(),
  getBatchEstimateAction: vi.fn(),
  runBatchNowAction: vi.fn(),
  cancelBatchRunAction: vi.fn(),
  evaluatePairAction: vi.fn(),
  addAgentSkillMatchAction: vi.fn(),
  removeAgentSkillMatchAction: vi.fn(),
  recreateLibraryAction: vi.fn(),
  deprecateSkillFromEfficacyAction: vi.fn(),
  dismissDeprecationCandidateAction: vi.fn(),
  reinstateDeprecationCandidateAction: vi.fn(),
}));

// The page opens with the admin gate; it is pinned in
// src/app/configuration/__tests__/configuration-admin-gate.test.ts, so this
// file runs as an admin.
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({
    user: { id: "user_admin", role: "user,admin" },
    session: { activeOrganizationId: "org_1" },
  })),
}));

const { AGENTS, SKILL } = vi.hoisted(() => ({
  AGENTS: [
    {
      id: "blog-draft-writer",
      identifier: "blog-draft-writer",
      packageId: "blog-draft-writer",
      humanReadableName: "Blog Draft Writer Agent",
    },
    {
      id: "web-research",
      identifier: "web-research",
      packageId: "web-research",
      humanReadableName: "Web Research Agent",
    },
  ],
  SKILL: {
    id: "blog-writing",
    name: "Blog writing",
    packageName: "@cinatra-ai/blog-writing-skill",
    level: "organization",
    agentId: null,
  },
}));

vi.mock("@/lib/agents-store", () => ({
  readAgentsForSkillMatching: vi.fn(async () => AGENTS),
  readAgentSkillMatches: vi.fn(async () => ({ matches: [], matchedAt: null })),
}));

vi.mock("@cinatra-ai/skills", () => ({
  dedupSkillsByName: <T,>(skills: T[]) => skills,
  listInstalledSkills: vi.fn(async () => [SKILL]),
  readSchedule: vi.fn(async () => ({ enabled: false, cronExpression: null, timezone: "UTC" })),
  readLatestBatchRun: vi.fn(async () => null),
  skillMatchesStore: { readAllMatched: vi.fn(async () => []) },
}));

vi.mock("@cinatra-ai/skills/store", () => ({
  readSkillsStorageConfig: vi.fn(() => ({})),
}));

vi.mock("@/lib/connector-client-providers", () => ({
  resolveGitHubConnectionClient: vi.fn(async () => null),
}));

vi.mock("@/lib/nango-system", () => ({
  getNangoFrontendConfig: vi.fn(() => null),
  getNangoStatus: vi.fn(() => null),
  getPrimarySavedNangoConnection: vi.fn(() => null),
}));

vi.mock("@cinatra-ai/sdk-ui/nango", () => ({
  NangoUserConnectButton: () => null,
}));

vi.mock("@/lib/skill-efficacy", () => ({
  readSkillEfficacy: vi.fn(() => []),
  SKILL_DEPRECATION_MIN_EXPOSURE_SAMPLE: 20,
}));

vi.mock("../_matches-status-panel", () => ({ MatchesStatusPanel: () => null }));
vi.mock("../_matches-cron-picker", () => ({ MatchesCronPicker: () => null }));
vi.mock("../_matches-batch-modal", () => ({ MatchesBatchModal: () => null }));
vi.mock("../_matches-row-action", () => ({ MatchesRowAction: () => null }));

const MOCKED = [
  "next/navigation",
  "@/context/notification-context",
  "../actions",
  "@/lib/auth-session",
  "@/lib/agents-store",
  "@cinatra-ai/skills",
  "@cinatra-ai/skills/store",
  "@/lib/connector-client-providers",
  "@/lib/nango-system",
  "@cinatra-ai/sdk-ui/nango",
  "@/lib/skill-efficacy",
  "../_matches-status-panel",
  "../_matches-cron-picker",
  "../_matches-batch-modal",
  "../_matches-row-action",
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(() => {
  for (const path of MOCKED) vi.doUnmock(path);
  vi.resetModules();
  vi.restoreAllMocks();
});

const AGENT_NAMES = ["Blog Draft Writer Agent", "Web Research Agent"];

/** Await every async server function in the tree with its props, recursively. */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child: ReactNode) => resolveTree(child)));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  const type = element.type as unknown;
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") {
    const rendered = await (type as (props: unknown) => Promise<ReactNode>)(element.props);
    return resolveTree(rendered);
  }
  if (element.props.children === undefined) return element;
  const children = await resolveTree(element.props.children);
  return cloneElement(element, { children });
}

describe("Matches tab: the skill picker and Add skill button of each agent (client)", () => {
  async function renderSelectors() {
    const { AddMatchSkillSelector } = await import("../matches-client");
    const skills = [{ id: SKILL.id, name: SKILL.name, packageName: SKILL.packageName }];
    return render(
      <div>
        {AGENTS.map((agent) => (
          <AddMatchSkillSelector key={agent.id} agentId={agent.id} agentName={agent.humanReadableName} skills={skills} />
        ))}
      </div>,
    );
  }

  // "each section's picker carries a name that says what it picks and for which agent"
  it("names each picker for its agent", async () => {
    await renderSelectors();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    const names = AGENT_NAMES.map(
      (name) => screen.getByRole("combobox", { name: `Skill for ${name}` }).getAttribute("aria-label"),
    );
    expect(new Set(names).size).toBe(2);
  });

  // "the \"Add skill\" button is named per section the same way, as the product's other pickers are"
  it("names each Add skill button for its agent", async () => {
    await renderSelectors();
    for (const name of AGENT_NAMES) {
      expect(screen.getByRole("button", { name: `Add skill to ${name}` })).toBeTruthy();
    }
  });

  // Nothing a person sees changes.
  it("keeps the visible button text and the picker placeholder", async () => {
    const { container } = await renderSelectors();
    const buttons = Array.from(container.querySelectorAll('button:not([role="combobox"])'));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.textContent).toBe("Add skill");
    const pickers = screen.getAllByRole("combobox");
    for (const picker of pickers) expect(picker.textContent).toBe("Add a skill…");
  });
});

describe("Matches tab: each agent section is a region named by the agent (page)", () => {
  // "A heading or `aria-labelledby` per section (the agent's name) fixes both this and the picker's name above."
  it("draws one region per agent, scoping its own named picker and button", async () => {
    const { default: SettingsSkillsPage } = await import("../page");
    const tree = await SettingsSkillsPage({ searchParams: Promise.resolve({ tab: "matches" }) });
    render(<>{await resolveTree(tree)}</>);

    const regions = screen.getAllByRole("region");
    for (const name of AGENT_NAMES) {
      const named = regions.filter((region) => {
        const labelId = region.getAttribute("aria-labelledby");
        return labelId !== null && document.getElementById(labelId)?.textContent === name;
      });
      expect(named, `region named ${name}`).toHaveLength(1);
      const region = screen.getByRole("region", { name });
      expect(within(region).getAllByRole("combobox")).toHaveLength(1);
      expect(within(region).getByRole("combobox", { name: `Skill for ${name}` })).toBeTruthy();
      expect(within(region).getByRole("button", { name: `Add skill to ${name}` })).toBeTruthy();
    }
  });
});
