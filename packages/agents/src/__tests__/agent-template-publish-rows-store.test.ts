/**
 * cinatra#4150 — `agent_templates.publish_rows` through the store layer and
 * its writers.
 *
 *   - createLocalAgentTemplateVersion threads an explicit field list into
 *     createAgentTemplate; the seed's publishRows must reach the row input. Its
 *     module is "use server", so a client can call it: it accepts only the rows
 *     the compiler itself produced (the same object), and refuses any map a
 *     caller wrote, valid-looking or not, before anything is written.
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
import { collectPublishRows, type PublishRows } from "../oas-compiler";
import { serializeTemplate, deserializeTemplate } from "../store-template-versions";
import { _runAgentTemplateUpdate } from "../store";
import type { CreateAgentTemplateInput } from "../store";

const ROWS = { publish: [{ label: "Post", input: "content" }, { label: "Where", input: "destination" }] };
const rowInput = () => createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
const field = (o: object) => (o as Record<string, unknown>).publishRows;

beforeEach(() => {
  vi.clearAllMocks();
});

// The rows exactly as the compiler produces them for a declared publishing node.
function compiledRows() {
  const node = {
    component_type: "ApiNode",
    id: "publish",
    inputs: [{ title: "content" }, { title: "destination" }],
    metadata: { cinatra: { publishes: true, publishRows: ROWS.publish } },
  };
  const res = collectPublishRows({ nodes: [{ $component_ref: "publish" }], $referenced_components: { publish: node } }, ["publish"]);
  if (!res.ok) throw new Error(res.error);
  return res.rows;
}
const seedWith = (publishRows: unknown) =>
  ({ packageName: "@cinatra-ai/publish-fixture-agent", packageVersion: "1.0.0", publishRows }) as never;

describe("cinatra#4150 — createLocalAgentTemplateVersion carries publishRows onto the row", () => {
  it("the rows the compiler produced reach createAgentTemplate", async () => {
    const rows = compiledRows();
    await createLocalAgentTemplateVersion({ seed: seedWith(rows) });
    expect(rowInput().publishRows).toEqual(ROWS);
  });

  it("a seed with no rows lands null (unknown), never undefined-and-forgotten", async () => {
    await createLocalAgentTemplateVersion({
      seed: { packageName: "@cinatra-ai/publish-fixture-agent", packageVersion: "1.0.0" },
    });
    expect(rowInput()).toHaveProperty("publishRows", null);
  });

  it("a seed with publishRows null lands null", async () => {
    await createLocalAgentTemplateVersion({ seed: seedWith(null) });
    expect(rowInput()).toHaveProperty("publishRows", null);
  });
});

describe("cinatra#4150 — a client call cannot write rows the compiler did not produce", () => {
  for (const [label, rows] of [
    ["a valid-looking map a caller wrote", ROWS],
    ["an invalid map (a two-line label, an input the node does not have)", { publish: [{ label: "Bad\nLabel", input: "not-owned" }] }],
    ["an empty map a caller wrote", {}],
    ["a copy of the compiler's rows", JSON.parse(JSON.stringify(compiledRows()))],
    ["a list", []],
    ["a string", "publish"],
  ] as const) {
    it(`${label} is refused and nothing is written`, async () => {
      await expect(createLocalAgentTemplateVersion({ seed: seedWith(rows) })).rejects.toThrow(
        /^publishRows must be the compiler's own output$/,
      );
      expect(createTemplate).not.toHaveBeenCalled();
    });
  }
});

// A map no compile produced: a two-line label over an input the node does not have.
const FORGED = { publish: [{ label: "Bad\nLabel", input: "not-owned" }] };
const writtenRows = () => createTemplate.mock.calls.map((call) => field(call[0] as object));

describe("cinatra#4150 — the create reads publishRows once and writes only the value it checked", () => {
  it("an own getter that gives null to the check and a forged map later writes no forged map", async () => {
    let reads = 0;
    const seed = {
      packageName: "@cinatra-ai/publish-fixture-agent",
      packageVersion: "1.0.0",
      get publishRows() {
        reads += 1;
        return reads === 1 ? null : FORGED;
      },
    };
    await createLocalAgentTemplateVersion({ seed: seed as never }).catch(() => undefined);
    expect(writtenRows()).not.toContainEqual(FORGED);
    expect(writtenRows().every((rows) => rows === null)).toBe(true);
  });

  it("an inherited getter that gives the compiler's map to the checks and a forged map later writes the checked rows", async () => {
    const compiled = compiledRows();
    let reads = 0;
    const proto = {
      get publishRows() {
        reads += 1;
        return reads <= 2 ? compiled : FORGED;
      },
    };
    const seed = Object.assign(Object.create(proto) as object, {
      packageName: "@cinatra-ai/publish-fixture-agent",
      packageVersion: "1.0.0",
    });
    await createLocalAgentTemplateVersion({ seed: seed as never }).catch(() => undefined);
    expect(writtenRows()).not.toContainEqual(FORGED);
    expect(writtenRows()).toEqual([ROWS]);
  });
});

describe("cinatra#4150 — the compiler's map cannot be changed after it is returned", () => {
  it("the map, each rows list and each row are frozen", () => {
    const rows = compiledRows();
    expect(Object.isFrozen(rows)).toBe(true);
    for (const list of Object.values(rows)) {
      expect(Object.isFrozen(list)).toBe(true);
      for (const row of list) expect(Object.isFrozen(row)).toBe(true);
    }
  });

  for (const [label, change] of [
    // The compiler's own (readonly) map type: each change below is one the type already refuses, made anyway to prove the
    // run-time freeze (Object.assign onto a row is not a type error, so it carries no directive).
    ["a row's label and input are changed", (r: PublishRows) => Object.assign(r.publish![0]!, FORGED.publish[0])],
    ["a row is added to the list", (r: PublishRows) =>
      // @ts-expect-error a compiled rows list is readonly
      r.publish!.push(FORGED.publish[0]!)],
    ["the node's list is replaced", (r: PublishRows) =>
      // @ts-expect-error a compiled map is readonly
      (r.publish = FORGED.publish)],
    ["a node is added", (r: PublishRows) =>
      // @ts-expect-error a compiled map is readonly
      (r.other = FORGED.publish)],
  ] as const) {
    it(`${label}: the change throws and the write carries the compiled rows`, async () => {
      const rows = compiledRows();
      expect(() => change(rows)).toThrow(TypeError);
      await createLocalAgentTemplateVersion({ seed: seedWith(rows) });
      expect(writtenRows()).toEqual([ROWS]);
    });
  }

  it("the write carries a copy taken at the check, not the caller's object", async () => {
    const rows = compiledRows();
    await createLocalAgentTemplateVersion({ seed: seedWith(rows) });
    expect(rowInput().publishRows).toEqual(ROWS);
    expect(rowInput().publishRows).not.toBe(rows);
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

  // cinatra#4150 W4: the list row the compiler writes reads back; any other kind or a malformed list row throws.
  it("a stored list row reads back beside a text row", () => {
    const rows = {
      publish: [
        { label: "Post", input: "content" },
        { kind: "list", label: "Recipients", input: "recipients", columns: [{ label: "Name", field: "name" }] },
      ],
    };
    const values = { ...serializeTemplate(input(undefined)), publishRows: JSON.stringify(rows) };
    expect(field(deserializeTemplate(asRow(values)))).toEqual(rows);
  });

  // C1b: the artifacts row the compiler writes reads back (red at C1's head 2ea9dbd1, whose reader throws on it).
  it("a stored artifacts row reads back beside a text row", () => {
    const rows = {
      publish: [
        { label: "Post", input: "content" },
        { kind: "artifacts", label: "Proposed page", input: "targets" },
      ],
    };
    const values = { ...serializeTemplate(input(undefined)), publishRows: JSON.stringify(rows) };
    expect(field(deserializeTemplate(asRow(values)))).toEqual(rows);
  });

  for (const [label, row] of [
    ["an artifacts row with columns", { kind: "artifacts", label: "Page", input: "targets", columns: [{ label: "N", field: "n" }] }],
    ["an artifacts row with an empty label", { kind: "artifacts", label: "", input: "targets" }],
    ["an artifacts row whose label has a line break", { kind: "artifacts", label: "Pa\nge", input: "targets" }],
    ["a row of an unknown kind", { kind: "table", label: "Page", input: "targets" }],
    ["a list row with no columns", { kind: "list", label: "R", input: "r", columns: [] }],
    ["a list row with five columns", { kind: "list", label: "R", input: "r", columns: ["a", "b", "c", "d", "e"].map((f) => ({ label: f, field: f })) }],
    ["a list row whose column has an extra key", { kind: "list", label: "R", input: "r", columns: [{ label: "N", field: "n", w: 1 }] }],
    ["a list row whose field is not a string", { kind: "list", label: "R", input: "r", columns: [{ label: "N", field: 1 }] }],
    ["a text row that carries a kind", { kind: "text", label: "Post", input: "content" }],
  ] as const) {
    it(`a stored ${label} throws, naming the column only`, () => {
      // Red first at the base: a list row is a valid row only from W4 on, so the base throws on the valid list row above
      // and this pins that each listed shape keeps throwing.
      const valid = { kind: "list", label: "Recipients", input: "recipients", columns: [{ label: "Name", field: "name" }] };
      const ok = { ...serializeTemplate(input(undefined)), publishRows: JSON.stringify({ publish: [valid] }) };
      expect(() => deserializeTemplate(asRow(ok))).not.toThrow();
      const values = { ...serializeTemplate(input(undefined)), publishRows: JSON.stringify({ publish: [row] }) };
      expect(() => deserializeTemplate(asRow(values))).toThrow(/^agent_templates\.publish_rows is not a JSON map of node ids to rows$/);
    });
  }

  // pre-2 findings 2 and 3: the stored reader holds the compiler's caps and rules, so a stored value cannot widen the card.
  // Each case is accepted at base 46f770fe (red there).
  const TEXT = (n: number) => ({ label: `Row ${n}`, input: `in${n}` });
  const LISTROW = (over: Record<string, unknown> = {}) => ({
    kind: "list",
    label: "Recipients",
    input: "people",
    columns: [{ label: "Name", field: "name" }],
    ...over,
  });
  const reads = (rows: unknown) =>
    deserializeTemplate(asRow({ ...serializeTemplate(input(undefined)), publishRows: JSON.stringify({ publish: rows }) }));

  it("four stored rows read; zero or five stored rows throw", () => {
    const four = [TEXT(1), TEXT(2), TEXT(3), LISTROW()];
    expect(field(reads(four))).toEqual({ publish: four });
    expect(() => reads([...four, TEXT(5)])).toThrow(/^agent_templates\.publish_rows is not a JSON map of node ids to rows$/);
    expect(() => reads([])).toThrow(/^agent_templates\.publish_rows is not a JSON map of node ids to rows$/);
  });

  it("two stored rows over the same input throw", () => {
    expect(() => reads([TEXT(1), { label: "Again", input: "in1" }])).toThrow(/^agent_templates\.publish_rows is not/);
    expect(() => reads([TEXT(1), LISTROW({ input: "in1" })])).toThrow(/^agent_templates\.publish_rows is not/);
  });

  for (const [label, row] of [
    ["an empty list label", LISTROW({ label: "" })],
    ["a list label with a line break", LISTROW({ label: "Re\ncipients" })],
    ["a list label over 60 characters", LISTROW({ label: "x".repeat(61) })],
    ["a list label with a leading space", LISTROW({ label: " Recipients" })],
    ["an empty column label", LISTROW({ columns: [{ label: "", field: "name" }] })],
    ["an empty field", LISTROW({ columns: [{ label: "Name", field: "" }] })],
    ["a field with a trailing space", LISTROW({ columns: [{ label: "Name", field: "name " }] })],
    ["a field over 64 characters", LISTROW({ columns: [{ label: "Name", field: "f".repeat(65) }] })],
    ["a field with a control character", LISTROW({ columns: [{ label: "Name", field: "na\u0000me" }] })],
    ["a repeated field", LISTROW({ columns: [{ label: "Name", field: "name" }, { label: "Again", field: "name" }] })],
  ] as const) {
    it(`a stored list row with ${label} throws, as the compiler refuses it`, () => {
      expect(() => reads([row])).toThrow(/^agent_templates\.publish_rows is not a JSON map of node ids to rows$/);
    });
  }

  it("the error never quotes the stored text", () => {
    const values = { ...serializeTemplate(input(undefined)), publishRows: '{"publish":"sk-live-SECRET-0123"}' };
    let caught: unknown = null;
    try {
      deserializeTemplate(asRow(values));
    } catch (error) {
      caught = error;
    }
    expect(caught, "a malformed stored value must throw").toBeInstanceOf(Error);
    expect(String((caught as Error).message)).not.toContain("SECRET");
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
