/**
 * cinatra#4920 (direct readers): compileOasAgentJson, given only a package
 * name, reads `cinatra/oas.json` and nothing else. A directory with only the
 * old `agent.json` / `cinatra/agent.json` fails with one plain error naming the
 * directory, the file found and the path the definition must be at.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/oas-compiler-by-name-oas-only-4920.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync as fsRealpathSync } from "node:fs";

// The operator's instance namespace; null = identity unset (first-party only).
const identity = vi.hoisted(() => ({ namespace: null as string | null }));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => (identity.namespace ? { instanceNamespace: identity.namespace } : null)),
}));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: vi.fn(() => process.cwd()),
  resolveDevExtensionSourceRoot: vi.fn(() => process.cwd()),
}));

import { compileOasAgentJson } from "../oas-compiler";

// The compiler reads the operator's namespace through a lazy CommonJS
// `require` (so the identity store is not a hard import); vi.mock does not reach
// `require`, so the test answers that one request itself.
const nodeModule = createRequire(import.meta.url)("node:module") as {
  _load: (request: string, ...rest: unknown[]) => unknown;
};
const realLoad = nodeModule._load;
beforeAll(() => {
  nodeModule._load = function (request: string, ...rest: unknown[]) {
    if (request === "@/lib/instance-identity-store") {
      return { readInstanceIdentity: () => (identity.namespace ? { instanceNamespace: identity.namespace } : null) };
    }
    return realLoad.call(this, request, ...rest);
  };
});
afterAll(() => {
  nodeModule._load = realLoad;
});

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
    identity.namespace = null;
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

  // Two vendors (cinatra#4920): the operator's directory ("acme") is probed
  // first, then first-party. The FIRST directory that holds ANY definition file
  // decides; a lower-priority directory is never consulted after it.
  describe("two vendors: the first directory that holds a definition file decides", () => {
    const MALFORMED = "{ not json";
    const operatorOas = `acme/${SLUG}/cinatra/oas.json`;
    const operatorOld = `acme/${SLUG}/cinatra/agent.json`;
    const firstPartyOas = `cinatra-ai/${SLUG}/cinatra/oas.json`;
    const firstPartyOld = `cinatra-ai/${SLUG}/cinatra/agent.json`;
    const abs = (rel: string) => path.join(fsRealpathSync(tmpRoot), rel);

    beforeEach(() => {
      identity.namespace = "acme";
    });

    it("operator old-layout + first-party canonical: the operator's migration error", async () => {
      await put(operatorOld, MALFORMED);
      await put(firstPartyOas, MALFORMED);
      const result = await compileOasAgentJson({ packageName: PKG });
      expect(result).toEqual({
        ok: false,
        error:
          `Agent definition is in the old layout: found ${operatorOld} in acme/${SLUG}, which is no longer read. ` +
          `The definition must be at ${operatorOas}; move it there.`,
      });
    });

    it("operator canonical + first-party old-layout: reads the operator's canonical file", async () => {
      await put(operatorOas, MALFORMED);
      await put(firstPartyOld, MALFORMED);
      const result = await compileOasAgentJson({ packageName: PKG });
      expect((result as { error: string }).error).toContain(`OAS source at ${abs(operatorOas)} is malformed JSON`);
    });

    it("operator has nothing + first-party canonical: reads the first-party file", async () => {
      await put(firstPartyOas, MALFORMED);
      const result = await compileOasAgentJson({ packageName: PKG });
      expect((result as { error: string }).error).toContain(`OAS source at ${abs(firstPartyOas)} is malformed JSON`);
    });

    it("operator has nothing + first-party old-layout: the first-party migration error", async () => {
      await put(firstPartyOld, MALFORMED);
      const result = await compileOasAgentJson({ packageName: PKG });
      expect((result as { error: string }).error).toContain(`found ${firstPartyOld} in cinatra-ai/${SLUG}`);
    });
  });
});
