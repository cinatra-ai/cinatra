/**
 * Unit tests for the sibling-file credential scanner.
 *
 * Locks the scanner contract:
 * - Scans every UTF-8 text file under a package root.
 * - Skips known generated dirs (node_modules, dist, .git, etc.) + symlinks.
 * - Skips binary extensions.
 * - Lockfile-aware: skips generic entropy noise but flags credential prefixes + JWTs.
 * - Blocks non-example .env* files outright (regardless of content).
 * - Caps per-file scan at 1 MB; emits a warning, never silently skips.
 * - Findings NEVER echo the matched secret string.
 * - Deterministic: alphabetical traversal, POSIX separators.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  isBlockedEnvFile,
  walkPackageFiles,
  scanPackageSiblingFilesForLiteralSecrets,
  SKIP_DIRS,
  BINARY_EXTS,
  LOCKFILE_BASENAMES,
  MAX_SCAN_BYTES,
} from "../scan-package-siblings";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sibling-scanner-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

describe("isBlockedEnvFile", () => {
  it("blocks bare .env", () => {
    expect(isBlockedEnvFile(".env")).toBe(true);
  });
  it("blocks .env.local / .env.production", () => {
    expect(isBlockedEnvFile(".env.local")).toBe(true);
    expect(isBlockedEnvFile(".env.production")).toBe(true);
  });
  it("allows .env.example", () => {
    expect(isBlockedEnvFile(".env.example")).toBe(false);
  });
  it("allows *.sample / *.template", () => {
    expect(isBlockedEnvFile(".env.sample")).toBe(false);
    expect(isBlockedEnvFile(".env.template")).toBe(false);
  });
  it("ignores non-env files", () => {
    expect(isBlockedEnvFile("environment.ts")).toBe(false);
    expect(isBlockedEnvFile("package.json")).toBe(false);
  });
});

describe("walkPackageFiles — traversal policy", () => {
  it("returns files in deterministic alphabetical order", async () => {
    await write("zebra.md", "z");
    await write("alpha.md", "a");
    await write("middle.md", "m");
    const out = await walkPackageFiles(tmpRoot);
    expect(out.map((f) => f.relPath)).toEqual(["alpha.md", "middle.md", "zebra.md"]);
  });

  it("skips node_modules / dist / .git / build / .next / out / coverage", async () => {
    await write("README.md", "readme");
    for (const skip of ["node_modules", "dist", ".git", "build", ".next", "out", "coverage"]) {
      await write(`${skip}/leaked.md`, "Bearer sk-1234567890abcdef1234567890ABCDEF12");
    }
    const out = await walkPackageFiles(tmpRoot);
    expect(out.map((f) => f.relPath)).toEqual(["README.md"]);
    // Sanity: SKIP_DIRS constant matches what we tested
    expect(SKIP_DIRS.has("node_modules")).toBe(true);
    expect(SKIP_DIRS.has("dist")).toBe(true);
  });

  it("tags binary extensions but still returns the entry", async () => {
    await write("logo.png", "fake-png");
    await write("README.md", "readme");
    const out = await walkPackageFiles(tmpRoot);
    const png = out.find((f) => f.relPath === "logo.png");
    expect(png?.isBinary).toBe(true);
    expect(BINARY_EXTS.has(".png")).toBe(true);
  });

  it("tags lockfile basenames", async () => {
    await write("package-lock.json", "{}");
    await write("pnpm-lock.yaml", "lockfile: 6.0\n");
    const out = await walkPackageFiles(tmpRoot);
    expect(out.find((f) => f.relPath === "package-lock.json")?.isLockfile).toBe(true);
    expect(out.find((f) => f.relPath === "pnpm-lock.yaml")?.isLockfile).toBe(true);
    expect(LOCKFILE_BASENAMES.has("yarn.lock")).toBe(true);
  });

  it("tags blocked .env* files", async () => {
    await write(".env", "FOO=bar");
    await write(".env.example", "FOO=placeholder");
    const out = await walkPackageFiles(tmpRoot);
    expect(out.find((f) => f.relPath === ".env")?.isEnvBlocked).toBe(true);
    expect(out.find((f) => f.relPath === ".env.example")?.isEnvBlocked).toBe(false);
  });

  it("tags only the canonical OAS path as isCanonicalOasFile", async () => {
    // Canonical OAS files at the well-known cinatra/oas.json or cinatra/agent.json
    // path are exempted (the OAS scanner covers them). Any other location with
    // the same basename — examples, fixtures, nested copies — MUST still be
    // scanned for credentials. This prevents path-matching regressions.
    await write("cinatra/oas.json", "{}");
    await write("cinatra/agent.json", "{}");
    await write("examples/agent.json", "{}");
    await write("tests/fixtures/oas.json", "{}");
    await write("docs/sample-oas.json", "{}");
    await write("regular.json", "{}");
    const out = await walkPackageFiles(tmpRoot);
    expect(out.find((f) => f.relPath === "cinatra/oas.json")?.isCanonicalOasFile).toBe(true);
    expect(out.find((f) => f.relPath === "cinatra/agent.json")?.isCanonicalOasFile).toBe(true);
    // Nested basename-matches MUST NOT be exempt — they would otherwise ship
    // unscanned credentials past the gate.
    expect(out.find((f) => f.relPath === "examples/agent.json")?.isCanonicalOasFile).toBe(false);
    expect(out.find((f) => f.relPath === "tests/fixtures/oas.json")?.isCanonicalOasFile).toBe(false);
    expect(out.find((f) => f.relPath === "docs/sample-oas.json")?.isCanonicalOasFile).toBe(false);
    expect(out.find((f) => f.relPath === "regular.json")?.isCanonicalOasFile).toBe(false);
  });

  it("scans nested agent.json copies for credentials", async () => {
    // Regression test: a credentialled
    // examples/agent.json or tests/fixtures/oas.json would be silently skipped if the matcher used basename equality. The
    // scanner now path-matches only the resolved OAS file at the canonical
    // location, so nested copies are caught.
    await write("cinatra/oas.json", "{}");
    await write("examples/agent.json", '"apiKey": "sk-test1234567890abcdef1234567890ABCDEF12"');
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(
      findings.some(
        (f) =>
          f.code === "literal_credential_in_sibling_file" &&
          f.location?.startsWith("examples/agent.json:"),
      ),
    ).toBe(true);
  });

  it("does not follow symlinks (anti-escape)", async () => {
    await write("regular.md", "content");
    await fs.symlink("/etc/passwd", path.join(tmpRoot, "evil-link"));
    const out = await walkPackageFiles(tmpRoot);
    expect(out.find((f) => f.relPath === "evil-link")).toBeUndefined();
  });

  it("uses POSIX separators in relPath", async () => {
    await write("nested/dir/file.md", "x");
    const out = await walkPackageFiles(tmpRoot);
    expect(out[0]?.relPath).toBe("nested/dir/file.md");
    expect(out[0]?.relPath.includes("\\")).toBe(false);
  });
});

describe("scanPackageSiblingFilesForLiteralSecrets — positive cases", () => {
  it("flags openai-sk key in SKILL.md", async () => {
    await write("skills/x/SKILL.md", "API key: sk-test1234567890abcdef1234567890ABCDEF12");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const credBlockers = findings.filter(
      (f) => f.code === "literal_credential_in_sibling_file" && f.severity === "blocker",
    );
    expect(credBlockers.length).toBeGreaterThan(0);
    expect(credBlockers[0]?.location).toBe("skills/x/SKILL.md:1");
    expect(credBlockers[0]?.message).toContain("pattern=openai-sk");
    // Finding NEVER echoes the secret
    expect(credBlockers[0]?.message).not.toContain("sk-test1234567890abcdef1234567890ABCDEF12");
  });

  it("flags github PAT in package.json", async () => {
    // Place the PAT as the sole content of a token-separated value so the
    // tokenizer hits the github-pat regex directly instead of high-entropy-token.
    await write(
      "package.json",
      '{\n  "name": "@cinatra/x",\n  "githubToken": "gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890"\n}',
    );
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const credBlockers = findings.filter((f) => f.code === "literal_credential_in_sibling_file");
    expect(credBlockers.length).toBeGreaterThan(0);
    expect(credBlockers[0]?.message).toContain("pattern=github-pat");
  });

  it("flags AWS access key in .npmrc as a standalone token", async () => {
    // Place the key as its own line value so the tokenizer hits the AWS regex directly.
    await write(".npmrc", 'registry=https://registry.example.com\naws-key="AKIAIOSFODNN7EXAMPLE"');
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const credBlockers = findings.filter((f) => f.code === "literal_credential_in_sibling_file");
    expect(credBlockers.some((b) => b.message.includes("pattern=aws-access-key"))).toBe(true);
  });

  it("flags credentials embedded in shell-style assignments as high-entropy", async () => {
    // When a credential is glued onto a `KEY=value` style assignment, the
    // tokenizer captures `KEY=value` as a single token. The token doesn't
    // match a known-prefix regex (prefix is anchored at start), but the
    // value-suffix is long + high-entropy → flagged as high-entropy-token.
    // This is correct behavior — credentials get flagged via the fallback.
    await write("scripts/deploy.sh", "#!/bin/sh\nexport GH_TOKEN=gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const credBlockers = findings.filter((f) => f.code === "literal_credential_in_sibling_file");
    expect(credBlockers.length).toBeGreaterThan(0);
    // Either pattern is acceptable — high-entropy-token is the expected fallback path here.
    const patterns = credBlockers.map((b) => b.message);
    expect(patterns.some((m) => m.includes("pattern=github-pat") || m.includes("pattern=high-entropy-token"))).toBe(true);
  });

  it("flags JWT in a script file", async () => {
    await write(
      "scripts/auth.sh",
      "#!/bin/sh\nexport TOKEN=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const credBlockers = findings.filter((f) => f.code === "literal_credential_in_sibling_file");
    expect(credBlockers.some((b) => b.message.includes("pattern=jwt"))).toBe(true);
  });

  it("blocks non-example .env file outright (regardless of content)", async () => {
    await write(".env", "FOO=safe_placeholder_value");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const envBlock = findings.find((f) => f.code === "package_env_file_forbidden");
    expect(envBlock).toBeDefined();
    expect(envBlock?.severity).toBe("blocker");
    expect(envBlock?.location).toBe(".env");
  });

  it("blocks .env.local and .env.production", async () => {
    await write(".env.local", "X=1");
    await write(".env.production", "Y=2");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const envBlockers = findings.filter((f) => f.code === "package_env_file_forbidden");
    expect(envBlockers.map((f) => f.location).sort()).toEqual([".env.local", ".env.production"]);
  });
});

describe("scanPackageSiblingFilesForLiteralSecrets — negative cases", () => {
  it("does NOT flag .env.example", async () => {
    await write(".env.example", "API_KEY=your-key-here");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.filter((f) => f.code === "package_env_file_forbidden")).toEqual([]);
  });

  it("does NOT flag placeholders ({{TOKEN}}, ${TOKEN}, <API_KEY>) in SKILL.md", async () => {
    await write(
      "skills/x/SKILL.md",
      "Pass Authorization: Bearer {{token}}\nOr ${TOKEN}\nOr <API_KEY>\nOr ***\nOr REDACTED",
    );
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.filter((f) => f.code === "literal_credential_in_sibling_file")).toEqual([]);
  });

  it("does NOT flag documentation examples (sk-EXAMPLE)", async () => {
    await write(
      "README.md",
      "Use `sk-EXAMPLE` as your API key placeholder during onboarding.",
    );
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.filter((f) => f.code === "literal_credential_in_sibling_file")).toEqual([]);
  });

  it("does NOT scan oas.json or agent.json (covered by OAS scanner)", async () => {
    await write(
      "cinatra/oas.json",
      '{"system": "Use sk-test1234567890abcdef1234567890ABCDEF12 here"}',
    );
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.filter((f) => f.code === "literal_credential_in_sibling_file")).toEqual([]);
  });

  it("does NOT scan binary extensions", async () => {
    // Write something that LOOKS like a credential into a .png — should be ignored
    await write("logo.png", "Bearer sk-1234567890abcdef1234567890ABCDEF12");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.filter((f) => f.code === "literal_credential_in_sibling_file")).toEqual([]);
  });

  it("does NOT walk node_modules / dist / .git", async () => {
    await write("node_modules/evil/leak.md", "sk-test1234567890abcdef1234567890ABCDEF12");
    await write("dist/leak.md", "sk-test1234567890abcdef1234567890ABCDEF12");
    await write(".git/leak.md", "sk-test1234567890abcdef1234567890ABCDEF12");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.filter((f) => f.code === "literal_credential_in_sibling_file")).toEqual([]);
  });

  it("lockfile integrity hashes do NOT trigger generic entropy", async () => {
    // pnpm-lock.yaml shape: high-entropy sha256 + base64-ish integrity blobs.
    // None of these are credential prefixes, JWT, or trigger the entropy floor
    // when scanned on lines that include the noise patterns we exclude.
    await write(
      "pnpm-lock.yaml",
      [
        "lockfileVersion: '6.0'",
        "packages:",
        "  /lodash@4.17.21:",
        "    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}",
        "    engines: {node: '>=4.0.0'}",
        "  /react@18.2.0:",
        "    resolution: {integrity: sha512-/3IjMdb2L9QbBdWiW5e3P2/npwMBaU9mHCSCUzNln0ZCYbcfTsGbTJrU/kGemdH2IWmB2ioZ+zkxtmq6g09fGQ==}",
      ].join("\n"),
    );
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.filter((f) => f.code === "literal_credential_in_sibling_file")).toEqual([]);
  });

  it("findings never echo the matched secret", async () => {
    const secret = "sk-veryDeterministicSecretWithEnoughLength123";
    await write("README.md", `Use this: ${secret}`);
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.message).not.toContain(secret);
      expect(JSON.stringify(f)).not.toContain(secret);
    }
  });

  it("returns empty findings for a clean package", async () => {
    await write("package.json", '{ "name": "@cinatra/clean", "version": "0.1.0" }');
    await write("skills/x/SKILL.md", "This is a clean skill that does nothing risky.");
    await write("README.md", "# Clean Package");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings).toEqual([]);
  });
});

describe("scanPackageSiblingFilesForLiteralSecrets — edge cases", () => {
  it("emits a warning for files larger than 1 MB", async () => {
    // Write a file slightly larger than MAX_SCAN_BYTES with no credentials
    const big = "x".repeat(MAX_SCAN_BYTES + 100);
    await write("big.md", big);
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const warning = findings.find((f) => f.code === "package_file_too_large_to_scan");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("warning");
    expect(warning?.location).toBe("big.md");
  });

  it("scans extensionless text files (LICENSE, Dockerfile, Makefile)", async () => {
    await write("LICENSE", "Use sk-test1234567890abcdef1234567890ABCDEF12 freely");
    await write("Dockerfile", "ENV API=gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890");
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const credBlockers = findings.filter((f) => f.code === "literal_credential_in_sibling_file");
    expect(credBlockers.length).toBeGreaterThanOrEqual(2);
    const locations = credBlockers.map((f) => f.location);
    expect(locations.some((l) => l?.startsWith("LICENSE"))).toBe(true);
    expect(locations.some((l) => l?.startsWith("Dockerfile"))).toBe(true);
  });

  it("scans .svg files (SVG is text)", async () => {
    await write(
      "icon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg">\n<!-- token: gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890 -->\n</svg>',
    );
    const findings = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(findings.filter((f) => f.code === "literal_credential_in_sibling_file").length).toBeGreaterThan(0);
  });

  it("deterministic finding order across consecutive runs (idempotence)", async () => {
    await write("a.md", "sk-test1234567890abcdef1234567890ABCDEF12");
    await write("b.md", "sk-test1234567890abcdef1234567890ABCDEF12");
    const r1 = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    const r2 = await scanPackageSiblingFilesForLiteralSecrets(tmpRoot);
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2));
  });
});
