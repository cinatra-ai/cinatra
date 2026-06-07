// Cinatra npm and pnpm invocations must pass explicit registry and auth-token
// flags instead of mutating ~/.npmrc.
//
// Centralized flag construction keeps every spawn site on the same auth format
// and prevents call sites from rebuilding the token flag by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock execFile so we capture the args without actually spawning npm.
const execFileMock = vi.fn(
  (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout: "", stderr: "" });
  },
);
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  default: { execFile: execFileMock },
}));

// Mock fs to detect any forbidden ~/.npmrc writes.
const writeFileSyncMock = vi.fn();
const appendFileSyncMock = vi.fn();
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
    appendFileSync: appendFileSyncMock,
  };
});

import {
  buildRegistryAuthArgs,
  extractHost,
} from "../verdaccio/cli-flags";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verdaccio cli flags", () => {
  describe("buildRegistryAuthArgs helper", () => {
    it("returns a 2-element array containing --registry= and --//<host>/:_authToken= for https URLs", () => {
      const args = buildRegistryAuthArgs({
        registryUrl: "https://registry.cinatra.ai",
        token: "abc123",
      });
      expect(args).toHaveLength(2);
      expect(args).toEqual([
        "--registry=https://registry.cinatra.ai",
        "--//registry.cinatra.ai/:_authToken=abc123",
      ]);
    });

    it("supports both http: and https: protocols", () => {
      const args = buildRegistryAuthArgs({
        registryUrl: "http://127.0.0.1:4873",
        token: "tok",
      });
      expect(args).toEqual([
        "--registry=http://127.0.0.1:4873",
        "--//127.0.0.1:4873/:_authToken=tok",
      ]);
    });

    it("preserves the port in the host portion of the auth-token flag", () => {
      const args = buildRegistryAuthArgs({
        registryUrl: "http://127.0.0.1:4873",
        token: "tok",
      });
      // Host segment of the second flag must literally include `:4873`.
      const authFlag = args[1];
      expect(authFlag).toContain("127.0.0.1:4873");
      expect(authFlag).toContain("/:_authToken=tok");
    });

    it("throws when token is empty", () => {
      expect(() =>
        buildRegistryAuthArgs({
          registryUrl: "https://registry.cinatra.ai",
          token: "",
        }),
      ).toThrow(/token is empty/i);
    });

    it("extractHost returns host:port for URLs that include a port", () => {
      expect(extractHost("http://127.0.0.1:4873")).toBe("127.0.0.1:4873");
      expect(extractHost("https://registry.cinatra.ai")).toBe("registry.cinatra.ai");
    });
  });

  describe("install path", () => {
    it("installAgentPackageWithDependencies references buildRegistryAuthArgs", async () => {
      // The install path itself fetches via pacote (HTTP), so there is no
      // direct execFile spawn inside install-from-package.ts. The helper is
      // imported there as a readiness marker so future spawn sites can splice
      // the flags directly.
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const repoRoot = path.resolve(__dirname, "../../../..");
      const src = await fs.readFile(
        path.join(
          repoRoot,
          "packages/agents/src/install-from-package.ts",
        ),
        "utf8",
      );
      expect(src).toMatch(/buildRegistryAuthArgs/);
    });
  });

  describe("publish/unpublish path", () => {
    it("verdaccio/client.ts wires buildRegistryAuthArgs at every spawn site", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const repoRoot = path.resolve(__dirname, "../../../..");
      const src = await fs.readFile(
        path.join(
          repoRoot,
          "packages/agents/src/verdaccio/client.ts",
        ),
        "utf8",
      );
      // Spawn sites must flow through buildRegistryAuthArgs.
      const helperRefs = (src.match(/buildRegistryAuthArgs/g) ?? []).length;
      expect(helperRefs).toBeGreaterThanOrEqual(1);
      // Negative: no inline `--//${...}/:_authToken=${...}` template-literal
      // regression. The helper owns flag construction.
      expect(src).not.toMatch(/`--\/\/\$\{[^}]+\}\/:_authToken=/);
    });

    it("unpublish path sets an explicit auth-token flag", () => {
      // Pin the documented format emitted by the helper.
      const args = buildRegistryAuthArgs({
        registryUrl: "https://registry.cinatra.ai",
        token: "TOKEN_VALUE",
      });
      const authFlag = args.find((a) => a.startsWith("--//")) ?? "";
      expect(authFlag.startsWith("--//")).toBe(true);
      expect(authFlag).toContain("/:_authToken=");
    });
  });

  describe("negative — no .npmrc writes", () => {
    it("does not write .npmrc", () => {
      // Spawn-site code must not write .npmrc. The helper module itself never
      // touches fs.
      buildRegistryAuthArgs({
        registryUrl: "https://registry.cinatra.ai",
        token: "tok",
      });
      expect(writeFileSyncMock).not.toHaveBeenCalled();
      expect(appendFileSyncMock).not.toHaveBeenCalled();
    });

    it("static guard — neither install-from-package.ts nor verdaccio/client.ts writes .npmrc", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const repoRoot = path.resolve(__dirname, "../../../..");
      for (const rel of [
        "packages/agents/src/install-from-package.ts",
        "packages/agents/src/verdaccio/client.ts",
      ]) {
        const src = await fs.readFile(path.join(repoRoot, rel), "utf8");
        expect(src).not.toMatch(/writeFileSync\([^)]*\.npmrc/);
        expect(src).not.toMatch(/appendFileSync\([^)]*\.npmrc/);
      }
    });
  });
});
