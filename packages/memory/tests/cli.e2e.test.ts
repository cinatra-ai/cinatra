import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BIN = path.join(
  fileURLToPath(new URL("..", import.meta.url)),
  "bin",
  "memory.mjs",
);
const tmp = mkdtempSync(path.join(os.tmpdir(), "memory-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(
  args: string[],
  options: { cwd?: string; input?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: options.cwd ?? tmp,
    encoding: "utf8",
    input: options.input ?? "",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const bundleDir = path.join(tmp, "repo", ".memory");

describe("memory CLI end-to-end (real command runs)", () => {
  it("init creates the bundle config and initial index", () => {
    const result = run(["init", "--dir", bundleDir, "--name", "e2e bundle"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Initialized memory bundle [0-9a-f-]{36} at /);
    expect(existsSync(path.join(bundleDir, "bundle.yaml"))).toBe(true);
    expect(existsSync(path.join(bundleDir, "index.md"))).toBe(true);
  });

  it("init refuses to reinitialize (bundleId is immutable)", () => {
    const result = run(["init", "--dir", bundleDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already initialized");
  });

  it("add writes one concept per insight", () => {
    const result = run([
      "add",
      "--dir",
      bundleDir,
      "--type",
      "Convention",
      "--title",
      "Use pnpm",
      "--description",
      "Always drive installs through pnpm.",
      "--tags",
      "tooling,pnpm",
      "--body",
      "Use pnpm for every install in this workspace.",
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Added convention/use-pnpm.md");
    expect(existsSync(path.join(bundleDir, "convention/use-pnpm.md"))).toBe(true);
  });

  it("add reads the body from stdin when piped", () => {
    const result = run(
      [
        "add",
        "--dir",
        bundleDir,
        "--type",
        "Debugging Insight",
        "--title",
        "Flaky port bind",
        "--path",
        "debugging/flaky-port-bind.md",
      ],
      { input: "Retry the bind after releasing the stale listener.\n" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Added debugging/flaky-port-bind.md");
  });

  it("discovers the bundle from a nested working directory", () => {
    const nested = path.join(tmp, "repo", "src", "deep");
    mkdirSync(nested, { recursive: true });
    const result = run(["list"], { cwd: nested });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("convention/use-pnpm");
  });

  it("list shows the concepts (and filters by type)", () => {
    const all = run(["list", "--dir", bundleDir, "--json"]);
    expect(all.status).toBe(0);
    const parsed = JSON.parse(all.stdout) as Array<{ id: string; type: string }>;
    expect(parsed.map((c) => c.id)).toEqual([
      "convention/use-pnpm",
      "debugging/flaky-port-bind",
    ]);
    const filtered = run(["list", "--dir", bundleDir, "--type", "Convention"]);
    expect(filtered.stdout).toContain("convention/use-pnpm");
    expect(filtered.stdout).not.toContain("flaky-port-bind");
  });

  it("recall ranks a matching concept first", () => {
    const result = run(["recall", "pnpm", "install", "--dir", bundleDir, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<{ id: string; score: number }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]?.id).toBe("convention/use-pnpm");
    expect(parsed[0]?.score).toBeGreaterThan(0);
  });

  it("recall reports no matches without failing", () => {
    const result = run(["recall", "zzzunmatchedterm", "--dir", bundleDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No matches.");
  });

  it("check passes on a conformant bundle", () => {
    const result = run(["check", "--dir", bundleDir, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      conformant: boolean;
      concepts: number;
      errors: number;
    };
    expect(parsed.conformant).toBe(true);
    expect(parsed.concepts).toBe(2);
    expect(parsed.errors).toBe(0);
  });

  it("check fails (exit 1) once a hard-nonconformant file appears", () => {
    writeFileSync(
      path.join(bundleDir, "rot.md"),
      "---\ntitle: no type\n---\nBody.\n",
    );
    const result = run(["check", "--dir", bundleDir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("type-missing");
    rmSync(path.join(bundleDir, "rot.md"));
  });

  it("denies a path escape with a containment error (exit 1)", () => {
    const result = run([
      "add",
      "--dir",
      bundleDir,
      "--type",
      "X",
      "--path",
      "../evil.md",
      "--body",
      "nope",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("escapes the bundle root");
    expect(existsSync(path.join(tmp, "repo", "evil.md"))).toBe(false);
  });

  it("reports a missing --body-file as a clean one-line failure", () => {
    const result = run([
      "add",
      "--dir",
      bundleDir,
      "--type",
      "X",
      "--path",
      "nope/from-file.md",
      "--body-file",
      path.join(tmp, "does-not-exist.md"),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read --body-file");
    expect(result.stderr).not.toContain("at "); // no stack trace
  });

  it("fails usage errors with exit 2", () => {
    const missingType = run(["add", "--dir", bundleDir, "--title", "no type"]);
    expect(missingType.status).toBe(2);
    const unknown = run(["frobnicate"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown command");
  });

  it("errors cleanly when no bundle can be found", () => {
    const lonely = mkdtempSync(path.join(os.tmpdir(), "memory-nobundle-"));
    try {
      const result = run(["list"], { cwd: lonely });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no bundle found");
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });
});
