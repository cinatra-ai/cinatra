/**
 * actor.principalId must flow through the production files that otherwise
 * risk defaulting to LOCAL_USER_ID. Every reference to LOCAL_USER_ID outside
 * an explicit BETTER_AUTH_DEV_BYPASS branch is a violation.
 *
 * Strategy: block-scope static analysis strips BETTER_AUTH_DEV_BYPASS blocks,
 * comments, and the kept re-export at personal-skills.ts:16, then
 * any remaining `LOCAL_USER_ID` identifier is a violation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const TARGET_FILES = [
  "packages/skills/src/personal-skills.ts",
  "packages/skills/src/actions.ts",
  "packages/skills/src/plugin-pages.tsx",
  "packages/skills/src/mcp/handlers.ts",
  "src/lib/blog/application/use-cases.ts",
];

/**
 * Strip:
 *  1. Line comments (`// …`)
 *  2. Block comments (`/* … *\/`)
 *  3. Any `if (…BETTER_AUTH_DEV_BYPASS…) { … }` block (multi-line, brace-balanced)
 *  4. The kept re-export `export { LOCAL_USER_ID … };`
 */
function stripGuardedSections(source: string): string {
  // Block comments
  let s = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Line comments
  s = s.replace(/\/\/[^\n]*/g, "");
  // Re-export of the constant (acceptable barrel)
  s = s.replace(/export\s*\{\s*LOCAL_USER_ID[^}]*\}\s*;?/g, "");
  // BETTER_AUTH_DEV_BYPASS guarded blocks (brace-balanced)
  s = stripBalancedIfBlocks(s, /if\s*\([^)]*BETTER_AUTH_DEV_BYPASS[^)]*\)\s*\{/g);
  return s;
}

function stripBalancedIfBlocks(source: string, opener: RegExp): string {
  let out = source;
  let m: RegExpExecArray | null;
  // Iteratively strip; opener is global — start at lastIndex = 0 each pass.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    opener.lastIndex = 0;
    m = opener.exec(out);
    if (!m) break;
    const start = m.index;
    let i = m.index + m[0].length; // points just inside `{`
    let depth = 1;
    while (i < out.length && depth > 0) {
      const ch = out[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    out = out.slice(0, start) + out.slice(i);
  }
  return out;
}

describe("actor.principalId threading", () => {
  it.each(TARGET_FILES)(
    "%s contains no LOCAL_USER_ID references outside BETTER_AUTH_DEV_BYPASS / comments / re-export",
    (rel) => {
      const abs = path.join(REPO_ROOT, rel);
      const raw = fs.readFileSync(abs, "utf-8");
      const stripped = stripGuardedSections(raw);
      const matches = stripped.match(/\bLOCAL_USER_ID\b/g) ?? [];
      expect(matches).toEqual([]);
    },
  );

  it("personalSkillSaveAction (or its replacement) passes actor.principalId — not LOCAL_USER_ID — to upsertCustomSkill", async () => {
    // Hoisted mocks
    const { upsertCustomSkillMock, getActorMock } = vi.hoisted(() => ({
      upsertCustomSkillMock: vi.fn(async (..._args: [Record<string, unknown>]) => ({ id: "x" })),
      getActorMock: vi.fn(async () => ({
        principalId: "real-user-123",
        principalType: "HumanUser" as const,
      })),
    }));
    vi.doMock("server-only", () => ({}));
    vi.doMock("../skills-store", () => ({
      upsertCustomSkill: upsertCustomSkillMock,
      getCustomSkillForAgent: vi.fn(async () => null),
      listCustomSkills: vi.fn(async () => []),
      listCustomSkillsForAgent: vi.fn(async () => []),
    }));
    vi.doMock("@/lib/auth-session", () => ({
      getActorContext: getActorMock,
      requireActorContext: getActorMock,
    }));

    // The action accepts actor context from the authenticated session.
    const mod = await import("../actions");
    type SaveFn = (input: Record<string, unknown>) => Promise<unknown>;
    const action: SaveFn | undefined =
      (mod as Record<string, unknown>).personalSkillSaveAction as SaveFn | undefined;
    expect(typeof action).toBe("function");
    if (!action) return;

    await action({
      agentId: "a1",
      name: "n",
      description: "d",
      content: "c",
    });

    const call = upsertCustomSkillMock.mock.calls[0]?.[0] as
      | { ownerUserId?: string }
      | undefined;
    expect(call?.ownerUserId).toBe("real-user-123");
  });

  it("MCP zod schema for custom-skill handlers makes ownerUserId optional", async () => {
    const handlers = await import("../mcp/handlers");
    // Handlers expose a Zod schema or an array of schemas for custom skill inputs.
    const candidates = Object.entries(handlers as Record<string, unknown>).filter(
      ([k]) => /Schema$/i.test(k) && /custom|skill/i.test(k),
    );
    expect(candidates.length).toBeGreaterThan(0);
    const schemas = candidates
      .map(([, v]) => v)
      .filter((v): v is { parse: (x: unknown) => unknown } =>
        typeof (v as { parse?: unknown })?.parse === "function",
      );
    expect(schemas.length).toBeGreaterThan(0);

    // Empty input must succeed and ownerUserId comes back undefined (no LOCAL_USER_ID default).
    const parsed = schemas[0].parse({}) as { ownerUserId?: unknown };
    expect(parsed.ownerUserId).toBeUndefined();

    // Override still accepted.
    const parsed2 = schemas[0].parse({ ownerUserId: "x" }) as { ownerUserId?: unknown };
    expect(parsed2.ownerUserId).toBe("x");
  });
});
