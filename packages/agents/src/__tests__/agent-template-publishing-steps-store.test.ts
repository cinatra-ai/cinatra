/**
 * cinatra#4150 — `agent_templates.publishing_steps` through the store layer.
 *
 *   - createLocalAgentTemplateVersion (the shared creation path for ZIP imports
 *     and registry installs) threads an explicit field list into
 *     createAgentTemplate, so a seed field missing from that list would be
 *     dropped silently. The seed's publishingSteps must reach the row input.
 *   - serializeTemplate writes the list as JSON-as-text (like gated_steps);
 *     deserializeTemplate reads it back, passes null (unknown) through, and
 *     THROWS on a stored value that is not a list of node ids instead of reading
 *     it as "publishes nothing".
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-template-publishing-steps-store.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({
  db: {},
  agentBuilderPool: { on: () => {}, listenerCount: () => 1, end: vi.fn() },
}));

const createTemplate = vi.fn(async (..._a: unknown[]) => ({ id: "tmpl-1" }));
vi.mock("../store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store")>();
  return {
    ...actual,
    createAgentTemplate: (...a: unknown[]) => createTemplate(...(a as [])),
    createAgentVersion: vi.fn(async () => {}),
    readAgentTemplateById: vi.fn(async () => null),
  };
});
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({ user: { id: "u" } })),
}));
vi.mock("@/lib/authz", () => ({ logAuditEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/authz/actor-context", () => ({ POLICY_VERSION: "test" }));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: vi.fn(async () => ({})),
}));
vi.mock("../publish-template", () => ({
  publishAgentTemplateAndBindVersion: vi.fn(async () => {}),
}));

import { createLocalAgentTemplateVersion } from "../import-export-actions";
import { serializeTemplate, deserializeTemplate } from "../store-template-versions";
import { _runAgentTemplateUpdate } from "../store";
import type { CreateAgentTemplateInput } from "../store";

const rowInput = () => createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cinatra#4150 — createLocalAgentTemplateVersion carries publishingSteps onto the row", () => {
  it("the seed's list reaches createAgentTemplate (never dropped in the field list)", async () => {
    await createLocalAgentTemplateVersion({
      seed: { packageName: "@cinatra-ai/publish-fixture-agent", packageVersion: "1.0.0", publishingSteps: ["publish"] },
    });
    expect(rowInput().publishingSteps).toEqual(["publish"]);
  });

  it("a seed with no list lands null (unknown), never undefined-and-forgotten", async () => {
    await createLocalAgentTemplateVersion({
      seed: { packageName: "@cinatra-ai/publish-fixture-agent", packageVersion: "1.0.0" },
    });
    expect(rowInput().publishingSteps).toBeNull();
  });
});

function input(publishingSteps: string[] | null | undefined): CreateAgentTemplateInput {
  return {
    id: "tmpl-1",
    name: "Publish fixture",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { type: "object", properties: {} },
    approvalPolicy: { steps: [] },
    packageName: "@cinatra-ai/publish-fixture-agent",
    ...(publishingSteps === undefined ? {} : { publishingSteps }),
  };
}

type Row = Parameters<typeof deserializeTemplate>[0];
const asRow = (values: Record<string, unknown>): Row =>
  ({ createdAt: new Date(0), updatedAt: new Date(0), ...values }) as unknown as Row;

describe("cinatra#4150 — the column round-trips through serializeTemplate / deserializeTemplate", () => {
  it("writes the list as JSON-as-text and reads the same list back", () => {
    const values = serializeTemplate(input(["publish", "second"]));
    expect(values.publishingSteps).toBe('["publish","second"]');
    expect(deserializeTemplate(asRow(values)).publishingSteps).toEqual(["publish", "second"]);
  });

  it("an empty list stays an empty list (a compile that declares nothing is not unknown)", () => {
    const values = serializeTemplate(input([]));
    expect(deserializeTemplate(asRow(values)).publishingSteps).toEqual([]);
  });

  it("an omitted or null list is stored as NULL and read back as null (unknown)", () => {
    expect(serializeTemplate(input(undefined)).publishingSteps).toBeNull();
    expect(serializeTemplate(input(null)).publishingSteps).toBeNull();
    expect(deserializeTemplate(asRow({ ...serializeTemplate(input(undefined)) })).publishingSteps).toBeNull();
  });

  for (const [label, stored] of [
    ["a JSON object", "{}"],
    ["a list holding a number", "[1]"],
    ["a bare string", '"publish"'],
    ["text that is not JSON", "publish"],
    ["the JSON null", "null"],
  ] as const) {
    it(`a stored value that is ${label} throws instead of reading as "publishes nothing"`, () => {
      const values = { ...serializeTemplate(input(undefined)), publishingSteps: stored };
      expect(() => deserializeTemplate(asRow(values))).toThrow();
    });
  }

  it("the error names the column only, never the stored text or the parser's message", () => {
    for (const stored of ["sk-live-SECRET-0123 is not json", '{"token":"sk-live-SECRET-0123"}']) {
      const values = { ...serializeTemplate(input(undefined)), publishingSteps: stored };
      expect(() => deserializeTemplate(asRow(values))).toThrow(/^agent_templates\.publishing_steps is not a JSON list of node ids$/);
      try {
        deserializeTemplate(asRow(values));
      } catch (error) {
        expect(String((error as Error).message)).not.toContain("SECRET");
      }
    }
  });
});

describe("cinatra#4150 — the update patch re-projects the column", () => {
  async function setOf(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    let set: Record<string, unknown> = {};
    const exec = {
      update: () => ({
        set: (u: Record<string, unknown>) => {
          set = u;
          return { where: () => ({ returning: async () => [] }) };
        },
      }),
    };
    await _runAgentTemplateUpdate(exec as never, "tmpl-1", patch as never, undefined);
    return set;
  }

  it("a list is written as JSON-as-text", async () => {
    expect((await setOf({ publishingSteps: ["publish"] })).publishingSteps).toBe('["publish"]');
  });

  it("an empty list stays an empty list", async () => {
    expect((await setOf({ publishingSteps: [] })).publishingSteps).toBe("[]");
  });

  it("null clears the column", async () => {
    const set = await setOf({ publishingSteps: null });
    expect(set).toHaveProperty("publishingSteps");
    expect(set.publishingSteps).toBeNull();
  });

  it("an omitted field leaves the column untouched", async () => {
    expect(await setOf({ name: "renamed" })).not.toHaveProperty("publishingSteps");
  });
});
