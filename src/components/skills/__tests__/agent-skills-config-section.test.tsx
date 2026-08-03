// The §V Skills section's SERVER half (cinatra#2349 S4, epic #2345).
//
// Two decisions live here and nowhere else, so both are pinned:
//
//   1. WHO GETS THE SECTION. Agent kind, non-assistant, decided from
//      authoritative declaration/registry data — and FAIL-CLOSED on any read
//      failure. A wrong "yes" advertises an assignment the injection path
//      could never deliver.
//   2. WHERE THE ROWS COME FROM. S1's hydrated assignment read, never the
//      search population — the search excludes exactly the archived and
//      role-changed rows an admin needs to see and clear.
//
//   pnpm exec vitest run \
//     src/components/skills/__tests__/agent-skills-config-section.test.tsx

import { beforeEach, describe, expect, it, vi } from "vitest";

const readCanonicalPackageKind = vi.fn();
const isAssistantPackageName = vi.fn();
const listAssignedAgentSkills = vi.fn();
const assignAgentSkill = vi.fn();
const removeAgentSkill = vi.fn();
const searchAssignableSkillExtensions = vi.fn();
const resolveAssignedSkillDisplay = vi.fn();

vi.mock("@/lib/agent-package-eligibility", () => ({
  readCanonicalPackageKind: (...a: unknown[]) => readCanonicalPackageKind(...a),
  isAssistantPackageName: (...a: unknown[]) => isAssistantPackageName(...a),
}));
vi.mock("@cinatra-ai/skills/agent-assigned-skills-actions", () => ({
  listAssignedAgentSkills: (...a: unknown[]) => listAssignedAgentSkills(...a),
  assignAgentSkill: (...a: unknown[]) => assignAgentSkill(...a),
  removeAgentSkill: (...a: unknown[]) => removeAgentSkill(...a),
}));
vi.mock("@cinatra-ai/extensions/assignable-skills-actions", () => ({
  searchAssignableSkillExtensions: (...a: unknown[]) => searchAssignableSkillExtensions(...a),
}));
vi.mock("@cinatra-ai/extensions/assigned-skills-display", () => ({
  resolveAssignedSkillDisplay: (...a: unknown[]) => resolveAssignedSkillDisplay(...a),
}));

import {
  isAgentSkillsSectionEligible,
  loadAgentSkillsSection,
} from "@/components/skills/agent-skills-config-section";
import type { AgentSkillRow } from "@/components/skills/agent-skills-config-client";

const assignedRow = (over: Record<string, unknown> = {}) => ({
  skillId: "s-blog-writing",
  position: 0,
  name: "Blog Writing",
  description: "",
  ownerPackageName: "@cinatra-ai/blog-skills",
  status: "ok",
  assignable: true,
  createdBy: "u-admin",
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  readCanonicalPackageKind.mockResolvedValue("agent");
  isAssistantPackageName.mockResolvedValue(false);
  listAssignedAgentSkills.mockResolvedValue({
    ok: true,
    agentPackageName: "@acme/research-agent",
    skills: [],
  });
  resolveAssignedSkillDisplay.mockResolvedValue(new Map());
});

/** Read the client element's props out of the returned node. */
function propsOf(node: unknown): {
  cap: number;
  initialRows: AgentSkillRow[];
  search: (q: string, p: { offset: number; limit: number }) => Promise<unknown>;
  assign: (id: string) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
} {
  return (node as { props: ReturnType<typeof propsOf> }).props;
}

describe("eligibility — who gets a Skills section", () => {
  it("an agent that is not an assistant DOES", async () => {
    await expect(isAgentSkillsSectionEligible("@acme/research-agent")).resolves.toBe(true);
  });

  it("an ASSISTANT does NOT — decided from the declaration/registry, not the name", async () => {
    isAssistantPackageName.mockResolvedValue(true);
    await expect(isAgentSkillsSectionEligible("@acme/chat-assistant")).resolves.toBe(false);
    // The verdict came from the authoritative read, never from the string.
    expect(isAssistantPackageName).toHaveBeenCalledWith("@acme/chat-assistant");
  });

  it("a NON-AGENT kind does NOT, and is never even asked about assistant-ness", async () => {
    for (const kind of ["connector", "artifact", "skill", "workflow"]) {
      readCanonicalPackageKind.mockResolvedValue(kind);
      await expect(isAgentSkillsSectionEligible("@acme/thing")).resolves.toBe(false);
    }
    expect(isAssistantPackageName).not.toHaveBeenCalled();
  });

  it("an UNRESOLVABLE kind does NOT (ambiguous rows fail closed)", async () => {
    readCanonicalPackageKind.mockResolvedValue(null);
    await expect(isAgentSkillsSectionEligible("@acme/thing")).resolves.toBe(false);
  });

  it("FAILS CLOSED when either read throws", async () => {
    readCanonicalPackageKind.mockRejectedValue(new Error("db down"));
    await expect(isAgentSkillsSectionEligible("@acme/research-agent")).resolves.toBe(false);

    readCanonicalPackageKind.mockResolvedValue("agent");
    isAssistantPackageName.mockRejectedValue(new Error("db down"));
    await expect(isAgentSkillsSectionEligible("@acme/research-agent")).resolves.toBe(false);
  });

  it("refuses an empty reference without reading anything", async () => {
    await expect(isAgentSkillsSectionEligible("")).resolves.toBe(false);
    expect(readCanonicalPackageKind).not.toHaveBeenCalled();
  });
});

