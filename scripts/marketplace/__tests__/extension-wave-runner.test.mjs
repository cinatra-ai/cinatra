import { describe, expect, it } from "vitest";
import {
  isZeroDep,
  hasWorkspaceSpec,
  transformPackageJsonForPublish,
  classifyCinatraDeps,
  extractCinatraManifestDepNames,
  orderByExtensionDeps,
  selectWaveExtensions,
  validatePackedTarball,
  parseSubmitStdout,
  clampPaceMs,
  parseCanaryArg,
  normalizeCanaryLimit,
  getFlagValue,
  parseWaveArgs,
  assessStorefrontBody,
  decideWaveAction,
  MAX_TARBALL_BYTES,
  DEFAULT_PACE_MS,
  MIN_PACE_MS,
  ALWAYS_SKIP_SLUGS,
  AUTH_PREFLIGHT_PACKAGE,
} from "../extension-wave-runner.mjs";
import { classifySubmissionOutcome } from "../../extensions/templates/release/release-submit.mjs";
import { planExtractionForPackage } from "../../extensions/extract-extension-repos.mjs";

describe("AUTH_PREFLIGHT_PACKAGE (cinatra-extension-get requires a scoped name)", () => {
  it("is a scoped npm-style name (leading @) — a bare name is rejected by the server", () => {
    expect(AUTH_PREFLIGHT_PACKAGE.startsWith("@")).toBe(true);
    expect(AUTH_PREFLIGHT_PACKAGE).toMatch(/^@[a-z0-9-]+\/[a-z0-9-]+$/);
  });
});

describe("isZeroDep", () => {
  it("true when there is no @cinatra-ai/* dependency or peerDependency", () => {
    expect(isZeroDep({ dependencies: { zod: "^3" }, peerDependencies: { react: "*" } })).toBe(true);
    expect(isZeroDep({})).toBe(true);
  });
  it("false when an @cinatra-ai/* dep or peer is declared", () => {
    expect(isZeroDep({ dependencies: { "@cinatra-ai/sdk-ui": "*" } })).toBe(false);
    expect(isZeroDep({ peerDependencies: { "@cinatra-ai/sdk-extensions": "*" } })).toBe(false);
  });
});

describe("selectWaveExtensions", () => {
  const cand = (slug, manifest) => ({ slug, dir: `/x/${slug}`, manifest });
  const okPkg = (slug) => cand(slug, { name: `@cinatra-ai/${slug}`, version: "1.0.0", cinatra: { kind: "skill" } });

  it("keeps eligible 0-dep packages and sorts by slug", () => {
    const sel = selectWaveExtensions([okPkg("b-agent"), okPkg("a-skill")]);
    expect(sel.map((e) => e.slug)).toEqual(["a-skill", "b-agent"]);
    expect(sel.every((e) => e.eligible)).toBe(true);
  });

  it("always skips the already-published blog-skills slug", () => {
    expect(ALWAYS_SKIP_SLUGS.has("blog-skills")).toBe(true);
    const sel = selectWaveExtensions([okPkg("blog-skills"), okPkg("keep-me")]);
    expect(sel.map((e) => e.slug)).toEqual(["keep-me"]);
  });

  it("honors --only and --exclude", () => {
    const all = [okPkg("a"), okPkg("b"), okPkg("c")];
    expect(selectWaveExtensions(all, { only: ["b"] }).map((e) => e.slug)).toEqual(["b"]);
    expect(selectWaveExtensions(all, { exclude: ["b"] }).map((e) => e.slug)).toEqual(["a", "c"]);
  });

  it("marks non-0-dep / malformed packages INELIGIBLE with reasons (does not drop silently)", () => {
    const sel = selectWaveExtensions([
      cand("has-dep", { name: "@cinatra-ai/has-dep", version: "1.0.0", cinatra: { kind: "agent" }, dependencies: { "@cinatra-ai/x": "*" } }),
      cand("no-kind", { name: "@cinatra-ai/no-kind", version: "1.0.0" }),
      cand("no-name", { version: "1.0.0", cinatra: { kind: "skill" } }),
    ]);
    const byslug = Object.fromEntries(sel.map((e) => [e.slug, e]));
    expect(byslug["has-dep"].eligible).toBe(false);
    expect(byslug["has-dep"].reasons.join()).toMatch(/0-dep/);
    expect(byslug["no-kind"].reasons.join()).toMatch(/cinatra\.kind/);
    expect(byslug["no-name"].reasons.join()).toMatch(/scoped package name/);
  });
});

