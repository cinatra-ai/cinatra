/**
 * cinatra#4920 (read paths): an agent's definition file is `cinatra/oas.json`.
 *
 * The agent_source_* readers resolve `<vendor>/<slug>/cinatra/oas.json` and
 * nothing else. A source directory in the old layout (an `agent.json`, no
 * `cinatra/oas.json`) is not read as an agent, and no reader passes over it
 * silently: the listing names it in `warnings[]` and still lists the others;
 * a read that asks for it by slug answers with one error that names the
 * directory and says "move it to cinatra/oas.json".
 *
 * Two old-layout directories can share one slug (a vendor directory and a flat
 * one): the listing warns for each, and a slug-keyed error names both.
 *
 * Every directory shape the readers accepted before (scoped and flat, with
 * `agent.json`, `cinatra/agent.json`, `cinatra/oas.json`) is in exactly one of two
 * states, READ or REPORTED, in the shared enumeration and in every reader here;
 * one table (SHAPES) runs through all of them. The boot walk and the picker run
 * the same shapes in their own suites (src/lib/__tests__).
 *
 * `agent_source_publish` refuses when `cinatra/oas.json` exists but cannot be
 * read, and never reaches the publisher.
 *
 * Fixtures sit under `<cwd>/extensions`, the dev source root.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-source-old-layout-4920.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const { mockPublishFromGitDir } = vi.hoisted(() => ({
  mockPublishFromGitDir: vi.fn(async () => ({ published: true })),
}));

// The real client with the two publishers replaced, so a test can say that the
// publisher was never called.
vi.mock("../verdaccio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../verdaccio/client")>()),
  publishAgentPackageFromGitDir: mockPublishFromGitDir,
  publishAgentPackage: mockPublishFromGitDir,
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
}));

// The path resolvers ask the instance identity for the operator vendor segment.
// "No identity" is the first-party "cinatra-ai" segment, the layout used here,
// and it keeps this unit suite off the database.
vi.mock("@/lib/instance-identity-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instance-identity-store")>()),
  readInstanceIdentity: vi.fn(() => null),
}));

import { createAgentBuilderPrimitiveHandlers, __resolveAgentJsonPathForRead } from "../mcp/handlers";
import { compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";

type Handler = (req: unknown) => Promise<unknown>;
const handlers = createAgentBuilderPrimitiveHandlers() as Record<string, Handler>;

const SLUG = "example-agent";
const MOVE = "move it to cinatra/oas.json";
// A flat directory is not a read place: its message names the SCOPED place.
const MOVE_FLAT = "move the directory to ";

let tmpRoot: string;
let originalCwd: string;

/** Old-layout shapes the retired read ladder accepted, with the directory each one names. */
const OLD_LAYOUTS: Array<{ label: string; file: string[]; dir: string[]; move: string }> = [
  { label: "vendor dir, cinatra/agent.json", file: ["cinatra-ai", SLUG, "cinatra", "agent.json"], dir: ["cinatra-ai", SLUG], move: MOVE },
  { label: "vendor dir, root agent.json", file: ["cinatra-ai", SLUG, "agent.json"], dir: ["cinatra-ai", SLUG], move: MOVE },
  { label: "flat dir, cinatra/agent.json", file: [SLUG, "cinatra", "agent.json"], dir: [SLUG], move: MOVE_FLAT + path.join("extensions", "cinatra-ai", SLUG) },
  { label: "flat dir, root agent.json", file: [SLUG, "agent.json"], dir: [SLUG], move: MOVE_FLAT + path.join("extensions", "cinatra-ai", SLUG) },
];

