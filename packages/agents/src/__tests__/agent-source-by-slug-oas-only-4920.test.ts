/**
 * cinatra#4920 (direct readers): a by-slug read of an agent definition takes
 * `cinatra/oas.json` only, from the first directory that holds ANY definition
 * file (operator vendor, then first-party, then the legacy directory). A
 * directory with only `agent.json` or only `cinatra/agent.json` fails with one
 * plain error naming the directory, the file found and the path the definition
 * must be at. With both files in a directory, `cinatra/oas.json` is processed
 * and the old file is ignored. Every handler is checked for POSITIVE proof:
 * it succeeded (or reached its named downstream call) with the canonical file's
 * own content or path.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-source-by-slug-oas-only-4920.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { resolveDevExtensionSourceRoot } from "../agent-runtime-mount";

// ---------------------------------------------------------------------------
// vi.hoisted refs.
// ---------------------------------------------------------------------------

const {
  readLog,
  mockPublishAgentPackageFromGitDir,
  mockPublishAgentPackage,
  mockCompileOasAgentJson,
  mockSyncCompiledTemplateToDb,
  mockReadAgentTemplateById,
  mockCreateZipBuffer,
  identity,
} = vi.hoisted(() => ({
  // Every path read through node:fs/promises readFile, in order.
  readLog: [] as string[],
  mockPublishAgentPackageFromGitDir: vi.fn(),
  mockPublishAgentPackage: vi.fn(),
  mockCompileOasAgentJson: vi.fn(),
  mockSyncCompiledTemplateToDb: vi.fn(async () => undefined),
  mockReadAgentTemplateById: vi.fn(),
  mockCreateZipBuffer: vi.fn(),
  // The operator's vendor directory; null = identity unset (first-party only).
  identity: { vendor: null as string | null, failure: null as Error | null },
}));

// Observe which definition file a handler really opens: record each readFile path.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((...args: Parameters<typeof actual.readFile>) => {
    readLog.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: mockPublishAgentPackage,
  publishAgentPackageFromGitDir: mockPublishAgentPackageFromGitDir,
}));

// The on-disk path resolvers' vendor-segment derivation reads the instance
// identity; the real store would reach @/lib/database. `identity.vendor` null =
// "identity unset", so the resolvers use the first-party "cinatra-ai" vendor
// segment only.
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => {
    // A failing identity store (the database is down) throws, as the real one does.
    if (identity.failure) throw identity.failure;
    return identity.vendor ? { vendorName: identity.vendor } : null;
  }),
  markFirstPublishedIfCurrentScope: vi.fn(),
}));

// Publish-path dependencies (the same set the publish handler tests use).
vi.mock("@cinatra-ai/extensions/license-detection", () => ({
  detectSpdxLicense: vi.fn(async () => ({ tier: "permissive", spdxId: "MIT", reason: null })),
  LicenseDetectionRejectedError: class extends Error { code = "LICENSE_DETECTION_REJECTED"; },
  LicenseAcknowledgementRequiredError: class extends Error {
    code = "LICENSE_ACKNOWLEDGEMENT_REQUIRED";
  },
}));
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolvePublishDestination: vi.fn(async () => ({
    registryUrl: "http://127.0.0.1:4873",
    token: "ci-test-token",
    packageScope: "@cinatra",
    destinationId: "local",
  })),
  PublishDestinationNotConfiguredError: class extends Error {},
  InstanceNamespaceNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/dev-extensions", () => ({ readEffectivePublishScopeOverride: vi.fn(() => null) }));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(async () => ({
    registryUrl: "http://127.0.0.1:4873",
    token: "ci-test-token",
    packageScope: "@cinatra",
  })),
}));
vi.mock("../install-from-package", () => ({
  installAgentFromPackage: vi.fn(async () => undefined),
  syncCompiledTemplateToDb: mockSyncCompiledTemplateToDb,
}));
vi.mock("../wayflow-reload-client", () => ({
  triggerWayflowReload: vi.fn(async () => ({ ok: false, reason: "no_token" })),
}));
vi.mock("../wayflow-preflight", () => ({ preflightWayflowAgent: vi.fn(async () => ({ ok: true })) }));

// ---------------------------------------------------------------------------
// Mock the rest of the transitive chain (same surface as the handler test).
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s), assertSafePathSegment: (s: unknown, label = "path segment"): void => { const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s); if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s)); }, listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: vi.fn(() => ({})),
}));
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => {
    throw new Error("not used");
  },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(),
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
}));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
// Make resolveDevExtensionSourceRoot return process.cwd() so the handler's
// rung-1 path is <tmpRoot>/cinatra/<slug>/cinatra/oas.json — which is where
// our test fixture writes its file (handler at handlers.ts:1911 joins with
// "cinatra" twice, matching our writeOasFixture path).
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => process.cwd()),
  resolveDevExtensionSourceRoot: vi.fn(() => process.cwd()),
}));
vi.mock("../zip-helpers", () => ({ createZipBuffer: mockCreateZipBuffer }));
vi.mock("../oas-compiler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../oas-compiler")>()),
  compileOasAgentJson: mockCompileOasAgentJson,
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(() => ({})),
}));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn(() => ({ items: [], nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => true), // admin so the publish gate passes
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: vi.fn(async () => undefined),
  can: vi.fn(async () => ({ allowed: true })),
  POLICY_VERSION: "1.0",
  AuthzError: class extends Error {
    statusCode = 403;
    reason = "denied";
  },
}));
vi.mock("../auth-policy", () => ({
  enforceRunAccess: vi.fn(async () => undefined),
  actorContextFromMcpRequest: vi.fn(() => null),
}));
vi.mock("../store", () => ({
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
  updateAgentTemplateOrigin: vi.fn(async () => undefined),
  readAgentTemplateById: mockReadAgentTemplateById,
  readAgentTemplateByPackageName: vi.fn(async () => null),
  readAgentVersionsByTemplate: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: vi.fn(),
  createInProcessPrimitiveTransport: vi.fn(),
  PrimitiveInvocationError: class extends Error {},
}));

// ---------------------------------------------------------------------------
// Module under test
//
// Note: the plan named `createAgentsPrimitiveHandlers()` as the invocation
// surface, but the agent_source_compile / agent_source_publish dispatchers
// actually live on `createAgentBuilderPrimitiveHandlers()` (handlers.ts:2781);
// `createAgentsPrimitiveHandlers()` only exposes `agents_list`. Both are
// public exports — the contract requirement ("factory, not private import")
// is satisfied either way. We use the factory that actually contains the
// handlers being tested.
// ---------------------------------------------------------------------------
import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

const SLUG = "by-slug-oas-only-agent";
const FIRST_PARTY = "cinatra-ai";
const OPERATOR = "acme";

type Canon = { tag: string; marker: string; rel: string; abs: string; dir: string; slug: string };

let tmpRoot: string;
let originalCwd: string;

async function put(rel: string, content: string): Promise<void> {
  const full = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

// A canonical definition whose own content carries `marker` (a tag naming the
// directory it sits in), so a handler's result shows WHICH file it processed.
function oas(marker: string): string {
  return JSON.stringify({
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "oas-only-flow",
    name: "Oas Only",
    description: marker,
    metadata: { cinatra: { type: "node" } },
    inputs: [],
    outputs: [],
    nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
    },
  });
}
// An old-layout file: valid JSON that every handler would visibly mishandle
// (a blocker in review/compile/publish, invalid in validate, shown by read).
const OLD_ONLY = JSON.stringify({ name: "OLD FILE MUST NOT BE READ" });
// An old-layout file beside a canonical one: a well-formed definition carrying
// a marker, so a handler that wrongly read it would show the marker in its own
// result (read, export) while the path log shows the wrong file either way.
const OLD_MARKED = JSON.stringify({ ...JSON.parse(oas("OLD FILE MUST NOT BE READ")) });

/** The canonical definition of `vendor`'s package: written, and described. */
async function putCanonical(vendor: string): Promise<Canon> {
  const marker = `CANONICAL-${vendor}`;
  const rel = `${vendor}/${SLUG}/cinatra/oas.json`;
  await put(rel, oas(marker));
  return { tag: vendor, marker, rel, abs: path.join(process.cwd(), rel), dir: path.join(process.cwd(), vendor, SLUG), slug: SLUG };
}

