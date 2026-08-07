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
    // S7/M2 (cinatra#1631): listRow graduated from RESERVED to the active enum.
    expect(UI_RULES.artifactUiSlots.has("listRow")).toBe(true);
    expect(UI_RULES.artifactUiReservedSlots.has("listRow")).toBe(false);
    expect(UI_RULES.artifactUiReservedSlots.has("card")).toBe(true);
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

  it("accepts the activated listRow slot (S7/M2, cinatra#1631)", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, renderers: { listRow: { entry: "./src/detail.tsx", propsApiVersion: 1 } } };
    const pkgDir = writeFixture(artifactUiFixture({ ui }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.blocking.some((f) => f.rule === "manifest.artifact-ui-unknown-slot")).toBe(false);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a RESERVED slot (card) in v1", () => {
    const ui = { abiVersion: 1, sdkAbiRange: GEN_UI_RANGE, renderers: { card: { entry: "./src/detail.tsx", propsApiVersion: 1 } } };
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
// cinatra.llmProvider — LLM-provider declaration surface (cinatra#1712, epic
// #1711 S1 AC1). OPTIONAL (no connector declares it yet — AC6 later); FAIL-CLOSED
// at the publish gate when PRESENT; ZERO findings when ABSENT. Uses the clean
// connector fixture (an LLM connector is a `kind:"connector"`). The abiVersion +
// vocabularies are DERIVED from the live leaf.
// ---------------------------------------------------------------------------

// A valid v2 declaration mirroring the anthropic build-known catalog entry
// (ABI v2 per cinatra#2093, epic #2086 S6 — adds the two setup-time flags).
const validLlmProvider = {
  abiVersion: 2,
  provider: "anthropic",
  capabilities: {
    function_tools: true,
    media_input: false,
    native_mcp: { status: "native", approval: "unsupported" },
  },
  models: { default: "claude-sonnet-4-6", allowed: ["claude-sonnet-4-6", "claude-opus-4-7"] },
  defaultCapable: true,
  wizardEligible: true,
};
function connectorWithLlmProvider(llmProvider) {
  return cleanConnectorFiles({ pkg: { cinatra: { ...CLEAN_CONNECTOR_PKG.cinatra, llmProvider } } });
}
const llmProviderBlockingRules = (result) =>
  result.blocking.filter((f) => f.rule.startsWith("manifest.llm-provider")).map((f) => f.rule);

describe("conformance-gate — cinatra.llmProvider derivation + leaf parity (cinatra#1712)", () => {
  it("derives the llmProvider ABI version + vocabularies from live leaf source", () => {
    expect(UI_RULES.ok).toBe(true);
    expect(UI_RULES.llmProviderAbiVersion).toBe(2);
    expect([...UI_RULES.llmProviders].sort()).toEqual(["anthropic", "gemini", "openai"]);
    expect(UI_RULES.llmCapabilities).toEqual(["media_input", "function_tools", "native_mcp"]);
    expect([...UI_RULES.nativeMcpStatuses].sort()).toEqual(["dormant", "native", "unsupported"]);
    expect([...UI_RULES.mcpApprovalModes].sort()).toEqual(["approval_required", "auto_execute", "unsupported"]);
  });

  it("the gate-derived llmProvider ABI version equals the leaf's declared literal (mirror parity)", () => {
    // Independent extraction of LLM_PROVIDER_ABI_VERSION straight from the leaf
    // source — proves loadLiveRules DERIVES the same value the leaf declares
    // (never a re-listed copy; the #979 addendum principle). The leaf↔gate parity
    // guard for the top-level cinatra.llmProvider field.
    const leafSrc = readFileSync(
      join(REPO_ROOT, "packages/sdk-extensions/src/llm-provider-contract.ts"),
      "utf8",
    );
    const m = /export const LLM_PROVIDER_ABI_VERSION\s*=\s*(\d+)/.exec(leafSrc);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(UI_RULES.llmProviderAbiVersion);
  });
});

describe("conformance-gate — cinatra.llmProvider (optional; fail-closed at publish)", () => {
  it("a connector with NO llmProvider block is unaffected (optional — the current fleet state)", () => {
    const pkgDir = writeFixture(cleanConnectorFiles());
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(llmProviderBlockingRules(result)).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("conforms cleanly with a valid v2 llmProvider block", () => {
    const pkgDir = writeFixture(connectorWithLlmProvider(validLlmProvider));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.infra).toBe(false);
    expect(llmProviderBlockingRules(result)).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a wrong abiVersion (derived, fail-closed)", () => {
    const pkgDir = writeFixture(connectorWithLlmProvider({ ...validLlmProvider, abiVersion: 3 }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-abi-version");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  // cinatra#2093 (epic #2086 S6) — the ABI v2 flags. PUBLISH is fail-closed on
  // v1 even though the HOST transitionally accepts an allowlisted v1 block:
  // a release is exactly the moment a connector can and must carry v2, and this
  // is the one door the v1-retirement ratchet exists to close.
  it("flags a RETIRING v1 block at publish (the host-side allowlist is not honoured here)", () => {
    const { defaultCapable: _dc, wizardEligible: _we, ...v1 } = validLlmProvider;
    const pkgDir = writeFixture(connectorWithLlmProvider({ ...v1, abiVersion: 1, provider: "gemini", models: { default: "g", allowed: ["g"] } }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-abi-version");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a MISSING v2 flag", () => {
    const { wizardEligible: _omitted, ...noFlag } = validLlmProvider;
    const pkgDir = writeFixture(connectorWithLlmProvider(noFlag));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-flag-type");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a NON-BOOLEAN v2 flag (no truthiness coercion)", () => {
    const pkgDir = writeFixture(connectorWithLlmProvider({ ...validLlmProvider, defaultCapable: "true" }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-flag-type");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags the INCOHERENT wizardEligible-without-defaultCapable combination", () => {
    const pkgDir = writeFixture(
      connectorWithLlmProvider({ ...validLlmProvider, defaultCapable: false, wizardEligible: true }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-wizard-subset");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("accepts the GEMINI matrix (defaultCapable true, wizardEligible false)", () => {
    const pkgDir = writeFixture(
      connectorWithLlmProvider({
        ...validLlmProvider,
        provider: "gemini",
        capabilities: { function_tools: true, media_input: true, native_mcp: { status: "unsupported" } },
        models: { default: "gemini-3.5-flash", allowed: ["gemini-3.5-flash"] },
        defaultCapable: true,
        wizardEligible: false,
      }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(llmProviderBlockingRules(result)).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an unknown provider (derived vocabulary)", () => {
    const pkgDir = writeFixture(connectorWithLlmProvider({ ...validLlmProvider, provider: "mistral" }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-provider");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an extraneous top-level key (closed v1 shape)", () => {
    const pkgDir = writeFixture(connectorWithLlmProvider({ ...validLlmProvider, extra: true }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-extraneous-key");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a missing required capability key", () => {
    const pkgDir = writeFixture(
      connectorWithLlmProvider({ ...validLlmProvider, capabilities: { function_tools: true, native_mcp: { status: "native" } } }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-capabilities-missing");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a non-boolean capability flag", () => {
    const pkgDir = writeFixture(
      connectorWithLlmProvider({ ...validLlmProvider, capabilities: { function_tools: "yes", media_input: false, native_mcp: { status: "native" } } }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-capability-flag");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an unknown native_mcp status (derived vocabulary)", () => {
    const pkgDir = writeFixture(
      connectorWithLlmProvider({ ...validLlmProvider, capabilities: { function_tools: true, media_input: false, native_mcp: { status: "maybe" } } }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-native-mcp-status");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an unknown native_mcp approval mode (derived vocabulary)", () => {
    const pkgDir = writeFixture(
      connectorWithLlmProvider({ ...validLlmProvider, capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", approval: "sometimes" } } }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-native-mcp-approval");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an empty native_mcp transports array (nonempty when present)", () => {
    const pkgDir = writeFixture(
      connectorWithLlmProvider({ ...validLlmProvider, capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", transports: [] } } }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-native-mcp-transports");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags an empty models.allowed", () => {
    const pkgDir = writeFixture(connectorWithLlmProvider({ ...validLlmProvider, models: { default: "x", allowed: [] } }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-models-allowed");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags models.default NOT in models.allowed (the cross-field rule)", () => {
    const pkgDir = writeFixture(
      connectorWithLlmProvider({ ...validLlmProvider, models: { default: "gpt-9", allowed: ["claude-sonnet-4-6"] } }),
    );
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-models-default-not-allowed");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a non-object llmProvider block", () => {
    const pkgDir = writeFixture(connectorWithLlmProvider("nope"));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(llmProviderBlockingRules(result)).toContain("manifest.llm-provider-shape");
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

// ---------------------------------------------------------------------------
// cinatra.logo across EVERY extension kind (cinatra#2469, follow-up to
// #1482/#2467).
//
// Maintainer decision on cinatra#2469 (2026-08-06): "Every extension kind must
// be able to self-define `cinatra.logo`". The ONLY per-kind cinatra-key set the
// gate closes is the artifact one (`rules.artifactAllowedCinatraKeys`, DERIVED
// from the live `ARTIFACT_ALLOWED_CINATRA_KEYS` source) — connector / agent /
// skill / workflow carry no closed set, so the key was already structurally
// admitted for them. These fixtures pin BOTH halves of the outcome: the artifact
// widening actually landed in the derived rules, and no kind regressed.
//
// Every fixture below is IN-REPO (a tmpdir the test writes), never an external
// package — the acceptance criterion on the issue.
// ---------------------------------------------------------------------------

// A minimal, sanitizer-clean brand glyph: a bare <svg> document with one path.
const FIXTURE_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>\n';

/** A metadata-only fixture of any kind, optionally declaring `cinatra.logo`. */
function kindLogoFixture(kind, { logo, extraCinatra = {} } = {}) {
  const cinatra = {
    kind,
    apiVersion: "cinatra.ai/v1",
    ...(kind === "artifact" ? { artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } } } : {}),
    ...(logo !== undefined ? { logo } : {}),
    ...extraCinatra,
  };
  const files = {
    "package.json": JSON.stringify(
      {
        name: `@cinatra-ai/fixture-${kind}`,
        version: "0.0.1",
        license: "Apache-2.0",
        // `logo.svg` is listed so the fixture is a package that would ACTUALLY
        // ship its declared asset (codex round-1): a fixture whose `files`
        // omitted the logo would prove the gate accepts the declaration while
        // quietly modelling a package that publishes a dangling pointer.
        files: ["src", "cinatra", "logo.svg"],
        main: "src/index.ts",
        cinatra,
      },
      null,
      2,
    ),
    "README.md": `# Fixture ${kind}\n`,
    "src/index.ts": "export {};\n",
    "logo.svg": FIXTURE_LOGO_SVG,
  };
  // An agent fixture must ship the authored `cinatra/oas.json` proxy or the
  // agent arm flags `manifest.agent-missing-oas` for reasons unrelated to logo.
  if (kind === "agent") files["cinatra/oas.json"] = JSON.stringify({ openapi: "3.1.0" }, null, 2);
  return files;
}

/** Every finding the gate produced, at any severity. */
function allFindings(result) {
  return [...result.blocking, ...(result.advisory ?? []), ...(result.info ?? [])];
}

/** Findings that name the extraneous-key rule for the artifact kind. */
function extraneousKeyFindings(result) {
  return allFindings(result).filter((f) => f.rule === "manifest.artifact-extraneous-keys");
}

/**
 * Findings that COMPLAIN about the logo declaration, at any severity and under
 * ANY rule. Used for the non-artifact kinds, where filtering on the artifact
 * extraneous-key rule alone would be vacuous (codex round-0): those kinds have
 * no closed key set, so that rule can never fire for them and asserting its
 * absence proves nothing. Matching the word `logo` across every rule catches a
 * kind-specific rejection landing under some OTHER rule name.
 */
function logoComplaints(result) {
  return allFindings(result).filter((f) => /\blogo\b/i.test(`${f.rule} ${f.detail ?? ""}`));
}

describe("conformance-gate — cinatra.logo is admitted for EVERY kind (cinatra#2469)", () => {
  it("derives the WIDENED artifact key set from live source — `logo` alongside displayName/vendor", () => {
    const rules = loadLiveRules(REPO_ROOT);
    expect(rules.ok).toBe(true);
    // The derivation is the load-bearing half: the gate reads
    // ARTIFACT_ALLOWED_CINATRA_KEYS out of the live .ts source text, so this
    // failing means the widening did not reach the gate at all.
    expect(rules.artifactAllowedCinatraKeys.has("logo")).toBe(true);
    expect(rules.artifactAllowedCinatraKeys.has("displayName")).toBe(true);
    expect(rules.artifactAllowedCinatraKeys.has("vendor")).toBe(true);
  });

  it("renders the DERIVED key list in the extraneous-key detail (never a stale hand-copied list)", () => {
    const pkgDir = writeFixture(kindLogoFixture("artifact", { extraCinatra: { riskLevel: "low" } }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    const found = extraneousKeyFindings(result);
    expect(found.length).toBe(1);
    // The message must advertise `logo` as declarable now that it is.
    expect(found[0].detail).toMatch(/\blogo\b/);
    expect(found[0].detail).toMatch(/riskLevel/);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("an ARTIFACT fixture declaring a valid cinatra.logo conforms cleanly (the #2469 capability gap, closed)", () => {
    const pkgDir = writeFixture(kindLogoFixture("artifact", { logo: "./logo.svg" }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.infra).toBe(false);
    expect(extraneousKeyFindings(result)).toEqual([]);
    expect(result.blocking).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("the SAME artifact fixture WITHOUT a logo is equally clean (absent stays the documented default)", () => {
    const pkgDir = writeFixture(kindLogoFixture("artifact"));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.blocking).toEqual([]);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it.each([
    ["a non-.svg path", "./logo.png", "manifest.logo-not-svg"],
    ["a blank declaration", "   ", "manifest.logo-malformed"],
    ["a non-string declaration", 42, "manifest.logo-malformed"],
    ["a lexical escape", "../evil.svg", "manifest.logo-escapes-package"],
    ["a missing file", "./nope.svg", "manifest.logo-unresolved"],
  ])("fails CLOSED on %s (the #1482/#2467 contract, mirrored for every kind)", (_label, logo, rule) => {
    const pkgDir = writeFixture(kindLogoFixture("artifact", { logo }));
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    expect(result.blocking.some((f) => f.rule === rule)).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a logo that resolves on disk but would NOT SHIP (outside the `files` allowlist)", () => {
    // codex round-7: the ONE check no other layer can make. The asset exists and
    // every path rule passes, so the generator is happy — but `npm pack` obeys
    // `files`, so the tarball carries the POINTER and not the ASSET and every
    // consumer silently falls back to the generic kind emblem.
    const files = kindLogoFixture("artifact", { logo: "./logo.svg" });
    const pkg = JSON.parse(files["package.json"]);
    pkg.files = ["src", "cinatra"]; // logo.svg deliberately NOT listed
    files["package.json"] = JSON.stringify(pkg, null, 2);

    const pkgDir = writeFixture(files);
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.conform).toBe(false);
    const finding = result.blocking.find((f) => f.rule === "manifest.logo-out-of-scope");
    expect(finding).toBeDefined();
    // The message must tell the author exactly what to add.
    expect(finding.detail).toContain("logo.svg");
    expect(finding.detail).toContain('"files"');
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("flags a logo excluded by a NESTED .npmignore — proved against npm's own packlist, not the `files` heuristic", () => {
    // codex round-8: `isInScope` models ONLY the `files` array. npm additionally
    // applies root and NESTED .npmignore files, its built-in ignores, and full
    // glob semantics. This package lists the logo's directory in `files` (so the
    // heuristic is satisfied) while a nested .npmignore excludes every .svg —
    // `npm pack` ships package.json and NOT the logo. Only the real packlist
    // catches it, and this is the release path for all ~111 extension repos.
    const files = kindLogoFixture("artifact", { logo: "./assets/logo.svg" });
    const pkg = JSON.parse(files["package.json"]);
    pkg.files = ["src", "cinatra", "assets"];
    files["package.json"] = JSON.stringify(pkg, null, 2);
    delete files["logo.svg"];
    files["assets/logo.svg"] = FIXTURE_LOGO_SVG;
    files["assets/.npmignore"] = "*.svg\n";

    const pkgDir = writeFixture(files);
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    const finding = result.blocking.find((f) => f.rule === "manifest.logo-out-of-scope");
    expect(finding).toBeDefined();
    expect(finding.detail).toContain("npm pack --dry-run");
    expect(finding.detail).toContain(".npmignore");
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it("passes the SAME package once the nested .npmignore stops excluding the asset (the check is not blanket-strict)", () => {
    const files = kindLogoFixture("artifact", { logo: "./assets/logo.svg" });
    const pkg = JSON.parse(files["package.json"]);
    pkg.files = ["src", "cinatra", "assets"];
    files["package.json"] = JSON.stringify(pkg, null, 2);
    delete files["logo.svg"];
    files["assets/logo.svg"] = FIXTURE_LOGO_SVG;

    const pkgDir = writeFixture(files);
    const result = runConformanceGate({ packageDir: pkgDir, sdkRoot: REPO_ROOT });
    expect(result.blocking.some((f) => f.rule === "manifest.logo-out-of-scope")).toBe(false);
    expect(result.conform).toBe(true);
    rmSync(pkgDir, { recursive: true, force: true });
  });

  it.each(["connector", "agent", "skill", "workflow"])(
    "a %s fixture declaring cinatra.logo raises no key-set finding (no closed set — unchanged by #2469)",
    (kind) => {
      const withLogo = writeFixture(kindLogoFixture(kind, { logo: "./logo.svg" }));
      const without = writeFixture(kindLogoFixture(kind));
      const a = runConformanceGate({ packageDir: withLogo, sdkRoot: REPO_ROOT });
      const b = runConformanceGate({ packageDir: without, sdkRoot: REPO_ROOT });
      expect(a.infra).toBe(false);
      // NOT the artifact extraneous-key rule (which can never fire for these
      // kinds, so asserting its absence would be vacuous): assert that NO
      // finding, under ANY rule and at ANY severity, complains about the logo.
      expect(logoComplaints(a)).toEqual([]);
      // Declaring a logo must change NOTHING about the kind's blocking verdict:
      // same rules fire with and without it (a per-kind no-regression pin, not
      // an assertion that these bare fixtures are otherwise conformant).
      expect(a.blocking.map((f) => f.rule).sort()).toEqual(b.blocking.map((f) => f.rule).sort());
      rmSync(withLogo, { recursive: true, force: true });
      rmSync(without, { recursive: true, force: true });
    },
  );
});
