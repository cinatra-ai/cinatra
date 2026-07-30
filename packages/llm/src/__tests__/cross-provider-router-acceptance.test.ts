/**
 * CROSS-PROVIDER ROUTER ACCEPTANCE SUITE (cinatra#2094, epic #2086 S7).
 *
 * The S7 acceptance framing names this block directly: *"one bundle delivered
 * through all three providers — tool-read reachability on OpenAI/Anthropic, core
 * expansion on Gemini, over-budget fixtures proving whole-skill drops, exposure
 * ledger correctness (delta counted, drops recorded)"*. The first acceptance run
 * recorded it as NOT RUN: its constituent invariants were green in the S4 suites,
 * but no suite drove ONE bundle across all three delivery mechanisms end to end.
 * This is that suite.
 *
 * ## What makes this different from the S4 suites it sits on
 *
 * The S4 suites (`skill-delivery.test.ts`, `skill-exposure-contract.test.ts`,
 * `packages/skills/.../injection/__tests__/*`) each prove ONE mechanism, each
 * with its own fixture. They remain the unit-level authority and are NOT
 * replaced. What none of them can show is the property the epic actually claims:
 * that a SINGLE authored bundle survives all three routes with the same members,
 * the same cap, and an exposure ledger that agrees with what each provider was
 * really handed. A per-mechanism suite cannot catch a bundle that is reachable on
 * OpenAI and silently unreachable on Anthropic, because it never delivers the
 * same bundle to both.
 *
 * So every arm below reads from the ONE `BUNDLE` fixture defined at the top, and
 * the cross-cutting arm asserts the three routes against each other rather than
 * against three hand-written expectations.
 *
 * ## Scope, stated honestly
 *
 * This is a STUBBED suite: the skills client and `node:fs` are mocked exactly as
 * the S4 suites mock them, so the real `buildSkillTools`, the real inline
 * expansion core, and the real container-reference assembly all execute, but no
 * provider is contacted. Provider-side acceptance of these artifacts is a
 * separate, LIVE claim and is evidenced by the live conformance arm
 * (`evidence/2094-s7-acceptance/live-results.json` — C8 proves the 8-per-request
 * ceiling is the server's own, C9 that an unresolvable reference fails closed).
 * Nothing here is labelled live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { installedGetMock, existsSyncMock } = vi.hoisted(() => ({
  installedGetMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { get: installedGetMock },
  }),
}));

// Serve the FIXTURE bodies by path so an OpenAI shell read returns the same
// router text the Gemini inline arm expands — that shared body is what makes
// this a one-bundle suite rather than three fixtures.
vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: async (abs: string) => {
    for (const [suffix, content] of Object.entries(FIXTURE_FILES)) {
      if (abs.endsWith(suffix)) return content;
    }
    return "";
  },
}));

const { openaiShellSurface } = vi.hoisted(() => ({
  openaiShellSurface: {
    providerId: "openai",
    shellTools: {
      readSettings: () => null,
      runCommandInDocker: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    },
  },
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn(() => null),
  getLlmSkillDeliveryAdapterSurface: vi.fn(() => null),
  getLlmProviderSurface: vi.fn((providerId: string) =>
    providerId === "openai" ? openaiShellSurface : null,
  ),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    if (providerId === "openai") return openaiShellSurface;
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => [openaiShellSurface]),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

import { selectSkillDeliveryAdapter } from "../tools/skill-delivery";
import { createLocalSkillShellTool } from "../tools/skills";
import {
  setAnthropicSkillSyncMap,
  resetAnthropicSkillSyncMap,
  type AnthropicSyncedSkillRef,
} from "../tools/anthropic-skill-sync-map";
import {
  INJECTED_SKILL_CAP,
  PROVIDER_SKILL_DELIVERY_MECHANISM,
  resolveSkillDeliveryMechanism,
  extractOneHopReferences,
  planInlineExpansion,
  type InlineExpansionUnit,
} from "@cinatra-ai/skills/injection";
import { AnthropicSkillNotSyncedError } from "../errors";
import type { LlmShellTool, LlmContainerSkillsTool } from "../types";

// ===========================================================================
// THE ONE BUNDLE
// ===========================================================================

/**
 * A router SKILL.md that names its one-hop references in all three shapes the
 * extractor recognizes (markdown link, back-ticked path, bare mention), so the
 * Gemini arm exercises real extraction rather than a pre-computed list.
 */
