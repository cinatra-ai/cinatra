import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// cinatra.artifact.ui — the versioned renderer block (cinatra#1621, epic #1620).
// ---------------------------------------------------------------------------

const UI_RULES = loadLiveRules(REPO_ROOT);
const GEN_UI_RANGE = UI_RULES.artifactUiSdkAbiRange;

function artifactUiFixture({ ui, files = ["src", "cinatra"], entryFile = "src/detail.tsx", withEntryFile = true } = {}) {
  const pkg = {
    name: "@cinatra-ai/fixture-artifact",
    version: "0.0.1",
    license: "Apache-2.0",
    files,
    main: "src/index.ts",
    cinatra: {
      kind: "artifact",
      apiVersion: "cinatra.ai/v1",
      artifact: {
        accepts: { file: { mimeTypes: ["text/markdown"] } },
        ...(ui !== undefined ? { ui } : {}),
      },
    },
  };
  const out = {
    "package.json": JSON.stringify(pkg, null, 2),
    "README.md": "# Fixture Artifact\n",
    "src/index.ts": "export {};\n",
  };
  if (withEntryFile) out[entryFile] = "export default function R() { return null; }\n";
  return out;
}

const validUiBlock = () => ({
  abiVersion: UI_RULES.artifactUiAbiVersion,
  sdkAbiRange: GEN_UI_RANGE,
  renderers: { detail: { entry: "./src/detail.tsx", propsApiVersion: 1 } },
});

describe("conformance-gate — artifact-ui rule derivation (cinatra#1621)", () => {
  it("derives the v1 slot enum, ui ABI version, and generated sdkAbiRange from live leaf source", () => {
    expect(UI_RULES.ok).toBe(true);
    expect(UI_RULES.artifactUiSlots.has("detail")).toBe(true);
    expect(UI_RULES.artifactUiSlots.has("preview")).toBe(true);
    expect(UI_RULES.artifactUiReservedSlots.has("listRow")).toBe(true);
    expect(UI_RULES.artifactUiAbiVersion).toBe(1);
    expect(GEN_UI_RANGE).toMatch(/^\^\d+\.\d+\.\d+$/);
  });
});