async function put(parts: string[], content: string): Promise<void> {
  const abs = path.join(tmpRoot, "extensions", ...parts);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

function oasJson(name: string): string {
  return JSON.stringify({
    name,
    description: "An example agent.",
    metadata: { cinatra: { packageName: `@example-org/${SLUG}`, packageVersion: "1.0.0" } },
  });
}

/** The directory as the handlers print it: relative to the working directory. */
function printed(dir: string[]): string {
  return path.join("extensions", ...dir);
}

function call(name: string, input: Record<string, unknown>, admin = false): Promise<unknown> {
  return handlers[name]({
    primitiveName: name,
    input,
    actor: { actorType: "human", source: "ui", ...(admin ? { platformRole: "platform_admin" } : {}) },
    mode: "deterministic",
  });
}

beforeEach(async () => {
  mockPublishFromGitDir.mockClear();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "old-layout-4920-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe("agent_source_* readers: cinatra/oas.json is the one definition file (cinatra#4920)", () => {
  it("reads a cinatra/oas.json agent as before", async () => {
    await put(["cinatra-ai", SLUG, "cinatra", "oas.json"], oasJson("Example"));
    await put(["cinatra-ai", SLUG, "package.json"], JSON.stringify({ name: `@example-org/${SLUG}`, version: "1.0.0" }));

    expect(__resolveAgentJsonPathForRead(SLUG)).toMatchObject({
      relPath: path.join("extensions", "cinatra-ai", SLUG, "cinatra", "oas.json"),
    });

    const read = (await call("agent_source_read", { packageSlug: SLUG })) as { content?: { name?: string }; path?: string; error?: string };
    expect(read.error).toBeUndefined();
    expect(read.content?.name).toBe("Example");
    expect(read.path).toBe(path.join("extensions", "cinatra-ai", SLUG, "cinatra", "oas.json"));

    const list = (await call("agent_source_list", {})) as { items: Array<{ name: string; packageName: string }>; total: number; warnings?: string[] };
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ name: "Example", packageName: `@example-org/${SLUG}` });
    // Nothing old to name: the field is absent, not an empty list.
    expect("warnings" in list).toBe(false);
  });

  it.each(OLD_LAYOUTS)("does not read an agent.json-only tree ($label); read names the directory and the move", async ({ file, dir, move }) => {
    await put(file, oasJson("Old"));

    expect(__resolveAgentJsonPathForRead(SLUG)).toBeNull();

    const read = (await call("agent_source_read", { packageSlug: SLUG })) as { content?: unknown; error?: string };
    expect(read.content).toBeUndefined();
    expect(read.error).toContain(`${printed(dir)} is an agent in the old layout`);
    expect(read.error).toContain(move);
  });

  it("a slug with no agent file at all keeps its plain not-found error, which names oas.json", async () => {
    const read = (await call("agent_source_read", { packageSlug: SLUG })) as { error?: string };
    expect(read.error).toBe(`Agent file not found: agents/${SLUG}/cinatra/oas.json`);
  });

  it("a directory holding both files is read from oas.json and is not named as old", async () => {
    await put(["cinatra-ai", SLUG, "cinatra", "oas.json"], oasJson("Current"));
    await put(["cinatra-ai", SLUG, "cinatra", "agent.json"], oasJson("Stale"));

    const read = (await call("agent_source_read", { packageSlug: SLUG })) as { content?: { name?: string }; error?: string };
    expect(read.content?.name).toBe("Current");
    const list = (await call("agent_source_list", {})) as { items: unknown[]; warnings?: string[] };
    expect(list.items).toHaveLength(1);
    expect(list.warnings).toBeUndefined();
  });

  it("the listing names every old-layout directory, logs it, and still lists the other agents", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await put(["cinatra-ai", "current-agent", "cinatra", "oas.json"], oasJson("Current"));
    await put(["cinatra-ai", "old-transitional", "cinatra", "agent.json"], oasJson("Old A"));
    await put(["old-nested", "cinatra", "agent.json"], oasJson("Old B"));
    await put(["old-flat", "agent.json"], oasJson("Old C"));
    // A directory with no agent file is neither listed nor named.
    await fs.mkdir(path.join(tmpRoot, "extensions", "cinatra-ai", "docs-only"), { recursive: true });

    const list = (await call("agent_source_list", {})) as { items: Array<{ name: string }>; total: number; warnings?: string[] };

    expect(list.items.map((i) => i.name)).toEqual(["Current"]);
    expect(list.total).toBe(1);
    const dirs = [printed(["cinatra-ai", "old-transitional"]), printed(["old-nested"]), printed(["old-flat"])];
    expect(list.warnings).toHaveLength(3);
    for (const dir of dirs) {
      expect(list.warnings!.filter((w) => w.includes(`${dir} is an agent in the old layout`))).toHaveLength(1);
    }
    for (const w of list.warnings!) expect(w.includes(MOVE) || w.includes(MOVE_FLAT)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is an agent in the old layout"));
  });

  it.each(OLD_LAYOUTS)("validate, review, compile and publish name the directory ($label)", async ({ file, dir, move }) => {
    await put(file, oasJson("Old"));
    const named = `${printed(dir)} is an agent in the old layout`;

    const validate = (await call("agent_source_validate", { packageSlug: SLUG })) as { valid?: boolean; errors?: string[] };
    expect(validate.valid).toBe(false);
    expect(validate.errors?.join(" ")).toContain(named);

    const review = (await call("agent_source_review", { packageSlug: SLUG, reviewMode: "deterministic" })) as {
      blockers: Array<{ code: string; message: string }>;
    };
    expect(review.blockers.map((b) => b.code)).toContain("agent_not_found");
    expect(review.blockers.map((b) => b.message).join(" ")).toContain(named);

    const compile = (await call("agent_source_compile", { packageSlug: SLUG }, true)) as { error?: string };
    expect(compile.error).toContain(named);
    expect(compile.error).toContain(move);

    const publish = (await call("agent_source_publish", { packageSlug: SLUG }, true)) as { error?: string };
    expect(publish.error).toContain(named);
    expect(publish.error).toContain(move);
  });
});

