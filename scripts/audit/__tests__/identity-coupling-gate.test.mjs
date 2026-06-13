import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../lib/strip-comments.mjs";
import {
  discoverSdkCapabilityValues,
  discoverExtensionIdentities,
  authGuardExtensionRouteFindings,
  capabilityRedeclarationFindings,
} from "../identity-coupling-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("identity-coupling-gate — SDK capability authority", () => {
  it("discovers the SDK *_CAPABILITY / *_CAPABILITY_ID constants from the real SDK source", () => {
    const values = discoverSdkCapabilityValues();
    // Both naming forms must be picked up (codex finding #2).
    expect(values.get("email-send")).toBe("EMAIL_SEND_CAPABILITY");
    expect(values.get("llm-toolbox")).toBe("LLM_TOOLBOX_CAPABILITY");
    expect(values.get("crm-list-reader")).toBe("CRM_LIST_READER_CAPABILITY_ID");
    expect(values.get("email-sender-identities")).toBe("EMAIL_SENDER_IDENTITIES_CAPABILITY_ID");
    // nango-system lives in a SEPARATE contract file — the scan must be tree-wide.
    expect(values.get("nango-system")).toBe("NANGO_SYSTEM_CAPABILITY");
    expect(values.size).toBeGreaterThanOrEqual(15);
  });
});

describe("identity-coupling-gate — capability re-declaration findings", () => {
  const sdkValues = new Map([
    ["email-send", "EMAIL_SEND_CAPABILITY"],
    ["llm-toolbox", "LLM_TOOLBOX_CAPABILITY"],
    ["crm-list-reader", "CRM_LIST_READER_CAPABILITY_ID"],
  ]);

  it("flags a const re-declaring an SDK capability value", () => {
    const code = `const EMAIL_SEND_CAPABILITY = "email-send";`;
    const f = capabilityRedeclarationFindings("src/lib/x.ts", code, sdkValues);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("redeclares SDK capability id");
    expect(f[0]).toContain("EMAIL_SEND_CAPABILITY");
  });

  it("flags let/var re-declarations too", () => {
    expect(capabilityRedeclarationFindings("src/x.ts", `let cap = "llm-toolbox";`, sdkValues)).toHaveLength(1);
    expect(capabilityRedeclarationFindings("src/x.ts", `var cap = "crm-list-reader";`, sdkValues)).toHaveLength(1);
  });

  it("flags TS-annotated and single-quoted re-declarations (broadened matcher)", () => {
    // const X: string = 'email-send' and double/single quote variants.
    expect(capabilityRedeclarationFindings("src/x.ts", `const X: string = "email-send";`, sdkValues)).toHaveLength(1);
    expect(capabilityRedeclarationFindings("src/x.ts", `const X = 'email-send';`, sdkValues)).toHaveLength(1);
    expect(capabilityRedeclarationFindings("src/x.ts", `let Y: Capability = 'llm-toolbox';`, sdkValues)).toHaveLength(1);
  });

  it("flags direct-literal register/resolveCapabilityProvider(s) calls (both quote styles)", () => {
    expect(
      capabilityRedeclarationFindings("src/x.ts", `registerCapabilityProvider("email-send", p);`, sdkValues),
    ).toHaveLength(1);
    expect(
      capabilityRedeclarationFindings("src/x.ts", `resolveCapabilityProviders("llm-toolbox");`, sdkValues),
    ).toHaveLength(1);
    expect(
      capabilityRedeclarationFindings("src/x.ts", `registerCapabilityProvider('email-send', p);`, sdkValues),
    ).toHaveLength(1);
  });

  it("does NOT flag importing the SDK constant (the sanctioned form)", () => {
    const code = `import { EMAIL_SEND_CAPABILITY } from "@cinatra-ai/sdk-extensions";\nresolveCapabilityProviders(EMAIL_SEND_CAPABILITY);`;
    expect(capabilityRedeclarationFindings("src/lib/email-send-providers.ts", code, sdkValues)).toEqual([]);
  });

  it("does NOT flag a host-owned id that is not an SDK capability value", () => {
    // @cinatra-ai/host:* services and host-local capabilities (e.g. blog-connector)
    // are not SDK-owned constants — never flagged.
    const code = `registerCapabilityProvider("blog-connector", p);\nresolveCapabilityProviders("@cinatra-ai/host:email-routing");`;
    expect(capabilityRedeclarationFindings("src/lib/register-blog-providers.ts", code, sdkValues)).toEqual([]);
  });

  it("the REAL host src/ tree re-declares NONE of the SDK capability ids (end-state — actual tree scan)", () => {
    // Actually walk src/ and run the matcher against every file, mirroring the
    // gate's live assertion so a regression fails as a unit test too (not a
    // synthetic string check).
    const real = discoverSdkCapabilityValues();
    expect(real.size).toBeGreaterThanOrEqual(15);
    const srcRoot = join(REPO_ROOT, "src");
    const findings = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
          walk(full);
        } else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(entry)) {
          const rel = relative(REPO_ROOT, full).split("\\").join("/");
          if (/\.(test|spec)\.|\/__tests__\/|\/__mocks__\/|\/tests?\/|\/fixtures?\//.test(rel)) continue;
          const code = stripComments(readFileSync(full, "utf8"));
          findings.push(...capabilityRedeclarationFindings(rel, code, real));
        }
      }
    };
    if (existsSync(srcRoot)) walk(srcRoot);
    expect(findings, findings.join("\n")).toEqual([]);
  });
});

