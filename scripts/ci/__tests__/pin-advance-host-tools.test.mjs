// The pin-advance host-tool check (cinatra#3422, item 2): a pack tip whose
// flow calls a host tool the passthrough of this tree does not carry is
// refused. The suite exercises the pure core over two hand-written fixture
// flows, the static allowlist reader over this tree's own route, and the
// one-flow command-line form.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  changedPins,
  collectPassthroughHostTools,
  hostToolFindings,
  readPassthroughAllowlist,
} from "../pin-advance-host-tools.mjs";
// Imported as a namespace so a missing export fails only the case that reads it.
import * as check from "../pin-advance-host-tools.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts/ci/pin-advance-host-tools.mjs");
const FIXTURES = fileURLToPath(new URL("./__fixtures__/pin-advance-host-tools/", import.meta.url));
const readFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

const PACKAGE = "@cinatra-ai/fixture-agent";
const TIP = "c".repeat(40);
const BASE = "b".repeat(40);

const passthroughNode = (id, data) => ({
  component_type: "ApiNode",
  id,
  name: id,
  url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
  http_method: "POST",
  data,
});

describe("the allowlist reader over this tree's own route", () => {
  it("returns exactly the twenty names the passthrough carries", () => {
    const allowlist = readPassthroughAllowlist(REPO_ROOT);
    expect([...allowlist].sort()).toEqual([
      "agent_run_hitl_prompts_exclude",
      "agent_run_hitl_prompts_list",
      "artifact_content_read",
      "artifact_image_generate",
      "artifact_materialize",
      "artifacts_get",
      "artifacts_list",
      "email_outreach_initial_drafts_update",
      "email_outreach_recipients_update",
      "email_test_delivery_parse_action",
      "email_test_delivery_run_send",
      "extension_data",
      "extension_tool",
      "objects_classify",
      "objects_save",
      "objects_update",
      "run_folder_list",
      "run_folder_read",
      "run_folder_write",
      "trigger_config_set",
    ]);
  });
});

describe("the allowlist reader over inline text", () => {
  const ROUTE = "src/app/api/agents/passthrough/route.ts";
  const route = [
    'import { SCOPED_TOOLS } from "@/lib/scoped";',
    "const ALLOWED_TOOLS = new Set([",
    '  "objects_save", // a comment, "not_a_name"',
    "  /* another comment */",
    "  ...SCOPED_TOOLS,",
    "]);",
  ].join("\n");

  it("resolves an imported set whose block spreads a same-file set and a same-file constant", () => {
    const files = {
      [ROUTE]: route,
      "src/lib/scoped.ts": [
        'const READ_TOOL = "artifacts_get";',
        "const ARTIFACT_READ_TOOLS = new Set<string>([READ_TOOL, 'artifacts_list']);",
        "export const SCOPED_TOOLS: ReadonlySet<string> = new Set<string>([",
        '  "extension_tool",',
        "  ...ARTIFACT_READ_TOOLS,",
        "]);",
      ].join("\n"),
    };
    const allowlist = readPassthroughAllowlist("/repo", {
      readText: (abs) => {
        const rel = path.relative("/repo", abs);
        if (!(rel in files)) throw new Error(`ENOENT ${rel}`);
        return files[rel];
      },
    });
    expect([...allowlist].sort()).toEqual(["artifacts_get", "artifacts_list", "extension_tool", "objects_save"]);
  });

  it("throws, naming the entry and the file, on a spread it cannot resolve", () => {
    const files = {
      [ROUTE]: route,
      "src/lib/scoped.ts": "export const SCOPED_TOOLS = new Set([...toolsFromSomewhere()]);",
    };
    const read = () =>
      readPassthroughAllowlist("/repo", {
        readText: (abs) => {
          const rel = path.relative("/repo", abs);
          if (!(rel in files)) throw new Error(`ENOENT ${rel}`);
          return files[rel];
        },
      });
    expect(read).toThrow(/\.\.\.toolsFromSomewhere\(\).*src\/lib\/scoped\.ts/);
  });

  it("throws on a spread of a name the route neither declares nor imports", () => {
    const files = { [ROUTE]: "const ALLOWED_TOOLS = new Set([...MYSTERY_TOOLS]);" };
    expect(() =>
      readPassthroughAllowlist("/repo", { readText: (abs) => files[path.relative("/repo", abs)] }),
    ).toThrow(/MYSTERY_TOOLS.*route\.ts/);
  });
});