describe("two old-layout directories sharing one slug are both named (cinatra#4920)", () => {
  const VENDOR_DIR = ["cinatra-ai", SLUG];
  const FLAT_DIR = [SLUG];

  async function plantBoth(): Promise<void> {
    await put([...VENDOR_DIR, "cinatra", "agent.json"], oasJson("Old A"));
    await put([...FLAT_DIR, "agent.json"], oasJson("Old B"));
  }

  it("the listing warns for each directory, once each", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await plantBoth();

    const list = (await call("agent_source_list", {})) as { items: unknown[]; warnings?: string[] };

    expect(list.items).toEqual([]);
    expect(list.warnings).toHaveLength(2);
    for (const dir of [VENDOR_DIR, FLAT_DIR]) {
      expect(list.warnings!.filter((w) => w.includes(`${printed(dir)} is an agent in the old layout`))).toHaveLength(1);
    }
  });

  it("the listing also names an old directory that shares a slug with a current agent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await put([...VENDOR_DIR, "cinatra", "oas.json"], oasJson("Current"));
    await put([...FLAT_DIR, "agent.json"], oasJson("Old B"));

    const list = (await call("agent_source_list", {})) as { items: Array<{ name: string }>; warnings?: string[] };

    expect(list.items.map((i) => i.name)).toEqual(["Current"]);
    expect(list.warnings).toHaveLength(1);
    expect(list.warnings![0]).toContain(`${printed(FLAT_DIR)} is an agent in the old layout`);
  });

  it("a slug-keyed error names both directories and the move", async () => {
    await plantBoth();
    const named = [VENDOR_DIR, FLAT_DIR].map((dir) => `${printed(dir)} is an agent in the old layout`);

    const read = (await call("agent_source_read", { packageSlug: SLUG })) as { error?: string };
    const compile = (await call("agent_source_compile", { packageSlug: SLUG }, true)) as { error?: string };
    const validate = (await call("agent_source_validate", { packageSlug: SLUG })) as { errors?: string[] };
    for (const text of [read.error, compile.error, validate.errors?.join(" ")]) {
      for (const sentence of named) expect(text).toContain(sentence);
      // The scoped directory is told to move its file; the flat one is told the scoped place.
      expect(text!.split(MOVE)).toHaveLength(2);
      expect(text!.split(MOVE_FLAT + printed(VENDOR_DIR))).toHaveLength(2);
    }
  });
});

