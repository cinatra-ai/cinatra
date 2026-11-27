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

type Handler = (req: unknown) => Promise<unknown>;
const handlers = createAgentBuilderPrimitiveHandlers() as Record<string, Handler>;

const SLUG = "example-agent";
const MOVE = "move it to cinatra/oas.json";

let tmpRoot: string;
let originalCwd: string;

/** Old-layout shapes the retired read ladder accepted, with the directory each one names. */
const OLD_LAYOUTS: Array<{ label: string; file: string[]; dir: string[] }> = [
  { label: "vendor dir, cinatra/agent.json", file: ["cinatra-ai", SLUG, "cinatra", "agent.json"], dir: ["cinatra-ai", SLUG] },
  { label: "vendor dir, root agent.json", file: ["cinatra-ai", SLUG, "agent.json"], dir: ["cinatra-ai", SLUG] },
  { label: "flat dir, cinatra/agent.json", file: [SLUG, "cinatra", "agent.json"], dir: [SLUG] },
  { label: "flat dir, root agent.json", file: [SLUG, "agent.json"], dir: [SLUG] },
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

  it.each(OLD_LAYOUTS)("does not read an agent.json-only tree ($label); read names the directory and the move", async ({ file, dir }) => {
    await put(file, oasJson("Old"));

    expect(__resolveAgentJsonPathForRead(SLUG)).toBeNull();

    const read = (await call("agent_source_read", { packageSlug: SLUG })) as { content?: unknown; error?: string };
    expect(read.content).toBeUndefined();
    expect(read.error).toContain(`${printed(dir)} is an agent in the old layout`);
    expect(read.error).toContain(MOVE);
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
    for (const w of list.warnings!) expect(w).toContain(MOVE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is an agent in the old layout"));
  });

  it.each(OLD_LAYOUTS)("validate, review, compile and publish name the directory ($label)", async ({ file, dir }) => {
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
    expect(compile.error).toContain(MOVE);

    const publish = (await call("agent_source_publish", { packageSlug: SLUG }, true)) as { error?: string };
    expect(publish.error).toContain(named);
    expect(publish.error).toContain(MOVE);
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
      expect(text!.split(MOVE)).toHaveLength(3);
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