const ROUTER_BODY = [
  "# Quarterly close",
  "",
  "Follow the [posting guide](references/posting-guide.md) for the ledger rules.",
  "Rate tables live in `references/rates.md`.",
  "Escalation contacts: references/escalation.md",
].join("\n");

const POSTING_GUIDE = "## Posting guide\n\nDebit before credit. Never post to a closed period.";
const RATES = "## Rates\n\n| region | rate |\n|---|---|\n| eu | 0.19 |";
const ESCALATION = "## Escalation\n\nPage the controller on any variance over 1%.";
const HELPER_BODY = "# Variance helper\n\nCompute variance as (actual - plan) / plan.";

/** Path suffix -> content, consulted by the mocked `readSkillFileContent`. */
const FIXTURE_FILES: Record<string, string> = {
  "quarterly-close/SKILL.md": ROUTER_BODY,
  "quarterly-close/references/posting-guide.md": POSTING_GUIDE,
  "quarterly-close/references/rates.md": RATES,
  "quarterly-close/references/escalation.md": ESCALATION,
  "variance-helper/SKILL.md": HELPER_BODY,
};

const ROUTER_ID = "@cinatra/finance:quarterly-close";
const HELPER_ID = "@cinatra/finance:variance-helper";
/** The run owner's personal delta — always delivered, and it counts to the cap. */
const DELTA_ID = "@personal/delta:owner-notes";
const DELTA_BODY = "Always report in EUR.";

/** The bundle, as authored. Every arm below reads from exactly this. */
const BUNDLE = {
  members: [
    {
      catalogSkillId: ROUTER_ID,
      slug: "quarterly-close",
      directoryPath: "/skills-src/quarterly-close",
      sourcePath: "/skills-src/quarterly-close/SKILL.md",
      body: ROUTER_BODY,
      anthropic: { skillId: "skill_qc_001", version: "1785360069482729" },
    },
    {
      catalogSkillId: HELPER_ID,
      slug: "variance-helper",
      directoryPath: "/skills-src/variance-helper",
      sourcePath: "/skills-src/variance-helper/SKILL.md",
      body: HELPER_BODY,
      anthropic: { skillId: "skill_vh_002", version: "1785360070364116" },
    },
  ],
  delta: { catalogSkillId: DELTA_ID, body: DELTA_BODY },
} as const;

const BUNDLE_IDS = BUNDLE.members.map((m) => m.catalogSkillId);

function installedRecordFor(id: string) {
  const member = BUNDLE.members.find((m) => m.catalogSkillId === id);
  if (!member) return { id, name: id, slug: id, description: `desc ${id}` };
  return {
    id,
    name: member.slug,
    slug: member.slug,
    description: `desc ${member.slug}`,
    sourcePath: member.sourcePath,
    body: member.body,
  };
}

function syncMapForBundle() {
  setAnthropicSkillSyncMap({
    resolve: async (catalogSkillId: string): Promise<AnthropicSyncedSkillRef | null> => {
      const member = BUNDLE.members.find((m) => m.catalogSkillId === catalogSkillId);
      if (!member) return null;
      return {
        skillId: member.anthropic.skillId,
        version: member.anthropic.version,
        catalogSkillId,
      };
    },
  });
}

beforeEach(() => {
  installedGetMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
  installedGetMock.mockImplementation((id: string) =>
    Promise.resolve(installedRecordFor(id)),
  );
});

afterEach(() => {
  resetAnthropicSkillSyncMap();
});

