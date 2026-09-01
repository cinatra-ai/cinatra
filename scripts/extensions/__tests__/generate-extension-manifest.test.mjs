import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildManifest,
  checkParity,
  readPresentExtensionNames,
  readDeclaredExtensionUniverse,
  assertDeclarationShapes,
  checkExitCode,
  resolveDisplayName,
  resolveVendor,
  sanitizeSvgToDataUri,
  sanitizeLogoDataUri,
  resolveDeclaredLogo,
  validateDeclaredLogo,
  extractFactoryExport,
  validateWidgetStreamDeclaration,
  validateWebhooksDeclaration,
  validateStreamsDeclaration,
  validateChatViewsDeclaration,
  webhookHandlerExportsFactory,
  assertManifestWidgetIdsCovered,
  assertArtifactRendererPackaging,
  MAX_LOGO_BYTES,
} from "../generate-extension-manifest.mjs";
import { GENERATED_MANIFEST_FILES } from "../generated-manifest-files.mjs";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
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
      "src/lib/generated/__tests__/guarded-optional-loaders.test.ts",
      // Agent UI bindings + role bindings (cinatra#151 Stage 5).
      "src/lib/generated/agent-bindings.ts",
      // Artifact-renderer dispatch spine (cinatra#1629, epic #1620 S2): the
      // literal-import BUILD table of extension-shipped cinatra.artifact.ui
      // renderer modules. Inert until an artifact declares `ui` (S3+/M1).
      "src/lib/generated/artifact-renderers.ts",
      // Chat renderable-view dispatch map (cinatra#1626, epic #1620 S9/M4): the
      // literal-import BUILD table of extension-shipped cinatra.views renderable-
      // view components, keyed by wire viewType. Inert until an extension
      // declares `cinatra.views` (the chart migration).
      "src/lib/generated/chat-views.ts",
      "src/lib/generated/connector-setup-pages.ts",
      "src/lib/generated/extensions.client.tsx",
      "src/lib/generated/extensions.server.ts",
      // Field-renderer component dispatch spine (cinatra#1625, epic #1620 S8 —
      // M3): the CLIENT-safe literal-import BUILD table of extension-shipped
      // HITL field-renderer modules. Empty until a claimant declares
      // cinatra.fieldRenderers[].component.
      "src/lib/generated/field-renderer-components.ts",
      // Neutral stream primitives capability (cinatra#344): the host-owned
      // generated maps for the generic /api/streams/<slug> route (dispatch map +
      // slug-only public-path list). Inert until an extension declares
      // cinatra.streams.
      "src/lib/generated/stream-public-paths.ts",
      "src/lib/generated/streams.server.ts",
      // Inbound-webhook facility (cinatra#340): the host-owned generated maps
      // for the generic /webhook route (dispatch registry, declared-prefix
      // list, registry-UI metadata). Inert until #343.
      "src/lib/generated/webhook-public-paths.ts",
      "src/lib/generated/webhook-registry-meta.ts",
      "src/lib/generated/webhooks.server.ts",
      "src/lib/generated/widget-stream-public-paths.ts",
    ]);
  });
});

