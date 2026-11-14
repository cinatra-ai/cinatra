// cinatra#4264 (slice A0): the git-directory publisher fails closed on a
// compile error and carries the source package's `cinatra.lifecycle` block.
//
// `publishAgentPackageFromGitDir` builds a FRESH cinatra block for the
// manifest it publishes. Before this change it (a) compiled the OAS by a
// packageName lookup instead of the file it packages, (b) swallowed a failed
// or thrown compile and published anyway, and (c) dropped `cinatra.lifecycle`
// (`repairCapable`, `repairFindingsInput`, ...), so an installed copy lost
// every lifecycle declaration.
//
// These cases EXECUTE the publisher: the registry read (pacote) is mocked to
// say the version is new, the compile is a controlled mock, and the registry
// write (fetch PUT) is captured.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { c as tarCreate, x as tarExtract } from "tar";

// The real tar, with the create call observed: a refusal must come before the
// tarball is built, not only before the registry write.
vi.mock("tar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tar")>();
  return { ...actual, c: vi.fn(actual.c) };
});

vi.mock("pacote", () => {
  const notFound = async () => {
    throw Object.assign(new Error("not found"), { code: "E404", statusCode: 404 });
  };
  return { packument: vi.fn(notFound), tarball: vi.fn(notFound), extract: vi.fn(notFound) };
});

const { compileMock } = vi.hoisted(() => ({
  compileMock: vi.fn(async (_opts: Record<string, unknown>): Promise<unknown> => ({ ok: true, value: {} })),
}));

vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: compileMock,
}));

// The package walk, with a hook that runs while it walks: a source rewritten
// after the compile must not reach the tarball (cinatra#4264).
const { walkHook } = vi.hoisted(() => ({
  walkHook: { current: null as null | ((rootAbs: string) => Promise<void>) },
}));

vi.mock("../scan-package-siblings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scan-package-siblings")>();
  return {
    ...actual,
    walkPackageFiles: vi.fn(async (rootAbs: string) => {
      const files = await actual.walkPackageFiles(rootAbs);
      if (walkHook.current) await walkHook.current(rootAbs);
      return files;
    }),
  };
});

import { publishAgentPackageFromGitDir } from "../verdaccio/client";

const PACKAGE_NAME = "@cinatra-fixtures/lifecycle-agent";
const PACKAGE_VERSION = "0.2.0";
const CONFIG = {
  registryUrl: "http://registry.test/",
  packageScope: "@cinatra-fixtures",
  token: null,
  uiUrl: null,
} as unknown as Parameters<typeof publishAgentPackageFromGitDir>[1];

const LIFECYCLE = {
  requestedSkips: ["recommendation"],
  repairCapable: false,
  producedTypes: ["blog-post"],
  repairFindingsInput: { input: "instructions" },
};

type PutCall = { url: string; method: string | undefined; body: Record<string, unknown> };

let tmpRoot: string;
let puts: PutCall[];

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publish-lifecycle-4264-"));
  puts = [];
  compileMock.mockReset();
  compileMock.mockImplementation(async () => ({ ok: true, value: {} }));
  walkHook.current = null;
  vi.mocked(tarCreate).mockClear();
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

const OAS_SOURCE = `${JSON.stringify({ component_type: "Flow", name: "Lifecycle agent" }, null, 2)}\n`;
const OAS_BYTES = Buffer.from(OAS_SOURCE, "utf8");
const OTHER_SOURCE = `${JSON.stringify({ component_type: "Flow", name: "Other" })}\n`;