describe("collectPassthroughHostTools", () => {
  it("reads only the passthrough nodes, and the extension tool's inner name is never a host tool", () => {
    const calls = collectPassthroughHostTools(readFixture("allowed-host-tool.oas.json"));
    expect(calls).toEqual([
      { nodeId: "save_object", tool: "objects_save" },
      { nodeId: "run_pack_tool", tool: "extension_tool" },
    ]);
  });

  it("returns a node whose data.tool is missing, not a string or a template as unreadable", () => {
    const calls = collectPassthroughHostTools({
      $referenced_components: {
        a: passthroughNode("no_tool", { input: {} }),
        b: passthroughNode("number_tool", { tool: 7 }),
        c: passthroughNode("template_tool", { tool: "{{ chosen_tool }}" }),
      },
    });
    expect(calls.map((c) => [c.nodeId, c.tool, typeof c.unreadable])).toEqual([
      ["no_tool", null, "string"],
      ["number_tool", null, "string"],
      ["template_tool", null, "string"],
    ]);
  });
});

describe("hostToolFindings", () => {
  const allowlist = readPassthroughAllowlist(REPO_ROOT);

  it("finds nothing in the allowed fixture and lists its two host tools", () => {
    const calls = collectPassthroughHostTools(readFixture("allowed-host-tool.oas.json"));
    const result = hostToolFindings({ packageName: PACKAGE, tip: TIP, calls, allowlist });
    expect(result.findings).toEqual([]);
    expect(result.tools).toEqual(["extension_tool", "objects_save"]);
    // The inner name is on no host list, and it is never compared with one.
    expect(allowlist.has("a_tool_only_the_pack_declares")).toBe(false);
  });

  it("refuses the unlisted fixture with ONE line naming the package, the tip, the node and the tool", () => {
    const calls = collectPassthroughHostTools(readFixture("unlisted-host-tool.oas.json"));
    const result = hostToolFindings({ packageName: PACKAGE, tip: TIP, calls, allowlist });
    expect(result.findings.map((f) => f.line)).toEqual([
      `pin-advance host-tool check: ${PACKAGE} at ${TIP} — node "call_unlisted" calls host tool ` +
        `"a_tool_the_host_does_not_carry", which the passthrough allowlist of this tree ` +
        "(src/app/api/agents/passthrough/route.ts) does not carry",
    ]);
  });

  it("refuses a pack-declared name used directly as a node's data.tool", () => {
    const calls = collectPassthroughHostTools({
      $referenced_components: {
        direct: passthroughNode("direct_call", { tool: "a_tool_only_the_pack_declares", input: {} }),
        wrapped: passthroughNode("wrapped_call", {
          tool: "extension_tool",
          input: { name: "a_tool_only_the_pack_declares", input: {} },
        }),
      },
    });
    const result = hostToolFindings({ packageName: PACKAGE, tip: TIP, calls, allowlist });
    expect(result.findings.map((f) => [f.nodeId, f.tool])).toEqual([["direct_call", "a_tool_only_the_pack_declares"]]);
  });

  it("refuses an unreadable node rather than passing it", () => {
    const calls = collectPassthroughHostTools({
      $referenced_components: { a: passthroughNode("template_tool", { tool: "{{ chosen_tool }}" }) },
    });
    const result = hostToolFindings({ packageName: PACKAGE, tip: TIP, calls, allowlist });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].line).toContain('node "template_tool"');
  });
});

describe("changedPins", () => {
  const lock = (entries) => ({
    schemaVersion: 1,
    packages: Object.entries(entries).map(([packageName, resolvedSha]) => ({
      packageName,
      repo: `cinatra-ai/${packageName.split("/")[1]}`,
      resolvedSha,
    })),
  });

  it("separates changed, new, removed and unchanged entries", () => {
    const result = changedPins(
      lock({ "@cinatra-ai/moved": BASE, "@cinatra-ai/kept": BASE, "@cinatra-ai/gone": BASE }),
      lock({ "@cinatra-ai/moved": TIP, "@cinatra-ai/kept": BASE, "@cinatra-ai/added": TIP }),
    );
    expect(result.changed).toEqual([{ packageName: "@cinatra-ai/moved", from: BASE, to: TIP }]);
    expect(result.added).toEqual([{ packageName: "@cinatra-ai/added", to: TIP }]);
    expect(result.removed).toEqual([{ packageName: "@cinatra-ai/gone", from: BASE }]);
    expect(result.unchanged).toEqual(["@cinatra-ai/kept"]);
  });

  it("reads several lock files per side and refuses a malformed sha", () => {
    const result = changedPins(
      [lock({ "@cinatra-ai/a": BASE }), lock({ "@cinatra-ai/b": BASE })],
      [lock({ "@cinatra-ai/a": BASE }), lock({ "@cinatra-ai/b": TIP })],
    );
    expect(result.changed.map((c) => c.packageName)).toEqual(["@cinatra-ai/b"]);
    expect(() => changedPins(lock({ "@cinatra-ai/a": BASE }), lock({ "@cinatra-ai/a": "main" }))).toThrow(
      /@cinatra-ai\/a.*resolvedSha/,
    );
  });
});

