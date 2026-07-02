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
 *
 * `--no-inline-config` mirrors the ui-design-system-gate invocation: the
 * "exemptions are files-glob carve-outs, never inline eslint-disable"
 * contract must hold in this harness exactly as it does in the gate.
 */
function lintFile(file: string): Array<{
  filePath: string;
  messages: Array<{ ruleId: string | null; message: string; severity: number }>;
  errorCount: number;
}> {
  try {
    const stdout = execSync(
      `pnpm exec eslint --no-ignore --no-inline-config --format json "${file}"`,
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

// ───── Arbitrary color/type ban helpers (TYPE_BANS, cinatra#803) ─────

const TYPE_BAN_FRAGMENTS = [
  "Arbitrary color value",
  "Manual dark: color override",
  "Arbitrary text-[…] font size",
  "Arbitrary tracking-[…] letter-spacing",
];

function typeBanMessages(result: ReturnType<typeof lintFile>) {
  const all = result[0];
  expect(all).toBeDefined();
  return all.messages.filter(
    (m) =>
      m.ruleId === "no-restricted-syntax" &&
      TYPE_BAN_FRAGMENTS.some((fragment) => m.message.includes(fragment)),
  );
}

function expectTypeBan(
  result: ReturnType<typeof lintFile>,
  messageSubstring: string,
) {
  const matching = typeBanMessages(result).filter((m) =>
    m.message.includes(messageSubstring),
  );
  expect(
    matching.length,
    `Expected a no-restricted-syntax type ban including "${messageSubstring}", got: ${JSON.stringify(result[0]?.messages, null, 2)}`,
  ).toBeGreaterThan(0);
}

function expectNoTypeBans(result: ReturnType<typeof lintFile>) {
  const bans = typeBanMessages(result);
  expect(
    bans,
    `Expected no type-ban violations, got: ${JSON.stringify(bans, null, 2)}`,
  ).toEqual([]);
}

/**
 * Copy a fixture to a repo-relative destination so it is linted under the
 * config layer that owns that zone (the fixtures directory itself sits in
 * the `__tests__` carve-out, where TYPE_BANS intentionally do not apply).
 * Returns the absolute destination path; the caller removes it in afterAll.
 */
function copyFixtureTo(fixture: string, destRelative: string): string {
  const dest = path.join(REPO_ROOT, destRelative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, fixture), dest);
  return dest;
}

describe("sdk-dashboard ESLint import-boundary", () => {
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
    // which is NOT inside the Layer 4 carve-out glob, so the Layer 1
    // client ban still fires. The carve-out message is asserted via
    // eslint.config.mjs CLIENT_BAN.
    const r = lintFile(
      path.join(FIXTURE_DIR, "forbidden-drizzle-cube-client.fixture.ts"),
    );
    expectViolation(r, "shared dashboards client shell");
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

  describe("positive control: drizzle-cube/client is allowed inside packages/dashboards/src/components/", () => {
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

describe("arbitrary color/type className bans (cinatra#803)", () => {
  // Temp copies land in real zone paths (see copyFixtureTo); every path is
  // tracked here and removed in afterAll.
  const tempFiles: string[] = [];
  const EXT_FIXTURE_ROOT = path.join(
    REPO_ROOT,
    "extensions/__eslint-boundary-fixtures__",
  );

  const l1Forbidden = "src/components/__eslint-boundary-type-ban.fixture.tsx";
  const l1LengthBypass =
    "src/components/__eslint-boundary-length-bypass.fixture.tsx";
  const l1BypassForms =
    "src/components/__eslint-boundary-bypass-forms.fixture.tsx";
  const l1NonJsx = "src/lib/__eslint-boundary-type-ban.fixture.ts";
  const l1Allowed = "src/components/__eslint-boundary-type-allowed.fixture.tsx";
  const sdkUiCarveOut =
    "packages/sdk-ui/src/__eslint-boundary-type-carveout.fixture.tsx";
  const extensionCarveOut =
    "extensions/__eslint-boundary-fixtures__/src/type-carveout.fixture.tsx";

  beforeAll(() => {
    tempFiles.push(
      copyFixtureTo("forbidden-arbitrary-type-values.fixture.tsx", l1Forbidden),
      copyFixtureTo("forbidden-text-length-bypass.fixture.tsx", l1LengthBypass),
      copyFixtureTo(
        "forbidden-type-ban-bypass-forms.fixture.tsx",
        l1BypassForms,
      ),
      copyFixtureTo("forbidden-type-values-nonjsx.fixture.ts", l1NonJsx),
      copyFixtureTo("allowed-type-tokens.fixture.tsx", l1Allowed),
      copyFixtureTo(
        "forbidden-arbitrary-type-values.fixture.tsx",
        sdkUiCarveOut,
      ),
      copyFixtureTo(
        "forbidden-arbitrary-type-values.fixture.tsx",
        extensionCarveOut,
      ),
    );
  });

  afterAll(() => {
    for (const f of tempFiles) {
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    if (fs.existsSync(EXT_FIXTURE_ROOT)) {
      fs.rmSync(EXT_FIXTURE_ROOT, { recursive: true });
    }
  });

  it("flags arbitrary color values in the app zone", () => {
    const r = lintFile(path.join(REPO_ROOT, l1Forbidden));
    expectTypeBan(r, "Arbitrary color value");
  });

  it("flags manual dark: color overrides, including variant chains", () => {
    const r = lintFile(path.join(REPO_ROOT, l1Forbidden));
    const darkBans = typeBanMessages(r).filter((m) =>
      m.message.includes("Manual dark: color override"),
    );
    // `dark:text-red-500` and `dark:focus-visible:ring-red-500` both fire.
    expect(darkBans.length).toBeGreaterThanOrEqual(2);
  });

  it("flags arbitrary text-[…] sizes and tracking-[…] letter-spacing", () => {
    const r = lintFile(path.join(REPO_ROOT, l1Forbidden));
    expectTypeBan(r, "Arbitrary text-[…] font size");
    expectTypeBan(r, "Arbitrary tracking-[…] letter-spacing");
  });

  it("flags text-[length:<value>] — the length: prefix is not a bypass", () => {
    const r = lintFile(path.join(REPO_ROOT, l1LengthBypass));
    expectTypeBan(r, "Arbitrary text-[…] font size");
  });

  it("flags color: type-hint arbitrary colors — bg-[color:#…] is not a bypass", () => {
    const r = lintFile(path.join(REPO_ROOT, l1BypassForms));
    const colorBans = typeBanMessages(r).filter((m) =>
      m.message.includes("Arbitrary color value"),
    );
    // `bg-[color:#ff0000]` and `border-[color:rgb(255,0,0)]` both fire.
    expect(colorBans.length).toBeGreaterThanOrEqual(2);
  });

  it("flags dark: overrides behind variant chains — dark:hover:focus:/dark:data-[…]: are not bypasses", () => {
    const r = lintFile(path.join(REPO_ROOT, l1BypassForms));
    const darkBans = typeBanMessages(r).filter((m) =>
      m.message.includes("Manual dark: color override"),
    );
    expect(darkBans.length).toBeGreaterThanOrEqual(2);
  });

  it("flags template-literal class strings — backticks are not a bypass", () => {
    const r = lintFile(path.join(REPO_ROOT, l1BypassForms));
    expectTypeBan(r, "Arbitrary text-[…] font size");
  });

  it("flags .ts template-literal HTML builders (non-JSX layer coverage)", () => {
    const r = lintFile(path.join(REPO_ROOT, l1NonJsx));
    expectTypeBan(r, "Arbitrary tracking-[…] letter-spacing");
  });

  it("allows named tokens, text-[length:inherit], and non-color dark: variants", () => {
    const r = lintFile(path.join(REPO_ROOT, l1Allowed));
    expectNoTypeBans(r);
  });

  it("carves out packages/sdk-ui (the tokens' raw values live there)", () => {
    const r = lintFile(path.join(REPO_ROOT, sdkUiCarveOut));
    expectNoTypeBans(r);
  });

  it("carves out extensions/** internals (gated on sdk-ui adoption, not the type ramp)", () => {
    const r = lintFile(path.join(REPO_ROOT, extensionCarveOut));
    expectNoTypeBans(r);
  });

  it("keeps migration-allowlisted files exempt (shrink-only, cinatra#886)", () => {
    // scope-badge.tsx carries a pre-existing tracking-[0.15em]; the
    // TYPE_ARBITRARY_MIGRATION_ALLOWLIST layer keeps it lint-green until
    // the cinatra#886 migration shrinks the list.
    const r = lintFile(path.join(REPO_ROOT, "src/components/scope-badge.tsx"));
    expectNoTypeBans(r);
  });

  it("keeps the allowlisted .ts HTML builder exempt (markdown-render.ts)", () => {
    const r = lintFile(
      path.join(REPO_ROOT, "packages/chat/src/markdown-render.ts"),
    );
    expectNoTypeBans(r);
  });

  it("carves out eslint.config.mjs itself (its messages spell the banned shapes)", () => {
    const r = lintFile(path.join(REPO_ROOT, "eslint.config.mjs"));
    expectNoTypeBans(r);
  });
});

describe("first-party extension import boundary (cinatra#803)", () => {
  const EXT_FIXTURE_ROOT = path.join(
    REPO_ROOT,
    "extensions/__eslint-boundary-fixtures__",
  );
  const extSrc =
    "extensions/__eslint-boundary-fixtures__/src/app-alias.fixture.tsx";
  const extVendoredUi =
    "extensions/__eslint-boundary-fixtures__/components/ui/app-alias.fixture.tsx";

  beforeAll(() => {
    copyFixtureTo("forbidden-extension-app-alias.fixture.tsx", extSrc);
    copyFixtureTo("forbidden-extension-app-alias.fixture.tsx", extVendoredUi);
  });

  afterAll(() => {
    if (fs.existsSync(EXT_FIXTURE_ROOT)) {
      fs.rmSync(EXT_FIXTURE_ROOT, { recursive: true });
    }
  });

  it("blocks @/* app-alias imports inside extensions/", () => {
    const r = lintFile(path.join(REPO_ROOT, extSrc));
    expectViolation(r, "app-private modules");
  });

  it("keeps the restated Radix ban firing inside extensions/ (last-match-wins)", () => {
    const r = lintFile(path.join(REPO_ROOT, extSrc));
    expectViolation(r, "Radix belongs inside the vendored shadcn primitives");
  });

  it("keeps the Radix allowance in extension vendored-ui dirs while still banning @/*", () => {
    const r = lintFile(path.join(REPO_ROOT, extVendoredUi));
    expectViolation(r, "app-private modules");
    const radix = r[0].messages.filter(
      (m) =>
        m.ruleId === "no-restricted-imports" &&
        m.message.includes("Radix belongs"),
    );
    expect(
      radix,
      `Radix must stay allowed in extension vendored-ui dirs, got: ${JSON.stringify(radix, null, 2)}`,
    ).toEqual([]);
  });
});