async function writeAgentDir(
  cinatra: Record<string, unknown>,
  oasRelPath = "cinatra/oas.json",
  oasBytes: Buffer = OAS_BYTES,
): Promise<string> {
  const agentDir = path.join(tmpRoot, "agent");
  const pkg = {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    license: "Apache-2.0",
    description: "A fixture agent that declares lifecycle fields.",
    type: "module",
    cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent", ...cinatra },
  };
  const files: Record<string, Buffer> = {
    "package.json": Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`, "utf8"),
    [oasRelPath]: oasBytes,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(agentDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return agentDir;
}

/** The one registry write: the packument version manifest and the tarball's own package.json. */
async function publishedManifests(): Promise<Array<Record<string, unknown>>> {
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
  return [packument, tarball];
}

/** The shipped bytes of one tarball file; call after publishedManifests(). */
async function shippedBytes(relPath: string): Promise<Buffer> {
  return fs.readFile(path.join(tmpRoot, "extracted", "package", relPath));
}

/** The compiled task spec the tarball's synthesized agent.json carries. */
async function shippedTaskSpec(): Promise<unknown> {
  const payload = JSON.parse((await shippedBytes("agent.json")).toString("utf8")) as {
    template: { taskSpec: unknown };
  };
  return payload.template.taskSpec;
}

/** A compile mock that compiles what it is handed and reports it as the prompt. */
function compileHandedBytes(opts: Record<string, unknown>): Promise<Buffer> {
  return opts.oasSource instanceof Buffer
    ? Promise.resolve(opts.oasSource)
    : fs.readFile(String(opts.oasSourcePath));
}

function cinatraOf(manifest: Record<string, unknown>): Record<string, unknown> {
  return manifest.cinatra as Record<string, unknown>;
}

describe("publishAgentPackageFromGitDir fails closed on the compile (cinatra#4264 A0)", () => {
  it("refuses a compile ok:false before any registry write", async () => {
    compileMock.mockImplementation(async () => ({ ok: false, error: "OAS structural validation failed" }));
    const agentDir = await writeAgentDir({});
    await expect(publishAgentPackageFromGitDir({ agentDir }, CONFIG)).rejects.toThrow(
      /OAS structural validation failed/,
    );
    expect(tarCreate).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it("refuses a thrown compile before any registry write", async () => {
    compileMock.mockImplementation(async () => {
      throw new Error("compiler exploded");
    });
    const agentDir = await writeAgentDir({});
    await expect(publishAgentPackageFromGitDir({ agentDir }, CONFIG)).rejects.toThrow(/compiler exploded/);
    expect(tarCreate).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it("compiles the same OAS file it packages (the resolved oasSourcePath)", async () => {
    const agentDir = await writeAgentDir({});
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(compileMock.mock.calls[0][0]).toMatchObject({
      packageName: PACKAGE_NAME,
      oasSourcePath: path.join(agentDir, "cinatra", "oas.json"),
    });
    await publishedManifests();
    expect((await shippedBytes("cinatra/oas.json")).equals(OAS_BYTES)).toBe(true);
  });

  it("hands the compile the bytes it read, as a Buffer, not only the path", async () => {
    const agentDir = await writeAgentDir({});
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    const handed = compileMock.mock.calls[0][0].oasSource;
    expect(Buffer.isBuffer(handed)).toBe(true);
    expect((handed as Buffer).equals(OAS_BYTES)).toBe(true);
  });

  it("compiles and ships the transitional cinatra/agent.json source as the same bytes", async () => {
    const agentDir = await writeAgentDir({}, "cinatra/agent.json");
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    expect(compileMock.mock.calls[0][0]).toMatchObject({
      oasSourcePath: path.join(agentDir, "cinatra", "agent.json"),
    });
    await publishedManifests();
    expect((await shippedBytes("cinatra/agent.json")).equals(OAS_BYTES)).toBe(true);
  });

  it("refuses a flat agent.json source, whose bytes the synthesized payload replaces, before any registry write", async () => {
    const agentDir = await writeAgentDir({}, "agent.json");
    await expect(publishAgentPackageFromGitDir({ agentDir }, CONFIG)).rejects.toThrow(/does not ship in the tarball/);
    expect(tarCreate).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it("an A->B->A swap during the compile cannot split the compiled flow from the shipped bytes", async () => {
    const agentDir = await writeAgentDir({});
    const oasPath = path.join(agentDir, "cinatra", "oas.json");
    compileMock.mockImplementation(async (opts: Record<string, unknown>) => {
      await fs.writeFile(oasPath, OTHER_SOURCE);
      const compiled = await compileHandedBytes(opts);
      await fs.writeFile(oasPath, OAS_BYTES);
      return { ok: true, value: { prompt: compiled.toString("utf8") } };
    });
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    await publishedManifests();
    const shipped = await shippedBytes("cinatra/oas.json");
    expect(shipped.equals(OAS_BYTES)).toBe(true);
    expect(await shippedTaskSpec()).toBe(shipped.toString("utf8"));
  });

  it("a source rewritten during the compile ships the bytes the compile was handed", async () => {
    const agentDir = await writeAgentDir({});
    compileMock.mockImplementation(async (opts: Record<string, unknown>) => {
      await fs.writeFile(String(opts.oasSourcePath), OTHER_SOURCE);
      const compiled = await compileHandedBytes(opts);
      return { ok: true, value: { prompt: compiled.toString("utf8") } };
    });
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    await publishedManifests();
    const shipped = await shippedBytes("cinatra/oas.json");
    expect(shipped.equals(OAS_BYTES)).toBe(true);
    expect(await shippedTaskSpec()).toBe(OAS_SOURCE);
  });

  it("a source rewritten during the package walk still ships the compiled bytes, never a reread", async () => {
    const agentDir = await writeAgentDir({});
    compileMock.mockImplementation(async (opts: Record<string, unknown>) => {
      const compiled = await compileHandedBytes(opts);
      // Armed only after the compile, so the rewrite lands between the
      // compile and the packaging of the source file.
      walkHook.current = async (rootAbs) => {
        await fs.writeFile(path.join(rootAbs, "cinatra", "oas.json"), OTHER_SOURCE);
      };
      return { ok: true, value: { prompt: compiled.toString("utf8") } };
    });
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    await publishedManifests();
    const shipped = await shippedBytes("cinatra/oas.json");
    expect(shipped.equals(OAS_BYTES)).toBe(true);
    expect(await shippedTaskSpec()).toBe(OAS_SOURCE);
  });

  it("refuses an OAS source that is not valid UTF-8 (a raw 0x80 byte) before any tarball or registry write", async () => {
    const [head, tail] = OAS_SOURCE.split("Lifecycle agent");
    const bytes = Buffer.concat([Buffer.from(`${head}Life`, "utf8"), Buffer.from([0x80]), Buffer.from(`cycle agent${tail}`, "utf8")]);
    const agentDir = await writeAgentDir({}, "cinatra/oas.json", bytes);
    await expect(publishAgentPackageFromGitDir({ agentDir }, CONFIG)).rejects.toThrow(/not valid UTF-8/);
    expect(compileMock).not.toHaveBeenCalled();
    expect(tarCreate).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });
});

describe("publishAgentPackageFromGitDir carries cinatra.lifecycle (cinatra#4264 A0)", () => {
  it("publishes a valid lifecycle block, in the packument and in the tarball", async () => {
    const agentDir = await writeAgentDir({ lifecycle: LIFECYCLE });
    const result = await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    expect(result.published).toBe(true);
    for (const manifest of await publishedManifests()) {
      expect(cinatraOf(manifest).lifecycle).toEqual(LIFECYCLE);
    }
  });

  it("absence stays absence: no lifecycle key when the source declares none", async () => {
    const agentDir = await writeAgentDir({});
    await publishAgentPackageFromGitDir({ agentDir }, CONFIG);
    for (const manifest of await publishedManifests()) {
      expect(Object.keys(cinatraOf(manifest))).not.toContain("lifecycle");
    }
  });

  it.each([
    ["an unknown member", { repairCapeable: true }],
    ["a wrong member type", { repairCapable: "true" }],
    ["a reserved repair input", { repairFindingsInput: { input: "lifecycleRepairRequest" } }],
    ["not an object", ["repairCapable"]],
    ["an explicit null", null],
  ])("refuses a malformed lifecycle block (%s) before any registry write", async (_label, lifecycle) => {
    const agentDir = await writeAgentDir({ lifecycle });
    await expect(publishAgentPackageFromGitDir({ agentDir }, CONFIG)).rejects.toThrow(/cinatra\.lifecycle/);
    expect(puts).toHaveLength(0);
  });
});