describe("the one-flow command line", () => {
  const run = (fixture) =>
    spawnSync(
      process.execPath,
      [SCRIPT, "--flow", path.join(FIXTURES, fixture), "--package", PACKAGE, "--tip", TIP],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

  it("exits 1 on the unlisted fixture and 0 on the allowed one", () => {
    const refused = run("unlisted-host-tool.oas.json");
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('node "call_unlisted" calls host tool "a_tool_the_host_does_not_carry"');
    const passed = run("allowed-host-tool.oas.json");
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("extension_tool, objects_save");
  });

  it("exits 2 with its reason when the arguments are incomplete", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--flow"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.status).toBe(2);
  });
});

describe("the per-pack route reading (cinatra#3664)", () => {
  // The route analyses a run takes once, in an order other than the tracked one.
  const analyses = (packModules) =>
    ["/chat", "/api/llm-bridge", "/sign-in", "/api/a2a", "/api/mcp"].map((route) => ({
      route,
      ok: true,
      missingCount: 0,
      extensionModulesByPack: {
        "@cinatra-ai/another-pack": 5,
        ...(packModules[route] ? { [PACKAGE]: packModules[route] } : {}),
      },
    }));
  const seventeen = { "/api/mcp": 17, "/chat": 17, "/api/a2a": 17, "/api/llm-bridge": 17 };

  it("the reading records a changed pack's reachable module count on each tracked route and adds no finding", () => {
    const reading = check.packRouteReading({ packageName: PACKAGE, tip: TIP, routes: analyses(seventeen) });
    expect(reading.packageName).toBe(PACKAGE);
    expect(reading.tip).toBe(TIP);
    expect(reading.perRoute).toEqual([
      { route: "/sign-in", modules: 0 },
      { route: "/api/mcp", modules: 17 },
      { route: "/chat", modules: 17 },
      { route: "/api/a2a", modules: 17 },
      { route: "/api/llm-bridge", modules: 17 },
    ]);
    expect(reading.line).toBe(
      `pin-advance host-tool check: ${PACKAGE} at ${TIP} — reachable modules on the tracked routes: ` +
        "/sign-in 0, /api/mcp 17, /chat 17, /api/a2a 17, /api/llm-bridge 17",
    );
    // A route that did not resolve, and one with missing imports, say so.
    const routes = analyses(seventeen).map((r) =>
      r.route === "/chat" ? { route: "/chat", ok: false } : r.route === "/api/a2a" ? { ...r, missingCount: 3 } : r,
    );
    const partial = check.packRouteReading({ packageName: PACKAGE, tip: TIP, routes });
    expect(partial.line).toContain("/chat unresolved");
    expect(partial.line).toContain("/api/a2a 17 (+3 missing)");
    // The reading is beside the host-tool comparison and adds no finding to it.
    const allowlist = readPassthroughAllowlist(REPO_ROOT);
    const calls = collectPassthroughHostTools(readFixture("allowed-host-tool.oas.json"));
    expect(hostToolFindings({ packageName: PACKAGE, tip: TIP, calls, allowlist }).findings).toEqual([]);
    expect(Object.keys(reading).sort()).toEqual(["line", "packageName", "perRoute", "tip"]);
  });

  it("a pack whose modules grow shows in the per-pack reading", () => {
    const before = check.packRouteReading({ packageName: PACKAGE, tip: TIP, routes: analyses(seventeen) });
    const after = check.packRouteReading({
      packageName: PACKAGE,
      tip: TIP,
      routes: analyses({ ...seventeen, "/chat": 19 }),
    });
    expect(before.perRoute.find((r) => r.route === "/chat").modules).toBe(17);
    expect(after.perRoute.find((r) => r.route === "/chat").modules).toBe(19);
    expect(after.line).not.toBe(before.line);
    expect(after.line).toBe(before.line.replace("/chat 17,", "/chat 19,"));
  });

  it("a counter that cannot load leaves the check's own exit code and reason unchanged", () => {
    // A copy of the check and the counter over a tree whose tsconfig.json is not JSON.
    const tree = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pin-advance-3664-")));
    try {
      mkdirSync(path.join(tree, "scripts", "ci"), { recursive: true });
      copyFileSync(path.join(REPO_ROOT, "scripts/route-graph.mjs"), path.join(tree, "scripts/route-graph.mjs"));
      copyFileSync(SCRIPT, path.join(tree, "scripts/ci/pin-advance-host-tools.mjs"));
      writeFileSync(path.join(tree, "tsconfig.json"), "{ not json");
      const result = spawnSync(process.execPath, [path.join(tree, "scripts/ci/pin-advance-host-tools.mjs"), "--flow"], {
        cwd: tree,
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("pin-advance host-tool check: error — --flow needs a value");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