describe("hasWorkspaceSpec", () => {
  it("detects workspace: specs in any dep field", () => {
    expect(hasWorkspaceSpec({ dependencies: { "@cinatra-ai/sdk-extensions": "workspace:*" } })).toBe(true);
    expect(hasWorkspaceSpec({ peerDependencies: { x: "workspace:^1" } })).toBe(true);
    expect(hasWorkspaceSpec({ dependencies: { react: "^19" }, peerDependencies: { "react-dom": "^19" } })).toBe(false);
    expect(hasWorkspaceSpec({})).toBe(false);
  });
});

describe("transformPackageJsonForPublish (workspace:* → host peers, no workspace survives)", () => {
  const src = {
    name: "@cinatra-ai/apify-connector",
    version: "0.1.0",
    private: true,
    type: "module",
    main: "src/index.ts",
    dependencies: { "@cinatra-ai/sdk-extensions": "workspace:*", "@cinatra-ai/sdk-ui": "workspace:*", clsx: "^2.1.1" },
    peerDependencies: { react: "^19.2.3" },
    cinatra: { apiVersion: "cinatra.ai/v1", kind: "connector" },
  };
  const out = transformPackageJsonForPublish(src);

  it("moves @cinatra-ai workspace deps into peerDependencies as '*'", () => {
    expect(out.peerDependencies["@cinatra-ai/sdk-extensions"]).toBe("*");
    expect(out.peerDependencies["@cinatra-ai/sdk-ui"]).toBe("*");
    expect(out.peerDependencies.react).toBe("^19.2.3"); // existing peer preserved
  });
  it("keeps real registry deps verbatim in dependencies", () => {
    expect(out.dependencies).toEqual({ clsx: "^2.1.1" });
  });
  it("preserves the cinatra block + entry fields and drops private", () => {
    expect(out.cinatra).toEqual({ apiVersion: "cinatra.ai/v1", kind: "connector" });
    expect(out.main).toBe("src/index.ts");
    expect(out.private).toBeUndefined();
  });
  it("leaves NO workspace: spec anywhere", () => {
    expect(JSON.stringify(out)).not.toContain("workspace:");
  });
  it("handles optionalDependencies (workspace:* → '*'), no workspace survives", () => {
    const o = transformPackageJsonForPublish({
      name: "@cinatra-ai/x",
      version: "1.0.0",
      optionalDependencies: { "@cinatra-ai/foo": "workspace:*", realopt: "^1.0.0" },
    });
    expect(o.optionalDependencies).toEqual({ "@cinatra-ai/foo": "*", realopt: "^1.0.0" });
    expect(JSON.stringify(o)).not.toContain("workspace:");
  });
  it("throws if a workspace spec would survive (defensive)", () => {
    // peerDependenciesMeta-style residue is not handled, but a stray workspace value in
    // an existing peer must collapse to '*', never survive:
    expect(transformPackageJsonForPublish({ name: "x", version: "1", peerDependencies: { y: "workspace:*" } }).peerDependencies.y).toBe("*");
  });
});