// A handler result: each handler returns its own shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = any;

function run(name: string, input: Record<string, unknown>): Promise<Result> {
  const handler = createAgentBuilderPrimitiveHandlers()[name];
  return handler({
    primitiveName: name,
    input,
    actor: { actorType: "user", source: "ui", userId: "u-admin", platformRole: "platform_admin" },
    mode: "deterministic",
  }) as Promise<Result>;
}

type Handler = {
  name: string;
  input: Record<string, unknown>;
  /** The error text(s) this handler returns, each in its own shape. */
  texts: (r: Result) => string[];
  /** Positive proof: it processed the canonical file `c`. */
  processed: (r: Result, c: Canon) => void;
};

const SLUG_INPUT = { packageSlug: SLUG };
const HANDLERS: Handler[] = [
  {
    name: "agent_source_read",
    input: SLUG_INPUT,
    texts: (r) => [r.error],
    processed: (r, c) => {
      expect(r.error).toBeUndefined();
      expect(r.path).toBe(c.rel);
      expect(r.content.description).toBe(c.marker);
    },
  },
  {
    name: "agent_source_validate",
    input: SLUG_INPUT,
    texts: (r) => r.errors,
    processed: (r) => expect(r).toEqual({ valid: true, errors: [] }),
  },
  {
    name: "agent_source_review",
    input: SLUG_INPUT,
    texts: (r) => (r.blockers ?? []).map((b: { message: string }) => b.message),
    processed: (r) => {
      expect(r.error).toBeUndefined();
      expect(r.blockers).toEqual([]);
    },
  },
  {
    name: "agent_source_compile",
    input: SLUG_INPUT,
    texts: (r) => [r.error],
    processed: (r, c) => {
      expect(r.error).toBeUndefined();
      expect(r.path).toBe(c.rel);
      // The compiler was handed the canonical file's path, and the row sync
      // names the package of the directory that holds it.
      expect(mockCompileOasAgentJson).toHaveBeenCalledWith(expect.objectContaining({ oasSourcePath: c.abs }));
      expect(mockSyncCompiledTemplateToDb).toHaveBeenCalledWith(`@${c.tag}/${c.slug}`, null, expect.anything(), expect.anything());
    },
  },
  {
    name: "agent_source_publish",
    input: { ...SLUG_INPUT, destination: "private" },
    texts: (r) => [r.error],
    processed: (r, c) => {
      expect(r.error).toBeUndefined();
      expect(r.published).toBe(true);
      // The publisher got the package root of the directory that holds the canonical file.
      expect(mockPublishAgentPackageFromGitDir).toHaveBeenCalledTimes(1);
      expect(mockPublishAgentPackageFromGitDir.mock.calls[0][0]).toMatchObject({ agentDir: c.dir });
    },
  },
  {
    name: "agent_export",
    input: { templateId: "template-1" },
    texts: (r) => [String(r.error).replace(/^Export unavailable: /, "")],
    processed: (r, c) => {
      expect(r.error).toBeUndefined();
      expect(r.fileName).toMatch(/\.zip$/);
      const entries = mockCreateZipBuffer.mock.calls[0][0] as Array<{ name: string; content: string }>;
      const exported = JSON.parse(entries.find((e) => e.name === "cinatra/oas.json")!.content);
      expect(exported.description).toBe(c.marker);
    },
  },
];

