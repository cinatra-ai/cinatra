/**
 * cinatra#4150 — `agent_templates.publish_rows` through the store layer and
 * its writers.
 *
 *   - createLocalAgentTemplateVersion threads an explicit field list into
 *     createAgentTemplate; the seed's publishRows must reach the row input.
 *   - serializeTemplate writes the map as JSON-as-text; deserializeTemplate
 *     reads it back, passes null (unknown) through, and THROWS on a stored
 *     value that is not { [nodeId]: [{ label, input }] }, naming the column only.
 *   - the update patch re-projects the column, and every template writer that
 *     writes publishingSteps writes publishRows as often (a pin over the named
 *     writer files).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-template-publish-rows-store.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

vi.mock("../db", () => ({
  db: {},
  agentBuilderPool: { on: () => {}, listenerCount: () => 1, end: vi.fn() },
}));

const createTemplate = vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({ id: "tmpl-1" }));
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

const ROWS = { publish: [{ label: "Post", input: "content" }, { label: "Where", input: "destination" }] };
const rowInput = () => createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
const field = (o: object) => (o as Record<string, unknown>).publishRows;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cinatra#4150 — createLocalAgentTemplateVersion carries publishRows onto the row", () => {
  it("the seed's rows reach createAgentTemplate", async () => {
    await createLocalAgentTemplateVersion({
      seed: { packageName: "@cinatra-ai/publish-fixture-agent", packageVersion: "1.0.0", publishRows: ROWS } as never,
    });
    expect(rowInput().publishRows).toEqual(ROWS);
  });

  it("a seed with no rows lands null (unknown), never undefined-and-forgotten", async () => {
    await createLocalAgentTemplateVersion({
      seed: { packageName: "@cinatra-ai/publish-fixture-agent", packageVersion: "1.0.0" },
    });
    expect(rowInput()).toHaveProperty("publishRows", null);
  });
});

function input(publishRows: unknown): CreateAgentTemplateInput {
  return {
    id: "tmpl-1",
    name: "Publish fixture",
    sourceNl: "",
    compiledPlan: [],
    inputSchema: { type: "object", properties: {} },
    approvalPolicy: { steps: [] },
    packageName: "@cinatra-ai/publish-fixture-agent",
    ...(publishRows === undefined ? {} : { publishRows }),
  } as CreateAgentTemplateInput;
}

type Row = Parameters<typeof deserializeTemplate>[0];
const asRow = (values: Record<string, unknown>): Row =>
  ({ createdAt: new Date(0), updatedAt: new Date(0), ...values }) as unknown as Row;

describe("cinatra#4150 — the column round-trips through serializeTemplate / deserializeTemplate", () => {
  it("writes the map as JSON-as-text and reads the same map back", () => {
    const values = serializeTemplate(input(ROWS));
    expect(field(values)).toBe(JSON.stringify(ROWS));
    expect(field(deserializeTemplate(asRow(values)))).toEqual(ROWS);
  });

  it("an empty map stays an empty map (a compile that declares no rows is not unknown)", () => {
    expect(field(deserializeTemplate(asRow(serializeTemplate(input({})))))).toEqual({});
  });

  it("an omitted or null map is stored as NULL and read back as null (unknown)", () => {
    expect(field(serializeTemplate(input(undefined)))).toBeNull();
    expect(field(serializeTemplate(input(null)))).toBeNull();
    expect(field(deserializeTemplate(asRow(serializeTemplate(input(undefined)))))).toBeNull();
  });

  for (const [label, stored] of [
    ["a JSON list", "[]"],
    ["a map to a non-list", '{"publish":{"label":"Post","input":"content"}}'],
    ["a row with an extra key", '{"publish":[{"label":"Post","input":"content","value":"x"}]}'],
    ["a row whose label is not a string", '{"publish":[{"label":1,"input":"content"}]}'],
    ["text that is not JSON", "publish"],
    ["the JSON null", "null"],
  ] as const) {
    it(`a stored value that is ${label} throws, naming the column only`, () => {
      const values = { ...serializeTemplate(input(undefined)), publishRows: stored };
      expect(() => deserializeTemplate(asRow(values))).toThrow(/^agent_templates\.publish_rows is not a JSON map of node ids to rows$/);
    });
  }

  it("the error never quotes the stored text", () => {
    const values = { ...serializeTemplate(input(undefined)), publishRows: '{"publish":"sk-live-SECRET-0123"}' };
    try {
      deserializeTemplate(asRow(values));
      throw new Error("expected a throw");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("SECRET");
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

  it("a map is written as JSON-as-text, an empty map stays empty, null clears", async () => {
    expect((await setOf({ publishRows: ROWS })).publishRows).toBe(JSON.stringify(ROWS));
    expect((await setOf({ publishRows: {} })).publishRows).toBe("{}");
    const cleared = await setOf({ publishRows: null });
    expect(cleared).toHaveProperty("publishRows", null);
  });

  it("an omitted field leaves the column untouched", async () => {
    expect(await setOf({ name: "renamed" })).not.toHaveProperty("publishRows");
  });
});

// The writers, by name: each writes publishRows: exactly as often as it writes
// publishingSteps: (object-literal properties; type annotations and comment
// lines are not counted).
const PACKAGE_SRC = fileURLToPath(new URL("../", import.meta.url));
const WRITERS = [
  "build-agent-template-seed.ts",
  "import-agent-core.ts",
  "import-export-actions.ts",
  "install-from-package.ts",
  "seed-bundled-agent-template.ts",
  "store-template-versions.ts",
];

function count(file: string, re: RegExp): number {
  return readFileSync(join(PACKAGE_SRC, file), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) && re.test(line);
    }).length;
}

describe("cinatra#4150 — every template writer writes publishRows beside publishingSteps", () => {
  for (const file of WRITERS) {
    it(file, () => {
      const steps = count(file, /\bpublishingSteps:(?!\s*(?:boolean|string)\b)/);
      expect(steps).toBeGreaterThan(0);
      expect(count(file, /\bpublishRows:(?!\s*(?:PublishRows|Record)\b)/)).toBe(steps);
    });
  }

  it("the store's update patch re-projects publishRows beside publishingSteps", () => {
    const store = readFileSync(join(PACKAGE_SRC, "store.ts"), "utf8");
    expect(store).toMatch(/updates\.publishingSteps\s*=/);
    expect(store).toMatch(/updates\.publishRows\s*=/);
  });
});