describe("extractCinatraManifestDepNames (canonical cinatra.dependencies)", () => {
  it("reads a list of {packageName} edge objects", () => {
    const m = { cinatra: { dependencies: [{ packageName: "@cinatra-ai/crm-connector", kind: "connector" }] } };
    expect(extractCinatraManifestDepNames(m)).toEqual(["@cinatra-ai/crm-connector"]);
  });
  it("reads a list of strings and a name→spec object", () => {
    expect(extractCinatraManifestDepNames({ cinatra: { dependencies: ["@cinatra-ai/x", "y"] } })).toEqual(["@cinatra-ai/x", "@cinatra-ai/y"]);
    expect(extractCinatraManifestDepNames({ cinatra: { dependencies: { "@cinatra-ai/z": "*" } } })).toEqual(["@cinatra-ai/z"]);
  });
  it("empty when absent/null", () => {
    expect(extractCinatraManifestDepNames({ cinatra: { dependencies: null } })).toEqual([]);
    expect(extractCinatraManifestDepNames({})).toEqual([]);
  });
});

describe("classifyCinatraDeps (extension vs host-internal; npm ∪ cinatra.dependencies)", () => {
  const extNames = new Set(["@cinatra-ai/nango-connector", "@cinatra-ai/crm-connector", "@cinatra-ai/social-media-connector"]);
  it("splits extension deps (in the set) from host-internal SDK deps (not in the set)", () => {
    const m = { dependencies: { "@cinatra-ai/nango-connector": "workspace:*", "@cinatra-ai/sdk-extensions": "workspace:*" } };
    const { extensionDeps, hostInternalDeps } = classifyCinatraDeps(m, extNames);
    expect(extensionDeps).toEqual(["@cinatra-ai/nango-connector"]);
    expect(hostInternalDeps).toEqual(["@cinatra-ai/sdk-extensions"]);
  });
  it("CATCHES an extension edge declared ONLY in cinatra.dependencies (the linkedin→social-media case)", () => {
    const m = {
      dependencies: { "@cinatra-ai/sdk-extensions": "workspace:*" }, // no npm extension dep
      cinatra: { dependencies: [{ packageName: "@cinatra-ai/social-media-connector" }] },
    };
    const { extensionDeps } = classifyCinatraDeps(m, extNames);
    expect(extensionDeps).toEqual(["@cinatra-ai/social-media-connector"]);
  });
  it("all host-internal when none are extensions", () => {
    const m = { dependencies: { "@cinatra-ai/sdk-extensions": "workspace:*", "@cinatra-ai/sdk-ui": "workspace:*" } };
    expect(classifyCinatraDeps(m, extNames).extensionDeps).toEqual([]);
  });
});

describe("orderByExtensionDeps (topological — deps publish first)", () => {
  const ext = (slug, deps = []) => ({ slug, name: `@cinatra-ai/${slug}`, extensionDeps: deps.map((d) => `@cinatra-ai/${d}`) });
  it("places a dependent AFTER its in-wave extension dep", () => {
    const ordered = orderByExtensionDeps([ext("anthropic-connector", ["nango-connector"]), ext("nango-connector")]);
    const slugs = ordered.map((e) => e.slug);
    expect(slugs.indexOf("nango-connector")).toBeLessThan(slugs.indexOf("anthropic-connector"));
  });
  it("ignores deps not in the wave (assumed already-published / host-internal)", () => {
    const ordered = orderByExtensionDeps([ext("twenty-connector", ["crm-connector"])]);
    expect(ordered.map((e) => e.slug)).toEqual(["twenty-connector"]);
  });
  it("throws on a cycle", () => {
    expect(() => orderByExtensionDeps([ext("a", ["b"]), ext("b", ["a"])])).toThrow(/cycle/);
  });
});

