import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildManifest,
  checkParity,
  readPresentExtensionNames,
  checkExitCode,
  resolveDisplayName,
  sanitizeSvgToDataUri,
  sanitizeLogoDataUri,
  extractFactoryExport,
  validateWidgetStreamDeclaration,
  assertManifestWidgetIdsCovered,
  MAX_LOGO_BYTES,
} from "../generate-extension-manifest.mjs";
import { GENERATED_MANIFEST_FILES } from "../generated-manifest-files.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("the zero-tolerance flip (#36) fail-closed --check + the shared generated-file list", () => {
  it("checkExitCode fails (1) on drift/missing OR parity issues; clean is 0 (the gates' exempt-tree integrity is load-bearing)", () => {
    expect(checkExitCode({ driftOrMissing: false, parityIssueCount: 0 })).toBe(0);
    expect(checkExitCode({ driftOrMissing: true, parityIssueCount: 0 })).toBe(1);
    expect(checkExitCode({ driftOrMissing: false, parityIssueCount: 3 })).toBe(1);
    expect(checkExitCode({ driftOrMissing: true, parityIssueCount: 1 })).toBe(1);
  });

  it("GENERATED_MANIFEST_FILES pins the exact emitted set (it is also the coupling gates' permanent-exempt list)", () => {
    expect([...GENERATED_MANIFEST_FILES].sort()).toEqual([
      // The semantic-floor artifact binding (cinatra#151 Stage 6) — the ONE
      // emitted path outside src/lib/generated/ (package-local pure data;
      // policy note in scripts/audit/extension-coupling-gates.md).
      "packages/objects/src/generated/artifact-floor.ts",
      "src/lib/generated/__tests__/guarded-optional-loaders.test.ts",
      // Agent UI bindings + role bindings (cinatra#151 Stage 5).
      "src/lib/generated/agent-bindings.ts",
      "src/lib/generated/connector-setup-pages.ts",
      "src/lib/generated/extensions.client.tsx",
      "src/lib/generated/extensions.server.ts",
      "src/lib/generated/widget-stream-public-paths.ts",
    ]);
  });
});

describe("generator-owned resolution classification + guarded emission (cinatra#7)", () => {
  // Real-tree assertions (the cloned-back extension universe): the
  // classification is keyed EXCLUSIVELY on the host-owned
  // cinatra.systemExtensions declaration — never on requiredExtensions and
  // never inferred from source shape.
  it("classifies every record: systemExtensions ⇒ required, everything else ⇒ guardedOptional", async () => {
    const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const { readFileSync } = await import("node:fs");
    const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const systemSet = new Set(rootPkg.cinatra.systemExtensions);
    const { records } = await buildManifest();
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(["required", "guardedOptional"], r.packageName).toContain(r.resolution);
      expect(r.resolution, r.packageName).toBe(systemSet.has(r.packageName) ? "required" : "guardedOptional");
    }
  });

  it("every derived loader list carries the owning record's resolution", async () => {
    const m = await buildManifest();
    const byName = new Map(m.records.map((r) => [r.packageName, r.resolution]));
    const lists = [
      m.connectorSetupPages,
      m.connectorSettingsPages,
      m.connectorEntryModules,
      m.connectorMcpModules,
      m.connectorPrimitiveHandlers,
      m.externalMcpToolboxes,
      m.widgetStreamAgents,
      m.chatWidgetModules,
    ];
    for (const list of lists) {
      for (const entry of list) {
        expect(entry.resolution, entry.packageName).toBe(byName.get(entry.packageName));
      }
    }
  });
});

