// cinatra#3821 — the core/extension border, connector side (classes 4 and 5).
//
// A connector gives an agent its connection and its tools. It never creates
// an artifact, never claims an artifact type, never declares a produced type
// and never draws an artifact. The conformance checker refuses a package of
// kind connector that does (class 4, the manifest) or whose code names a road
// by which the application creates an artifact (class 5, the source).
//
// Every case runs the checker through runConformanceGate against a synthetic
// package written into a throwaway temp dir, exactly as conformance-gate.test.mjs
// does. The road list is read from the SDK's own declaration
// (ARTIFACT_CREATING_ROADS in artifact-contract.ts), never typed here, except
// where a fixture must NAME a road in its source.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runConformanceGate } from "../conformance-gate.mjs";
import { loadLiveRules } from "../lib/conformance-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const temps = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function writeTree(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const CONNECTOR_PKG = {
  name: "@example-org/fixture-connector",
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

const CLEAN_REGISTER =
  'import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions/host-context";\n' +
  "export function register(ctx: ExtensionHostContext) {\n" +
  "  ctx.ui.registerAction({});\n" +
  "}\n";

function connector({ name, cinatra, register, extra } = {}) {
  const pkg = {
    ...CONNECTOR_PKG,
    ...(name ? { name } : {}),
    cinatra: { ...CONNECTOR_PKG.cinatra, ...(cinatra ?? {}) },
  };
  return writeTree("connector-artifact-border-", {
    "package.json": JSON.stringify(pkg, null, 2),
    "README.md": "# Fixture Connector\n",
    "src/index.ts": "export {};\n",
    "src/register.ts": register ?? CLEAN_REGISTER,
    "cinatra/config.json": JSON.stringify({ formatVersion: 1, access: { scope: { default: "user" } } }, null, 2),
    ...(extra ?? {}),
  });
}

const gate = (packageDir, strict = false) => runConformanceGate({ packageDir, sdkRoot: REPO_ROOT, strict });
const allFindings = (r) => [...(r.blocking ?? []), ...(r.known ?? []), ...(r.advisory ?? [])];
const borderFindings = (r) => allFindings(r).filter((f) => f.rule.startsWith("border."));

// THE PROMPTING CASE (A4): a connector that hands a page's words to the
// application's CMS review seam with its staged change — the seam stores them
// as an artifact for the display's diff.
const CMS_REVIEW_REGISTER =
  'import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions/host-context";\n' +
  "export function register(ctx: ExtensionHostContext) {\n" +
  '  const seam = ctx.capabilities.resolveProviders("@cinatra-ai/host:cms-review")[0];\n' +
  "  ctx.ui.registerAction({\n" +
  "    run: async (change) =>\n" +
  "      seam.impl.captureStagedWrite({ stagedChange: change, resolved: { words: change.pageWords } }),\n" +
  "  });\n" +
  "}\n";

describe("class 4 — a connector whose manifest declares a produced type or claims an object type", () => {
  it("U-a: cinatra.produces in package.json fails border.connector-declares-produces", () => {
    const r = gate(connector({ cinatra: { produces: ["@example-org/fixture:thing"] } }));
    expect(r.infra).toBe(false);
    expect(r.conform).toBe(false);
    const hit = r.blocking.filter((f) => f.rule === "border.connector-declares-produces");
    expect(hit.map((f) => f.file)).toEqual(["package.json"]);
  });

  it("U-b: metadata.cinatra.produces in cinatra/oas.json fails the same rule on that file", () => {
    const oas = { openapi: "3.1.0", info: { title: "x", version: "0.0.1" }, paths: {}, metadata: { cinatra: { produces: ["@example-org/fixture:thing"] } } };
    const r = gate(connector({ extra: { "cinatra/oas.json": JSON.stringify(oas, null, 2) } }));
    expect(r.infra).toBe(false);
    expect(r.conform).toBe(false);
    const hit = r.blocking.filter((f) => f.rule === "border.connector-declares-produces");
    expect(hit.map((f) => f.file)).toEqual(["cinatra/oas.json"]);
  });

  it("U-c: cinatra.artifact.objectTypes fails border.connector-claims-artifact naming objectTypes", () => {
    const r = gate(connector({ cinatra: { artifact: { objectTypes: [{ type: "@example-org/fixture:thing" }] } } }));
    expect(r.conform).toBe(false);
    const hit = r.blocking.filter((f) => f.rule === "border.connector-claims-artifact");
    expect(hit).toHaveLength(1);
    expect(hit[0].file).toBe("package.json");
    expect(hit[0].detail).toMatch(/objectTypes/);
  });

  it("U-d: cinatra.artifact.ui fails border.connector-claims-artifact naming ui", () => {
    const ui = { abiVersion: 1, slots: { detail: { entry: "./src/detail.tsx", propsApiVersion: 1 } } };
    const r = gate(connector({ cinatra: { artifact: { ui } } }));
    expect(r.conform).toBe(false);
    const hit = r.blocking.filter((f) => f.rule === "border.connector-claims-artifact");
    expect(hit).toHaveLength(1);
    expect(hit[0].detail).toMatch(/\bui\b/);
  });
});

