// cinatra#3924: the git-directory publisher carries the source package's
// `cinatra.tools` and `cinatra.declaredTables` into the manifest it publishes.
//
// A run reads both from the registry manifest of the version its template is
// bound to (src/lib/extension-run-package.ts): the generic tool dispatch
// resolves a name against `cinatra.tools` (src/lib/extension-tool-dispatch.ts)
// and the data tool reads `cinatra.declaredTables`
// (src/lib/extension-scoped-tools.ts). `publishAgentPackageFromGitDir` builds a
// fresh cinatra block, so before this change both declarations were lost on
// publish and a declared tool such as `settle_outcome` was refused.
//
// These cases EXECUTE the publisher: the registry read (pacote) is mocked to
// say the version is new, the registry write (fetch PUT) is captured, and the
// assertions read the manifest the publisher sends, both in the packument body
// and inside the tarball, through the same SDK parsers a run applies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { x as tarExtract } from "tar";
import { parseDeclaredTables, parseDeclaredTools } from "@cinatra-ai/sdk-extensions/manifest";

vi.mock("pacote", () => {
  const notFound = async () => {
    throw Object.assign(new Error("not found"), { code: "E404", statusCode: 404 });
  };
  return { packument: vi.fn(notFound), tarball: vi.fn(notFound), extract: vi.fn(notFound) };
});

vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: vi.fn(async () => ({ ok: false })),
}));

import { publishAgentPackageFromGitDir } from "../verdaccio/client";

const PACKAGE_NAME = "@cinatra-fixtures/tools-agent";
const PACKAGE_VERSION = "0.1.5";
const CONFIG = {
  registryUrl: "http://registry.test/",
  packageScope: "@cinatra-fixtures",
  token: null,
  uiUrl: null,
} as unknown as Parameters<typeof publishAgentPackageFromGitDir>[1];

const TOOLS = [
  { name: "review_targets", module: "./cinatra/tools/review-targets.mjs" },
  { name: "settle_outcome", module: "./cinatra/tools/settle-outcome.mjs" },
];

