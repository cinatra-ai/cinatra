/**
 * Verify publishAgentPackageFromGitDir's tarball file-set matches the scanner
 * file-set.
 *
 * The publisher must not blindly copy everything under agentDir. Directories
 * and files skipped by the scanner, including node_modules/, dist/, .git/,
 * symlinks, and blocked .env files, must also be excluded from the tarball.
 * Otherwise, a credential placed in any skipped-but-copied path could slip
 * past both the MCP sibling-scan gate and the last-resort throw.
 *
 * The publisher uses walkPackageFiles(), the same walker the scanner uses.
 * Generated dirs, symlinks, and blocked .env* files are excluded from both
 * scan and tarball.
 *
 * These tests invoke walkPackageFiles directly and verify the file-set shape.
 * Full end-to-end tarball construction is covered by publish-vendor-guard.test.ts;
 * here we lock the invariant.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { walkPackageFiles } from "../scan-package-siblings";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publish-align-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

describe("publishAgentPackageFromGitDir tarball alignment with scanner", () => {
  it("EXCLUDES node_modules/ from publishable file-set", async () => {
    await write("package.json", '{"name":"@cinatra/x"}');
    await write("cinatra/oas.json", '{"agentspec_version":"26.1.0"}');
    await write("node_modules/leak/file.txt", "sk-test1234567890abcdef1234567890ABCDEF12");
    await write("node_modules/leak/.env", "GIT_TOKEN=gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890");

    const files = await walkPackageFiles(tmpRoot);
    const relPaths = files.map((f) => f.relPath);
    expect(relPaths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    // Confirm the expected files ARE included
    expect(relPaths).toContain("package.json");
    expect(relPaths).toContain("cinatra/oas.json");
  });

  it("EXCLUDES dist/, build/, .git/, .next/, out/, coverage/ (generated dirs)", async () => {
    await write("package.json", "{}");
    for (const dir of ["dist", "build", ".git", ".next", "out", "coverage"]) {
      await write(`${dir}/leaked.txt`, "sk-test1234567890abcdef1234567890ABCDEF12");
    }
    const files = await walkPackageFiles(tmpRoot);
    const relPaths = files.map((f) => f.relPath);
    for (const dir of ["dist", "build", ".git", ".next", "out", "coverage"]) {
      expect(relPaths.some((p) => p.startsWith(`${dir}/`))).toBe(false);
    }
  });

  it("EXCLUDES symlinks (anti-escape)", async () => {
    await write("package.json", "{}");
    await fs.symlink("/etc/passwd", path.join(tmpRoot, "evil-link"));
    const files = await walkPackageFiles(tmpRoot);
    expect(files.some((f) => f.relPath === "evil-link")).toBe(false);
  });

  it("TAGS .env* files (publisher will skip; gate will block before reaching publish)", async () => {
    await write("package.json", "{}");
    await write(".env", "FOO=bar");
    await write(".env.local", "X=1");
    await write(".env.example", "FOO=placeholder");

    const files = await walkPackageFiles(tmpRoot);
    const envBlocked = files.filter((f) => f.isEnvBlocked).map((f) => f.relPath);
    expect(envBlocked.sort()).toEqual([".env", ".env.local"]);
    // .env.example is NOT blocked
    expect(files.find((f) => f.relPath === ".env.example")?.isEnvBlocked).toBe(false);
  });

  it("INCLUDES legitimate sibling files (SKILL.md, scripts, cinatra/, skills/)", async () => {
    await write("package.json", "{}");
    await write("cinatra/oas.json", "{}");
    await write("skills/x/SKILL.md", "## What I do");
    await write("scripts/build.sh", "#!/bin/sh\necho hi");
    await write("README.md", "# x");
    await write("LICENSE", "MIT");

    const files = await walkPackageFiles(tmpRoot);
    const relPaths = files.map((f) => f.relPath);
    expect(relPaths).toContain("package.json");
    expect(relPaths).toContain("cinatra/oas.json");
    expect(relPaths).toContain("skills/x/SKILL.md");
    expect(relPaths).toContain("scripts/build.sh");
    expect(relPaths).toContain("README.md");
    expect(relPaths).toContain("LICENSE");
  });

  it("INVARIANT: every file the scanner sees CAN be published; nothing extra can", async () => {
    // Build a realistic package shape with a mix of legitimate + skippable files.
    await write("package.json", '{"name":"@cinatra/x"}');
    await write("cinatra/oas.json", "{}");
    await write("skills/x/SKILL.md", "Clean skill");
    await write("README.md", "Clean readme");
    await write("logo.svg", "<svg/>");
    await write("node_modules/dep/index.js", "module.exports = {}");
    await write(".git/HEAD", "ref: refs/heads/main");
    await fs.symlink("/tmp/external", path.join(tmpRoot, "symlink-out"));

    const scannerFiles = await walkPackageFiles(tmpRoot);
    const scannerSet = new Set(scannerFiles.map((f) => f.relPath));

    // The publisher iterates exactly this list (minus synthesized
    // package.json/agent.json + blocked .env files). Verify the invariant:
    // anything in the scanner set is publishable; nothing OUTSIDE the scanner
    // set can be published.
    expect(scannerSet.has("node_modules/dep/index.js")).toBe(false);
    expect(scannerSet.has(".git/HEAD")).toBe(false);
    expect(scannerSet.has("symlink-out")).toBe(false);
    // Legitimate files ARE in the scanner set
    expect(scannerSet.has("package.json")).toBe(true);
    expect(scannerSet.has("cinatra/oas.json")).toBe(true);
    expect(scannerSet.has("skills/x/SKILL.md")).toBe(true);
    expect(scannerSet.has("README.md")).toBe(true);
    expect(scannerSet.has("logo.svg")).toBe(true);
  });
});