describe("selectWaveExtensions — connector mode (includeExtensionDeps)", () => {
  const cand = (slug, manifest) => ({ slug, dir: `/x/${slug}`, manifest });
  const conn = (slug, deps) => cand(slug, { name: `@cinatra-ai/${slug}`, version: "0.1.0", cinatra: { kind: "connector" }, dependencies: deps });
  const extNames = new Set(["@cinatra-ai/nango-connector", "@cinatra-ai/apify-connector", "@cinatra-ai/anthropic-connector"]);

  it("0-dep mode still rejects a connector with @cinatra-ai deps", () => {
    const sel = selectWaveExtensions([conn("apify-connector", { "@cinatra-ai/sdk-extensions": "workspace:*" })], { extensionNames: extNames });
    expect(sel[0].eligible).toBe(false);
    expect(sel[0].reasons.join()).toMatch(/not 0-dep/);
  });
  it("connector mode accepts a connector whose only @cinatra-ai deps are host-internal", () => {
    const sel = selectWaveExtensions([conn("apify-connector", { "@cinatra-ai/sdk-extensions": "workspace:*", "@cinatra-ai/sdk-ui": "workspace:*" })], {
      extensionNames: extNames,
      includeExtensionDeps: true,
    });
    expect(sel[0].eligible).toBe(true);
    expect(sel[0].extensionDeps).toEqual([]);
    expect(sel[0].hostInternalDeps.length).toBe(2);
  });
  it("connector mode records an extension dep for ordering", () => {
    const sel = selectWaveExtensions([conn("anthropic-connector", { "@cinatra-ai/nango-connector": "workspace:*", "@cinatra-ai/sdk-extensions": "workspace:*" })], {
      extensionNames: extNames,
      includeExtensionDeps: true,
    });
    expect(sel[0].eligible).toBe(true);
    expect(sel[0].extensionDeps).toEqual(["@cinatra-ai/nango-connector"]);
  });
});

describe("validatePackedTarball", () => {
  const pack = (over = {}) => [{ size: 1000, files: [{ path: "package/package.json" }, { path: "package/README.md" }], ...over }];

  it("ok when under the cap with package.json + README + a declared kind", () => {
    const v = validatePackedTarball(pack(), { declaredKind: "skill" });
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
  });
  it("flags an oversized tarball against the 50MiB server cap", () => {
    const v = validatePackedTarball(pack({ size: MAX_TARBALL_BYTES + 1 }), { declaredKind: "skill" });
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/exceeds/);
  });
  it("flags a missing README (would blank the storefront Description tab)", () => {
    const v = validatePackedTarball([{ size: 10, files: [{ path: "package/package.json" }] }], { declaredKind: "skill" });
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/README/);
  });
  it("flags a missing cinatra.kind", () => {
    const v = validatePackedTarball(pack(), {});
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/cinatra\.kind/);
  });
  it("is case-insensitive about readme/package.json paths", () => {
    const v = validatePackedTarball([{ size: 10, files: [{ path: "PACKAGE/Package.json" }, { path: "PACKAGE/Readme.MD" }] }], { declaredKind: "agent" });
    expect(v.ok).toBe(true);
  });
});

describe("parseSubmitStdout", () => {
  it("parses submission_id, status, promotion_state", () => {
    const out = parseSubmitStdout("submission_id: 42\nstatus: promoted\npromotion_state: complete\n");
    expect(out).toEqual({ submissionId: "42", status: "promoted", promotionState: "complete" });
  });
  it("maps promotion_state n/a → null", () => {
    expect(parseSubmitStdout("submission_id: 7\nstatus: pending\npromotion_state: n/a\n").promotionState).toBeNull();
  });
  it("returns nulls on empty stdout", () => {
    expect(parseSubmitStdout("")).toEqual({ submissionId: null, status: null, promotionState: null });
  });
});

describe("clampPaceMs", () => {
  it("never below the rate-limit floor", () => {
    expect(clampPaceMs(1000)).toBe(MIN_PACE_MS);
    expect(clampPaceMs(20000)).toBe(20000);
  });
  it("defaults on a non-number", () => {
    expect(clampPaceMs("nope")).toBe(DEFAULT_PACE_MS);
  });
});

describe("parseCanaryArg (parses a PRESENT flag's value; fail closed)", () => {
  it("valid non-negative integers", () => {
    expect(parseCanaryArg("0")).toBe(0);
    expect(parseCanaryArg("5")).toBe(5);
  });
  it("THROWS on a missing/empty value (a present flag must carry a number)", () => {
    expect(() => parseCanaryArg(undefined)).toThrow(/requires a non-negative integer/);
    expect(() => parseCanaryArg("")).toThrow();
    expect(() => parseCanaryArg("   ")).toThrow();
  });
  it("THROWS on a malformed value (never silently disables the cap)", () => {
    expect(() => parseCanaryArg("nope")).toThrow(/non-negative integer/);
    expect(() => parseCanaryArg("-1")).toThrow();
    expect(() => parseCanaryArg("1.5")).toThrow();
  });
});