describe("agent_source_publish refuses when cinatra/oas.json cannot be read (cinatra#4920)", () => {
  it("the file check passes, the read fails (a directory stands where oas.json should be): refused, publisher not called", async () => {
    // existsSync(oas.json) is true for a directory, so the resolver accepts it;
    // readFile then fails with EISDIR.
    await fs.mkdir(path.join(tmpRoot, "extensions", "cinatra-ai", SLUG, "cinatra", "oas.json"), { recursive: true });
    expect(__resolveAgentJsonPathForRead(SLUG)).not.toBeNull();

    const publish = (await call("agent_source_publish", { packageSlug: SLUG }, true)) as { error?: string; code?: string };

    expect(publish.error).toContain("Agent file could not be read");
    expect(publish.error).toContain(path.join("extensions", "cinatra-ai", SLUG, "cinatra", "oas.json"));
    expect(publish.error).toContain("EISDIR");
    expect(publish.error).toContain("the publish was not started");
    expect(mockPublishFromGitDir).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// One table: every directory shape is READ or REPORTED, never silent, and the
// shared enumeration, the listing, the by-slug read and the compiler agree.
// ---------------------------------------------------------------------------

const TABLE_SCOPED = ["cinatra-ai", SLUG];
const TABLE_FLAT = [SLUG];
const TABLE_LEGACY_FLAT = ["drupal-content-editor"];

const SHAPES: Array<{
  label: string;
  /** The slug the agent is asked for by (a flat legacy directory name maps back to it). */
  slug: string;
  /** Files created, relative to the dev source root `<cwd>/extensions`. */
  files: string[][];
  /** The directory the shape sits in, relative to the same root. */
  dir: string[];
  state: "read" | "reported";
  /** REPORTED only: the file names the message says were found. */
  found?: string;
}> = [
  { label: "scoped, cinatra/oas.json", slug: SLUG, dir: TABLE_SCOPED, files: [[...TABLE_SCOPED, "cinatra", "oas.json"]], state: "read" },
  {
    label: "scoped, cinatra/oas.json beside cinatra/agent.json",
    slug: SLUG,
    dir: TABLE_SCOPED,
    files: [[...TABLE_SCOPED, "cinatra", "oas.json"], [...TABLE_SCOPED, "cinatra", "agent.json"]],
    state: "read",
  },
  {
    label: "scoped, cinatra/oas.json beside a root agent.json",
    slug: SLUG,
    dir: TABLE_SCOPED,
    files: [[...TABLE_SCOPED, "cinatra", "oas.json"], [...TABLE_SCOPED, "agent.json"]],
    state: "read",
  },
  { label: "scoped, cinatra/agent.json only", slug: SLUG, dir: TABLE_SCOPED, files: [[...TABLE_SCOPED, "cinatra", "agent.json"]], state: "reported", found: "cinatra/agent.json" },
  { label: "scoped, root agent.json only", slug: SLUG, dir: TABLE_SCOPED, files: [[...TABLE_SCOPED, "agent.json"]], state: "reported", found: "agent.json" },
  { label: "flat, cinatra/agent.json only", slug: SLUG, dir: TABLE_FLAT, files: [[...TABLE_FLAT, "cinatra", "agent.json"]], state: "reported", found: "cinatra/agent.json" },
  { label: "flat, root agent.json only", slug: SLUG, dir: TABLE_FLAT, files: [[...TABLE_FLAT, "agent.json"]], state: "reported", found: "agent.json" },
  { label: "flat, cinatra/oas.json only", slug: SLUG, dir: TABLE_FLAT, files: [[...TABLE_FLAT, "cinatra", "oas.json"]], state: "reported", found: "cinatra/oas.json" },
  {
    label: "flat, cinatra/oas.json beside cinatra/agent.json",
    slug: SLUG,
    dir: TABLE_FLAT,
    files: [[...TABLE_FLAT, "cinatra", "oas.json"], [...TABLE_FLAT, "cinatra", "agent.json"]],
    state: "reported",
    found: "cinatra/oas.json and cinatra/agent.json",
  },
  {
    label: "flat under an old directory name (drupal-content-editor), cinatra/agent.json",
    slug: "drupal-agent",
    dir: TABLE_LEGACY_FLAT,
    files: [[...TABLE_LEGACY_FLAT, "cinatra", "agent.json"]],
    state: "reported",
    found: "cinatra/agent.json",
  },
];

describe.each(SHAPES)("agent source shape: $label", (shape) => {
  async function plant(): Promise<void> {
    for (const file of shape.files) await put(file, oasJson("Example"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  it(`the resolver puts it in one state: ${shape.state}`, async () => {
    await plant();
    if (shape.state === "read") {
      expect(__resolveAgentJsonPathForRead(shape.slug)).toMatchObject({
        relPath: path.join("extensions", "cinatra-ai", shape.slug, "cinatra", "oas.json"),
      });
    } else {
      expect(__resolveAgentJsonPathForRead(shape.slug)).toBeNull();
    }
  });

  it("the listing and the by-slug read agree with it", async () => {
    await plant();
    const list = (await call("agent_source_list", {})) as { items: unknown[]; warnings?: string[] };
    const read = (await call("agent_source_read", { packageSlug: shape.slug })) as { content?: unknown; error?: string };

    if (shape.state === "read") {
      expect(list.items).toHaveLength(1);
      expect(list.warnings).toBeUndefined();
      expect(read.error).toBeUndefined();
      expect(read.content).toBeDefined();
      return;
    }
    expect(list.items).toEqual([]);
    expect(list.warnings).toHaveLength(1);
    expect(read.content).toBeUndefined();
    for (const text of [list.warnings![0]!, read.error!]) {
      // The directory, what was found, and the exact place the definition must be.
      expect(text).toContain(`${path.join("extensions", ...shape.dir)} is an agent in the old layout`);
      expect(text).toContain(shape.found!);
      expect(text).toContain(path.join("extensions", "cinatra-ai", shape.slug, "cinatra", "oas.json"));
    }
  });

  it("the compiler agrees with it", async () => {
    await plant();
    __resetRegistryCacheForTests();
    const registryPath = path.join(tmpRoot, "components.json");
    await fs.writeFile(registryPath, JSON.stringify({ components: {} }), "utf-8");
    const res = await compileOasAgentJson({ packageName: `@example-org/${shape.slug}`, registryPath });
    const error = res.ok ? "" : (res as { error: string }).error;
    if (shape.state === "read") {
      expect(error).not.toContain("is an agent in the old layout");
      expect(error).not.toContain("OAS source not found");
      return;
    }
    expect(res.ok).toBe(false);
    // The compiler prints real (absolute) paths.
    const real = await fs.realpath(tmpRoot);
    expect(error).toContain(`${path.join(real, "extensions", ...shape.dir)} is an agent in the old layout`);
    expect(error).toContain(shape.found!);
    expect(error).toContain(path.join(real, "extensions", "cinatra-ai", shape.slug, "cinatra", "oas.json"));
  });
});

describe("directories that are not agent sources, and two sharing a slug", () => {
  it("a directory with no agent file, and a vendor directory's own files, are nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await put([...TABLE_SCOPED, "cinatra", "oas.json"], oasJson("Example"));
    await put(["cinatra-ai", "agent.json"], oasJson("Stray"));
    await fs.mkdir(path.join(tmpRoot, "extensions", "docs-only"), { recursive: true });
    const list = (await call("agent_source_list", {})) as { items: unknown[]; warnings?: string[] };
    expect(list.items).toHaveLength(1);
    expect(list.warnings).toBeUndefined();
  });

  it("two directories sharing a slug each get their own state", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await put([...TABLE_SCOPED, "cinatra", "oas.json"], oasJson("Example"));
    await put([...TABLE_FLAT, "cinatra", "oas.json"], oasJson("Example"));
    const list = (await call("agent_source_list", {})) as { items: unknown[]; warnings?: string[] };
    expect(list.items).toHaveLength(1);
    expect(list.warnings).toHaveLength(1);
    expect(list.warnings![0]).toContain(`${path.join("extensions", ...TABLE_FLAT)} is an agent in the old layout`);
  });
});
