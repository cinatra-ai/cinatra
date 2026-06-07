import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURE_DIR = path.join(__dirname, "fixtures");

/**
 * Run ESLint against a single file using the project's flat config.
 * Returns the JSON-formatted result array (one entry per file).
 *
 * `--no-ignore` defeats the `globalIgnores` entry that excludes the fixture
 * directory from `pnpm lint` (the fixtures intentionally violate the
 * boundary rules; default lint must skip them to stay green).
 */
function lintFile(file: string): Array<{
  filePath: string;
  messages: Array<{ ruleId: string | null; message: string; severity: number }>;
  errorCount: number;
}> {
  try {
    const stdout = execSync(
      `pnpm exec eslint --no-ignore --format json "${file}"`,
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      },
    );
    return JSON.parse(stdout);
  } catch (err) {
    const exec = err as { stdout?: Buffer | string; status?: number };
    const stdout = exec.stdout?.toString() ?? "";
    if (!stdout) {
      throw err;
    }
    return JSON.parse(stdout);
  }
}

function expectViolation(
  result: ReturnType<typeof lintFile>,
  messageSubstring: string,
) {
  const all = result[0];
  expect(all).toBeDefined();
  const matching = all.messages.filter(
    (m) =>
      m.ruleId === "no-restricted-imports" &&
      m.message.includes(messageSubstring),
  );
  expect(
    matching.length,
    `Expected no-restricted-imports rule with message including "${messageSubstring}", got: ${JSON.stringify(all.messages, null, 2)}`,
  ).toBeGreaterThan(0);
}

function expectNoBoundaryViolation(result: ReturnType<typeof lintFile>) {
  const all = result[0];
  expect(all).toBeDefined();
  const boundary = all.messages.filter(
    (m) => m.ruleId === "no-restricted-imports",
  );
  expect(
    boundary,
    `Expected no no-restricted-imports violations, got: ${JSON.stringify(boundary, null, 2)}`,
  ).toEqual([]);
}

describe("sdk-dashboard ESLint import-boundary (ADR 0044)", () => {
  it("blocks @/* imports from inside sdk-dashboard", () => {
    const r = lintFile(
      path.join(FIXTURE_DIR, "forbidden-cinatra-import.fixture.ts"),
    );
    expectViolation(r, "Cinatra app source");
  });

  it("blocks @cinatra/* imports from inside sdk-dashboard", () => {
    const r = lintFile(
      path.join(FIXTURE_DIR, "forbidden-cinatra-package-import.fixture.ts"),
    );
    expectViolation(r, "Cinatra packages");
  });

  it("blocks better-auth imports from inside sdk-dashboard", () => {
    const r = lintFile(
      path.join(FIXTURE_DIR, "forbidden-better-auth-import.fixture.ts"),
    );
    expectViolation(r, "better-auth");
  });

  it("blocks bullmq imports from inside sdk-dashboard", () => {
    const r = lintFile(
      path.join(FIXTURE_DIR, "forbidden-bullmq-import.fixture.ts"),
    );
    expectViolation(r, "bullmq");
  });

  it("blocks drizzle-cube/* imports outside the adapter directory", () => {
    const r = lintFile(
      path.join(
        FIXTURE_DIR,
        "forbidden-drizzle-cube-outside-adapter.fixture.ts",
      ),
    );
    expectViolation(r, "must live in packages/sdk-dashboard/src/adapters/drizzle-cube/");
  });

  it("blocks drizzle-cube/* imports across the repository", () => {
    // The drizzle-cube ban must apply outside packages/sdk-dashboard/src/** so
    // no other repo path can import drizzle-cube/server. This fixture proves
    // the ban applies everywhere via the Layer 1 config block.
    const r = lintFile(
      path.join(FIXTURE_DIR, "forbidden-drizzle-cube-anywhere.fixture.ts"),
    );
    expectViolation(r, "must live in packages/sdk-dashboard/src/adapters/drizzle-cube/");
  });

  it("blocks drizzle-cube/client/* imports outside the dashboards-components carve-out", () => {
    // The fixture lives under packages/sdk-dashboard/src/__tests__/fixtures/,
    // which is NOT inside the ADR-0045 Layer 4 carve-out glob, so the Layer 1
    // client ban still fires. The ADR 0045 carve-out message is asserted via
    // eslint.config.mjs CLIENT_BAN.
    const r = lintFile(
      path.join(FIXTURE_DIR, "forbidden-drizzle-cube-client.fixture.ts"),
    );
    expectViolation(r, "ADR 0045");
  });

  it("blocks drizzle-cube/mcp imports outside the adapter directory", () => {
    const r = lintFile(
      path.join(FIXTURE_DIR, "forbidden-drizzle-cube-mcp.fixture.ts"),
    );
    expectViolation(r, "actor context");
  });

  describe("positive control: drizzle-cube/server is allowed inside the adapter", () => {
    const tempInAdapter = path.join(
      REPO_ROOT,
      "packages/sdk-dashboard/src/adapters/drizzle-cube/__boundary-fixture-allowed.fixture.ts",
    );

    beforeAll(() => {
      fs.copyFileSync(
        path.join(FIXTURE_DIR, "allowed-drizzle-cube-in-adapter.fixture.ts"),
        tempInAdapter,
      );
    });

    afterAll(() => {
      if (fs.existsSync(tempInAdapter)) fs.rmSync(tempInAdapter);
    });

    it("does NOT trigger no-restricted-imports for drizzle-cube/server", () => {
      const r = lintFile(tempInAdapter);
      expectNoBoundaryViolation(r);
    });
  });

  describe("positive control: drizzle-cube/mcp is allowed inside the adapter", () => {
    const tempInAdapter = path.join(
      REPO_ROOT,
      "packages/sdk-dashboard/src/adapters/drizzle-cube/__boundary-fixture-mcp-allowed.fixture.ts",
    );

    beforeAll(() => {
      fs.copyFileSync(
        path.join(FIXTURE_DIR, "allowed-drizzle-cube-mcp-in-adapter.fixture.ts"),
        tempInAdapter,
      );
    });

    afterAll(() => {
      if (fs.existsSync(tempInAdapter)) fs.rmSync(tempInAdapter);
    });

    it("does NOT trigger no-restricted-imports for drizzle-cube/mcp", () => {
      const r = lintFile(tempInAdapter);
      expectNoBoundaryViolation(r);
    });
  });

  describe("positive control: drizzle-cube/client is allowed inside packages/dashboards/src/components/ (ADR 0045)", () => {
    // The fixture lives at a permanent path under the Layer 4 carve-out glob
    // `packages/dashboards/src/components/**/*.{ts,tsx}` and is not copied.
    const allowedFixture = path.join(
      REPO_ROOT,
      "packages/dashboards/src/components/__fixtures__/dc-client-allowed.fixture.tsx",
    );

    it("does NOT trigger no-restricted-imports for drizzle-cube/client", () => {
      const r = lintFile(allowedFixture);
      expectNoBoundaryViolation(r);
    });
  });
});