describe("class 5 — a connector whose code calls a road that creates an artifact", () => {
  it("U-e: THE PROMPTING CASE — the CMS review seam with the page's words fails border.connector-creates-artifact", () => {
    const r = gate(connector({ register: CMS_REVIEW_REGISTER }));
    expect(r.conform).toBe(false);
    const hit = r.blocking.filter((f) => f.rule === "border.connector-creates-artifact");
    expect(hit).toHaveLength(1);
    expect(hit[0].file).toBe("src/register.ts");
    expect(hit[0].detail).toContain("@cinatra-ai/host:cms-review");
  });

  it("U-f: a tool that calls the MCP tool artifact_authoring_emit fails the same rule", () => {
    const tool =
      "export async function publish(client, text) {\n" +
      '  return client.callTool("artifact_authoring_emit", { declaredMime: "text/markdown", content: text });\n' +
      "}\n";
    const r = gate(connector({ extra: { "src/tools/publish.ts": tool } }));
    expect(r.conform).toBe(false);
    const hit = r.blocking.filter((f) => f.rule === "border.connector-creates-artifact");
    expect(hit).toHaveLength(1);
    expect(hit[0].file).toBe("src/tools/publish.ts");
    expect(hit[0].detail).toContain("artifact_authoring_emit");
  });

  it("U-f: a road id named only as part of a longer token is not a finding (whole token only)", () => {
    const near =
      "export const names = [\n" +
      '  "artifact_authoring_emit_extra",\n' +
      '  "my_artifact_materialize",\n' +
      '  "@cinatra-ai/host:cms-review-draft",\n' +
      '  "@cinatra-ai/host:email-routing/draft",\n' +
      '  "x@cinatra-ai/host:blog-routing",\n' +
      "];\n";
    const r = gate(connector({ extra: { "src/names.ts": near } }));
    expect(r.infra).toBe(false);
    expect(borderFindings(r)).toEqual([]);
  });

  it("U-f: a road named twice in one file after a multi-line comment is ONE finding naming its first line", () => {
    const register =
      CLEAN_REGISTER +
      "/* a block comment\n" +
      "   spanning two lines */\n" +
      'export const first = "artifact_materialize";\n' +
      'export const again = "artifact_materialize";\n';
    const r = gate(connector({ register }));
    const hit = r.blocking.filter((f) => f.rule === "border.connector-creates-artifact");
    expect(hit).toHaveLength(1);
    expect(hit[0].detail).toContain("first at line 7");
  });
});

describe("the road list is derived from the SDK's declaration, fail closed", () => {
  const RULE_FILES = [
    "packages/sdk-extensions/src/host-context.ts",
    "packages/sdk-extensions/src/artifact-contract.ts",
    "packages/sdk-extensions/src/chat-views-contract.ts",
    "packages/sdk-extensions/src/llm-provider-contract.ts",
    "packages/sdk-extensions/src/access-config.ts",
    "packages/sdk-extensions/package.json",
    "packages/sdk-ui/package.json",
  ];

  it("U-g: loadLiveRules derives the five roads in their declared order", () => {
    const rules = loadLiveRules(REPO_ROOT);
    expect(rules.ok).toBe(true);
    expect(rules.artifactCreatingRoads).toEqual([
      "@cinatra-ai/host:cms-review",
      "@cinatra-ai/host:blog-routing",
      "@cinatra-ai/host:email-routing",
      "artifact_materialize",
      "artifact_authoring_emit",
    ]);
  });

  it("U-g: an SDK root without the ARTIFACT_CREATING_ROADS declaration answers infra, never a silent pass", () => {
    const files = {};
    for (const rel of RULE_FILES) files[rel] = readFileSync(join(REPO_ROOT, rel), "utf8");
    const contract = files["packages/sdk-extensions/src/artifact-contract.ts"];
    const without = contract.replace(/export const ARTIFACT_CREATING_ROADS\b[\s\S]*?\]\s*(?:as const)?\s*;/, "");
    files["packages/sdk-extensions/src/artifact-contract.ts"] = without;
    const sdkRoot = writeTree("connector-artifact-border-sdk-", files);
    const r = runConformanceGate({ packageDir: connector(), sdkRoot });
    expect(r.infra).toBe(true);
    expect(r.message).toContain("ARTIFACT_CREATING_ROADS");
    expect(without).not.toBe(contract);
  });

  it("U-g: an SDK root whose ARTIFACT_CREATING_ROADS declaration is empty answers infra, never a silent pass", () => {
    const files = {};
    for (const rel of RULE_FILES) files[rel] = readFileSync(join(REPO_ROOT, rel), "utf8");
    const contract = files["packages/sdk-extensions/src/artifact-contract.ts"];
    const empty = contract.replace(
      /export const ARTIFACT_CREATING_ROADS\b[\s\S]*?\]\s*(?:as const)?\s*;/,
      "export const ARTIFACT_CREATING_ROADS = [] as const;",
    );
    expect(empty).not.toBe(contract);
    files["packages/sdk-extensions/src/artifact-contract.ts"] = empty;
    const sdkRoot = writeTree("connector-artifact-border-sdk-", files);
    const r = runConformanceGate({ packageDir: connector(), sdkRoot });
    expect(r.infra).toBe(true);
    expect(r.message).toContain("ARTIFACT_CREATING_ROADS");
  });
});