describe("getFlagValue (supports --flag value AND --flag=value; absent vs valueless)", () => {
  it("--flag value", () => {
    expect(getFlagValue(["--canary", "3"], "--canary")).toEqual({ present: true, value: "3" });
  });
  it("--flag=value", () => {
    expect(getFlagValue(["--canary=3"], "--canary")).toEqual({ present: true, value: "3" });
  });
  it("present but valueless (next token is another flag) → value undefined", () => {
    expect(getFlagValue(["--canary", "--execute"], "--canary")).toEqual({ present: true, value: undefined });
  });
  it("present but valueless (end of args) → value undefined", () => {
    expect(getFlagValue(["--canary"], "--canary")).toEqual({ present: true, value: undefined });
  });
  it("absent → present:false", () => {
    expect(getFlagValue(["--execute"], "--canary")).toEqual({ present: false, value: undefined });
  });
});

describe("parseWaveArgs (the fail-open cases)", () => {
  const argv = (...rest) => ["node", "script.mjs", ...rest];
  it("absent --canary → Infinity (whole set)", () => {
    expect(parseWaveArgs(argv()).canary).toBe(Infinity);
    expect(parseWaveArgs(argv("--execute")).canary).toBe(Infinity);
  });
  it("--canary 1 → 1", () => {
    expect(parseWaveArgs(argv("--canary", "1")).canary).toBe(1);
  });
  it("--canary=1 → 1 (the = form must NOT fail open to Infinity)", () => {
    expect(parseWaveArgs(argv("--canary=1")).canary).toBe(1);
  });
  it("bare --canary (no value) → THROWS, never a full wave", () => {
    expect(() => parseWaveArgs(argv("--canary"))).toThrow();
    expect(() => parseWaveArgs(argv("--canary", "--execute"))).toThrow();
  });
  it("--execute is detected", () => {
    expect(parseWaveArgs(argv("--execute", "--canary", "2")).execute).toBe(true);
  });

  it("absent --only/--exclude → safe defaults (null / [])", () => {
    const o = parseWaveArgs(argv());
    expect(o.only).toBeNull();
    expect(o.exclude).toEqual([]);
  });
  it("--only a,b and --only=a,b both parse to a list", () => {
    expect(parseWaveArgs(argv("--only", "a,b")).only).toEqual(["a", "b"]);
    expect(parseWaveArgs(argv("--only=a,b")).only).toEqual(["a", "b"]);
  });
  it("valueless --only / --exclude THROW (must not silently widen the wave)", () => {
    expect(() => parseWaveArgs(argv("--only"))).toThrow();
    expect(() => parseWaveArgs(argv("--only", "--execute"))).toThrow();
    expect(() => parseWaveArgs(argv("--exclude"))).toThrow();
    expect(() => parseWaveArgs(argv("--only", ","))).toThrow(/non-empty/);
  });
  it("valueless --state / --extensions-dir / --pace-ms THROW", () => {
    expect(() => parseWaveArgs(argv("--state"))).toThrow();
    expect(() => parseWaveArgs(argv("--extensions-dir", "--execute"))).toThrow();
    expect(() => parseWaveArgs(argv("--pace-ms"))).toThrow();
  });
});

describe("normalizeCanaryLimit (defensive fail-closed inside runWave)", () => {
  it("keeps Infinity and valid non-negative integers", () => {
    expect(normalizeCanaryLimit(Infinity)).toBe(Infinity);
    expect(normalizeCanaryLimit(3)).toBe(3);
    expect(normalizeCanaryLimit(0)).toBe(0);
  });
  it("collapses NaN / negatives / non-integers to 0 (submit nothing)", () => {
    expect(normalizeCanaryLimit(NaN)).toBe(0);
    expect(normalizeCanaryLimit(-2)).toBe(0);
    expect(normalizeCanaryLimit(1.5)).toBe(0);
  });
});