describe("the section node", () => {
  it("is NULL for an assistant — no heading, no empty frame", async () => {
    isAssistantPackageName.mockResolvedValue(true);
    await expect(loadAgentSkillsSection({ packageName: "@acme/chat-assistant" })).resolves.toBeNull();
    // Never even reads the assignments for a target that cannot have any.
    expect(listAssignedAgentSkills).not.toHaveBeenCalled();
  });

  it("is NULL for a non-agent kind", async () => {
    readCanonicalPackageKind.mockResolvedValue("connector");
    await expect(loadAgentSkillsSection({ packageName: "@acme/crm" })).resolves.toBeNull();
  });

  it("is NULL when the assignment read itself refuses", async () => {
    listAssignedAgentSkills.mockResolvedValue({ ok: false, reason: "forbidden" });
    await expect(loadAgentSkillsSection({ packageName: "@acme/research-agent" })).resolves.toBeNull();
  });

  it("hydrates rows from the ASSIGNMENT read, never from the search population", async () => {
    listAssignedAgentSkills.mockResolvedValue({
      ok: true,
      agentPackageName: "@acme/research-agent",
      skills: [assignedRow(), assignedRow({ skillId: "s-archived", name: "Company Research", status: "archived", assignable: false, ownerPackageName: "@northstar/research-toolkit" })],
    });
    resolveAssignedSkillDisplay.mockResolvedValue(
      new Map([
        [
          "s-blog-writing",
          { skillId: "s-blog-writing", displayName: "Blog Skills", vendorName: "Cinatra" },
        ],
      ]),
    );

    const node = await loadAgentSkillsSection({ packageName: "@acme/research-agent" });
    expect(node).not.toBeNull();
    const { initialRows, cap } = propsOf(node);

    expect(cap).toBe(3);
    expect(searchAssignableSkillExtensions).not.toHaveBeenCalled();
    expect(initialRows).toEqual([
      {
        skillId: "s-blog-writing",
        skillName: "Blog Writing",
        displayName: "Blog Skills",
        vendorName: "Cinatra",
        status: "ok",
      },
      {
        // The ARCHIVED row survives — and falls back to its owning package
        // name, which the assignable population no longer covers.
        skillId: "s-archived",
        skillName: "Company Research",
        displayName: "@northstar/research-toolkit",
        vendorName: null,
        status: "archived",
      },
    ]);
  });

  it("falls back to the skill name when even the owning package is unknown", async () => {
    listAssignedAgentSkills.mockResolvedValue({
      ok: true,
      agentPackageName: "@acme/research-agent",
      skills: [assignedRow({ skillId: "s-gone", name: "s-gone", status: "missing", ownerPackageName: null })],
    });
    const node = await loadAgentSkillsSection({ packageName: "@acme/research-agent" });
    expect(propsOf(node).initialRows[0]).toMatchObject({ displayName: "s-gone", status: "missing" });
  });

  it("binds every action to the SERVER-derived package, never a client-named one", async () => {
    searchAssignableSkillExtensions.mockResolvedValue({
      ok: true,
      agentPackageName: "@acme/research-agent",
      results: [
        {
          skillId: "s-x",
          skillName: "X",
          skillDescription: "",
          packageName: "@acme/x",
          displayName: "X Kit",
          vendorName: "Acme",
          status: "active",
        },
      ],
      hasMore: true,
    });
    assignAgentSkill.mockResolvedValue({ ok: true, agentPackageName: "@acme/research-agent", skillId: "s-x", position: 0, alreadyAssigned: false });
    removeAgentSkill.mockResolvedValue({ ok: true, agentPackageName: "@acme/research-agent", skillId: "s-x", removed: true });

    const { search, assign, remove } = propsOf(
      await loadAgentSkillsSection({ packageName: "@acme/research-agent" }),
    );

    await expect(search("x", { offset: 0, limit: 20 })).resolves.toEqual({
      ok: true,
      hasMore: true,
      results: [
        {
          skillId: "s-x",
          skillName: "X",
          displayName: "X Kit",
          vendorName: "Acme",
          status: "active",
        },
      ],
    });
    expect(searchAssignableSkillExtensions).toHaveBeenCalledWith("@acme/research-agent", "x", {
      offset: 0,
      limit: 20,
    });

    await expect(assign("s-x")).resolves.toEqual({ ok: true });
    expect(assignAgentSkill).toHaveBeenCalledWith({
      agentRef: "@acme/research-agent",
      skillId: "s-x",
    });

    await expect(remove("s-x")).resolves.toEqual({ ok: true });
    expect(removeAgentSkill).toHaveBeenCalledWith({
      agentRef: "@acme/research-agent",
      skillId: "s-x",
    });
  });

  it("passes each refusal through as a REASON the client can explain", async () => {
    searchAssignableSkillExtensions.mockResolvedValue({ ok: false, reason: "eligibility-unreadable" });
    assignAgentSkill.mockResolvedValue({ ok: false, reason: "cap-exceeded" });
    removeAgentSkill.mockResolvedValue({ ok: false, reason: "forbidden" });

    const { search, assign, remove } = propsOf(
      await loadAgentSkillsSection({ packageName: "@acme/research-agent" }),
    );
    await expect(search("q", { offset: 0, limit: 20 })).resolves.toEqual({
      ok: false,
      reason: "eligibility-unreadable",
    });
    await expect(assign("s-x")).resolves.toEqual({ ok: false, reason: "cap-exceeded" });
    await expect(remove("s-x")).resolves.toEqual({ ok: false, reason: "forbidden" });
  });
});