describe("generator-owned resolution classification + guarded emission (cinatra#7)", () => {
  // Real-tree assertions (the cloned-back extension universe): the
  // classification is keyed EXCLUSIVELY on the host-owned
  // cinatra.systemExtensions declaration — never on extensions and
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
      m.chatViews,
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

// ---------------------------------------------------------------------------
// cinatra#1482 — a DECLARED `cinatra.logo` that does not resolve must be LOUD.
//
// #1325 landed the host-side resolution order (manifest.logo → client icon map
// → catalog icon_url → vendor logo → kind emblem). The per-connector rollout
// then hangs on one silent failure mode: a connector declares `cinatra.logo`,
// the path/asset is wrong, the generator emits `logo: null`, and the card falls
// back to the SAME generic emblem it showed before — the author sees no signal
// and believes the connector self-describes when it does not. `resolveDeclaredLogo`
// separates ABSENT (the documented default, never an error) from DECLARED-but-
// unresolvable (an authoring error the generation gate throws on).
// ---------------------------------------------------------------------------
describe("resolveDeclaredLogo — declared-but-unresolvable is an ERROR, absent is not (cinatra#1482)", () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const relDir = ".tmp-1482-declared-logo-test";
  const absDir = path.join(REPO_ROOT, relDir);
  let outsideFile;

  beforeAll(() => {
    rmSync(absDir, { recursive: true, force: true });
    mkdirSync(absDir, { recursive: true });
    writeFileSync(
      path.join(absDir, "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
    );
    // Structurally valid file, sanitizer-REJECTED content (a script element).
    writeFileSync(path.join(absDir, "hostile.svg"), '<svg><script>alert(1)</script></svg>');
    // Over the inline budget.
    writeFileSync(path.join(absDir, "huge.svg"), `<svg>${"x".repeat(MAX_LOGO_BYTES + 1)}</svg>`);
    const outsideDir = mkdtempSync(path.join(tmpdir(), "d1482-outside-"));
    outsideFile = path.join(outsideDir, "evil.svg");
    writeFileSync(outsideFile, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>');
    symlinkSync(outsideFile, path.join(absDir, "escape.svg"));
  });
  afterAll(() => {
    rmSync(absDir, { recursive: true, force: true });
    if (outsideFile) rmSync(path.dirname(outsideFile), { recursive: true, force: true });
  });

  // THE no-regression case: not declaring a logo is the documented default and
  // must stay silent — every connector that ships today is in this state.
  it("ABSENT (undefined / null) → no data URI and NO error (the untouched fallback default)", () => {
    expect(resolveDeclaredLogo(relDir, undefined)).toEqual({ dataUri: null, error: null });
    expect(resolveDeclaredLogo(relDir, null)).toEqual({ dataUri: null, error: null });
  });

  it("a resolvable in-package SVG → the data URI, no error", () => {
    const { dataUri, error } = resolveDeclaredLogo(relDir, "./logo.svg");
    expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(error).toBeNull();
    // Byte-identical to the value-only accessor the record assembly uses.
    expect(dataUri).toBe(sanitizeLogoDataUri(relDir, "./logo.svg"));
  });

  it.each([
    ["a missing file", "./nope.svg", /does not resolve to a readable file inside the package/],
    ["a non-.svg path", "./logo.png", /is not a "\.svg" path/],
    ["a lexical escape", "../../etc/hostname.svg", /escapes the package directory/],
    ["a symlink escape", "./escape.svg", /outside the package directory/],
    ["sanitizer-rejected content", "./hostile.svg", /REJECTED by the SVG sanitizer/],
    ["an over-budget asset", "./huge.svg", /REJECTED by the SVG sanitizer/],
    ["an empty string", "   ", /non-empty package-relative/],
    ["a non-string", 42, /non-empty package-relative/],
    // Resolution runs on the RAW value (pre-#1482 behavior preserved): a padded
    // path resolved literally then, and still does not resolve now.
    ["a whitespace-padded path", " ./logo.svg ", /does not resolve to a readable file inside the package/],
  ])("DECLARED but unresolvable — %s → null + a reason", (_label, value, reason) => {
    const { dataUri, error } = resolveDeclaredLogo(relDir, value);
    expect(dataUri).toBeNull();
    expect(error).toMatch(reason);
    // The value-only accessor keeps its exact pre-#1482 contract (null, never a throw).
    expect(sanitizeLogoDataUri(relDir, value)).toBeNull();
    // …and the gate arm the generator pushes into `bindingErrors` reports it,
    // package-name-prefixed, so the build failure names the offending extension.
    const errs = validateDeclaredLogo(relDir, "@cinatra-ai/x-connector", { logo: value });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^@cinatra-ai\/x-connector — /);
    expect(errs[0]).toMatch(reason);
  });

  it("the gate arm is SILENT for an undeclared logo and for a resolvable one", () => {
    expect(validateDeclaredLogo(relDir, "@cinatra-ai/x-connector", {})).toEqual([]);
    expect(validateDeclaredLogo(relDir, "@cinatra-ai/x-connector", { logo: null })).toEqual([]);
    expect(validateDeclaredLogo(relDir, "@cinatra-ai/x-connector", undefined)).toEqual([]);
    expect(validateDeclaredLogo(relDir, "@cinatra-ai/x-connector", { logo: "./logo.svg" })).toEqual([]);
  });
});

describe("the real extension tree carries no mis-declared logo (cinatra#1482 gate, live)", () => {
  it("buildManifest succeeds and every record.logo is null or a sanitized inline-SVG data URI", async () => {
    const { records } = await buildManifest();
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.logo === null || /^data:image\/svg\+xml;base64,/.test(r.logo), r.packageName).toBe(true);
    }
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

  // #12 connector vendor-identity end-state: a connector declares its OWN
  // vendor key + name in its manifest (`cinatra.vendor`). The generator accepts
  // ANY non-empty string key (the SDK owns no roster — open marketplace) and
  // carries the value THROUGH unvalidated; authoritative shape/ownership/
  // uniqueness/provider-mapping verification is the marketplace publish gate's
  // job (separate repo), not the generator's.
  it("resolveVendor accepts a manifest-declared vendor identity (any key, trimmed; else null)", () => {
    // A well-known first-party vendor key is accepted verbatim.
    expect(resolveVendor({ vendor: { key: "openai", name: "OpenAI" } })).toEqual({
      key: "openai",
      name: "OpenAI",
    });
    // A NOVEL key no first-party connector ships is accepted unchanged — the
    // open marketplace: the SDK enumerates NO authoritative vendor roster.
    expect(resolveVendor({ vendor: { key: "acme-crm", name: "Acme CRM" } })).toEqual({
      key: "acme-crm",
      name: "Acme CRM",
    });
    // Trimmed.
    expect(resolveVendor({ vendor: { key: "  zap  ", name: "  Zapier  " } })).toEqual({
      key: "zap",
      name: "Zapier",
    });
    // Absent / malformed → null (carried through as null on the record).
    expect(resolveVendor({})).toBeNull();
    expect(resolveVendor({ vendor: null })).toBeNull();
    expect(resolveVendor({ vendor: { key: "openai" } })).toBeNull();
    expect(resolveVendor({ vendor: { name: "OpenAI" } })).toBeNull();
    expect(resolveVendor({ vendor: { key: "", name: "x" } })).toBeNull();
    expect(resolveVendor({ vendor: { key: "x", name: "   " } })).toBeNull();
    expect(resolveVendor({ vendor: { key: 42, name: "x" } })).toBeNull();
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

  it("readPresentExtensionNames reads package names from disk, scoped to the declared universe", () => {
    const root = mkdtempSync(path.join(tmpdir(), "present-names-"));
    try {
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          cinatra: { devExtensions: { "@some-scope/alpha-connector": "https://example.invalid/a.git" } },
        }),
      );
      mkdirSync(path.join(root, "extensions", "some-scope", "alpha-connector"), { recursive: true });
      writeFileSync(
        path.join(root, "extensions", "some-scope", "alpha-connector", "package.json"),
        JSON.stringify({ name: "@some-scope/alpha-connector" }),
      );
      mkdirSync(path.join(root, "extensions", "some-scope", "not-a-package"), { recursive: true });
      // A stale clone-back leftover (cinatra#2543): on disk, NOT declared. It
      // contributes no manifest record, so it must not count as present either
      // — otherwise a catalog descriptor for it becomes a hard parity break.
      mkdirSync(path.join(root, "extensions", "some-scope", "retired-agent"), { recursive: true });
      writeFileSync(
        path.join(root, "extensions", "some-scope", "retired-agent", "package.json"),
        JSON.stringify({ name: "@some-scope/retired-agent" }),
      );
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
    // A schema-config connector (declared cinatra.uiSurface, host-rendered from
    // configSchema — the 0.1.4+ conversions) is NOT a facade even without pages.
    const schemaConfig = records.find(
      (r) => r.kind === "connector" && !r.hasSetupPage && !r.hasSettingsPage && r.configSchema,
    );
    expect(schemaConfig).toBeDefined();
    expect(schemaConfig.uiSurface).toBe("schema-config");
    const facade = records.find(
      (r) =>
        r.kind === "connector" && !r.hasSetupPage && !r.hasSettingsPage && !r.configSchema,
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

describe("inbound-webhook declaration (cinatra.webhooks, cinatra#340)", () => {
  const validHook = {
    id: "post-published",
    handler: "./src/webhooks/post-published",
    factory: "createPostPublishedHandler",
  };

  it("validateWebhooksDeclaration: valid declaration → no errors", () => {
    expect(
      validateWebhooksDeclaration("@x/p", {
        hooks: [validHook, { ...validHook, id: "post-updated", rejectStatus: 422, label: "Updated" }],
      }),
    ).toEqual([]);
  });

  it("FAILS CLOSED: non-object, empty hooks, bad id, missing handler/factory", () => {
    expect(validateWebhooksDeclaration("@x/p", "nope").length).toBeGreaterThan(0);
    expect(validateWebhooksDeclaration("@x/p", { hooks: [] })).toEqual(
      expect.arrayContaining([expect.stringContaining("non-empty array")]),
    );
    expect(
      validateWebhooksDeclaration("@x/p", { hooks: [{ ...validHook, id: "Bad ID!" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".id")]));
    expect(
      validateWebhooksDeclaration("@x/p", { hooks: [{ id: "ok", factory: "createX" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".handler")]));
    expect(
      validateWebhooksDeclaration("@x/p", { hooks: [{ id: "ok", handler: "./h" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".factory")]));
  });

  it("FAILS CLOSED: duplicate hook id within a package", () => {
    expect(
      validateWebhooksDeclaration("@x/p", { hooks: [validHook, { ...validHook }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("duplicate hook id")]));
  });

  it("FAILS CLOSED: rejectStatus out of the 4xx range; schemaVersion < 1", () => {
    expect(
      validateWebhooksDeclaration("@x/p", { hooks: [{ ...validHook, rejectStatus: 503 }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("rejectStatus")]));
    expect(
      validateWebhooksDeclaration("@x/p", { hooks: [{ ...validHook, rejectStatus: 200 }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("rejectStatus")]));
    expect(
      validateWebhooksDeclaration("@x/p", { hooks: [{ ...validHook, schemaVersion: 0 }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("schemaVersion")]));
  });

  it("webhookHandlerExportsFactory: detects an exported function/const factory, rejects a missing one", () => {
    expect(
      webhookHandlerExportsFactory(
        "export function createPostPublishedHandler() {}",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    expect(
      webhookHandlerExportsFactory(
        "export const createPostPublishedHandler = () => {};",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    expect(
      webhookHandlerExportsFactory(
        "export async function createPostPublishedHandler() {}",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    // A non-exported or absent factory is rejected (fail-closed at generation).
    expect(
      webhookHandlerExportsFactory("function createPostPublishedHandler() {}", "createPostPublishedHandler"),
    ).toBe(false);
    expect(webhookHandlerExportsFactory("export const other = 1;", "createPostPublishedHandler")).toBe(
      false,
    );
  });

  it("webhookHandlerExportsFactory: proves CALLABILITY — rejects a non-function const, comments, and strings", () => {
    // A const bound to a NON-function value is rejected (the old loose regex
    // accepted any `export const NAME = …`).
    expect(
      webhookHandlerExportsFactory("export const createPostPublishedHandler = 5;", "createPostPublishedHandler"),
    ).toBe(false);
    expect(
      webhookHandlerExportsFactory(
        'export const createPostPublishedHandler = "not a function";',
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    // Async arrow + typed-param arrow forms are accepted (callable).
    expect(
      webhookHandlerExportsFactory(
        "export const createPostPublishedHandler = async () => {};",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    expect(
      webhookHandlerExportsFactory(
        "export const createPostPublishedHandler = (deps: Deps) => ({});",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    // `export const NAME: Type = function` is accepted.
    expect(
      webhookHandlerExportsFactory(
        "export const createPostPublishedHandler: Factory = function () {};",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    // A mention ONLY inside a comment or a string never satisfies the gate.
    expect(
      webhookHandlerExportsFactory(
        "// export function createPostPublishedHandler() {}\nexport const other = 1;",
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    expect(
      webhookHandlerExportsFactory(
        "/* export const createPostPublishedHandler = () => {}; */\nexport const other = 1;",
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    expect(
      webhookHandlerExportsFactory(
        'const doc = "export function createPostPublishedHandler() {}";',
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    // A mention inside a TEMPLATE literal (incl. a nested template in `${}`) or
    // a REGEX literal never satisfies the gate (fail-closed strip).
    expect(
      webhookHandlerExportsFactory(
        "const s = `${`export function createPostPublishedHandler() {}`}`;",
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    expect(
      webhookHandlerExportsFactory(
        "const re = /export function createPostPublishedHandler\\(/;",
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    // An arrow whose params contain a default with NESTED parens is callable.
    expect(
      webhookHandlerExportsFactory(
        "export const createPostPublishedHandler = (deps = makeDeps()) => ({});",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    // A REAL export sitting after a template/regex line is still detected (the
    // strip does not corrupt the surrounding real code).
    expect(
      webhookHandlerExportsFactory(
        "const re = /a\\/b/g;\nexport function createPostPublishedHandler() {}",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    // A bare-identifier arrow head and an extra-parenthesized arrow are callable.
    expect(
      webhookHandlerExportsFactory(
        "export const createPostPublishedHandler = deps => ({});",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    expect(
      webhookHandlerExportsFactory(
        "export const createPostPublishedHandler = ((deps) => ({}));",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    // STATEMENT-ANCHORING: a `return`ed regex / a string whose CONTENT is a fake
    // `export function NAME(` is mid-expression (not at statement position) and
    // must NOT satisfy the gate.
    expect(
      webhookHandlerExportsFactory(
        "function x(){ return /export function createPostPublishedHandler()/; }\nexport const other = 1;",
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    expect(
      webhookHandlerExportsFactory(
        'const s = "; export function createPostPublishedHandler() {}";\nexport const other = 1;',
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    // A postfix `++` before a `/` is DIVISION — the stripper must not eat the
    // following real `export` as a regex body (no false rejection).
    expect(
      webhookHandlerExportsFactory(
        "let n = 0; const z = n++ / 2;\nexport function createPostPublishedHandler() {}",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    // A regex in KEYWORD context (e.g. after `return`) is stripped, so a fake
    // `; export function NAME(` inside the regex body must NOT pass the gate.
    expect(
      webhookHandlerExportsFactory(
        "function x(){ return /; export function createPostPublishedHandler()/; }\nexport const other = 1;",
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    // A NESTED-generic arrow head is callable (not falsely rejected).
    expect(
      webhookHandlerExportsFactory(
        "export const createPostPublishedHandler = <T extends Record<string, unknown>>(deps: T) => ({});",
        "createPostPublishedHandler",
      ),
    ).toBe(true);
    // Regex literals after `)` / `}` (control-flow heads / block ends) are also
    // stripped (fail-closed bias), so a fake `; export …` in the regex body is
    // rejected.
    expect(
      webhookHandlerExportsFactory(
        "if (ok) /; export function createPostPublishedHandler()/.test(x);\nexport const other = 1;",
        "createPostPublishedHandler",
      ),
    ).toBe(false);
    expect(
      webhookHandlerExportsFactory(
        "{} /; export function createPostPublishedHandler()/.test(x);\nexport const other = 1;",
        "createPostPublishedHandler",
      ),
    ).toBe(false);
  });

  it("the real tree emits exactly the declared cinatra.webhooks hooks (wordpress-mcp post-published since 0.1.5; drupal-mcp node-published since cinatra#974)", async () => {
    const { webhookHooks } = await buildManifest();
    expect(
      webhookHooks.map((h) => `${h.vendor}/${h.slug}/${h.hook}`).sort(),
    ).toEqual([
      "cinatra-ai/drupal-mcp-connector/node-published",
      "cinatra-ai/wordpress-mcp-connector/post-published",
    ]);
  });
});

describe("stream declarations (cinatra.streams, cinatra#344)", () => {
  const validStream = {
    streamSlug: "x-content-editor",
    label: "X Content Editor",
    handler: "./src/streams/run",
    factory: "createRunStream",
  };

  it("validateStreamsDeclaration: valid declaration → no errors", () => {
    expect(
      validateStreamsDeclaration("@x/p", {
        streams: [validStream, { ...validStream, streamSlug: "x-other", resume: true }],
      }),
    ).toEqual([]);
  });

  it("FAILS CLOSED: non-object, empty streams, bad slug, missing label/handler/factory", () => {
    expect(validateStreamsDeclaration("@x/p", "nope").length).toBeGreaterThan(0);
    expect(validateStreamsDeclaration("@x/p", { streams: [] })).toEqual(
      expect.arrayContaining([expect.stringContaining("non-empty array")]),
    );
    expect(
      validateStreamsDeclaration("@x/p", { streams: [{ ...validStream, streamSlug: "Bad Slug!" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".streamSlug")]));
    expect(
      validateStreamsDeclaration("@x/p", { streams: [{ streamSlug: "ok", handler: "./h", factory: "createX" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".label")]));
    expect(
      validateStreamsDeclaration("@x/p", { streams: [{ streamSlug: "ok", label: "L", factory: "createX" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".handler")]));
    expect(
      validateStreamsDeclaration("@x/p", { streams: [{ streamSlug: "ok", label: "L", handler: "./h" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".factory")]));
  });

  it("FAILS CLOSED: duplicate slug within a package; non-boolean resume", () => {
    expect(
      validateStreamsDeclaration("@x/p", { streams: [validStream, { ...validStream }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("duplicate slug")]));
    expect(
      validateStreamsDeclaration("@x/p", { streams: [{ ...validStream, resume: "yes" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".resume")]));
  });

  it("handler factory resolvability reuses the fail-closed structural check (callable export required)", () => {
    // The collection path asserts the declared factory is an exported function
    // via webhookHandlerExportsFactory (shared structural gate); prove the
    // contract holds for a stream-style factory name.
    expect(
      webhookHandlerExportsFactory("export function createRunStream() {}", "createRunStream"),
    ).toBe(true);
    expect(webhookHandlerExportsFactory("export const createRunStream = 5;", "createRunStream")).toBe(false);
  });

  it("the real tree emits an EMPTY stream map (inert — no extension declares cinatra.streams)", async () => {
    const { streamDeclarations } = await buildManifest();
    expect(streamDeclarations).toEqual([]);
  });
});

describe("chat renderable-view declarations (cinatra.views, cinatra#1626 S9/M4)", () => {
  const validEntry = { viewType: "chart", entry: "./src/views/chart.tsx", propsApiVersion: 1 };
  const validDecl = { abiVersion: 1, entries: [validEntry] };

  it("validateChatViewsDeclaration: valid declaration → no errors", () => {
    expect(validateChatViewsDeclaration("@x/p", validDecl)).toEqual([]);
    expect(
      validateChatViewsDeclaration("@x/p", {
        abiVersion: 1,
        entries: [validEntry, { viewType: "content_change_proposal", entry: "./src/views/proposal", propsApiVersion: 2 }],
      }),
    ).toEqual([]);
  });

  it("FAILS CLOSED: non-object, wrong abiVersion, empty entries, bad viewType, uncontained entry, bad propsApiVersion, extraneous key", () => {
    expect(validateChatViewsDeclaration("@x/p", "nope").length).toBeGreaterThan(0);
    expect(validateChatViewsDeclaration("@x/p", { abiVersion: 2, entries: [validEntry] })).toEqual(
      expect.arrayContaining([expect.stringContaining(".abiVersion")]),
    );
    expect(validateChatViewsDeclaration("@x/p", { abiVersion: 1, entries: [] })).toEqual(
      expect.arrayContaining([expect.stringContaining("non-empty array")]),
    );
    expect(
      validateChatViewsDeclaration("@x/p", { abiVersion: 1, entries: [{ ...validEntry, viewType: "Chart" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".viewType")]));
    expect(
      validateChatViewsDeclaration("@x/p", { abiVersion: 1, entries: [{ ...validEntry, entry: "./a/../b" }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".entry")]));
    expect(
      validateChatViewsDeclaration("@x/p", { abiVersion: 1, entries: [{ ...validEntry, propsApiVersion: 0 }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining(".propsApiVersion")]));
    expect(
      validateChatViewsDeclaration("@x/p", { abiVersion: 1, entries: [{ ...validEntry, ports: [] }] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("unexpected key")]));
  });

  it("FAILS CLOSED: duplicate viewType within a package (one effective provider per viewType)", () => {
    expect(
      validateChatViewsDeclaration("@x/p", {
        abiVersion: 1,
        entries: [validEntry, { ...validEntry, entry: "./src/views/chart2.tsx" }],
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("duplicate viewType")]));
  });

  it("the real tree emits the `chart` chat-view from @cinatra-ai/chart-artifact (S9-b cutover, #1626)", async () => {
    const { chatViews } = await buildManifest();
    // chart-artifact is the sole `cinatra.views` provider; one effective
    // provider per viewType, so exactly one `chart` entry is emitted.
    expect(chatViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewType: "chart",
          packageName: "@cinatra-ai/chart-artifact",
          propsApiVersion: 1,
        }),
      ]),
    );
    expect(chatViews.filter((v) => v.viewType === "chart")).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// cinatra#2469 — `cinatra.logo` is a CROSS-KIND declaration.
//
// Maintainer decision (2026-08-06): "Every extension kind must be able to
// self-define `cinatra.logo`". The generator half was ALREADY kind-agnostic
// when #1482/#2467 landed — `validateDeclaredLogo` runs over every record in
// the collection loop with no `kind` branch, and the record assembly emits
// `logo: sanitizeLogoDataUri(...)` unconditionally. What blocked the other
// kinds was the artifact allowlist (`ARTIFACT_ALLOWED_CINATRA_KEYS`), fixed in
// `packages/sdk-extensions`.
//
// These fixtures PIN the kind-agnosticism rather than assuming it: the exact
// #1482 fail-closed matrix (absent → clean; valid → data URI; declared-but-
// unresolvable → one named reason) is re-run against an IN-REPO fixture package
// of EACH kind, and the live-tree assertion below pins that the generator emits
// the `logo` field for every kind it actually scans.
//
// NOTE on what makes these non-tautological: `validateDeclaredLogo` receives the
// whole cinatra block, so it COULD branch on `cin.kind` — the per-kind cases
// below pass genuinely different `kind` values and would catch such a branch.
// (An earlier draft asserted the function's formal-parameter count instead;
// codex round-0 correctly called that noise with a false rationale — a
// third-argument branch needs no extra parameter — and it was removed.)
// ---------------------------------------------------------------------------
describe("validateDeclaredLogo / sanitizeLogoDataUri are KIND-AGNOSTIC (cinatra#2469)", () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const relDir = ".tmp-2469-cross-kind-logo-test";
  const absDir = path.join(REPO_ROOT, relDir);

  // The five kinds the extension model names (`workflow` is the retired install
  // path still tolerated on the normalized record — included on purpose so a
  // legacy-kind package is proven to behave identically, not specially).
  const KINDS = ["agent", "connector", "artifact", "skill", "workflow"];

  beforeAll(() => {
    rmSync(absDir, { recursive: true, force: true });
    mkdirSync(absDir, { recursive: true });
    writeFileSync(
      path.join(absDir, "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
    );
    writeFileSync(path.join(absDir, "hostile.svg"), '<svg><script>alert(1)</script></svg>');
  });
  afterAll(() => {
    rmSync(absDir, { recursive: true, force: true });
  });

  it.each(KINDS)("kind=%s — ABSENT stays completely clean (the documented default)", (kind) => {
    expect(validateDeclaredLogo(relDir, `@cinatra-ai/fixture-${kind}`, { kind })).toEqual([]);
    expect(validateDeclaredLogo(relDir, `@cinatra-ai/fixture-${kind}`, { kind, logo: null })).toEqual([]);
  });

  it.each(KINDS)("kind=%s — a VALID in-package logo passes the gate and inlines to a data URI", (kind) => {
    const cin = { kind, apiVersion: "cinatra.ai/v1", logo: "./logo.svg" };
    expect(validateDeclaredLogo(relDir, `@cinatra-ai/fixture-${kind}`, cin)).toEqual([]);
    const { dataUri, error } = resolveDeclaredLogo(relDir, cin.logo);
    expect(error).toBeNull();
    expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    // Byte-identical to the value the record assembly emits.
    expect(dataUri).toBe(sanitizeLogoDataUri(relDir, cin.logo));
  });

  it.each(KINDS)(
    "kind=%s — a DECLARED-but-unresolvable logo fails CLOSED with a named reason (never a silent fallback)",
    (kind) => {
      const pkgName = `@cinatra-ai/fixture-${kind}`;
      for (const [value, reason] of [
        ["./nope.svg", /does not resolve to a readable file inside the package/],
        ["./logo.png", /is not a "\.svg" path/],
        ["../../etc/hostname.svg", /escapes the package directory/],
        ["./hostile.svg", /REJECTED by the SVG sanitizer/],
        ["", /non-empty package-relative/],
      ]) {
        const errs = validateDeclaredLogo(relDir, pkgName, { kind, logo: value });
        expect(errs, `${kind} ${value}`).toHaveLength(1);
        expect(errs[0]).toMatch(new RegExp(`^${pkgName.replace("/", "\\/")} — `));
        expect(errs[0]).toMatch(reason);
        expect(sanitizeLogoDataUri(relDir, value)).toBeNull();
      }
    },
  );

  it("every kind produces the IDENTICAL error text for the identical bad declaration (no per-kind wording)", () => {
    const texts = new Set(
      KINDS.map(
        (kind) => validateDeclaredLogo(relDir, "@cinatra-ai/same-name", { kind, logo: "./nope.svg" })[0],
      ),
    );
    expect(texts.size).toBe(1);
  });
});

describe("the generator emits `logo` for EVERY scanned kind, not only connectors (cinatra#2469, live tree)", () => {
  it("every record carries the logo field and the scanned tree spans non-connector kinds", async () => {
    const { records } = await buildManifest();
    expect(records.length).toBeGreaterThan(0);
    const kinds = new Set(records.map((r) => r.kind));
    // The emission is unconditional, so the field must exist on every record
    // regardless of kind — a per-kind branch would show up as a missing field.
    for (const r of records) {
      expect(Object.hasOwn(r, "logo"), r.packageName).toBe(true);
      expect(r.logo === null || /^data:image\/svg\+xml;base64,/.test(r.logo), r.packageName).toBe(true);
    }
    // Guard the guard: the assertion above is only meaningful if the scanned
    // tree actually contains non-connector kinds.
    expect(kinds.has("connector")).toBe(true);
    expect([...kinds].some((k) => k !== "connector")).toBe(true);
  });
});

describe("the generator scopes the on-disk tree to the DECLARED extension universe (cinatra#2543)", () => {
  // `extensions/` is gitignored and populated by a clone-back step that
  // clones-or-fast-forwards every DECLARED entry and never PRUNES a directory
  // that left the declaration. A RETIRED extension's checkout therefore survives
  // in every workspace that once had it — and before this fix the raw disk scan
  // fed it to the fail-closed declaration gates, so a stale directory failed
  // manifest generation (and therefore `cinatra install`, which regenerates the
  // maps) naming the kind VOCABULARY instead of the stale checkout.

  it("collects the union of devExtensions, extensions (range-stripped), systemExtensions and vendored bundles", () => {
    const universe = readDeclaredExtensionUniverse({
      cinatra: {
        devExtensions: { "@scope/dev-only": "https://example.invalid/d.git" },
        extensions: ["@scope/acquired@^0.1.0", "@scope/dev-only@^2.0.0-rc.1"],
        systemExtensions: ["@scope/locked"],
        vendoredSkillBundles: [{ packageName: "@vendor/bundle" }, { notAPackage: true }, null],
      },
    });
    expect([...universe].sort()).toEqual([
      "@scope/acquired",
      "@scope/dev-only",
      "@scope/locked",
      "@vendor/bundle",
    ]);
  });

  it("tolerates a missing/malformed cinatra block instead of throwing (the caller decides the posture)", () => {
    expect(readDeclaredExtensionUniverse(undefined).size).toBe(0);
    expect(readDeclaredExtensionUniverse({}).size).toBe(0);
    expect(
      readDeclaredExtensionUniverse({ cinatra: { devExtensions: null, extensions: "nope", systemExtensions: 7 } }).size,
    ).toBe(0);
  });

  it("keeps the scope + version-range split straight, whitespace-tolerantly", () => {
    const universe = readDeclaredExtensionUniverse({
      cinatra: { extensions: ["plain-pkg@1.2.3", "@scope/bare", "plain-pkg2", "  @scope/padded@^1.0.0  "] },
    });
    expect([...universe].sort()).toEqual(["@scope/bare", "@scope/padded", "plain-pkg", "plain-pkg2"]);
  });

  it("assertDeclarationShapes is the FAIL-CLOSED posture: a malformed declaration must not read as 'declares nothing'", () => {
    const ok = {
      cinatra: { devExtensions: { "@scope/a": "https://example.invalid/a.git" }, systemExtensions: ["@scope/a"] },
    };
    expect(() => assertDeclarationShapes(ok)).not.toThrow();
    expect(() => assertDeclarationShapes({ cinatra: { ...ok.cinatra, devExtensions: ["@scope/a"] } })).toThrow(
      /cinatra\.devExtensions must be an object/,
    );
    expect(() => assertDeclarationShapes({ cinatra: { ...ok.cinatra, extensions: "nope" } })).toThrow(
      /cinatra\.extensions must be an array/,
    );
    expect(() => assertDeclarationShapes({ cinatra: { ...ok.cinatra, extensions: ["@scope/a@^1", ""] } })).toThrow(
      /cinatra\.extensions\[1\]/,
    );
    expect(() => assertDeclarationShapes({ cinatra: { ...ok.cinatra, systemExtensions: ["@scope/a", 7] } })).toThrow(
      /cinatra\.systemExtensions\[1\]/,
    );
    expect(() => assertDeclarationShapes({ cinatra: { ...ok.cinatra, systemExtensions: "@scope/a" } })).toThrow(
      /cinatra\.systemExtensions must be an array/,
    );
    expect(() => assertDeclarationShapes({ cinatra: { ...ok.cinatra, vendoredSkillBundles: [{}] } })).toThrow(
      /vendoredSkillBundles\[0\]/,
    );
    // An empty universe would silently drop EVERY on-disk package.
    expect(() => assertDeclarationShapes({ cinatra: {} })).toThrow(/declares no extension universe/);
  });

  it("the live root package.json passes the shape gate (the gate is not vacuous)", async () => {
    const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const { readFileSync } = await import("node:fs");
    const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(() => assertDeclarationShapes(rootPkg)).not.toThrow();
  });

  it("the live tree's declared universe covers every extension the manifest emits a record for", async () => {
    // The invariant the fix rests on: after filtering, every generated record is
    // a package the host actually declares. Derived from the live tree, so a
    // future filter regression (or a declaration deleted without its record)
    // fails here rather than at install time.
    const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const { readFileSync } = await import("node:fs");
    const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const universe = readDeclaredExtensionUniverse(rootPkg);
    expect(universe.size).toBeGreaterThan(0);
    const { records } = await buildManifest();
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(universe.has(r.packageName), r.packageName).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The packaging rule's host half (plan (C) item 0.8 / §8.5): "every base
// extension gains its `exports` entry, the generated display maps stop
// importing internal source paths, and the thirteen hand-maintained aliases
// go." The generated display map is the emitted artefact those three sentences
// meet in, so it is pinned here: every emitted renderer import is a BARE
// package specifier that the owning package itself publishes at the
// generator's `exports` key, and NO host-maintained path alias stands behind
// it any more (neither in the generated tsconfig nor in its source manifest).
// A regression in any direction — a re-introduced alias, a relative path into
// extensions/, an unpublished key — is a failure here rather than a runtime
// import error on a page.
// ---------------------------------------------------------------------------
describe("the generated display map imports through package exports, never a host alias", () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const MAP_REL = "src/lib/generated/artifact-renderers.ts";

  /** Every dynamic-import specifier the generated display map emits. */
  function emittedRendererSpecifiers() {
    const src = readFileSync(path.join(REPO_ROOT, MAP_REL), "utf8");
    const found = new Set();
    for (const m of src.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) found.add(m[1]);
    return [...found].sort();
  }

  /** The emitted specifiers of entries the generator classified `required` —
   *  the packages the host acquires in every deployment. A `guardedOptional`
   *  entry is a package the required set deliberately does NOT carry, so it can
   *  take no workspace dependency edge (the coverage gate refuses one for a
   *  package outside `cinatra.extensions`) and keeps its host alias until it
   *  either joins that set or the guarded road gets a resolution of its own. */
  function emittedByResolution(resolution) {
    const src = readFileSync(path.join(REPO_ROOT, MAP_REL), "utf8");
    const found = new Set();
    const entry = /resolution:\s*"([^"]+)"[\s\S]*?import\(\s*"([^"]+)"\s*\)/g;
    for (const line of src.split("\n")) {
      entry.lastIndex = 0;
      const m = entry.exec(line);
      if (m && m[1] === resolution) found.add(m[2]);
    }
    return [...found].sort();
  }

  /** The generator's OWN alias predicate (generate-extension-manifest.mjs:
   *  `tsconfigText.includes(JSON.stringify(specifier))`), mirrored so this test
   *  judges resolution the way the generator judges it. tsconfig.json carries
   *  trailing line comments, so it is read as text, never parsed. */
  function tsconfigResolves(specifier) {
    const tsconfigText = readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8");
    return tsconfigText.includes(JSON.stringify(specifier));
  }

  function buildConfigAliases() {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "config/build-config.manifest.json"), "utf8"),
    );
    return new Set((manifest.tsconfigPaths ?? []).map((e) => e.alias));
  }

  it("emits one bare specifier per renderer — no relative path, no path into extensions/, no file extension", () => {
    const specifiers = emittedRendererSpecifiers();
    // Anti-vacuity: the thirteen alias-backed renderers are the floor; the two
    // new bases only add to it.
    expect(specifiers.length).toBeGreaterThanOrEqual(13);
    for (const spec of specifiers) {
      expect(spec.startsWith("."), spec).toBe(false);
      expect(spec.includes("extensions/"), spec).toBe(false);
      expect(/\.(ts|tsx|js|jsx)$/.test(spec), spec).toBe(false);
      expect(/^@[a-z0-9-]+\/[a-z0-9.-]+\/.+$/.test(spec), spec).toBe(true);
    }
  });

  it("no host-maintained path alias stands behind a REQUIRED base's renderer specifier (the eleven are gone)", () => {
    const required = emittedByResolution("required");
    expect(required.length).toBeGreaterThanOrEqual(11);
    const buildConfig = buildConfigAliases();
    expect(required.filter((s) => tsconfigResolves(s))).toEqual([]);
    expect(required.filter((s) => buildConfig.has(s))).toEqual([]);
  });

  it("the alias-backed remainder is EXACTLY the guarded-optional display, named and bounded", () => {
    // The aliases this change does not delete, pinned by name so a
    // re-introduced one for any other package fails here. A guardedOptional
    // package is outside `cinatra.extensions`, so it cannot take the workspace
    // dependency edge a bare specifier needs; its alias goes when it joins the
    // required set (or the guarded road gets its own resolution). The list
    // grows only when a pinned guarded-optional pack starts declaring its own
    // display: this wave advances exactly the screenshot and slide-deck display
    // packs plus cms-snapshot, so the remainder is the two pre-existing guarded
    // packs plus those three, and nothing else.
    const buildConfig = buildConfigAliases();
    const aliased = emittedRendererSpecifiers().filter(
      (s) => tsconfigResolves(s) || buildConfig.has(s),
    );
    expect(aliased).toEqual([
      "@cinatra-ai/cms-snapshot-artifact/src/renderers/detail",
      "@cinatra-ai/cms-snapshot-artifact/src/renderers/preview",
      "@cinatra-ai/podcast-artifacts/src/renderers/detail",
      "@cinatra-ai/podcast-artifacts/src/renderers/preview",
      "@cinatra-ai/screenshot-artifact/src/renderers/detail",
      "@cinatra-ai/slide-deck-artifact/src/renderers/detail",
    ]);
    expect(emittedByResolution("guardedOptional")).toEqual(aliased);
  });

  it("every emitted renderer specifier is published by its own package at the generator's exports key", () => {
    const specifiers = emittedRendererSpecifiers();
    const missing = [];
    for (const spec of specifiers) {
      const m = spec.match(/^(@[^/]+\/[^/]+)\/(.+)$/);
      expect(m, spec).not.toBe(null);
      const [, packageName, subpath] = m;
      const dir = path.join(REPO_ROOT, "extensions", ...packageName.replace(/^@/, "").split("/"));
      const manifestPath = path.join(dir, "package.json");
      if (!existsSync(manifestPath)) {
        // A bare checkout without the companion tree cannot judge publication;
        // the two alias assertions above still ran.
        console.warn(`[artifact-renderers] ${packageName} absent from extensions/ — exports check skipped`);
        continue;
      }
      const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
      const key = `./${subpath}`;
      const exportsMap = pkg.exports;
      if (exportsMap === null || typeof exportsMap !== "object" || Array.isArray(exportsMap) || !(key in exportsMap)) {
        missing.push(`${packageName} does not publish exports["${key}"]`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE PACKAGING RULE, on fixtures (item 0.8 of `PLAN: Agents Lifecycle (C)`):
// "every artifact extension declares its display through its own `exports`, the
// generator REQUIRES it for artifact extensions, and the thirteen hand-maintained
// display aliases are deleted".
//
// The real-tree block above proves the CURRENT fleet is clean. These cases prove
// the generator would REFUSE a regression: an artifact renderer that publishes no
// `exports` entry must fail generation even when a host alias would resolve it,
// because an alias standing in for the packaging is the host-edit-per-extension
// coupling item 0.8 removes.
// ---------------------------------------------------------------------------
describe("the packaging rule: a display is published by its own package, never by a host alias", () => {
  const base = {
    packageName: "@cinatra-ai/example-artifact",
    slot: "detail",
    specifier: "@cinatra-ai/example-artifact/src/renderers/detail",
    exportsKey: "./src/renderers/detail",
  };

  it("REFUSES a renderer with no exports entry even when a host path alias would resolve it", () => {
    expect(() =>
      assertArtifactRendererPackaging({
        ...base,
        hasExportsEntry: false,
        hasAliasRoad: true,
        hasDependencyEdge: false,
      }),
    ).toThrow(/not published by its own package/);
    expect(() =>
      assertArtifactRendererPackaging({
        ...base,
        hasExportsEntry: false,
        hasAliasRoad: true,
        hasDependencyEdge: true,
      }),
    ).toThrow(/is not an accepted substitute/);
  });

  it("REFUSES a renderer that publishes its exports but has no resolution road at all", () => {
    expect(() =>
      assertArtifactRendererPackaging({
        ...base,
        hasExportsEntry: true,
        hasAliasRoad: false,
        hasDependencyEdge: false,
      }),
    ).toThrow(/has no resolution road/);
  });

  it("ACCEPTS exports + a root dependency edge (the required road) and exports + an alias (the guarded-optional road)", () => {
    expect(() =>
      assertArtifactRendererPackaging({
        ...base,
        hasExportsEntry: true,
        hasAliasRoad: false,
        hasDependencyEdge: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertArtifactRendererPackaging({
        ...base,
        hasExportsEntry: true,
        hasAliasRoad: true,
        hasDependencyEdge: false,
      }),
    ).not.toThrow();
  });
});
