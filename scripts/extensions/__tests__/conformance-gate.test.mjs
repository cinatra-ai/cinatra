import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runConformanceGate, CONFORMANCE_GATE_VERSION } from "../conformance-gate.mjs";
import { loadLiveRules } from "../lib/conformance-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function writeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "conformance-gate-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const CLEAN_CONNECTOR_PKG = {
  name: "@cinatra-ai/fixture-connector",
  version: "0.0.1",
  license: "Apache-2.0",
  type: "module",
  files: ["src", "!src/__tests__", "cinatra"],
  main: "src/index.ts",
  exports: { ".": "./src/index.ts", "./register": "./src/register.ts" },
  dependencies: {},
  peerDependencies: { "@cinatra-ai/sdk-extensions": "*", "@cinatra-ai/sdk-ui": "*" },
  cinatra: {
    apiVersion: "cinatra.ai/v1",
    kind: "connector",
    dependencies: [],
    serverEntry: "./register",
    requestedHostPorts: ["capabilities", "ui"],
    sdkAbiRange: "^2",
  },
};

function cleanConnectorFiles(overrides = {}) {
  return {
    "package.json": JSON.stringify({ ...CLEAN_CONNECTOR_PKG, ...overrides.pkg }, null, 2),
    "README.md": "# Fixture Connector\n",
    "src/index.ts": overrides.index ?? 'export {};\n',
    "src/register.ts":
      overrides.register ??
      'import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions/host-context";\n' +
        "export function register(ctx: ExtensionHostContext) {\n" +
        '  ctx.ui.registerAction({});\n' +
        "}\n",
    "cinatra/config.json": overrides.accessConfig ?? JSON.stringify({ formatVersion: 1, access: { scope: { default: "user" } } }, null, 2),
  };
}

describe("conformance-gate — live rule derivation", () => {
  it("derives HOST_PORT_NAMES / ARTIFACT_ALLOWED_CINATRA_KEYS / connector access format version from THIS repo's live sources", () => {
    const rules = loadLiveRules(REPO_ROOT);
    expect(rules.ok).toBe(true);
    expect(rules.hostPortNames.has("ui")).toBe(true);
    expect(rules.hostPortNames.has("capabilities")).toBe(true);
    expect(rules.artifactAllowedCinatraKeys.has("artifact")).toBe(true);
    expect(rules.connectorAccessConfigFormatVersion).toBe(1);
  });

  it("reports an infra error (never a silent pass) when the SDK root doesn't own the expected source files", () => {
    const bogusRoot = mkdtempSync(join(tmpdir(), "conformance-gate-bogus-sdk-"));
    const pkgDir = writeFixture(cleanConnectorFiles());
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: bogusRoot });
    expect(result.infra).toBe(true);
    rmSync(bogusRoot, { recursive: true, force: true });
    rmSync(pkgDir, { recursive: true, force: true });
  });
});

describe("conformance-gate — a conformant connector fixture", () => {
  it("conforms cleanly", () => {
    const pkgDir = writeFixture(cleanConnectorFiles());
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.infra).toBe(false);
    expect(result.conform).toBe(true);
    expect(result.blocking).toEqual([]);
    expect(result.checkerVersion).toBe(CONFORMANCE_GATE_VERSION);
    rmSync(pkgDir, { recursive: true, force: true });
  });
});

