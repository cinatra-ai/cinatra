/**
 * THE PINNED PACK'S OWN STORED-IDEAS CALL REACHES THE HOST'S PREPARE ROAD
 * (cinatra#3035, epic #3023 W11).
 *
 * The envelope reading beside this file (extension-scoped-tools-stored-ideas-
 * envelope.test.ts) holds both call shapes open against a made-up pack, because
 * the host may not know a pack. This file does the other half: it takes the
 * call the PINNED pack actually declares — read out of the installed
 * declaration on disk, never re-typed here — and puts it through the same
 * dispatch, so the version this repository pins and the road that serves it are
 * pinned to each other. A pin advance that changed the call's shape, or a road
 * change that stopped reading it, fails here rather than on a run.
 *
 * The version is asserted from the pinned checkout's own manifest: this file
 * pins the call AT 0.2.2, and says so, so the reading cannot silently be taken
 * as proof about some other version of the pack.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getAgentPackage = vi.fn();
const prepareStoredIdeas = vi.fn();
const reserveStoredIdea = vi.fn();
const completeIdeaRelation = vi.fn();
const releaseIdeaReservation = vi.fn();
const extensionArtifactsList = vi.fn();

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
  probeInstalledOasPathForRead: (packageName: string) => ({
    path: packageName === PACKAGE_NAME ? OAS_PATH : null,
  }),
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

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const PACKAGE_NAME = "@cinatra-ai/blog-pipeline-agent";
/** The pinned checkout the dev-extensions lock materializes for this package. */
const PACK_ROOT = join(REPO_ROOT, "extensions", "cinatra-ai", "blog-pipeline-agent");
const OAS_PATH = join(PACK_ROOT, "cinatra", "oas.json");
/** The version whose call this file pins. */
const PINNED_VERSION = "0.2.2";
/** The declaration node that makes the pack's first call — its stored-ideas step. */
const PREPARE_NODE_ID = "prepare_ideas";

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, "utf8")) as Json;
}

/** The keys a declaration carries its NODES under — the same two the host's own
 *  admission walks (DECLARATION_NODE_CONTAINERS in src/lib/extension-scoped-tools.ts).
 *  Traversal follows ONLY these, never a node's request data, its metadata or a
 *  schema example: an ApiNode-SHAPED object sitting inside a payload declares
 *  nothing, and reading one here would pin the host to a call the pack never
 *  makes. The host learned this in its own convergence round; the reading beside
 *  it must not re-open the hole.
 */
const DECLARATION_NODE_CONTAINERS = ["nodes", "$referenced_components"] as const;

/** EVERY node the declaration runs under this id, out of its node containers at
 *  any depth. All of them, not the first: a declaration that ran two nodes under
 *  one id would make the reading below ambiguous, and the caller asserts there is
 *  exactly one. */
function findDeclaredNodes(doc: unknown, id: string): Json[] {
  const found: Json[] = [];
  const seen = new Set<unknown>();
  const walkContainer = (container: unknown, depth: number): void => {
    if (depth > 40 || container === null || typeof container !== "object") return;
    if (seen.has(container)) return;
    seen.add(container);
    const entries = Array.isArray(container) ? container : Object.values(container as Json);
    for (const entry of entries) {
      if (Array.isArray(entry)) {
        walkContainer(entry, depth + 1);
        continue;
      }
      if (entry === null || typeof entry !== "object" || seen.has(entry)) continue;
      seen.add(entry);
      const node = entry as Json;
      if (node.id === id) found.push(node);
      for (const key of DECLARATION_NODE_CONTAINERS) {
        walkContainer(node[key], depth + 1);
      }
    }
  };
  for (const key of DECLARATION_NODE_CONTAINERS) {
    walkContainer((doc as Json)[key], 0);
  }
  return found;
}

const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  templateId: "tmpl-1",
  packageVersion: PINNED_VERSION,
};

/** The prepare road, reached: the runner's own decision is mocked, and the port
 *  it reads the organisation's ideas through is exercised once, so the type the
 *  road resolved is observable on the listing itself. */
function prepareReadsTheIdeaListing(): void {
  prepareStoredIdeas.mockImplementation(
    async ({ ports }: { ports: { listIdeaArtifacts: () => Promise<unknown> } }) => {
      await ports.listIdeaArtifacts();
      return { ok: true, ideas: [] };
    },
  );
}

describe("the pinned blog pipeline's own stored-ideas call reaches the prepare road", () => {
  beforeEach(() => {
    query.mockReset();
    getAgentPackage.mockReset();
    prepareStoredIdeas.mockReset();
    reserveStoredIdea.mockReset();
    completeIdeaRelation.mockReset();
    releaseIdeaReservation.mockReset();
    extensionArtifactsList.mockReset();
    query.mockResolvedValue({
      rows: [{ package_name: PACKAGE_NAME, package_version: PINNED_VERSION }],
    });
    getAgentPackage.mockResolvedValue({ manifest: { cinatra: {} } });
    extensionArtifactsList.mockResolvedValue({ artifacts: [], nextCursor: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("reads only the declaration's own node containers, never a payload lookalike", () => {
    // The hole the host closed in its own admission: an ApiNode-SHAPED object
    // carried inside a node's request data declares nothing, and a reading that
    // picked it would pin this repository to a call the pack never makes.
    const doctored = {
      nodes: [
        {
          id: "some_other_node",
          component_type: "ApiNode",
          url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
          data: {
            tool: "extension_tool",
            example: {
              id: PREPARE_NODE_ID,
              component_type: "ApiNode",
              url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
              data: { tool: "extension_tool", input: { name: "not_the_real_call" } },
            },
          },
        },
      ],
    };
    expect(findDeclaredNodes(doctored, PREPARE_NODE_ID)).toEqual([]);
    // and the real declaration still yields exactly its one node
    expect(findDeclaredNodes(readJson(OAS_PATH), PREPARE_NODE_ID)).toHaveLength(1);
  });

  it("pins the version the reading below is about", () => {
    expect(readJson(join(PACK_ROOT, "package.json")).version).toBe(PINNED_VERSION);
  });

  it("reaches the prepare road with the idea type the pinned declaration names", async () => {
    const nodes = findDeclaredNodes(readJson(OAS_PATH), PREPARE_NODE_ID);
    expect(
      nodes.length,
      `${PREPARE_NODE_ID} is declared exactly once at ${PINNED_VERSION}`,
    ).toBe(1);
    const node = nodes[0];
    // The node the host would admit: its own passthrough api node, not a lookalike.
    expect(node.component_type).toBe("ApiNode");
    expect(String(node.url)).toContain("/api/agents/passthrough");
    const data = node.data as Json;
    const declaredType = (((data.input as Json).input as Json).ideaType) as string;
    expect(declaredType).toMatch(/^@[^:]+:[^:]+$/);

    prepareReadsTheIdeaListing();
    const { dispatchExtensionScopedTool } = await import("@/lib/extension-scoped-tools");
    const outcome = await dispatchExtensionScopedTool({
      tool: data.tool as string,
      input: data.input as Json,
      run: RUN,
    });

    expect(outcome).toEqual({ ok: true, result: { ok: true, ideas: [] } });
    expect(prepareStoredIdeas).toHaveBeenCalledTimes(1);
    expect(extensionArtifactsList).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ types: [declaredType] }),
    );
  });
});