const message = (found: string, dir: string, required: string) =>
  `Agent definition is in the old layout: found ${found} in ${dir}, which is no longer read. ` +
  `The definition must be at ${required}; move it there.`;

describe("by-slug source handlers read cinatra/oas.json only (cinatra#4920)", () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "by-slug-oas-only-"));
    originalCwd = process.cwd();
    process.chdir(tmpRoot);
    identity.vendor = null;
    identity.failure = null;
    mockPublishAgentPackageFromGitDir.mockReset();
    mockPublishAgentPackageFromGitDir.mockResolvedValue({
      packageName: `@cinatra/${SLUG}`,
      packageVersion: "0.1.0",
      registryUrl: "http://127.0.0.1:4873",
      published: true,
      alreadyPublished: false,
    });
    mockCompileOasAgentJson.mockReset();
    mockCompileOasAgentJson.mockImplementation(async (opts: { packageName: string }) => ({
      ok: true,
      value: { packageName: opts.packageName, compiledPlan: { steps: [] }, prompt: "compiled prompt", type: "flow" },
      siblingLifecycle: { readable: false },
    }));
    mockSyncCompiledTemplateToDb.mockClear();
    mockCreateZipBuffer.mockReset();
    mockCreateZipBuffer.mockReturnValue(Buffer.from("zip"));
    mockReadAgentTemplateById.mockReset();
    mockReadAgentTemplateById.mockResolvedValue({ id: "template-1", name: "Export Agent", packageName: `@x/${SLUG}` });
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  for (const h of HANDLERS) {
    describe(h.name, () => {
      // The two old layouts the by-slug readers used to fall back to.
      const OLD_LAYOUTS = [
        { name: "cinatra/agent.json beside the vendor directory", file: `${FIRST_PARTY}/${SLUG}/cinatra/agent.json`, dir: `${FIRST_PARTY}/${SLUG}` },
        { name: "cinatra/agent.json in the legacy directory", file: `${SLUG}/cinatra/agent.json`, dir: SLUG },
        { name: "a flat agent.json in the legacy directory", file: `${SLUG}/agent.json`, dir: SLUG },
      ];
      for (const layout of OLD_LAYOUTS) {
        it(`refuses ${layout.name} with the old-layout message`, async () => {
          await put(layout.file, OLD_ONLY);
          const result = await run(h.name, h.input);
          expect(h.texts(result)).toContain(message(layout.file, layout.dir, `${FIRST_PARTY}/${SLUG}/cinatra/oas.json`));
          expect(JSON.stringify(result)).not.toContain("OLD FILE MUST NOT BE READ");
        });
      }

      it("processes cinatra/oas.json and ignores the old files when both are there", async () => {
        const canon = await putCanonical(FIRST_PARTY);
        const oldBeside = `${FIRST_PARTY}/${SLUG}/cinatra/agent.json`;
        await put(oldBeside, OLD_MARKED);
        await put(`${SLUG}/agent.json`, OLD_MARKED);
        readLog.length = 0;
        const result = await run(h.name, h.input);
        h.processed(result, canon);
        expect(JSON.stringify(result)).not.toContain("OLD FILE MUST NOT BE READ");
        // Direct observation: the canonical file was opened, no old file was.
        expect(readLog).toContain(canon.abs);
        expect(readLog.filter((p) => /[\\/]agent\.json$/.test(p))).toEqual([]);
      });

      // Two vendors: the operator's directory is the first candidate, the
      // first-party one the second. The first directory that holds ANY
      // definition file decides, as on main (where the first match wins), with
      // an old-layout match turned into the migration error.
      describe("two vendors", () => {
        beforeEach(() => {
          identity.vendor = OPERATOR;
        });

        it("operator old-layout + first-party canonical: the operator's migration error", async () => {
          await put(`${OPERATOR}/${SLUG}/cinatra/agent.json`, OLD_ONLY);
          await putCanonical(FIRST_PARTY);
          const result = await run(h.name, h.input);
          expect(h.texts(result)).toContain(
            message(`${OPERATOR}/${SLUG}/cinatra/agent.json`, `${OPERATOR}/${SLUG}`, `${OPERATOR}/${SLUG}/cinatra/oas.json`),
          );
          expect(mockPublishAgentPackageFromGitDir).not.toHaveBeenCalled();
          expect(mockCompileOasAgentJson).not.toHaveBeenCalled();
          expect(mockCreateZipBuffer).not.toHaveBeenCalled();
        });

        it("operator canonical + first-party old-layout: the operator's canonical file", async () => {
          const canon = await putCanonical(OPERATOR);
          await put(`${FIRST_PARTY}/${SLUG}/cinatra/agent.json`, OLD_ONLY);
          const result = await run(h.name, h.input);
          h.processed(result, canon);
        });

        it("operator has nothing + first-party canonical: the first-party file", async () => {
          const canon = await putCanonical(FIRST_PARTY);
          const result = await run(h.name, h.input);
          h.processed(result, canon);
        });

        it("operator has nothing + first-party old-layout: the first-party migration error", async () => {
          await put(`${FIRST_PARTY}/${SLUG}/cinatra/agent.json`, OLD_ONLY);
          const result = await run(h.name, h.input);
          expect(h.texts(result)).toContain(
            message(`${FIRST_PARTY}/${SLUG}/cinatra/agent.json`, `${FIRST_PARTY}/${SLUG}`, `${FIRST_PARTY}/${SLUG}/cinatra/oas.json`),
          );
        });
      });
    });
  }

  // The listing walks every agent source directory (cinatra#4920): each one is
  // READ (listed) or REPORTED (a warnings[] message naming the directory, the
  // file found and the exact place the definition must be). Directories are
  // keyed by path, and no directory name is skipped (`cinatra` is a slug). A
  // directory that a by-slug read does not select (another directory holds the
  // same slug and comes first) is `shadowed` by the one it does select. One
  // table, with no excluded shape; the by-slug read of every slug is checked
  // against it: the selected directory's own outcome, its content if READ, its
  // migration error if REPORTED, and nothing at all when no directory is selected
  // (a by-slug read never looks at a root agent.json of a scoped directory, nor
  // at a flat directory that has only cinatra/oas.json; the listing reports both).
  const S = SLUG;
  const V = FIRST_PARTY;
  const OP = OPERATOR;
  type Row = {
    name: string;
    files: string[];
    read: string[];
    reported?: Array<{ dir: string; found: string[]; at: string; also?: string }>;
    /** directory -> the directory a by-slug read selects instead */
    shadowed?: Record<string, string>;
    /** what a by-slug read of each slug selects: a directory, or null for none */
    bySlug: Array<{ slug: string; dir: string | null }>;
  };
  const ROWS: Row[] = [
    { name: "scoped canonical", files: [`${V}/${S}/cinatra/oas.json`], read: [`${V}/${S}`], bySlug: [{ slug: S, dir: `${V}/${S}` }] },
    { name: "scoped old-only, cinatra/agent.json", files: [`${V}/${S}/cinatra/agent.json`], read: [], reported: [{ dir: `${V}/${S}`, found: ["cinatra/agent.json"], at: `${V}/${S}/cinatra/oas.json` }], bySlug: [{ slug: S, dir: `${V}/${S}` }] },
    { name: "scoped old-only, root agent.json", files: [`${V}/${S}/agent.json`], read: [], reported: [{ dir: `${V}/${S}`, found: ["agent.json"], at: `${V}/${S}/cinatra/oas.json` }], bySlug: [{ slug: S, dir: null }] },
    { name: "scoped old-only, both old forms", files: [`${V}/${S}/cinatra/agent.json`, `${V}/${S}/agent.json`], read: [], reported: [{ dir: `${V}/${S}`, found: ["cinatra/agent.json", "agent.json"], at: `${V}/${S}/cinatra/oas.json` }], bySlug: [{ slug: S, dir: `${V}/${S}` }] },
    { name: "scoped both", files: [`${V}/${S}/cinatra/oas.json`, `${V}/${S}/cinatra/agent.json`, `${V}/${S}/agent.json`], read: [`${V}/${S}`], bySlug: [{ slug: S, dir: `${V}/${S}` }] },
    { name: "flat canonical", files: [`${S}/cinatra/oas.json`], read: [], reported: [{ dir: `${S}`, found: ["cinatra/oas.json"], at: `${OP}/${S}/cinatra/oas.json` }], bySlug: [{ slug: S, dir: null }] },
    { name: "flat old-only, cinatra/agent.json", files: [`${S}/cinatra/agent.json`], read: [], reported: [{ dir: `${S}`, found: ["cinatra/agent.json"], at: `${OP}/${S}/cinatra/oas.json` }], bySlug: [{ slug: S, dir: `${S}` }] },
    { name: "flat old-only, root agent.json", files: [`${S}/agent.json`], read: [], reported: [{ dir: `${S}`, found: ["agent.json"], at: `${OP}/${S}/cinatra/oas.json` }], bySlug: [{ slug: S, dir: `${S}` }] },
    { name: "flat both", files: [`${S}/cinatra/oas.json`, `${S}/cinatra/agent.json`, `${S}/agent.json`], read: [], reported: [{ dir: `${S}`, found: ["cinatra/oas.json", "cinatra/agent.json", "agent.json"], at: `${OP}/${S}/cinatra/oas.json` }], bySlug: [{ slug: S, dir: `${S}` }] },
    { name: "slug cinatra, scoped", files: [`${V}/cinatra/cinatra/oas.json`], read: [`${V}/cinatra`], bySlug: [{ slug: "cinatra", dir: `${V}/cinatra` }] },
    { name: "a vendor directory that holds its own definition", files: [`${V}/agent.json`, `${V}/${S}/cinatra/oas.json`], read: [`${V}/${S}`], reported: [{ dir: `${V}`, found: ["agent.json"], at: `${OP}/${V}/cinatra/oas.json` }], bySlug: [{ slug: S, dir: `${V}/${S}` }, { slug: V, dir: `${V}` }] },
    { name: "operator canonical + first-party canonical", files: [`${OP}/${S}/cinatra/oas.json`, `${V}/${S}/cinatra/oas.json`], read: [`${OP}/${S}`, `${V}/${S}`], shadowed: { [`${V}/${S}`]: `${OP}/${S}` }, bySlug: [{ slug: S, dir: `${OP}/${S}` }] },
    { name: "operator old + first-party canonical", files: [`${OP}/${S}/cinatra/agent.json`, `${V}/${S}/cinatra/oas.json`], read: [`${V}/${S}`], reported: [{ dir: `${OP}/${S}`, found: ["cinatra/agent.json"], at: `${OP}/${S}/cinatra/oas.json` }], shadowed: { [`${V}/${S}`]: `${OP}/${S}` }, bySlug: [{ slug: S, dir: `${OP}/${S}` }] },
    { name: "operator canonical + first-party old", files: [`${OP}/${S}/cinatra/oas.json`, `${V}/${S}/cinatra/agent.json`], read: [`${OP}/${S}`], reported: [{ dir: `${V}/${S}`, found: ["cinatra/agent.json"], at: `${V}/${S}/cinatra/oas.json` }], shadowed: { [`${V}/${S}`]: `${OP}/${S}` }, bySlug: [{ slug: S, dir: `${OP}/${S}` }] },
    { name: "flat + scoped, same slug", files: [`${V}/${S}/cinatra/oas.json`, `${S}/agent.json`], read: [`${V}/${S}`], reported: [{ dir: `${S}`, found: ["agent.json"], at: `${OP}/${S}/cinatra/oas.json` }], shadowed: { [`${S}`]: `${V}/${S}` }, bySlug: [{ slug: S, dir: `${V}/${S}` }] },
    { name: "operator, first-party and flat directories with one slug", files: [`${OP}/${S}/cinatra/oas.json`, `${V}/${S}/cinatra/oas.json`, `${S}/cinatra/oas.json`], read: [`${OP}/${S}`, `${V}/${S}`], reported: [{ dir: `${S}`, found: ["cinatra/oas.json"], at: `${OP}/${S}/cinatra/oas.json`, also: "already holds a definition" }], shadowed: { [`${V}/${S}`]: `${OP}/${S}`, [`${S}`]: `${OP}/${S}` }, bySlug: [{ slug: S, dir: `${OP}/${S}` }] },
    { name: "legacy renamed slug", files: [`drupal-content-editor/cinatra/agent.json`], read: [], reported: [{ dir: `drupal-content-editor`, found: ["cinatra/agent.json"], at: `${OP}/drupal-agent/cinatra/oas.json` }], bySlug: [{ slug: "drupal-agent", dir: `drupal-content-editor` }] },
    { name: "a vendor directory the readers do not walk", files: [`other-vendor/${S}/cinatra/oas.json`], read: [], bySlug: [] },
  ];

  for (const row of ROWS) {
    it(`agent_source_list: ${row.name}`, async () => {
      identity.vendor = OPERATOR;
      for (const f of row.files) await put(f, f.endsWith("cinatra/oas.json") ? oas(`LISTED-${f}`) : OLD_ONLY);
      readLog.length = 0;
      const result = await run("agent_source_list", {});

      const canonical = (d: string) => path.join(d, "cinatra", "oas.json");
      const shadowed = row.shadowed ?? {};
      const items = result.items as Array<{ path: string; shadowed: { by: string; note: string } | null }>;
      expect(items.map((i) => i.path).sort()).toEqual(row.read.map(canonical).sort());
      for (const d of row.read) {
        expect(readLog).toContain(path.join(process.cwd(), canonical(d)));
        const item = items.find((i) => i.path === canonical(d))!;
        if (shadowed[d]) {
          expect(item.shadowed?.by).toBe(path.normalize(shadowed[d]));
          expect(item.shadowed?.note).toContain(`a read of slug ${path.basename(d)} `);
        } else {
          expect(item.shadowed).toBeNull();
        }
      }
      expect(readLog.filter((p) => /[\\/]agent\.json$/.test(p))).toEqual([]);

      const reported = row.reported ?? [];
      expect(result.warnings).toHaveLength(reported.length);
      for (const r of reported) {
        const warning = result.warnings.find((w: string) => w.startsWith(`${r.dir} is an agent in the old layout`));
        expect(warning).toBeDefined();
        for (const text of [...r.found, path.normalize(r.at), ...(r.also ? [r.also] : [])]) expect(warning).toContain(text);
        if (shadowed[r.dir]) expect(warning).toContain(`is also shadowed: a read of slug`);
      }

      // The by-slug read agrees with the listing, for every slug in the row.
      for (const by of Object.values(shadowed)) expect(row.bySlug.map((e) => e.dir)).toContain(by);
      for (const { slug, dir } of row.bySlug) {
        const read = await run("agent_source_read", { packageSlug: slug });
        if (dir === null) {
          expect(read.error).toBeDefined();
          expect(read.error).not.toContain("old layout");
        } else if (row.read.includes(dir)) {
          expect(read.error).toBeUndefined();
          expect(read.path).toBe(canonical(dir));
        } else {
          const r = reported.find((x) => x.dir === dir)!;
          expect(read.error).toContain(`in ${path.normalize(dir)},`);
          expect(read.error).toContain(path.normalize(r.at));
        }
      }
    });
  }

  // The listing keeps the error behaviour it had: a failing instance identity
  // store is an error of the call (it is not an unreadable tree, and it must
  // not pass as "no sources"); only an unreadable or missing source root lists
  // nothing.
  it("agent_source_list: a failing identity store rejects the call", async () => {
    await put(`${FIRST_PARTY}/${SLUG}/cinatra/oas.json`, oas("LISTED"));
    identity.failure = new Error("identity store down");
    await expect(run("agent_source_list", {})).rejects.toThrow("identity store down");
  });

  it("agent_source_list: a source root that cannot be read lists nothing", async () => {
    identity.vendor = OPERATOR;
    vi.mocked(resolveDevExtensionSourceRoot).mockReturnValue(path.join(tmpRoot, "no-such-root"));
    try {
      const result = await run("agent_source_list", {});
      expect(result.items).toEqual([]);
      expect(result.warnings).toEqual([]);
    } finally {
      vi.mocked(resolveDevExtensionSourceRoot).mockImplementation(() => process.cwd());
    }
  });
});