describe("conformance-gate — cinatra.artifact.ui (fail-closed at publish)", () => {
  it("conforms cleanly with a valid v1 ui block (entry ships via files)", () => {
    const pkgDir = writeFixture(artifactUiFixture({ ui: validUiBlock() }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.infra).toBe(false);
    expect(result.blocking.filter((f) => f.rule.startsWith("manifest.artifact-ui"))).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a renderer requesting host ports (v1 declares none)", () => {
    const ui = validUiBlock();
    ui.renderers.detail.ports = ["settings"];
    const pkgDir = writeFixture(artifactUiFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-renderer-ports")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a RESERVED slot (listRow) in v1", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, renderers: { listRow: { entry: "./src/detail.tsx", propsApiVersion: 1 } } };
    const pkgDir = writeFixture(artifactUiFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-unknown-slot")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a hand-written sdkAbiRange that is not the generated value", () => {
    const ui = { ...validUiBlock(), sdkAbiRange: "^2" };
    const pkgDir = writeFixture(artifactUiFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-sdk-abi-range")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a host-SATISFIABLE but non-canonical range at the gate (publish pins the exact generated value; the host tolerates it)", () => {
    const ui = { ...validUiBlock(), sdkAbiRange: "^2.0.0" };
    const pkgDir = writeFixture(artifactUiFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-sdk-abi-range")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an extraneous TOP-LEVEL ui key (gate is never looser than the leaf .strict())", () => {
    const ui = { ...validUiBlock(), somethingElse: true };
    const pkgDir = writeFixture(artifactUiFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-extraneous-key")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags the wrong ui abiVersion", () => {
    const ui = { ...validUiBlock(), abiVersion: 2 };
    const pkgDir = writeFixture(artifactUiFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-abi-version")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an entry that does not ship in the package (unresolved)", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, renderers: { detail: { entry: "./src/missing.tsx", propsApiVersion: 1 } } };
    const pkgDir = writeFixture(artifactUiFixture({ ui, withEntryFile: false }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-entry-unresolved")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an uncontained (traversing) entry", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, renderers: { detail: { entry: "../escape.tsx", propsApiVersion: 1 } } };
    const pkgDir = writeFixture(artifactUiFixture({ ui, withEntryFile: false }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-entry-uncontained")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an entry that resolves OUTSIDE the published files allowlist", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, renderers: { detail: { entry: "./tools/detail.tsx", propsApiVersion: 1 } } };
    const files = artifactUiFixture({ ui, withEntryFile: false });
    files["tools/detail.tsx"] = "export default function R() { return null; }\n";
    const pkgDir = writeFixture(files);
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-entry-out-of-scope")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("still bans a TOP-LEVEL cinatra.sdkAbiRange on an artifact (nested ui.sdkAbiRange is separate)", () => {
    const files = artifactUiFixture({ ui: validUiBlock() });
    const pkg = JSON.parse(files["package.json"]);
    pkg.cinatra.sdkAbiRange = "^2";
    files["package.json"] = JSON.stringify(pkg, null, 2);
    const pkgDir = writeFixture(files);
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-sdk-abi-range-present")).toBe(true);
    // The nested ui block itself is still conformant.
    expect(result.blocking.filter((f) => f.rule.startsWith("manifest.artifact-ui"))).toEqual([]);
    rmSync(pkgDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// cinatra.views — chat renderable-view declaration surface (cinatra#1626, epic
// #1620 S9/M4). FAIL-CLOSED at the publish gate; CROSS-KIND (validated for every
// kind). Uses a connector fixture (no top-level key allowlist) so the chat-views
// rules are isolated. The abiVersion literal is DERIVED from the live leaf.
// ---------------------------------------------------------------------------

// Inject a `cinatra.views` block into the clean connector fixture (merged into
// the cinatra block, not replacing it) and (by default) SHIP the renderer entry
// files so a well-formed block resolves within the published `files` scope.
function connectorWithViews(views, { shipEntry = true } = {}) {
  const files = cleanConnectorFiles({
    pkg: { cinatra: { ...CLEAN_CONNECTOR_PKG.cinatra, views } },
  });
  if (shipEntry) {
    files["src/views/chart.tsx"] = "export default function Chart() { return null; }\n";
    files["src/views/chart2.tsx"] = "export default function Chart2() { return null; }\n";
  }
  return files;
}
const validViewEntry = { viewType: "chart", entry: "./src/views/chart.tsx", propsApiVersion: 1 };
const chatViewsBlockingRules = (result) =>
  result.blocking.filter((f) => f.rule.startsWith("manifest.chat-views")).map((f) => f.rule);

describe("conformance-gate — cinatra.views derivation + leaf parity (cinatra#1626)", () => {
  it("derives the views ABI version from live leaf source", () => {
    expect(UI_RULES.ok).toBe(true);
    expect(UI_RULES.chatViewsAbiVersion).toBe(1);
  });

  it("the gate-derived views ABI version equals the leaf's declared literal (mirror parity)", () => {
    // Independent extraction of CHAT_VIEWS_ABI_VERSION straight from the leaf
    // source — proves loadLiveRules DERIVES the same value the leaf declares
    // (never a re-listed copy; the #979 addendum principle). This is the
    // leaf↔gate parity guard for the top-level cinatra.views field (the analog
    // of the S1 objects↔extensions byte-mirror, which does not apply to a
    // generator+gate-consumed top-level field).
    const leafSrc = readFileSync(
      join(REPO_ROOT, "packages/sdk-extensions/src/chat-views-contract.ts"),
      "utf8",
    );
    const m = /export const CHAT_VIEWS_ABI_VERSION\s*=\s*(\d+)/.exec(leafSrc);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(UI_RULES.chatViewsAbiVersion);
  });
});

describe("conformance-gate — cinatra.views (fail-closed at publish)", () => {
  it("conforms cleanly with a valid v1 views block", () => {
    const pkgDir = writeFixture(connectorWithViews({ abiVersion: 1, entries: [validViewEntry] }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.infra).toBe(false);
    expect(chatViewsBlockingRules(result)).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a duplicate viewType (one effective provider per viewType)", () => {
    const views = { abiVersion: 1, entries: [validViewEntry, { ...validViewEntry, entry: "./src/views/chart2.tsx" }] };
    const pkgDir = writeFixture(connectorWithViews(views));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(chatViewsBlockingRules(result)).toContain("manifest.chat-views-duplicate-viewtype");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a non-snake_case viewType", () => {
    const pkgDir = writeFixture(connectorWithViews({ abiVersion: 1, entries: [{ ...validViewEntry, viewType: "Chart" }] }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(chatViewsBlockingRules(result)).toContain("manifest.chat-views-viewtype");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a wrong abiVersion (derived, fail-closed)", () => {
    const pkgDir = writeFixture(connectorWithViews({ abiVersion: 2, entries: [validViewEntry] }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(chatViewsBlockingRules(result)).toContain("manifest.chat-views-abi-version");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an uncontained (traversing) entry", () => {
    const pkgDir = writeFixture(connectorWithViews({ abiVersion: 1, entries: [{ ...validViewEntry, entry: "../escape.tsx" }] }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(chatViewsBlockingRules(result)).toContain("manifest.chat-views-entry-path");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an extraneous entry key (closed v1 shape declares no host ports)", () => {
    const pkgDir = writeFixture(connectorWithViews({ abiVersion: 1, entries: [{ ...validViewEntry, ports: ["settings"] }] }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(chatViewsBlockingRules(result)).toContain("manifest.chat-views-entry-extraneous-key");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an empty entries array", () => {
    const pkgDir = writeFixture(connectorWithViews({ abiVersion: 1, entries: [] }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(chatViewsBlockingRules(result)).toContain("manifest.chat-views-empty");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an entry that does not ship in the package (unresolved) — as rigorous as artifact-ui renderers", () => {
    const pkgDir = writeFixture(connectorWithViews({ abiVersion: 1, entries: [validViewEntry] }, { shipEntry: false }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(chatViewsBlockingRules(result)).toContain("manifest.chat-views-entry-unresolved");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an entry that resolves OUTSIDE the published files allowlist", () => {
    const files = connectorWithViews(
      { abiVersion: 1, entries: [{ viewType: "chart", entry: "./tools/chart.tsx", propsApiVersion: 1 }] },
      { shipEntry: false },
    );
    files["tools/chart.tsx"] = "export default function Chart() { return null; }\n";
    const pkgDir = writeFixture(files);
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(chatViewsBlockingRules(result)).toContain("manifest.chat-views-entry-out-of-scope");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("a connector with NO views block is unaffected (optional)", () => {
    const pkgDir = writeFixture(cleanConnectorFiles());
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(chatViewsBlockingRules(result)).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("an ARTIFACT extension MAY declare a top-level cinatra.views (the initial carrier — cinatra#1626 allowlist widening)", () => {
    // The artifact kind is the initial cinatra.views carrier: `views` is admitted
    // to ARTIFACT_ALLOWED_CINATRA_KEYS, so a well-formed block does NOT trip the
    // artifact-extraneous-keys gate, and the views content itself conforms.
    const files = artifactUiFixture({ ui: validUiBlock() });
    const pkg = JSON.parse(files["package.json"]);
    pkg.cinatra.views = { abiVersion: 1, entries: [validViewEntry] };
    files["package.json"] = JSON.stringify(pkg, null, 2);
    files["src/views/chart.tsx"] = "export default function Chart() { return null; }\n";
    const pkgDir = writeFixture(files);
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-extraneous-keys")).toBe(false);
    expect(chatViewsBlockingRules(result)).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// cinatra.artifact.ui.registryItems — extension-contributed shadcn registry
// items (cinatra#1623, epic #1620 S5). FAIL-CLOSED at the publish gate.
// ---------------------------------------------------------------------------

const statTile = (over = {}) => ({
  name: "stat-tile",
  entry: "./src/registry/stat-tile.tsx",
  type: "registry:ui",
  description: "A presentational KPI stat tile.",
  ...over,
});

// A fixture whose ui declares registryItems (+ optional renderers), with the
// item entry files written so they resolve within `files`.
function registryItemsFixture({ ui, extraFiles = {} } = {}) {
  const files = artifactUiFixture({ ui, withEntryFile: Boolean(ui.renderers) });
  files["src/registry/stat-tile.tsx"] = "export default function StatTile() { return null; }\n";
  for (const [k, v] of Object.entries(extraFiles)) files[k] = v;
  return files;
}

describe("conformance-gate — artifact-ui registryItems rule derivation (cinatra#1623)", () => {
  it("derives the closed registry-item type enum from live leaf source", () => {
    expect(UI_RULES.artifactUiRegistryItemTypes.has("registry:ui")).toBe(true);
    expect(UI_RULES.artifactUiRegistryItemTypes.has("registry:lib")).toBe(true);
  });
});

describe("conformance-gate — cinatra.artifact.ui.registryItems (fail-closed at publish)", () => {
  it("conforms with renderers + registryItems (both ship)", () => {
    const ui = { ...validUiBlock(), registryItems: [statTile()] };
    const pkgDir = writeFixture(registryItemsFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.infra).toBe(false);
    expect(result.blocking.filter((f) => f.rule.startsWith("manifest.artifact-ui"))).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("conforms with registryItems ONLY (no renderers — the S5 optional-coupling relaxation)", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, registryItems: [statTile()] };
    const pkgDir = writeFixture(registryItemsFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.infra).toBe(false);
    expect(result.blocking.filter((f) => f.rule.startsWith("manifest.artifact-ui"))).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an empty ui block (NEITHER renderers nor registryItems)", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE };
    const pkgDir = writeFixture(artifactUiFixture({ ui, withEntryFile: false }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-empty")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an empty registryItems array", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, registryItems: [] };
    const pkgDir = writeFixture(artifactUiFixture({ ui, withEntryFile: false }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-registry-items-shape")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a registry item declaring a disallowed field (npm/registry deps are extracted from SOURCE, never declared)", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, registryItems: [statTile({ dependencies: ["radix-ui"] })] };
    const pkgDir = writeFixture(registryItemsFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-registry-item-extraneous-key")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a non-strict-lowercase component name", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, registryItems: [statTile({ name: "StatTile" })] };
    const pkgDir = writeFixture(registryItemsFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-registry-item-name")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a registry item whose entry does not resolve in the package", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, registryItems: [statTile({ entry: "./src/registry/missing.tsx" })] };
    const pkgDir = writeFixture(registryItemsFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-registry-item-entry-unresolved")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an unknown registry item type", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, registryItems: [statTile({ type: "registry:page" })] };
    const pkgDir = writeFixture(registryItemsFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-registry-item-type")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an empty description", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, registryItems: [statTile({ description: "" })] };
    const pkgDir = writeFixture(registryItemsFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-registry-item-description")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags duplicate registry item names within a manifest", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, registryItems: [statTile(), statTile()] };
    const pkgDir = writeFixture(registryItemsFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-registry-item-duplicate-name")).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });
});
