/**
 * cinatra#3089 — a list filing judges every member as the REAL creation
 * boundary will, before its first write. The creation path
 * (`createSemanticArtifact`), the blob store's MIME detection and the type
 * registry are the shipped modules; only the database and the run's package
 * reads are stubbed. A database call is a write: the database stub records it,
 * so "nothing written" is read off the database and the blob root.
 *
 *   npx vitest run src/lib/artifacts/__tests__/materialize-tool-artifact-list-boundary-3089.test.ts
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { dbCalls, poolQueryMock, claimMaterializationMock, resolveBoundArtifactTargetMock } = vi.hoisted(() => ({
  dbCalls: [] as unknown[],
  poolQueryMock: vi.fn(),
  claimMaterializationMock: vi.fn(),
  resolveBoundArtifactTargetMock: vi.fn(),
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (args: unknown) => {
    dbCalls.push(args);
    throw new Error("unit: the database was reached");
  },
}));
vi.mock("@/lib/db/pooled", async () => ({
  ...await vi.importActual<typeof import("@/lib/db/pooled")>("@/lib/db/pooled"),
  getPooledDb: () => ({ query: poolQueryMock, connect: async () => ({ query: poolQueryMock, release: () => {} }) }),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "public",
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/database", () => ({
  readChatThreadForClassifier: () => null,
  readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
  writeMetadataValueToDatabase: () => {},
}));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: vi.fn(async () => ({
    manifest: { name: "@test/agent", cinatra: { produces: [{ extension: "@cinatra-ai/blog-post-artifact" }] } },
    payload: null,
  })),
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({ registryUrl: "http://registry.test", token: "t" })),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));
vi.mock("../resolve-bound-artifact-type", () => ({ resolveBoundArtifactTarget: resolveBoundArtifactTargetMock }));
vi.mock("../materialization-ledger", async () => ({
  ...await vi.importActual<typeof import("../materialization-ledger")>("../materialization-ledger"),
  claimMaterialization: claimMaterializationMock,
}));
vi.mock("../artifact-extension-access", () => ({ isArtifactExtensionWriteAllowed: vi.fn(async () => true) }));
vi.mock("../matcher-enqueue", () => ({ enqueueArtifactMatchRun: vi.fn(async () => {}) }));
vi.mock("../artifact-authoring", () => ({
  MAX_AUTHORED_CONTENT_BYTES: 10 * 1024 * 1024,
  TEXT_AUTHORING_COMPATIBLE_MIMES: new Set(["text/markdown", "text/plain", "text/html", "application/json", "application/xml"]),
}));

import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  __resetRunPackageBindingsCacheForTests,
  materializeToolArtifact,
  materializeToolArtifactList,
} from "../run-artifact-materializer";

const EXT = "@cinatra-ai/blog-post-artifact";
const TYPE = `${EXT}:artifact`;
const PDF_LOOKING = "%PDF-1.7\nnot really a pdf, declared as markdown";

let blobRoot = "";
const savedRoot = process.env.CINATRA_ARTIFACT_DATA_ROOT;

function registerType(mimes: string[], schema: z.ZodTypeAny = z.record(z.string(), z.unknown())) {
  objectTypeRegistry._clearForTests();
  objectTypeRegistry.register(
    {
      type: TYPE,
      category: "report",
      schema,
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: mimes } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    EXT,
  );
  resolveBoundArtifactTargetMock.mockResolvedValue({
    ok: true,
    target: { objectTypeId: TYPE, acceptedFileMimeTypes: mimes },
  });
}

const CALL = {
  runId: "run-1",
  orgId: "org-a",
  templateId: "tpl-1",
  packageVersion: "1.2.3",
  createdBy: "user-1",
  nodeId: "file_bodies",
  extension: EXT,
  mime: "text/markdown",
};

/** Every file under the blob root, the store's staging folder included. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

beforeAll(() => {
  blobRoot = mkdtempSync(path.join(tmpdir(), "cin-3089-list-"));
  process.env.CINATRA_ARTIFACT_DATA_ROOT = blobRoot;
});
afterAll(() => {
  objectTypeRegistry._clearForTests();
  rmSync(blobRoot, { recursive: true, force: true });
  if (savedRoot === undefined) delete process.env.CINATRA_ARTIFACT_DATA_ROOT;
  else process.env.CINATRA_ARTIFACT_DATA_ROOT = savedRoot;
});
beforeEach(() => {
  vi.clearAllMocks();
  dbCalls.length = 0;
  __resetRunPackageBindingsCacheForTests();
  poolQueryMock.mockResolvedValue({ rows: [{ package_name: "@test/agent" }] });
  claimMaterializationMock.mockResolvedValue({ kind: "claimed", ledgerId: "led-1" });
});

describe("a list member is judged by the MIME the store detects (cinatra#3089)", () => {
  it("refuses a later member whose detected MIME the type does not accept, as the single path does, before any write", async () => {
    registerType(["text/markdown"]);
    const single = await materializeToolArtifact({ ...CALL, title: "Bob", content: PDF_LOOKING });
    expect(single).toMatchObject({ ok: false, error: expect.stringContaining('detected MIME "application/pdf" is not accepted') });

    vi.clearAllMocks();
    dbCalls.length = 0;
    const before = filesUnder(blobRoot);
    const list = await materializeToolArtifactList({
      ...CALL,
      members: [
        { title: "Ann", content: "# Hi Ann" },
        { title: "Bob", content: PDF_LOOKING },
      ],
    });
    expect(list).toEqual({
      ok: false,
      error: `member 2: detected MIME "application/pdf" is not accepted by "${TYPE}" (accepts [text/markdown])`,
    });
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(dbCalls).toEqual([]);
    expect(filesUnder(blobRoot)).toEqual(before);
  });

  it("checks a later member's schema with its detected MIME, as the creation boundary does, before any write", async () => {
    registerType(["text/markdown", "application/pdf"], z.object({ mime: z.literal("text/markdown") }).passthrough());
    const single = await materializeToolArtifact({ ...CALL, title: "Bob", content: PDF_LOOKING });
    expect(single).toMatchObject({ ok: false, error: expect.stringContaining("object payload does not satisfy the declared schema") });

    vi.clearAllMocks();
    dbCalls.length = 0;
    const before = filesUnder(blobRoot);
    const list = await materializeToolArtifactList({
      ...CALL,
      members: [
        { title: "Ann", content: "# Hi Ann" },
        { title: "Bob", content: PDF_LOOKING },
      ],
    });
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.error).toMatch(/^member 2: object payload does not satisfy the declared schema/);
    expect(claimMaterializationMock).not.toHaveBeenCalled();
    expect(dbCalls).toEqual([]);
    expect(filesUnder(blobRoot)).toEqual(before);
  });
});