const TABLES = [
  {
    name: "outcomes",
    organizationColumn: "org_id",
    columns: [
      { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
      { name: "org_id", type: "text", notNull: true },
    ],
  },
];

type PutCall = { url: string; method: string | undefined; body: Record<string, unknown> };

let tmpRoot: string;
let puts: PutCall[];

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publish-run-decl-3924-"));
  puts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      puts.push({
        url: String(url),
        method: init?.method,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

async function writeAgentDir(cinatra: Record<string, unknown>): Promise<string> {
  const agentDir = path.join(tmpRoot, "agent");
  const pkg = {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    license: "Apache-2.0",
    description: "A fixture agent that declares tools.",
    type: "module",
    cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent", ...cinatra },
  };
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "cinatra/oas.json": `${JSON.stringify({ component_type: "Flow", name: "Tools agent" })}\n`,
    "cinatra/tools/review-targets.mjs": "export async function extensionTool() { return {}; }\n",
    "cinatra/tools/settle-outcome.mjs": "export async function extensionTool() { return {}; }\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(agentDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  return agentDir;
}

/** The one registry write: the packument version manifest and the tarball's own package.json. */
async function publishedManifests(): Promise<{
  packument: Record<string, unknown>;
  tarball: Record<string, unknown>;
}> {
  expect(puts).toHaveLength(1);
  expect(puts[0].method).toBe("PUT");
  const body = puts[0].body as {
    versions: Record<string, Record<string, unknown>>;
    _attachments: Record<string, { data: string }>;
  };
  const packument = body.versions[PACKAGE_VERSION];
  const [attachment] = Object.values(body._attachments);
  const tgz = path.join(tmpRoot, "published.tgz");
  await fs.writeFile(tgz, Buffer.from(attachment.data, "base64"));
  const out = path.join(tmpRoot, "extracted");
  await fs.mkdir(out, { recursive: true });
  await tarExtract({ file: tgz, cwd: out });
  const tarball = JSON.parse(
    await fs.readFile(path.join(out, "package", "package.json"), "utf8"),
  ) as Record<string, unknown>;
  return { packument, tarball };
}

function cinatraOf(manifest: Record<string, unknown>): Record<string, unknown> {
  return manifest.cinatra as Record<string, unknown>;
}

describe("publishAgentPackageFromGitDir carries the run-read declarations (cinatra#3924)", () => {
  it("publishes the declared tools, in the packument and in the tarball", async () => {
    const agentDir = await writeAgentDir({ tools: TOOLS });
    const result = await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    expect(result.published).toBe(true);

    const { packument, tarball } = await publishedManifests();
    for (const manifest of [packument, tarball]) {
      expect(cinatraOf(manifest).tools).toEqual(TOOLS);
      // What the run's dispatch reads: the name resolves against the declaration.
      const names = parseDeclaredTools(cinatraOf(manifest).tools, PACKAGE_NAME).map((t) => t.name);
      expect(names).toContain("settle_outcome");
    }
    // The module the declaration names ships in the same tarball.
    const shipped = path.join(tmpRoot, "extracted", "package", "cinatra", "tools", "settle-outcome.mjs");
    await expect(fs.stat(shipped)).resolves.toBeTruthy();
  });

  it("publishes the declared tables, in the packument and in the tarball", async () => {
    const agentDir = await writeAgentDir({ declaredTables: TABLES });
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);

    const { packument, tarball } = await publishedManifests();
    for (const manifest of [packument, tarball]) {
      expect(cinatraOf(manifest).declaredTables).toEqual(TABLES);
      const tables = parseDeclaredTables(cinatraOf(manifest).declaredTables, PACKAGE_NAME);
      expect(tables.map((t) => t.name)).toEqual(["outcomes"]);
    }
  });

  it("absence stays absence: a package that declares neither publishes neither key", async () => {
    const agentDir = await writeAgentDir({});
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);

    const { packument, tarball } = await publishedManifests();
    for (const manifest of [packument, tarball]) {
      expect(Object.keys(cinatraOf(manifest))).not.toContain("tools");
      expect(Object.keys(cinatraOf(manifest))).not.toContain("declaredTables");
    }
  });

  it("an explicit null publishes neither key (both parsers read null as an empty list)", async () => {
    const agentDir = await writeAgentDir({ tools: null, declaredTables: null });
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);

    const { packument, tarball } = await publishedManifests();
    for (const manifest of [packument, tarball]) {
      expect(Object.keys(cinatraOf(manifest))).not.toContain("tools");
      expect(Object.keys(cinatraOf(manifest))).not.toContain("declaredTables");
    }
  });

  it("an explicit empty list is carried as declared", async () => {
    const agentDir = await writeAgentDir({ tools: [], declaredTables: [] });
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);

    const { packument, tarball } = await publishedManifests();
    for (const manifest of [packument, tarball]) {
      expect(cinatraOf(manifest).tools).toEqual([]);
      expect(cinatraOf(manifest).declaredTables).toEqual([]);
    }
  });

  it.each([
    ["not an array", { name: "settle_outcome", module: "./cinatra/tools/settle-outcome.mjs" }],
    ["a module outside the package", [{ name: "settle_outcome", module: "../escape.mjs" }]],
    ["a module that is not a built artifact", [{ name: "settle_outcome", module: "./cinatra/tools/x.ts" }]],
    ["a name the dispatch cannot match", [{ name: "Settle-Outcome", module: "./cinatra/tools/settle-outcome.mjs" }]],
    [
      "a name declared twice",
      [
        { name: "settle_outcome", module: "./cinatra/tools/settle-outcome.mjs" },
        { name: "settle_outcome", module: "./cinatra/tools/review-targets.mjs" },
      ],
    ],
  ])("refuses malformed tools (%s) before any registry write", async (_label, tools) => {
    const agentDir = await writeAgentDir({ tools });
    await expect(publishAgentPackageFromGitDir({ agentDir }, CONFIG)).rejects.toThrow(/\[declared-tools\]/);
    expect(puts).toHaveLength(0);
  });

  it.each([
    ["not an array", { name: "outcomes" }],
    [
      "a nullable organisation column",
      [{ name: "outcomes", organizationColumn: "org_id", columns: [{ name: "org_id", type: "text" }] }],
    ],
    [
      "a column type outside the vocabulary",
      [
        {
          name: "outcomes",
          organizationColumn: "org_id",
          columns: [
            { name: "org_id", type: "text", notNull: true },
            { name: "blob", type: "bytea" },
          ],
        },
      ],
    ],
  ])("refuses malformed declaredTables (%s) before any registry write", async (_label, declaredTables) => {
    const agentDir = await writeAgentDir({ declaredTables });
    await expect(publishAgentPackageFromGitDir({ agentDir }, CONFIG)).rejects.toThrow(/\[declared-tables\]/);
    expect(puts).toHaveLength(0);
  });
});
