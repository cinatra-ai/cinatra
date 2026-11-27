/**
 * cinatra#4920 (direct readers): compileOasAgentJson, given only a package
 * name, reads `cinatra/oas.json` and nothing else. A directory with only the
 * old `agent.json` / `cinatra/agent.json` fails with one plain error naming the
 * directory, the file found and the path the definition must be at.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/oas-compiler-by-name-oas-only-4920.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: vi.fn(() => null) }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => process.cwd()),
  resolveDevExtensionSourceRoot: vi.fn(() => process.cwd()),
}));

import { compileOasAgentJson } from "../oas-compiler";

const SLUG = "by-name-oas-only-agent";
const PKG = `@example-org/${SLUG}`;
const REQUIRED = `cinatra-ai/${SLUG}/cinatra/oas.json`;

let tmpRoot: string;
let originalCwd: string;

async function put(rel: string, content: string): Promise<void> {
  const full = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

const message = (found: string, dir: string) =>
  `Agent definition is in the old layout: found ${found} in ${dir}, which is no longer read. ` +
  `The definition must be at ${REQUIRED}; move it there.`;

describe("compileOasAgentJson by package name reads cinatra/oas.json only (cinatra#4920)", () => {
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oas-by-name-"));
    originalCwd = process.cwd();
    process.chdir(tmpRoot);
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reads cinatra/oas.json (a malformed one reports its own parse error)", async () => {
    await put(`cinatra-ai/${SLUG}/cinatra/oas.json`, "{ not json");
    const result = await compileOasAgentJson({ packageName: PKG });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/malformed JSON/);
  });

  it.each([
    ["cinatra/agent.json in the vendor directory", `cinatra-ai/${SLUG}/cinatra/agent.json`, `cinatra-ai/${SLUG}`],
    ["cinatra/agent.json in the legacy directory", `${SLUG}/cinatra/agent.json`, SLUG],
    ["a flat agent.json in the legacy directory", `${SLUG}/agent.json`, SLUG],
  ])("refuses %s with the old-layout message", async (_name, file, dir) => {
    await put(file, "{ not json");
    const result = await compileOasAgentJson({ packageName: PKG });
    expect(result).toEqual({ ok: false, error: message(file, dir) });
  });

  it("ignores the old file when cinatra/oas.json is there too", async () => {
    await put(`cinatra-ai/${SLUG}/cinatra/oas.json`, "{ not json");
    await put(`cinatra-ai/${SLUG}/cinatra/agent.json`, JSON.stringify({ component_type: "Flow" }));
    await put(`${SLUG}/agent.json`, JSON.stringify({ component_type: "Flow" }));
    const result = await compileOasAgentJson({ packageName: PKG });
    expect((result as { error: string }).error).toMatch(/malformed JSON/);
  });

  it("still reports a plain not-found when no definition file exists", async () => {
    const result = await compileOasAgentJson({ packageName: PKG });
    expect((result as { error: string }).error).toMatch(/OAS source not found/);
  });
});