describe("transformPackageJsonForPublish — parity with planExtractionForPackage", () => {
  // A representative connector: workspace SDK deps + external deps + existing peers.
  const connector = {
    name: "@cinatra-ai/apify-connector",
    version: "0.1.0",
    license: "Apache-2.0",
    private: true,
    type: "module",
    main: "src/index.ts",
    types: "src/index.ts",
    scripts: { test: "vitest" },
    dependencies: {
      "@cinatra-ai/sdk-extensions": "workspace:*",
      "@cinatra-ai/sdk-ui": "workspace:*",
      clsx: "^2.1.1",
    },
    // A first-party dev dep (reclassified to an optional peer) + an external dev dep
    // (kept) — so the devDependencies parity assertion is NON-vacuous.
    devDependencies: {
      "@cinatra-ai/agents": "workspace:*",
      typescript: "^5.6.0",
    },
    peerDependencies: { react: "^19.2.3" },
    cinatra: { apiVersion: "cinatra.ai/v1", kind: "connector" },
  };

  it("emits peerDependenciesMeta {optional:true} for every first-party peer (incl. a reclassified dev dep)", () => {
    const out = transformPackageJsonForPublish(connector);
    expect(out.peerDependenciesMeta).toEqual({
      "@cinatra-ai/sdk-extensions": { optional: true },
      "@cinatra-ai/sdk-ui": { optional: true },
      "@cinatra-ai/agents": { optional: true }, // first-party devDep reclassified to an optional peer
    });
  });

  it("reclassifies a NON-workspace first-party dependency into an optional peer (never a fetchable dep)", () => {
    const out = transformPackageJsonForPublish({
      name: "@cinatra-ai/x", version: "1.0.0",
      dependencies: { "@cinatra-ai/agents": "^1.2.3", lodash: "^4" },
    });
    expect(out.dependencies).toEqual({ lodash: "^4" });
    expect(out.peerDependencies["@cinatra-ai/agents"]).toBe("*");
    expect(out.peerDependenciesMeta["@cinatra-ai/agents"]).toEqual({ optional: true });
  });

  it("matches planExtractionForPackage on the dependency-shaping fields (single-source parity)", () => {
    const mine = transformPackageJsonForPublish(connector);
    const planned = planExtractionForPackage(connector).packageJson;
    // Non-vacuity guards: every compared field is actually populated by the planner,
    // so the equality assertions below can genuinely fail on divergence.
    expect(Object.keys(planned.dependencies ?? {})).toContain("clsx");
    expect(Object.keys(planned.peerDependencies ?? {})).toEqual(expect.arrayContaining(["react", "@cinatra-ai/sdk-extensions", "@cinatra-ai/agents"]));
    expect(planned.peerDependenciesMeta?.["@cinatra-ai/agents"]).toEqual({ optional: true });
    expect(planned.devDependencies).toEqual({ typescript: "^5.6.0" }); // first-party agents reclassified out
    for (const field of ["dependencies", "peerDependencies", "peerDependenciesMeta", "devDependencies"]) {
      expect(mine[field] ?? null, `field ${field} must match the planner`).toEqual(planned[field] ?? null);
    }
  });
});

describe("assessStorefrontBody (positive, slug-specific listed signal)", () => {
  const listedBody = `<html><link rel="canonical" href="/extension/cinatra-ai-foo-agent/"><div class="cin-ext-name">Foo</div><button class="single_add_to_cart_button">Add</button></html>`;
  it("listed only with slug marker + product chrome + no coming-soon", () => {
    expect(assessStorefrontBody("foo-agent", listedBody).listed).toBe(true);
  });
  it("NOT listed under a coming-soon placeholder", () => {
    expect(assessStorefrontBody("foo-agent", `<h1>Launching soon</h1>`).listed).toBe(false);
  });
  it("NOT listed when product chrome is present but the slug is a DIFFERENT extension", () => {
    expect(assessStorefrontBody("bar-agent", listedBody).listed).toBe(false);
  });
  it("a page that merely contains the word 'product' (no slug, no chrome) is NOT listed", () => {
    expect(assessStorefrontBody("foo-agent", `<p>our product catalog</p>`).listed).toBe(false);
  });
});