describe("conformance-gate — seeded violations (the #979 acceptance proof)", () => {
  it("flags a core-internal `@/` import", () => {
    const pkgDir = writeFixture(cleanConnectorFiles({ index: 'import { thing } from "@/lib/thing";\nexport {};\n' }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "imports.core-internal")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a deep dist/ import", () => {
    const pkgDir = writeFixture(cleanConnectorFiles({ index: 'import { thing } from "@cinatra-ai/some-package/dist/thing.js";\nexport {};\n' }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "imports.deep-dist")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an undeclared/non-SDK first-party @cinatra-ai/* import (cross-extension coupling)", () => {
    const pkgDir = writeFixture(cleanConnectorFiles({ index: 'import { helper } from "@cinatra-ai/some-other-connector/deps";\nexport {};\n' }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "imports.non-sdk-first-party")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an undeclared sdk-extensions subpath (not in its exports map)", () => {
    const pkgDir = writeFixture(cleanConnectorFiles({ index: 'import { x } from "@cinatra-ai/sdk-extensions/not-a-real-subpath";\nexport {};\n' }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "imports.undeclared-sdk-subpath")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("does NOT false-positive on prose containing the word \"from\" outside a real import (comment-stripped, syntax-anchored)", () => {
    const pkgDir = writeFixture(
      cleanConnectorFiles({
        index:
          "// This value is derived from 'some upstream computation', not imported\n" +
          '// redacted: "all fields stripped"\n' +
          "export const ok = true;\n",
      }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a missing cinatra/config.json for a connector", () => {
    const pkgDir = writeFixture(cleanConnectorFiles());
    rmSync(join(pkgDir, "cinatra", "config.json"));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.connector-missing-access-config")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a connector access config with BOTH default and only set (scope XOR violation)", () => {
    const pkgDir = writeFixture(
      cleanConnectorFiles({ accessConfig: JSON.stringify({ formatVersion: 1, access: { scope: { default: "user", only: "admin" } } }) }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.connector-access-config-scope-xor")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a connector access config with the wrong formatVersion", () => {
    const pkgDir = writeFixture(
      cleanConnectorFiles({ accessConfig: JSON.stringify({ formatVersion: 2, access: { scope: { default: "user" } } }) }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.connector-access-config-format-version")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an artifact extension declaring cinatra.sdkAbiRange (must be ABSENT — the #978 fleet-audit false-positive rule, now enforced)", () => {
    const pkgDir = writeFixture({
      "package.json": JSON.stringify(
        {
          name: "@cinatra-ai/fixture-artifact",
          version: "0.0.1",
          license: "Apache-2.0",
          files: ["src", "cinatra"],
          main: "src/index.ts",
          cinatra: {
            kind: "artifact",
            apiVersion: "cinatra.ai/v1",
            artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
            sdkAbiRange: "^2",
          },
        },
        null,
        2,
      ),
      "README.md": "# Fixture Artifact\n",
      "src/index.ts": "export {};\n",
    });
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-sdk-abi-range-present")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an artifact extension with an extraneous cinatra key", () => {
    const pkgDir = writeFixture({
      "package.json": JSON.stringify(
        {
          name: "@cinatra-ai/fixture-artifact",
          version: "0.0.1",
          license: "Apache-2.0",
          files: ["src", "cinatra"],
          main: "src/index.ts",
          cinatra: {
            kind: "artifact",
            apiVersion: "cinatra.ai/v1",
            artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
            riskLevel: "low",
          },
        },
        null,
        2,
      ),
      "README.md": "# Fixture Artifact\n",
      "src/index.ts": "export {};\n",
    });
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-extraneous-keys")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a malformed cinatra.sdkAbiRange", () => {
    const pkgDir = writeFixture(cleanConnectorFiles({ pkg: { cinatra: { ...CLEAN_CONNECTOR_PKG.cinatra, sdkAbiRange: "not-a-range" } } }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.sdk-abi-range-malformed")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an undocumented ctx port used in the resolved serverEntry", () => {
    const pkgDir = writeFixture(
      cleanConnectorFiles({
        register:
          'import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions/host-context";\n' +
          "export function register(ctx: ExtensionHostContext) {\n" +
          "  ctx.filesystem.readEverything();\n" +
          "}\n",
      }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "ctx-ports.undocumented-access" && f.detail.includes("ctx.filesystem"))).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("does NOT flag a ctx.<port> access in a file OTHER than the resolved serverEntry (a webhook handler's differently-typed ctx)", () => {
    const pkgDir = writeFixture({
      ...cleanConnectorFiles(),
      "src/webhooks/post.ts": "export function factory() {\n  return (ctx) => { ctx.webhook.messageId; ctx.log(\"ok\"); };\n}\n",
    });
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a direct node:fs import (cinatra#981) — and comment-only mentions do NOT false-positive", () => {
    const pkgDir = writeFixture(
      cleanConnectorFiles({
        index:
          "// This module deliberately avoids node:fs — see cinatra#981.\n" +
          'import { readFile } from "node:fs/promises";\n' +
          "export {};\n",
      }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "fs-ban.direct-filesystem-access")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a direct process.env read (cinatra#982) — and comment-only mentions do NOT false-positive", () => {
    const pkgDir = writeFixture(
      cleanConnectorFiles({
        index: "// connector code never reads process.env directly (cinatra#982).\nexport const url = process.env.SOME_URL;\n",
      }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "env-ban.direct-process-env-access")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("does not re-flag an fs-ban finding on the checker's own documented allowlist", () => {
    const pkgDir = writeFixture(
      cleanConnectorFiles({
        pkg: { name: "@cinatra-ai/gemini-connector" },
        index: 'export {};\n',
      }),
    );
    // rename the fixture's src/index.ts content to mirror the allowlisted path exactly
    writeFileSync(join(pkgDir, "src", "log-retention.ts"), 'import { unlink } from "node:fs/promises";\nexport {};\n');
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.blocking.some((f) => f.file === "src/log-retention.ts")).toBe(false);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a forbidden file in the published tarball (packlist)", () => {
    const pkgDir = writeFixture({
      ...cleanConnectorFiles(),
      "src/secrets.env": "SECRET=1\n",
    });
    // .env files aren't picked up by the source-file walk; add via package.json files so npm packs it for the test.
    const pkg = JSON.parse(JSON.stringify(CLEAN_CONNECTOR_PKG));
    pkg.files = ["src", "cinatra"];
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkg, null, 2));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "packlist.forbidden-file")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a reference to a non-public org repo (hygiene)", () => {
    const pkgDir = writeFixture(cleanConnectorFiles({ index: "// See cinatra-ai/engineering#123 for the design doc.\nexport {};\n" }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "hygiene.private-repo-reference")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("does NOT flag a reference to cinatra-ai/ci or cinatra-ai/extension-release-tooling (both public shared-tooling repos)", () => {
    const pkgDir = writeFixture(
      cleanConnectorFiles({ index: "// mirrors cinatra-ai/ci's shared gate and cinatra-ai/extension-release-tooling's template.\nexport {};\n" }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.blocking.some((f) => f.rule === "hygiene.private-repo-reference")).toBe(false);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an agent extension missing both a materialized agent.json and a cinatra/oas.json", () => {
    const pkgDir = writeFixture({
      "package.json": JSON.stringify(
        {
          name: "@cinatra-ai/fixture-agent",
          version: "0.0.1",
          license: "Apache-2.0",
          files: ["src", "cinatra"],
          main: "src/index.ts",
          cinatra: { kind: "agent", apiVersion: "cinatra.ai/v1", dependencies: [] },
        },
        null,
        2,
      ),
      "README.md": "# Fixture Agent\n",
      "src/index.ts": "export {};\n",
    });
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.agent-missing-oas")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("follows a local relative re-export from serverEntry to catch ctx misuse in a split lifecycle file (codex convergence finding)", () => {
    const pkgDir = writeFixture({
      ...cleanConnectorFiles({ register: 'export { bootstrap } from "./bootstrap";\nexport { register } from "./register-impl";\n' }),
      "src/register-impl.ts":
        'import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions/host-context";\n' +
        "export function register(ctx: ExtensionHostContext) {\n  ctx.ui.registerAction({});\n}\n",
      "src/bootstrap.ts":
        'import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions/host-context";\n' +
        "export function bootstrap(ctx: ExtensionHostContext) {\n  ctx.notAPort.doThing();\n}\n",
    });
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "ctx-ports.undocumented-access" && f.file === "src/bootstrap.ts")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a dynamic `await import(\"node:fs\")` (codex convergence finding — static-only regex missed this form)", () => {
    const pkgDir = writeFixture(cleanConnectorFiles({ index: 'export async function bad() {\n  const fs = await import("node:fs/promises");\n  return fs;\n}\n' }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "fs-ban.direct-filesystem-access")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a materialized root agent.json with the wrong formatVersion", () => {
    const pkgDir = writeFixture({
      "package.json": JSON.stringify(
        {
          name: "@cinatra-ai/fixture-agent",
          version: "0.0.1",
          license: "Apache-2.0",
          files: ["src", "cinatra"],
          main: "src/index.ts",
          cinatra: { kind: "agent", apiVersion: "cinatra.ai/v1", dependencies: [] },
        },
        null,
        2,
      ),
      "README.md": "# Fixture Agent\n",
      "src/index.ts": "export {};\n",
      "cinatra/oas.json": JSON.stringify({ ok: true }),
      "agent.json": JSON.stringify({ formatVersion: 1 }),
    });
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.agent-json-format-version")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });
});
