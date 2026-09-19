/**
 * THE STORED-IDEAS CALL ARRIVES IN EITHER SHAPE (cinatra#3035, epic #3023 W11).
 *
 * A pack reaches its own passthrough tool two ways. The flat way puts the
 * call's fields straight on the request body's `input`. The enveloped way names
 * the pack's own tool inside that body — `{ tool, input: { name, input } }` —
 * and carries the call's fields one level down, under the inner `input`. The
 * gate's road read the OUTER object either way, so an enveloped call reached it
 * with no `op` and no `ideaType` at all and was refused before it began.
 *
 * These cases hold BOTH readings open: the enveloped call reaches the prepare
 * road with its idea type read from the inner input, the flat call still does,
 * and a call that carries the type in neither is refused with the same typed
 * refusal — naming the tool the ENVELOPE names, never the outer name the body
 * was posted under.
 *
 * The pack below is a made-up one under a made-up vendor: the host may not know
 * a pack, and the reading has to hold for any pack at all.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getAgentPackage = vi.fn();
const prepareStoredIdeas = vi.fn();
const reserveStoredIdea = vi.fn();
const completeIdeaRelation = vi.fn();
const releaseIdeaReservation = vi.fn();
const extensionArtifactsList = vi.fn();

/** The fixture declaration's path, read by the admission through the mock below. */
let oasPath: string | null = null;

vi.mock("@/lib/db/pooled", () => ({
  getPooledDb: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://unused",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: (...a: unknown[]) => getAgentPackage(...a),
}));
vi.mock("@/lib/verdaccio-config", () => ({ loadVerdaccioConfigForReads: async () => ({}) }));
vi.mock("@cinatra-ai/agents/installed-oas-path", () => ({
  probeInstalledOasPathForRead: () => ({ path: oasPath }),
}));
vi.mock("@/lib/stored-ideas-gate-runner", () => ({
  prepareStoredIdeas: (...a: unknown[]) => prepareStoredIdeas(...a),
  reserveStoredIdea: (...a: unknown[]) => reserveStoredIdea(...a),
  completeIdeaRelation: (...a: unknown[]) => completeIdeaRelation(...a),
  releaseIdeaReservation: (...a: unknown[]) => releaseIdeaReservation(...a),
}));
vi.mock("@/lib/artifacts/extension-artifact-reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/extension-artifact-reads")>()),
  extensionArtifactsList: (...a: unknown[]) => extensionArtifactsList(...a),
}));

const FIXTURE_PACK = "@acme/example-pipeline";
const FIXTURE_IDEA_TYPE = "@acme/example-idea-artifact:example-idea";
/** The name the pack gives its OWN tool — the one an envelope carries. */
const PACK_TOOL = "example_ideas";
/** The name the body is posted under when the call is enveloped. */
const ENVELOPE_TOOL = "extension_tool";

const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: null,
};

/** A declaration that calls the passthrough both ways, so the admission admits
 *  either body and the reading below is the only thing under test. */
const FIXTURE_OAS = {
  component_type: "Flow",
  id: "example_flow",
  nodes: {
    prepare_enveloped: {
      component_type: "ApiNode",
      id: "prepare_enveloped",
      url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
      http_method: "POST",
      data: {
        tool: ENVELOPE_TOOL,
        input: { name: PACK_TOOL, input: { op: "prepare", ideaType: FIXTURE_IDEA_TYPE } },
      },
    },
    prepare_flat: {
      component_type: "ApiNode",
      id: "prepare_flat",
      url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
      http_method: "POST",
      data: { tool: PACK_TOOL, input: { op: "prepare", ideaType: FIXTURE_IDEA_TYPE } },
    },
  },
};

const roots: string[] = [];

function writeFixtureOas(doc: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), "stored-ideas-envelope-"));
  roots.push(root);
  const dir = path.join(root, "acme", "example-pipeline", "cinatra");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "oas.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

/** The prepare road, reached: the runner's own decision is mocked, and the port
 *  it would read the organisation's ideas through is exercised once, so the type
 *  the road resolved is observable on the listing itself. */
function prepareReadsTheIdeaListing(): void {
  prepareStoredIdeas.mockImplementation(
    async ({ ports }: { ports: { listIdeaArtifacts: () => Promise<unknown> } }) => {
      await ports.listIdeaArtifacts();
      return { ok: true, ideas: [] };
    },
  );
}

describe("the stored-ideas road reads the flat call and the enveloped one", () => {
  beforeEach(() => {
    query.mockReset();
    getAgentPackage.mockReset();
    prepareStoredIdeas.mockReset();
    reserveStoredIdea.mockReset();
    completeIdeaRelation.mockReset();
    releaseIdeaReservation.mockReset();
    extensionArtifactsList.mockReset();
    query.mockResolvedValue({
      rows: [{ package_name: FIXTURE_PACK, package_version: "0.2.1" }],
    });
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: {} } });
    extensionArtifactsList.mockResolvedValue({ artifacts: [], nextCursor: null });
    oasPath = writeFixtureOas(FIXTURE_OAS);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    oasPath = null;
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("reaches the prepare road from the envelope, with the idea type read from the inner input", async () => {
    prepareReadsTheIdeaListing();
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: ENVELOPE_TOOL,
      input: { name: PACK_TOOL, input: { op: "prepare", ideaType: FIXTURE_IDEA_TYPE } },
      run: RUN,
    });
    expect(outcome).toEqual({ ok: true, result: { ok: true, ideas: [] } });
    expect(prepareStoredIdeas).toHaveBeenCalledTimes(1);
    expect(extensionArtifactsList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ types: [FIXTURE_IDEA_TYPE] }),
    );
  });

  it("still reaches the prepare road from the flat call", async () => {
    prepareReadsTheIdeaListing();
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: PACK_TOOL,
      input: { op: "prepare", ideaType: FIXTURE_IDEA_TYPE },
      run: RUN,
    });
    expect(outcome).toEqual({ ok: true, result: { ok: true, ideas: [] } });
    expect(prepareStoredIdeas).toHaveBeenCalledTimes(1);
    expect(extensionArtifactsList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ types: [FIXTURE_IDEA_TYPE] }),
    );
  });

  it("refuses an enveloped call that names no idea type, naming the tool the envelope names", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: ENVELOPE_TOOL,
      input: { name: PACK_TOOL, input: { op: "prepare" } },
      run: RUN,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toMatch(new RegExp(`^${PACK_TOOL}: \`ideaType\` is required`));
    expect(outcome.error).not.toContain(ENVELOPE_TOOL);
    expect(prepareStoredIdeas).not.toHaveBeenCalled();
  });

  it("still refuses a flat call that names no idea type, naming the tool it was given", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: PACK_TOOL,
      input: { op: "prepare" },
      run: RUN,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toMatch(new RegExp(`^${PACK_TOOL}: \`ideaType\` is required`));
    expect(prepareStoredIdeas).not.toHaveBeenCalled();
  });

  it("reads the operation from the inner input too, and names the envelope's tool when it is none of them", async () => {
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: ENVELOPE_TOOL,
      input: {
        name: PACK_TOOL,
        input: { op: "sideways", ideaType: FIXTURE_IDEA_TYPE },
      },
      run: RUN,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
    expect(outcome.error).toMatch(new RegExp(`^${PACK_TOOL}: \`op\` must be one of`));
    expect(outcome.error).not.toContain(ENVELOPE_TOOL);
  });
});