describe("D10 logo path containment (symlink-safe)", () => {
  // sanitizeLogoDataUri resolves against the generator's REPO_ROOT (../..), so
  // the fixture lives under the repo in a temp dir that is cleaned up.
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const relDir = ".tmp-d10-symlink-test";
  const absDir = path.join(REPO_ROOT, relDir);
  let outsideFile;

  beforeAll(() => {
    rmSync(absDir, { recursive: true, force: true });
    mkdirSync(absDir, { recursive: true });
    const outsideDir = mkdtempSync(path.join(tmpdir(), "d10-outside-"));
    outsideFile = path.join(outsideDir, "evil.svg");
    writeFileSync(outsideFile, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>');
    // a real in-package clean logo
    writeFileSync(path.join(absDir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>');
    // a symlink that escapes the package
    symlinkSync(outsideFile, path.join(absDir, "escape.svg"));
  });
  afterAll(() => {
    rmSync(absDir, { recursive: true, force: true });
    if (outsideFile) rmSync(path.dirname(outsideFile), { recursive: true, force: true });
  });

  it("accepts an in-package logo and REJECTS a symlink escaping the package", () => {
    expect(sanitizeLogoDataUri(relDir, "./logo.svg")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(sanitizeLogoDataUri(relDir, "./escape.svg")).toBeNull();
    expect(sanitizeLogoDataUri(relDir, "../../etc/hostname.svg")).toBeNull();
    expect(sanitizeLogoDataUri(relDir, "logo.png")).toBeNull();
  });
});

describe("D10 self-describing card identity", () => {
  it("resolveDisplayName trims / nulls", () => {
    expect(resolveDisplayName({ displayName: "OpenAI" })).toBe("OpenAI");
    expect(resolveDisplayName({ displayName: "  Gmail  " })).toBe("Gmail");
    expect(resolveDisplayName({ displayName: "" })).toBeNull();
    expect(resolveDisplayName({ displayName: "   " })).toBeNull();
    expect(resolveDisplayName({})).toBeNull();
    expect(resolveDisplayName({ displayName: 42 })).toBeNull();
  });

  it("sanitizeSvgToDataUri inlines a clean SVG as a base64 data URI", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';
    const uri = sanitizeSvgToDataUri(svg);
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(uri.split(",")[1], "base64").toString("utf8")).toBe(svg);
  });

  it("allows a clean gradient logo with an INTERNAL url(#id) reference", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>' +
      '<rect width="24" height="24" fill="url(#g)"/></svg>';
    expect(sanitizeSvgToDataUri(svg)).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("rejects non-SVG, oversized, and every hostile SVG vector", () => {
    expect(sanitizeSvgToDataUri("not an svg")).toBeNull();
    expect(sanitizeSvgToDataUri("<div>nope</div>")).toBeNull();
    expect(sanitizeSvgToDataUri(`<svg>${"x".repeat(MAX_LOGO_BYTES + 1)}</svg>`)).toBeNull();
    expect(sanitizeSvgToDataUri(null)).toBeNull();
    // content before the <svg root
    expect(sanitizeSvgToDataUri('<div></div><svg></svg>')).toBeNull();
    // script / event handler
    expect(sanitizeSvgToDataUri('<svg><script>alert(1)</script></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg onload="x()"></svg>')).toBeNull();
    // external-reference elements + attrs
    expect(sanitizeSvgToDataUri('<svg><a href="https://evil.example/x">e</a></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><image href="https://evil.example/x.png"/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><use xlink:href="https://evil.example/x#i"/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><feImage href="https://evil.example/x.png"/></svg>')).toBeNull();
    // Bypasses to guard against: <style>@import, entity-encoded URL, file://, external url()
    expect(sanitizeSvgToDataUri('<svg><style>@import "https://evil.example/x.css";</style></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><a href="&#x68;ttps://evil.example/x#i">e</a></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><image href="file:///etc/passwd"/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><rect fill="url(https://evil.example/x)"/></svg>')).toBeNull();
    // XXE / CDATA / data: embedding
    expect(sanitizeSvgToDataUri('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><![CDATA[x]]></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><image href="data:image/png;base64,AAAA"/></svg>')).toBeNull();
    // SMIL animation (can carry begin/href)
    expect(sanitizeSvgToDataUri('<svg><animate attributeName="x"/></svg>')).toBeNull();
    // namespace-prefixed element bypass (allowlist rejects any `ns:tag`)
    expect(sanitizeSvgToDataUri('<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>x</s:script></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg xmlns:s="http://www.w3.org/2000/svg"><s:style>@import "https://evil.example/x.css";</s:style></svg>')).toBeNull();
    // CSS hex-escape bypass of url() (backslashes are rejected outright)
    expect(sanitizeSvgToDataUri('<svg><rect fill="u\\72l(https://evil.example/x.svg#p)"/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><rect style="fill:u\\72l(https://evil.example/x.svg#p)"/></svg>')).toBeNull();
    // style attribute (not just <style> element) — not in the attr allowlist
    expect(sanitizeSvgToDataUri('<svg><rect style="fill:red"/></svg>')).toBeNull();
    // unknown element / attribute → fail closed
    expect(sanitizeSvgToDataUri('<svg><bogus/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><rect data-x="1"/></svg>')).toBeNull();
    // external-ref via a CSS image function in an allowed attribute value
    expect(sanitizeSvgToDataUri('<svg xmlns="http://www.w3.org/2000/svg"><rect mask="image-set(\'https://evil.example/p.png\' 1x)"/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><rect fill="image(\'https://evil.example/p.png\')"/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><rect fill="cross-fade(url(https://evil.example/a.png), 50%)"/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><rect fill="-webkit-image-set(\'https://evil.example/p.png\' 1x)"/></svg>')).toBeNull();
    expect(sanitizeSvgToDataUri('<svg><rect mask="url(https://evil.example/m.svg#m)"/></svg>')).toBeNull();
    // a scheme in a non-xmlns attribute value
    expect(sanitizeSvgToDataUri('<svg><rect fill="foo://bar"/></svg>')).toBeNull();
  });

  it("allows internal url(#id) in mask/clip-path/fill (the legit logo case)", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<defs><clipPath id="c"><rect width="24" height="24"/></clipPath></defs>' +
      '<rect width="24" height="24" fill="#123" clip-path="url(#c)" mask="url(#m)"/></svg>';
    expect(sanitizeSvgToDataUri(svg)).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("every record carries displayName + logo as string|null; card connectors have a real displayName", async () => {
    const { records } = await buildManifest();
    // Type contract: every record (all kinds) exposes the self-describing identity fields as string|null.
    for (const r of records) {
      expect(r.displayName === null || typeof r.displayName === "string").toBe(true);
      expect(r.logo === null || typeof r.logo === "string").toBe(true);
    }
    // Known card-visible connectors self-describe their name from the manifest.
    for (const [pkg, name] of [
      ["@cinatra-ai/openai-connector", "OpenAI"],
      ["@cinatra-ai/gmail-connector", "Gmail"],
      ["@cinatra-ai/github-connector", "GitHub"],
      ["@cinatra-ai/twenty-connector", "Twenty CRM"],
    ]) {
      const rec = records.find((r) => r.packageName === pkg);
      expect(rec?.displayName).toBe(name);
    }
  });
});

describe("manifest generator", () => {
  it("emits one normalized record per inventoried extension", async () => {
    const { records } = await buildManifest();
    const names = new Set(records.map((r) => r.packageName));
    expect(names.size).toBe(records.length); // no dupes
    // every record has the required normalized fields
    for (const r of records) {
      expect(typeof r.packageName).toBe("string");
      expect(["agent", "connector", "artifact", "skill", "workflow"]).toContain(r.kind);
      expect(typeof r.sourceDir).toBe("string");
      expect(Array.isArray(r.requestedHostPorts)).toBe(true);
    }
  });

  it("every record carries configSchema as an object|null (present on the static normalized record)", async () => {
    const { records } = await buildManifest();
    for (const r of records) {
      // The field must EXIST on every record (the static manifest type requires
      // it). A schema-config connector carries its object; everything else null.
      expect("configSchema" in r).toBe(true);
      const ok =
        r.configSchema === null ||
        (typeof r.configSchema === "object" && !Array.isArray(r.configSchema));
      expect(ok).toBe(true);
      // A schema-config connector MUST carry an object configSchema (never null);
      // a non-schema-config record MUST carry null.
      if (r.uiSurface === "schema-config") {
        expect(r.configSchema && typeof r.configSchema === "object").toBe(true);
      } else {
        expect(r.configSchema).toBeNull();
      }
    }
  });

  it("generated connector setup-pages match the hand-maintained map (parity)", async () => {
    const problems = await checkParity();
    expect(problems).toEqual([]);
  });

  it("presence-aware parity (self mode) equals strict parity on the FULL tree", async () => {
    // On the canonical clone-back tree every catalog package is present, so
    // presence-awareness must change nothing — it only ever SKIPS descriptors
    // whose package is absent from a partial universe (prod image = the
    // lock-acquired required set; fresh public clone). The partial-universe
    // behavior itself is exercised end to end by the in-image
    // `--check --self` (Dockerfile) and the required-only fresh-clone job.
    const problems = await checkParity({ presenceAware: true });
    expect(problems).toEqual([]);
  });

  it("readPresentExtensionNames reads package names from disk (pure presence probe)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "present-names-"));
    try {
      mkdirSync(path.join(root, "extensions", "some-scope", "alpha-connector"), { recursive: true });
      writeFileSync(
        path.join(root, "extensions", "some-scope", "alpha-connector", "package.json"),
        JSON.stringify({ name: "@some-scope/alpha-connector" }),
      );
      mkdirSync(path.join(root, "extensions", "some-scope", "not-a-package"), { recursive: true });
      const present = readPresentExtensionNames(root);
      expect([...present]).toEqual(["@some-scope/alpha-connector"]);
      expect(readPresentExtensionNames(path.join(root, "nope")).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies a connector with a UI page as bundled-react, facades as null", async () => {
    // Derive from records (no hardcoded @cinatra-ai/* literals — those would
    // register a new inventory reference site and drift extension-inventory.json).
    const { records } = await buildManifest();
    const withUi = records.find(
      (r) => r.kind === "connector" && (r.hasSetupPage || r.hasSettingsPage),
    );
    expect(withUi).toBeDefined();
    expect(withUi.uiSurface).toBe("bundled-react");
    const facade = records.find(
      (r) => r.kind === "connector" && !r.hasSetupPage && !r.hasSettingsPage,
    );
    expect(facade).toBeDefined();
    expect(facade.uiSurface).toBe(null);
    // a non-connector kind never has a uiSurface
    const agent = records.find((r) => r.kind === "agent");
    expect(agent.uiSurface).toBe(null);
  });

  it("setup-page entries only point at connectors that actually have one", async () => {
    const { records, connectorSetupPages } = await buildManifest();
    const haveSetup = new Set(
      records.filter((r) => r.kind === "connector" && r.hasSetupPage).map((r) => r.packageName),
    );
    for (const p of connectorSetupPages) expect(haveSetup.has(p.packageName)).toBe(true);
  });

  // Settings-pages have no hand-maintained parity map (unlike setup-pages), so
  // the structural invariant IS the parity check: every emitted settings-page
  // slug must correspond to a record with hasSettingsPage=true.
  it("settings-page entries only point at connectors that actually have one", async () => {
    const { records, connectorSettingsPages } = await buildManifest();
    const haveSettings = new Set(
      records.filter((r) => r.kind === "connector" && r.hasSettingsPage).map((r) => r.packageName),
    );
    for (const p of connectorSettingsPages) expect(haveSettings.has(p.packageName)).toBe(true);
  });
});

describe("connector MCP discovery maps", () => {
  it("emits one MCP-module loader entry per connector with hasMcpModule (factory resolved)", async () => {
    const { records, connectorMcpModules } = await buildManifest();
    const withModule = records.filter((r) => r.kind === "connector" && r.hasMcpModule);
    expect(connectorMcpModules.length).toBe(withModule.length);
    expect(connectorMcpModules.length).toBeGreaterThan(0);
    const byPackage = new Set(withModule.map((r) => r.packageName));
    for (const e of connectorMcpModules) {
      expect(byPackage.has(e.packageName)).toBe(true);
      expect(e.slug).toBe(e.packageName.split("/")[1]);
      // The host resolves this exact export from the loaded namespace.
      expect(e.factory).toMatch(/^create[A-Za-z0-9]*Module$/);
    }
    // deterministic slug order (the host registers in map order)
    const slugs = connectorMcpModules.map((e) => e.slug);
    expect(slugs).toEqual([...slugs].sort());
  });

  it("primitive-handler entries are connectors that OPT IN via a create*PrimitiveHandlers export", async () => {
    const { records, connectorPrimitiveHandlers, connectorMcpModules } = await buildManifest();
    const connectorByPackage = new Set(
      records.filter((r) => r.kind === "connector").map((r) => r.packageName),
    );
    expect(connectorPrimitiveHandlers.length).toBeGreaterThan(0);
    for (const e of connectorPrimitiveHandlers) {
      expect(connectorByPackage.has(e.packageName)).toBe(true);
      expect(e.factory).toMatch(/^create[A-Za-z0-9]*PrimitiveHandlers$/);
    }
    // A handlers file WITHOUT the factory export is not part of the surface:
    // the handler map must be a subset of connectors, and any connector with an
    // MCP module but no handler entry simply didn't export the factory.
    const handlerSlugs = new Set(connectorPrimitiveHandlers.map((e) => e.slug));
    const moduleSlugs = new Set(connectorMcpModules.map((e) => e.slug));
    for (const slug of handlerSlugs) expect(moduleSlugs.has(slug)).toBe(true);
  });

  it("extractFactoryExport: none → null, one → name, two → throws (ambiguous)", () => {
    const re = /export\s+function\s+(create[A-Za-z0-9]*Module)\s*\(/g;
    expect(extractFactoryExport("export const x = 1;", re, "ctx")).toBeNull();
    expect(extractFactoryExport("export function createProbeModule() {}", re, "ctx")).toBe(
      "createProbeModule",
    );
    expect(() =>
      extractFactoryExport(
        "export function createProbeModule() {}\nexport function createOtherModule() {}",
        re,
        "ctx",
      ),
    ).toThrow(/ambiguous/);
  });
});

describe("external-MCP toolbox capability marker + loader map", () => {
  it("every record carries providesExternalMcpToolbox as a boolean, and it DISCRIMINATES (hasMcpModule does not)", async () => {
    const { records } = await buildManifest();
    for (const r of records) {
      expect(typeof r.providesExternalMcpToolbox).toBe("boolean");
    }
    const markerSlugs = records
      .filter((r) => r.providesExternalMcpToolbox)
      .map((r) => r.packageName.split("/")[1]);
    expect(markerSlugs).toEqual(
      expect.arrayContaining(["apify-connector", "drupal-mcp-connector", "wordpress-mcp-connector"]),
    );
    // Self-MCP capability modules also set hasMcpModule (apollo, crm, email, …)
    // — records with hasMcpModule but WITHOUT the marker must exist, proving
    // the marker is the discriminating selector hasMcpModule never was.
    const selfMcpOnly = records.filter((r) => r.hasMcpModule && !r.providesExternalMcpToolbox);
    expect(selfMcpOnly.length).toBeGreaterThan(0);
    // And the marker is not derived from hasMcpModule: apify declares it with
    // no self-MCP capability module at all.
    const apify = records.find((r) => r.packageName.split("/")[1] === "apify-connector");
    expect(apify?.providesExternalMcpToolbox).toBe(true);
    expect(apify?.hasMcpModule).toBe(false);
  });

  it("emits a toolbox loader entry for marker-bearing extensions that ship src/mcp/toolbox.ts", async () => {
    const { records, externalMcpToolboxes } = await buildManifest();
    const recordByPackage = new Map(records.map((r) => [r.packageName, r]));
    expect(externalMcpToolboxes.length).toBeGreaterThan(0);
    for (const e of externalMcpToolboxes) {
      const rec = recordByPackage.get(e.packageName);
      // Marker WITHOUT a toolbox module is allowed (registry-resolved
      // extension), but every loader entry MUST come from a marker-bearing
      // record — fail-closed pairing enforced at generation.
      expect(rec?.providesExternalMcpToolbox).toBe(true);
      expect(e.slug).toBe(e.packageName.split("/")[1]);
      // The host resolves this exact export from the loaded namespace.
      expect(e.factory).toMatch(/^create[A-Za-z0-9]*ExternalMcpToolbox$/);
    }
    // deterministic slug order (the injection path flattens in map order)
    const slugs = externalMcpToolboxes.map((e) => e.slug);
    expect(slugs).toEqual([...slugs].sort());
    // The three first-party external-MCP extensions are covered.
    expect(slugs).toEqual(
      expect.arrayContaining(["apify-connector", "drupal-mcp-connector", "wordpress-mcp-connector"]),
    );
  });
});

describe("widget-stream agent map (cinatra.widgetStream)", () => {
  it("emits one slug-keyed entry per declaring connector with a resolved create*WidgetChatTool factory", async () => {
    const { records, widgetStreamAgents } = await buildManifest();
    expect(widgetStreamAgents.length).toBeGreaterThanOrEqual(2);
    const connectorByPackage = new Set(
      records.filter((r) => r.kind === "connector").map((r) => r.packageName),
    );
    for (const w of widgetStreamAgents) {
      expect(connectorByPackage.has(w.packageName)).toBe(true);
      expect(w.agentSlug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(w.factory).toMatch(/^create[A-Za-z0-9]*WidgetChatTool$/);
      expect(w.label.length).toBeGreaterThan(0);
      expect(w.subjectNoun.length).toBeGreaterThan(0);
      expect(w.skillCapability.length).toBeGreaterThan(0);
      expect(w.contextFields.length).toBeGreaterThan(0);
      for (const f of w.contextFields) {
        expect(typeof f.key).toBe("string");
        expect(Number.isInteger(f.maxLength) && f.maxLength > 0).toBe(true);
      }
      expect(w.auth.tokenConfigKey).toMatch(/^[a-z0-9_]+$/);
      expect(w.auth.instancesConfigKey).toMatch(/^[a-z0-9_]+$/);
      expect(Array.isArray(w.auth.requiredInstanceFields)).toBe(true);
    }
    // deterministic slug order + unique slugs (the route resolves by slug)
    const slugs = widgetStreamAgents.map((w) => w.agentSlug);
    expect(slugs).toEqual([...slugs].sort());
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("validateWidgetStreamDeclaration: valid declaration → no errors", () => {
    expect(
      validateWidgetStreamDeclaration("@x/p", {
        agentSlug: "x-content-editor",
        label: "X",
        subjectNoun: "page",
        skillCapability: "widget-chat.x-content-editor",
        contextFields: [{ key: "pageId", maxLength: 32 }],
        auth: {
          tokenConfigKey: "x_widget_auth",
          instancesConfigKey: "x",
          requiredInstanceFields: ["id"],
        },
      }),
    ).toEqual([]);
  });

  it("validateWidgetStreamDeclaration: FAILS CLOSED on malformed declarations", () => {
    const valid = {
      agentSlug: "x-content-editor",
      label: "X",
      subjectNoun: "page",
      skillCapability: "widget-chat.x",
      contextFields: [{ key: "pageId", maxLength: 32 }],
      auth: { tokenConfigKey: "x_widget_auth", instancesConfigKey: "x", requiredInstanceFields: [] },
    };
    expect(validateWidgetStreamDeclaration("@x/p", "nope").length).toBeGreaterThan(0);
    expect(
      validateWidgetStreamDeclaration("@x/p", { ...valid, agentSlug: "Bad Slug!" }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("agentSlug")]));
    expect(
      validateWidgetStreamDeclaration("@x/p", { ...valid, label: " " }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("label")]));
    expect(
      validateWidgetStreamDeclaration("@x/p", { ...valid, contextFields: [] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("contextFields")]));
    expect(
      validateWidgetStreamDeclaration("@x/p", {
        ...valid,
        contextFields: [{ key: "ok", maxLength: 32 }, { key: "ok", maxLength: 16 }],
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("duplicate")]));
    expect(
      validateWidgetStreamDeclaration("@x/p", {
        ...valid,
        contextFields: [{ key: "bad key", maxLength: 0 }],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateWidgetStreamDeclaration("@x/p", {
        ...valid,
        auth: { tokenConfigKey: "Not-Snake", instancesConfigKey: "x", requiredInstanceFields: [] },
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("tokenConfigKey")]));
    expect(
      validateWidgetStreamDeclaration("@x/p", {
        ...valid,
        auth: { tokenConfigKey: "x", instancesConfigKey: "x", requiredInstanceFields: [""] },
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("requiredInstanceFields")]));
  });

  it("extractFactoryExport with the widget RE: none → null, one → name, two → ambiguous", () => {
    const re = /export\s+function\s+(create[A-Za-z0-9]*WidgetChatTool)\s*\(/g;
    expect(extractFactoryExport("export const x = 1;", re, "ctx")).toBeNull();
    expect(
      extractFactoryExport("export function createXWidgetChatTool() {}", re, "ctx"),
    ).toBe("createXWidgetChatTool");
    expect(() =>
      extractFactoryExport(
        "export function createXWidgetChatTool() {}\nexport function createYWidgetChatTool() {}",
        re,
        "ctx",
      ),
    ).toThrow(/ambiguous/);
  });
});

describe("chat-widget module discovery", () => {
  it("emits one chat-widget entry per extension shipping src/widgets/index.ts (manifest split enforced)", async () => {
    const { chatWidgetModules } = await buildManifest();
    // buildManifest THROWS for a widgets/index.ts without widgets/manifest.ts
    // (lockstep rule), so every surviving entry has BOTH modules — the emitter
    // derives the component map and the manifest map from the same list.
    expect(chatWidgetModules.length).toBeGreaterThan(0);
    // deterministic packageName order (the catalog resolves in map order)
    const names = chatWidgetModules.map((e) => e.packageName);
    expect(names).toEqual([...names].sort());
    // The two widget-bearing extensions are covered.
    expect(names).toEqual(
      expect.arrayContaining(["@cinatra-ai/apollo-connector", "@cinatra-ai/crm-connector"]),
    );  });
});

describe("assertManifestWidgetIdsCovered (manifest/widgets pairing)", () => {
  const widgetsSrc = `
    export const acmeWidgets: WidgetDefinition[] = [
      { id: "acme.finder", label: "Find", component: Finder },
      { id: "acme.editor", label: "Edit", component: Editor },
    ];
  `;

  it("passes when every wizard step widgetId is a defined widget id", () => {
    const manifestSrc = `
      export const acmeManifest: WidgetManifest = {
        id: "acme",
        description: "d",
        wizard: { steps: [ { widgetId: "acme.finder", description: "f" }, { widgetId: "acme.editor", description: "e" } ] },
      };
    `;
    expect(() => assertManifestWidgetIdsCovered(manifestSrc, widgetsSrc, "acme src/widgets")).not.toThrow();
  });

  it("passes for a manifest without wizard steps (nothing to cover)", () => {
    const manifestSrc = `export const acmeManifest = { id: "acme", description: "d" };`;
    expect(() => assertManifestWidgetIdsCovered(manifestSrc, widgetsSrc, "acme src/widgets")).not.toThrow();
  });

  it("accepts single-quoted and template (no-interpolation) literals", () => {
    const widgetsSingle = `export const w = [ { id: 'acme.finder', label: "F", component: F } ];`;
    const manifestSingle = `export const m = { wizard: { steps: [ { widgetId: 'acme.finder' } ] } };`;
    expect(() => assertManifestWidgetIdsCovered(manifestSingle, widgetsSingle, "q src/widgets")).not.toThrow();
    const manifestTpl = "export const m = { wizard: { steps: [ { widgetId: `acme.finder` } ] } };";
    expect(() => assertManifestWidgetIdsCovered(manifestTpl, widgetsSingle, "q src/widgets")).not.toThrow();
  });

  it("REJECTS a non-literal widgetId (identifier / computed / interpolated)", () => {
    const cases = [
      `export const m = { wizard: { steps: [ { widgetId: STEP_ONE } ] } };`,
      `export const m = { wizard: { steps: [ { widgetId: prefix + ".finder" } ] } };`,
      `export const m = { wizard: { steps: [ { widgetId: "acme.finder" + suffix } ] } };`,
      "export const m = { wizard: { steps: [ { widgetId: `${p}.finder` } ] } };",
    ];
    for (const manifestSrc of cases) {
      expect(() => assertManifestWidgetIdsCovered(manifestSrc, widgetsSrc, "dyn src/widgets")).toThrow(
        /non-literal widgetId/,
      );
    }
  });

  it("validates detector record-map VALUES as widget ids (and rejects non-literal values)", () => {
    const ok = `export const m = { detectors: [ { widgetId: { a: "acme.finder", b: 'acme.editor' } } ] };`;
    expect(() => assertManifestWidgetIdsCovered(ok, widgetsSrc, "rec src/widgets")).not.toThrow();
    const missing = `export const m = { detectors: [ { widgetId: { a: "acme.ghost" } } ] };`;
    expect(() => assertManifestWidgetIdsCovered(missing, widgetsSrc, "rec src/widgets")).toThrow(
      /not defined in src\/widgets\/index\.ts: acme\.ghost/,
    );
    const dynamic = `export const m = { detectors: [ { widgetId: { a: SOME_CONST } } ] };`;
    expect(() => assertManifestWidgetIdsCovered(dynamic, widgetsSrc, "rec src/widgets")).toThrow(
      /non-literal widgetId record value/,
    );
    const prefixed = `export const m = { detectors: [ { widgetId: { a: "acme.finder" + suffix } } ] };`;
    expect(() => assertManifestWidgetIdsCovered(prefixed, widgetsSrc, "rec src/widgets")).toThrow(
      /non-literal widgetId record value/,
    );
  });

  it("FAILS generation when a wizard step names an undefined widget id", () => {
    const manifestSrc = `
      export const acmeManifest = {
        id: "acme",
        description: "d",
        wizard: { steps: [ { widgetId: "acme.ghost", description: "g" } ] },
      };
    `;
    expect(() => assertManifestWidgetIdsCovered(manifestSrc, widgetsSrc, "acme src/widgets")).toThrow(
      /acme src\/widgets: manifest wizard step\(s\)\/detector\(s\) reference widget id\(s\) not defined in src\/widgets\/index\.ts: acme\.ghost/,
    );
  });

  it("the real widget-bearing extensions pass the pairing check (buildManifest does not throw)", async () => {
    await expect(buildManifest()).resolves.toBeTruthy();
  });
});