describe("not a connector, not a call — no border finding", () => {
  it("U-h: an agent that declares cinatra.produces and calls artifact_authoring_emit carries no border finding", () => {
    const dir = writeTree("connector-artifact-border-agent-", {
      "package.json": JSON.stringify(
        {
          name: "@example-org/fixture-agent",
          version: "0.0.1",
          license: "Apache-2.0",
          type: "module",
          files: ["src"],
          cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent", produces: ["@example-org/fixture:thing"] },
        },
        null,
        2,
      ),
      "src/index.ts": 'export const emit = (client) => client.callTool("artifact_authoring_emit", {});\n',
    });
    const r = gate(dir);
    expect(r.infra).toBe(false);
    expect(borderFindings(r)).toEqual([]);
  });

  it("U-h: an artifact extension with a cinatra.artifact block carries no border finding", () => {
    const dir = writeTree("connector-artifact-border-artifact-", {
      "package.json": JSON.stringify(
        {
          name: "@example-org/fixture-artifact",
          version: "0.0.1",
          license: "Apache-2.0",
          type: "module",
          files: ["src"],
          cinatra: { apiVersion: "cinatra.ai/v1", kind: "artifact", artifact: { objectTypes: [{ type: "@example-org/fixture:thing" }] } },
        },
        null,
        2,
      ),
      "src/index.ts": "export {};\n",
    });
    const r = gate(dir);
    expect(r.infra).toBe(false);
    expect(borderFindings(r)).toEqual([]);
  });

  it("U-h: a connector that names a road only inside a comment carries no border finding", () => {
    const register =
      "// The application's @cinatra-ai/host:cms-review seam is an agent's road, never this connector's.\n" +
      "/* artifact_authoring_emit is not called here either. */\n" +
      CLEAN_REGISTER;
    const r = gate(connector({ register }));
    expect(r.infra).toBe(false);
    expect(borderFindings(r)).toEqual([]);
  });
});

describe("the floor — the four connectors that name a road today", () => {
  const FLOORED = "@cinatra-ai/wordpress-mcp-connector";

  it("U-i: a floored file naming its floored road is conform with the finding in known, and blocking under strict", () => {
    const dir = connector({ name: FLOORED, register: CMS_REVIEW_REGISTER });
    const r = gate(dir);
    expect(r.infra).toBe(false);
    expect(r.conform).toBe(true);
    const known = r.known.filter((f) => f.rule === "border.connector-creates-artifact");
    expect(known).toHaveLength(1);
    expect(known[0].file).toBe("src/register.ts");
    const strict = gate(dir, true);
    expect(strict.conform).toBe(false);
    expect(strict.blocking.some((f) => f.rule === "border.connector-creates-artifact")).toBe(true);
  });

  it("U-i: a second road in the floored file is not conform", () => {
    const register = CMS_REVIEW_REGISTER + 'export const emitName = "artifact_authoring_emit";\n';
    const r = gate(connector({ name: FLOORED, register }));
    expect(r.conform).toBe(false);
    const hit = r.blocking.filter((f) => f.rule === "border.connector-creates-artifact");
    expect(hit.map((f) => f.detail).join("\n")).toContain("artifact_authoring_emit");
  });

  it("U-i: a floored package naming no road fails border.connector-floor-stale", () => {
    const r = gate(connector({ name: FLOORED }));
    expect(r.conform).toBe(false);
    const stale = r.blocking.filter((f) => f.rule === "border.connector-floor-stale");
    expect(stale).toHaveLength(1);
    expect(stale[0].detail).toContain(`${FLOORED}:src/register.ts:@cinatra-ai/host:cms-review`);
  });
});
