/**
 * Unit tests for child-run OBO ceiling composition (epic W5) at the persist-at-
 * dispatch seam `deriveRunOboCeilingJson` (packages/agents/src/agent-run-serde.ts).
 *
 * Contract under test:
 *   - The child's OWN anchor is ALWAYS freshly derived from the locked template
 *     owner (never copied). When the caller supplies `parentOboCeiling` (a
 *     genuine child dispatch), the parent chain is folded in on top via the
 *     shared `composeOboCeilingChain` primitive (satisfy-all).
 *   - No `parentOboCeiling` (top-level run OR recurring-trigger clone) → the
 *     un-composed child anchor is persisted. This is the clone-copy-trap guard:
 *     a clone re-derives its own chain and never carries the parent/source chain.
 *   - A provably-disjoint composition (same-axis id conflict or cross-org) THROWS
 *     OboCeilingCompositionError BEFORE any insert → the dispatch fails closed.
 *   - A corrupt child anchor still returns null (W1 contract: persist SQL NULL,
 *     fail closed at mint) — NOT escalated to a throw even under a child dispatch.
 *
 * Strategy: mock the package-local `../db` so the Drizzle template lookup
 * (`db.select(...).from(agentTemplates).where(...).limit(1)`) returns a canned
 * owner row; drive `deriveRunOboCeilingJson` directly (imported from
 * `../agent-run-serde`, avoiding the `@cinatra-ai/agents` barrel side-effects).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OboCeilingCompositionError,
  type OboCeilingChain,
} from "@cinatra-ai/mcp-server/obo-ceiling";

const ORG = "org-1";

// ---------------------------------------------------------------------------
// Hoisted mock state: the canned template owner row the lookup resolves to.
// ---------------------------------------------------------------------------
const queryState = vi.hoisted(() => ({
  rows: [] as Array<{ ownerLevel: string | null; ownerId: string | null }>,
}));

const mockDb = vi.hoisted(() => {
  // The Drizzle template lookup ignores its args in this mock; JS drops the
  // extra call arguments, so zero-arg thunks keep the chain lint-clean.
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(queryState.rows);
  return chain;
});

vi.mock("../db", () => ({
  db: mockDb,
  agentBuilderPool: {} as unknown,
}));

// Import AFTER vi.mock so the db mock is installed first.
import { deriveRunOboCeilingJson } from "../agent-run-serde";

function parse(json: string | null): OboCeilingChain | null {
  return json ? (JSON.parse(json) as OboCeilingChain) : null;
}

beforeEach(() => {
  queryState.rows = [];
});

describe("deriveRunOboCeilingJson — child-run composition (W5)", () => {
  it("NO parent chain (top-level / recurring clone) → un-composed child anchor (copy-trap guard)", async () => {
    queryState.rows = [{ ownerLevel: "team", ownerId: "t1" }];
    const json = await deriveRunOboCeilingJson({
      templateId: "tmpl-child",
      orgId: ORG,
      projectId: null,
    });
    expect(parse(json)).toEqual([
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
    ]);
  });

  it("recurring-clone regression: an explicit undefined/null parent does NOT inherit a parent chain", async () => {
    queryState.rows = [{ ownerLevel: "user", ownerId: "u1" }];
    const json = await deriveRunOboCeilingJson({
      templateId: "tmpl-child",
      orgId: ORG,
      projectId: null,
      parentOboCeiling: null,
    });
    // Only the freshly derived child anchor — never a stale/source chain.
    expect(parse(json)).toEqual([
      { tier: "user", id: "u1" },
      { tier: "organization", id: ORG },
    ]);
  });

  it("child dispatch: parent chain folded onto the freshly derived child anchor (incomparable axes carried)", async () => {
    // Child is team-anchored; parent run's chain carries a project ceiling.
    queryState.rows = [{ ownerLevel: "team", ownerId: "t1" }];
    const parent: OboCeilingChain = [
      { tier: "project", id: "parent-pj" },
      { tier: "organization", id: ORG },
    ];
    const json = await deriveRunOboCeilingJson({
      templateId: "tmpl-child",
      orgId: ORG,
      projectId: null,
      parentOboCeiling: parent,
    });
    const chain = parse(json)!;
    // child anchor (team t1 + org) UNION parent (project parent-pj + org), deduped.
    expect(chain).toEqual(
      expect.arrayContaining([
        { tier: "team", id: "t1" },
        { tier: "organization", id: ORG },
        { tier: "project", id: "parent-pj" },
      ]),
    );
    expect(chain).toHaveLength(3);
  });

  it("child dispatch: SAME-axis disjoint (child team t2, parent team t1) → THROWS, no run", async () => {
    queryState.rows = [{ ownerLevel: "team", ownerId: "t2" }];
    const parent: OboCeilingChain = [
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
    ];
    await expect(
      deriveRunOboCeilingJson({
        templateId: "tmpl-child",
        orgId: ORG,
        projectId: null,
        parentOboCeiling: parent,
      }),
    ).rejects.toBeInstanceOf(OboCeilingCompositionError);
  });

  it("child dispatch: CROSS-ORG (child org-B, parent org-A) → THROWS cross_org", async () => {
    // Child is org-anchored at org-B; run org is org-B.
    queryState.rows = [{ ownerLevel: "organization", ownerId: "org-B" }];
    const parent: OboCeilingChain = [{ tier: "organization", id: "org-A" }];
    await expect(
      deriveRunOboCeilingJson({
        templateId: "tmpl-child",
        orgId: "org-B",
        projectId: null,
        parentOboCeiling: parent,
      }),
    ).rejects.toMatchObject({ code: "AGENT_OBO_CEILING_DISJOINT" });
  });

  it("corrupt child anchor + parent chain → null (fail-closed at mint), NOT a throw", async () => {
    // Non-org owner tier with a missing id = corrupt partial anchor (W1).
    queryState.rows = [{ ownerLevel: "user", ownerId: null }];
    const parent: OboCeilingChain = [
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
    ];
    const json = await deriveRunOboCeilingJson({
      templateId: "tmpl-child",
      orgId: ORG,
      projectId: null,
      parentOboCeiling: parent,
    });
    expect(json).toBeNull();
  });

  it("child dispatch: MIXED owner tiers with NO verified containment (child user u1, parent team t1) → THROWS, no run", async () => {
    // The mixed-axis gap (#1884 C4): a user-anchored child under a team-anchored
    // parent has no single-owner-row satisfiable chain absent a verified relation.
    queryState.rows = [{ ownerLevel: "user", ownerId: "u1" }];
    const parent: OboCeilingChain = [
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
    ];
    await expect(
      deriveRunOboCeilingJson({
        templateId: "tmpl-child",
        orgId: ORG,
        projectId: null,
        parentOboCeiling: parent,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_OBO_CEILING_DISJOINT",
      denial: { reason: "unverified_owner_containment" },
    });
  });

  it("child dispatch: MIXED owner tiers WITH a verified containment fact → satisfiable collapsed chain persisted", async () => {
    // The acceptance case: given the dispatch-verified membership fact (u1 ∈ t1),
    // the owner axis collapses to the narrower user tier and a satisfiable chain
    // (user u1 + org) is persisted — the previously-denied composition now writes.
    queryState.rows = [{ ownerLevel: "user", ownerId: "u1" }];
    const parent: OboCeilingChain = [
      { tier: "team", id: "t1" },
      { tier: "organization", id: ORG },
    ];
    const json = await deriveRunOboCeilingJson({
      templateId: "tmpl-child",
      orgId: ORG,
      projectId: null,
      parentOboCeiling: parent,
      ownerContainments: [
        { narrower: { tier: "user", id: "u1" }, wider: { tier: "team", id: "t1" } },
      ],
    });
    const chain = parse(json)!;
    expect(chain).toEqual(
      expect.arrayContaining([
        { tier: "user", id: "u1" },
        { tier: "organization", id: ORG },
      ]),
    );
    expect(chain).toHaveLength(2);
    expect(chain.some((c) => c.tier === "team")).toBe(false);
  });

  it("child dispatch with an explicit project launch composes project + parent chain", async () => {
    queryState.rows = [{ ownerLevel: "user", ownerId: "u1" }];
    const parent: OboCeilingChain = [
      { tier: "user", id: "u1" },
      { tier: "organization", id: ORG },
    ];
    const json = await deriveRunOboCeilingJson({
      templateId: "tmpl-child",
      orgId: ORG,
      projectId: "pl",
      parentOboCeiling: parent,
    });
    const chain = parse(json)!;
    // child (user u1 + org + project pl) UNION parent (user u1 + org) → deduped.
    expect(chain).toEqual(
      expect.arrayContaining([
        { tier: "user", id: "u1" },
        { tier: "organization", id: ORG },
        { tier: "project", id: "pl" },
      ]),
    );
    expect(chain).toHaveLength(3);
  });
});