describe("identity-coupling-gate — auth-route-guard per-extension exemptions", () => {
  const identities = {
    shortNames: new Set(["wordpress-mcp-connector", "nango-connector", "openai-connector"]),
    packageIds: new Set([
      "@cinatra-ai/wordpress-mcp-connector",
      "@cinatra-ai/nango-connector",
      "@cinatra-ai/openai-connector",
    ]),
  };

  it("does NOT flag host route literals that merely share a prefix with an extension (exact-segment match)", () => {
    // /api/wordpress/bundle.js and /api/nango/webhook are HOST routes; the
    // segments "wordpress" / "nango" are not the extension SHORT-NAMES
    // (wordpress-mcp-connector / nango-connector). Codex finding #3.
    const guard = `
      const PUBLIC_PATH_PREFIXES = ["/api/nango/webhook", "/api/auth"];
      const PUBLIC_EXACT_PATHS = ["/api/wordpress/bundle.js", "/favicon.ico"];
    `;
    expect(authGuardExtensionRouteFindings(guard, identities)).toEqual([]);
  });

  it("FLAGS a literal whose path segment EXACTLY equals an extension short-name", () => {
    const guard = `const PUBLIC_PATH_PREFIXES = ["/api/agents/openai-connector/stream"];`;
    const f = authGuardExtensionRouteFindings(guard, identities);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain("openai-connector");
    expect(f[0]).toContain("real extension short-name");
  });

  it("FLAGS a literal embedding an extension package id", () => {
    const guard = `const X = ["@cinatra-ai/nango-connector:webhook"];`;
    const f = authGuardExtensionRouteFindings(guard, identities);
    expect(f.some((x) => x.includes("@cinatra-ai/nango-connector"))).toBe(true);
  });

  it("FLAGS a no-substitution template-literal route naming an extension (codex finding)", () => {
    const guard = "const X = [`/api/agents/openai-connector/stream`];";
    const f = authGuardExtensionRouteFindings(guard, identities);
    expect(f.some((x) => x.includes("openai-connector"))).toBe(true);
  });

  it("does NOT extract a DYNAMIC template literal (a ${...} route cannot be a hand-pinned exemption)", () => {
    const guard = "const X = [`/api/agents/${slug}/stream`];";
    expect(authGuardExtensionRouteFindings(guard, identities)).toEqual([]);
  });

  it("ignores commented-out dangerous literals (comment-stripped)", () => {
    const guard = `// const PUBLIC = ["/api/openai-connector"];\nconst PUBLIC_EXACT_PATHS = ["/favicon.ico"];`;
    expect(authGuardExtensionRouteFindings(guard, identities)).toEqual([]);
  });

  it("the REAL extension identity discovery returns a populated set (fail-closed sanity)", () => {
    const id = discoverExtensionIdentities();
    expect(id.shortNames.size).toBeGreaterThan(0);
    expect(id.packageIds.size).toBeGreaterThan(0);
  });
});