describe("cross-provider router acceptance suite — ONE bundle, all three providers", () => {
  // =========================================================================
  // 0. The route table itself
  // =========================================================================
  describe("route table", () => {
    it("every provider the bundle can reach declares exactly one mechanism", () => {
      expect(PROVIDER_SKILL_DELIVERY_MECHANISM).toEqual({
        openai: "tool-mount",
        gemini: "inline",
        anthropic: "container",
      });
      expect(resolveSkillDeliveryMechanism("openai")).toBe("tool-mount");
      expect(resolveSkillDeliveryMechanism("gemini")).toBe("inline");
      expect(resolveSkillDeliveryMechanism("anthropic")).toBe("container");
    });

    it("an undeclared provider fails closed rather than silently delivering nothing", () => {
      expect(() => resolveSkillDeliveryMechanism("mistral")).toThrow(
        /No skill-delivery mechanism is declared/,
      );
    });
  });

  // =========================================================================
  // 1. Tool-read reachability — OpenAI
  // =========================================================================
  describe("tool-read reachability :: OpenAI (tool-mount)", () => {
    it("mounts the bundle as shell tools with no system-prompt copy of the bodies", async () => {
      const result = await selectSkillDeliveryAdapter("openai").deliver({
        skillIds: [...BUNDLE_IDS],
      });
      expect(result.tools).toHaveLength(1);
      expect((result.tools[0] as { type: string }).type).toBe("shell");
      // The bodies are READ through the tool, never inlined on this route.
      expect(result.systemContext).toBe("");
    });

    it("the mounted tool actually REACHES the router body, attributed to its catalog id", async () => {
      const reads: string[] = [];
      const tool: LlmShellTool = createLocalSkillShellTool({
        mountedSkills: BUNDLE.members.map((m) => ({
          id: m.catalogSkillId,
          name: m.slug,
          slug: m.slug,
          description: `desc ${m.slug}`,
          sourcePath: m.sourcePath,
          directoryPath: m.directoryPath,
        })),
        onSkillRead: (id) => reads.push(id),
      });

      const results = await tool.execute!({
        commands: ["cat /skills/quarterly-close/SKILL.md"],
      });
      expect(results[0]?.outcome).toEqual({ type: "exit", exitCode: 0 });
      // Reachability is the CONTENT arriving, not merely a zero exit code.
      expect(results[0]?.stdout).toContain("Follow the [posting guide]");
      expect(reads).toEqual([ROUTER_ID]);
    });

    it("the one-hop targets the router names are reachable through the same mount", async () => {
      const tool: LlmShellTool = createLocalSkillShellTool({
        mountedSkills: [
          {
            id: ROUTER_ID,
            name: "quarterly-close",
            slug: "quarterly-close",
            description: "router",
            sourcePath: BUNDLE.members[0]!.sourcePath,
            directoryPath: BUNDLE.members[0]!.directoryPath,
          },
        ],
      });
      // Read every reference the router names — a router whose targets are
      // unreachable delivers instructions that route nowhere.
      for (const ref of extractOneHopReferences(ROUTER_BODY)) {
        const rel = ref.replace(/^\.\//, "");
        const results = await tool.execute!({
          commands: [`cat /skills/quarterly-close/${rel}`],
        });
        expect(results[0]?.outcome).toEqual({ type: "exit", exitCode: 0 });
        expect(results[0]?.stdout.length).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // 2. Tool-read reachability — Anthropic
  // =========================================================================
  describe("tool-read reachability :: Anthropic (container)", () => {
    it("emits ONE container tool carrying BOTH halves of every reference", async () => {
      syncMapForBundle();
      const result = await selectSkillDeliveryAdapter("anthropic").deliver({
        skillIds: [...BUNDLE_IDS],
      });

      expect(result.tools).toHaveLength(1);
      const container = result.tools[0] as LlmContainerSkillsTool;
      expect(container.type).toBe("container_skills");
      // Live check C9: an unresolvable reference is rejected at the API
      // boundary, so a half-populated reference is an unreachable skill.
      for (const entry of container.skills) {
        expect(typeof entry.skillId).toBe("string");
        expect(entry.skillId.length).toBeGreaterThan(0);
        expect(typeof entry.version).toBe("string");
        expect(entry.version.length).toBeGreaterThan(0);
      }
      expect(container.skills.map((s) => s.catalogSkillId)).toEqual([...BUNDLE_IDS]);
      expect(container.skills.map((s) => s.skillId)).toEqual(
        BUNDLE.members.map((m) => m.anthropic.skillId),
      );
      expect(container.skills.map((s) => s.version)).toEqual(
        BUNDLE.members.map((m) => m.anthropic.version),
      );
    });

    it("names the delivered skills in the system context and never offers read_skill", async () => {
      syncMapForBundle();
      const result = await selectSkillDeliveryAdapter("anthropic").deliver({
        skillIds: [...BUNDLE_IDS],
      });
      for (const id of BUNDLE_IDS) expect(result.systemContext).toContain(id);
      // `read_skill` does not exist on this route; advertising it would send the
      // model after a tool that is not there.
      expect(result.systemContext).not.toContain("read_skill");
    });

    it("an unsynced member of the SAME bundle fails loud, never a function-tool fallback", async () => {
      // Only the router is synced; the helper is not.
      setAnthropicSkillSyncMap({
        resolve: async (id: string) =>
          id === ROUTER_ID
            ? {
                skillId: BUNDLE.members[0]!.anthropic.skillId,
                version: BUNDLE.members[0]!.anthropic.version,
                catalogSkillId: ROUTER_ID,
              }
            : null,
      });
      const error = await selectSkillDeliveryAdapter("anthropic")
        .deliver({ skillIds: [...BUNDLE_IDS] })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(AnthropicSkillNotSyncedError);
      // It NAMES the offending skill — an operator has to know which one.
      expect(String((error as Error).message)).toContain(HELPER_ID);
      expect(String((error as Error).message)).not.toContain(ROUTER_ID);
    });
  });

  // =========================================================================
  // 3. Core one-hop expansion — Gemini
  // =========================================================================
  describe("core one-hop expansion :: Gemini (inline)", () => {
    it("extracts every one-hop target the router names, in all three shapes", () => {
      const refs = extractOneHopReferences(ROUTER_BODY);
      expect(refs).toEqual([
        "references/posting-guide.md", // markdown link
        "references/rates.md", // back-ticked path
        "references/escalation.md", // bare mention
      ]);
    });

    it("core inlines the router AND its one-hop references into the system context", () => {
      const plan = planInlineExpansion({
        units: [
          {
            skillId: ROUTER_ID,
            rank: "declared_dependency",
            body: ROUTER_BODY,
            references: [
              { path: "references/posting-guide.md", content: POSTING_GUIDE },
              { path: "references/rates.md", content: RATES },
              { path: "references/escalation.md", content: ESCALATION },
            ],
          },
          { skillId: HELPER_ID, rank: "recommendation", body: HELPER_BODY },
        ],
        budgetBytes: 200_000,
      });

      expect(plan.includedSkillIds).toEqual([ROUTER_ID, HELPER_ID]);
      expect(plan.dropped).toEqual([]);
      // The expansion is ONE hop: the router body plus each named reference.
      expect(plan.systemContext).toContain(ROUTER_BODY);
      expect(plan.systemContext).toContain(POSTING_GUIDE);
      expect(plan.systemContext).toContain(RATES);
      expect(plan.systemContext).toContain(ESCALATION);
      expect(plan.systemContext).toContain(HELPER_BODY);
      // The reported byte count is what was actually emitted.
      expect(plan.totalBytes).toBe(new TextEncoder().encode(plan.systemContext).length);
    });

    it("the Gemini adapter delivers the SAME bundle inline, with no tools", async () => {
      const result = await selectSkillDeliveryAdapter("gemini").deliver({
        skillIds: [...BUNDLE_IDS],
      });
      expect(result.tools).toEqual([]);
      expect(result.systemContext).toContain(ROUTER_BODY);
      expect(result.systemContext).toContain(HELPER_BODY);
    });
  });

  // =========================================================================
  // 4. Over-budget fixture — WHOLE-skill drops
  // =========================================================================
  describe("over-budget fixture :: whole-skill drops", () => {
    /** The router unit, with a reference padded to `padBytes`. */
    function routerUnit(padBytes: number): InlineExpansionUnit {
      return {
        skillId: ROUTER_ID,
        rank: "declared_dependency",
        body: ROUTER_BODY,
        references: [{ path: "references/rates.md", content: "x".repeat(padBytes) }],
      };
    }

    it("drops the WHOLE skill — router and every reference together — never a partial", () => {
      const plan = planInlineExpansion({
        units: [routerUnit(5_000), { skillId: HELPER_ID, rank: "recommendation", body: HELPER_BODY }],
        // Room for the helper but not for the padded router.
        budgetBytes: 1_000,
      });

      expect(plan.includedSkillIds).toEqual([HELPER_ID]);
      expect(plan.dropped).toEqual([
        { skillId: ROUTER_ID, rank: "declared_dependency", reason: "inline_budget_exhausted" },
      ]);
      // The dropped skill contributed NOTHING — not the router, not a reference,
      // not a truncated fragment of either.
      expect(plan.systemContext).not.toContain("Follow the [posting guide]");
      expect(plan.systemContext).not.toContain("x".repeat(100));
      expect(plan.systemContext).toContain(HELPER_BODY);
    });

    it("a reference larger than the whole budget drops its skill rather than shipping a dead router", () => {
      const plan = planInlineExpansion({
        units: [{ ...routerUnit(10), oversized: true }],
        budgetBytes: 200_000,
      });
      expect(plan.includedSkillIds).toEqual([]);
      expect(plan.dropped).toEqual([
        { skillId: ROUTER_ID, rank: "declared_dependency", reason: "inline_budget_exhausted" },
      ]);
      expect(plan.systemContext).toBe("");
    });

    it("the emitted fragment never exceeds the budget it was given", () => {
      const budgetBytes = 900;
      const plan = planInlineExpansion({
        units: [
          routerUnit(400),
          { skillId: HELPER_ID, rank: "recommendation", body: HELPER_BODY },
          { skillId: DELTA_ID, rank: "personal_delta", body: DELTA_BODY },
        ],
        budgetBytes,
      });
      expect(plan.totalBytes).toBeLessThanOrEqual(budgetBytes);
    });

    it("an unresolvable body is dropped with its OWN reason, distinct from budget overflow", () => {
      const plan = planInlineExpansion({
        units: [
          { skillId: ROUTER_ID, rank: "declared_dependency", body: null },
          { skillId: HELPER_ID, rank: "recommendation", body: HELPER_BODY },
        ],
        budgetBytes: 200_000,
      });
      expect(plan.dropped).toEqual([
        { skillId: ROUTER_ID, rank: "declared_dependency", reason: "inline_body_unresolvable" },
      ]);
      expect(plan.includedSkillIds).toEqual([HELPER_ID]);
    });
  });

  // =========================================================================
  // 5. Exposure ledger
  // =========================================================================
  describe("exposure ledger correctness", () => {
    it("each route reports exposure for exactly what it delivered, tagged with its mechanism", async () => {
      syncMapForBundle();

      const openai = await selectSkillDeliveryAdapter("openai").deliver({
        skillIds: [...BUNDLE_IDS],
      });
      const gemini = await selectSkillDeliveryAdapter("gemini").deliver({
        skillIds: [...BUNDLE_IDS],
      });
      const anthropic = await selectSkillDeliveryAdapter("anthropic").deliver({
        skillIds: [...BUNDLE_IDS],
      });

      // Same bundle in ⇒ same skill ids exposed out, on all three routes.
      for (const result of [openai, gemini, anthropic]) {
        expect(result.exposure.map((e) => e.skillId)).toEqual([...BUNDLE_IDS]);
      }
      expect(openai.exposure.map((e) => e.deliveryMode)).toEqual([
        "openai_shell",
        "openai_shell",
      ]);
      expect(gemini.exposure.map((e) => e.deliveryMode)).toEqual([
        "gemini_inline",
        "gemini_inline",
      ]);
      expect(anthropic.exposure.map((e) => e.deliveryMode)).toEqual([
        "anthropic_container",
        "anthropic_container",
      ]);
      // Only the shell mount yields an attributable per-skill invocation.
      expect(openai.exposure.every((e) => e.invocationAttributable)).toBe(true);
      expect(gemini.exposure.every((e) => !e.invocationAttributable)).toBe(true);
      expect(anthropic.exposure.every((e) => !e.invocationAttributable)).toBe(true);
    });

    it("a skill that could not be delivered is NOT reported as exposed", async () => {
      // The helper has no on-disk sourcePath ⇒ it cannot be mounted ⇒ the
      // ledger must not claim the model saw it.
      installedGetMock.mockImplementation((id: string) =>
        Promise.resolve(
          id === HELPER_ID
            ? { id, name: "variance-helper", slug: "variance-helper", description: "no path" }
            : installedRecordFor(id),
        ),
      );
      const result = await selectSkillDeliveryAdapter("openai").deliver({
        skillIds: [...BUNDLE_IDS],
      });
      expect(result.exposure.map((e) => e.skillId)).toEqual([ROUTER_ID]);
    });

    it("drops are RECORDED and excluded from exposure on the Anthropic general path", async () => {
      // 9 resolvable skills — one over the ceiling — on the selectable
      // (non-creation) path, which ranks and truncates rather than failing.
      const many = Array.from({ length: 9 }, (_, i) => `@cinatra/bulk:s${i}`);
      setAnthropicSkillSyncMap({
        resolve: async (id: string) => ({
          skillId: `skill_${id.split(":")[1]}`,
          version: "v1",
          catalogSkillId: id,
        }),
      });
      installedGetMock.mockImplementation((id: string) =>
        Promise.resolve({ id, name: id, slug: id, description: `desc ${id}` }),
      );

      const result = await selectSkillDeliveryAdapter("anthropic").deliver({
        skillIds: many,
        selectionMode: "general",
      });

      const container = result.tools[0] as LlmContainerSkillsTool;
      expect(container.skills).toHaveLength(INJECTED_SKILL_CAP);
      // The drop is named, not silent.
      expect(result.droppedSkillIds).toEqual([many[8]]);
      expect(result.selectionReason).toContain("Dropped");
      // Exposure covers the DELIVERED set only — a dropped skill was never seen.
      expect(result.exposure).toHaveLength(INJECTED_SKILL_CAP);
      expect(result.exposure.map((e) => e.skillId)).not.toContain(many[8]);
      // And the dropped skill is absent from the system context too, so the
      // model is never told about a skill it does not have.
      expect(result.systemContext).not.toContain(many[8]);
    });

    it("the personal delta COUNTS toward the one cap that decides what a model sees", () => {
      // The cap is 8 TOTAL including the delta — the delta is not a bonus slot.
      expect(INJECTED_SKILL_CAP).toBe(8);
      const units: InlineExpansionUnit[] = [
        { skillId: DELTA_ID, rank: "personal_delta", body: DELTA_BODY },
        ...Array.from({ length: 8 }, (_, i) => ({
          skillId: `@cinatra/bulk:s${i}`,
          rank: "recommendation" as const,
          body: `body ${i}`,
        })),
      ];
      // 9 units offered, and the delta is one of the 9 — not a ninth alongside 8.
      expect(units).toHaveLength(INJECTED_SKILL_CAP + 1);
      expect(units.filter((u) => u.rank === "personal_delta")).toHaveLength(1);

      // Delivered first, and inlined with the rest under one budget.
      const plan = planInlineExpansion({ units, budgetBytes: 200_000 });
      expect(plan.includedSkillIds[0]).toBe(DELTA_ID);
      expect(plan.includedSkillIds).toContain(DELTA_ID);
    });
  });

  // =========================================================================
  // 6. The cross-cutting assertion this suite exists for
  // =========================================================================
  describe("one bundle, three routes — the cross-cutting invariant", () => {
    it("delivers the SAME member set through every mechanism, with a per-route artifact", async () => {
      syncMapForBundle();

      const routes = [
        { provider: "openai" as const, mechanism: "tool-mount" as const },
        { provider: "gemini" as const, mechanism: "inline" as const },
        { provider: "anthropic" as const, mechanism: "container" as const },
      ];

      const delivered: Record<string, string[]> = {};
      for (const route of routes) {
        expect(resolveSkillDeliveryMechanism(route.provider)).toBe(route.mechanism);
        const result = await selectSkillDeliveryAdapter(route.provider).deliver({
          skillIds: [...BUNDLE_IDS],
        });
        delivered[route.provider] = result.exposure.map((e) => e.skillId);

        // Each mechanism must produce ITS artifact and not another's.
        if (route.mechanism === "tool-mount") {
          expect(result.tools.some((t) => (t as { type: string }).type === "shell")).toBe(true);
          expect(result.systemContext).toBe("");
        } else if (route.mechanism === "inline") {
          expect(result.tools).toEqual([]);
          expect(result.systemContext.length).toBeGreaterThan(0);
        } else {
          expect(
            result.tools.some((t) => (t as { type: string }).type === "container_skills"),
          ).toBe(true);
        }
      }

      // The property no single-mechanism suite can state: one authored bundle,
      // identical membership on all three routes. A skill reachable on one route
      // and silently missing on another fails here.
      expect(delivered.openai).toEqual([...BUNDLE_IDS]);
      expect(delivered.gemini).toEqual(delivered.openai);
      expect(delivered.anthropic).toEqual(delivered.openai);
    });

    it("no route delivers more members than the single cap allows", async () => {
      syncMapForBundle();
      for (const provider of ["openai", "gemini", "anthropic"] as const) {
        const result = await selectSkillDeliveryAdapter(provider).deliver({
          skillIds: [...BUNDLE_IDS],
        });
        expect(result.exposure.length).toBeLessThanOrEqual(INJECTED_SKILL_CAP);
      }
    });
  });
});