describe("decideWaveAction (pure run-loop decision, all four branches)", () => {
  const ext = (slug, deps = []) => ({ slug, name: `@cinatra-ai/${slug}`, version: "1.0.0", extensionDeps: deps.map((d) => `@cinatra-ai/${d}`) });
  const inWave = new Set(["@cinatra-ai/a", "@cinatra-ai/b", "@cinatra-ai/dep"]);

  it("skip-resumed when prior is listed at the SAME version", () => {
    const d = decideWaveAction({ ext: ext("a"), prior: { outcome: "listed", version: "1.0.0" }, listedNames: new Set(), inWaveNames: inWave, submitted: 0, canaryLimit: Infinity });
    expect(d.action).toBe("skip-resumed");
  });
  it("NOT skip-resumed when prior listed at a DIFFERENT version (republish)", () => {
    const d = decideWaveAction({ ext: ext("a"), prior: { outcome: "listed", version: "0.9.0" }, listedNames: new Set(), inWaveNames: inWave, submitted: 0, canaryLimit: Infinity });
    expect(d.action).toBe("submit");
  });
  it("blocked when an in-wave extension dep is not yet listed (incl. a preflight-invalid dep still in the wave set)", () => {
    const d = decideWaveAction({ ext: ext("b", ["dep"]), prior: undefined, listedNames: new Set(), inWaveNames: inWave, submitted: 0, canaryLimit: Infinity });
    expect(d.action).toBe("blocked");
    expect(d.blockedBy).toEqual(["@cinatra-ai/dep"]);
  });
  it("NOT blocked once the dep is listed; a dep NOT in the wave is assumed published (ignored)", () => {
    expect(decideWaveAction({ ext: ext("b", ["dep"]), prior: undefined, listedNames: new Set(["@cinatra-ai/dep"]), inWaveNames: inWave, submitted: 0, canaryLimit: Infinity }).action).toBe("submit");
    expect(decideWaveAction({ ext: ext("b", ["out-of-wave"]), prior: undefined, listedNames: new Set(), inWaveNames: inWave, submitted: 0, canaryLimit: Infinity }).action).toBe("submit");
  });
  it("canary-stopped once submitted >= canaryLimit (and blocking/resume take precedence over the canary stop)", () => {
    expect(decideWaveAction({ ext: ext("a"), prior: undefined, listedNames: new Set(), inWaveNames: inWave, submitted: 1, canaryLimit: 1 }).action).toBe("canary-stopped");
    // resume still wins even past the canary cap (no submit consumed):
    expect(decideWaveAction({ ext: ext("a"), prior: { outcome: "listed", version: "1.0.0" }, listedNames: new Set(), inWaveNames: inWave, submitted: 1, canaryLimit: 1 }).action).toBe("skip-resumed");
  });
  it("submit in the normal case", () => {
    expect(decideWaveAction({ ext: ext("a"), prior: undefined, listedNames: new Set(), inWaveNames: inWave, submitted: 0, canaryLimit: Infinity }).action).toBe("submit");
  });
});

describe("parseSubmitStdout → classifySubmissionOutcome round-trip (wire contract)", () => {
  const roundTrip = (stdout) => classifySubmissionOutcome(parseSubmitStdout(stdout)).kind;
  it("promoted+complete → listed", () => {
    expect(roundTrip("submission_id: 9\nstatus: promoted\npromotion_state: complete\n")).toBe("listed");
  });
  it("approved+failed (the silent half-failure) → failed", () => {
    expect(roundTrip("submission_id: 9\nstatus: approved\npromotion_state: failed\n")).toBe("failed");
  });
  it("pending (no promotion_state) → pending", () => {
    expect(roundTrip("submission_id: 9\nstatus: pending\npromotion_state: n/a\n")).toBe("pending");
  });
});
