// Host-bundling resolvability for agent field-renderer component subpaths
// (cinatra#1625, epic #1620 S8 — M3, prereq (c)). Codex convergence found the
// spine's original "tsconfig alias OR package.json exports" predicate UNSOUND for
// this topology: `-agent` packages are excluded from the pnpm workspace
// (filesystem-loaded, never workspace-linked into node_modules), so an `exports`
// entry alone does NOT make the bare specifier resolvable at host build — only an
// explicit tsconfig/build-config path alias into `extensions/…` does. This pins
// the corrected predicate: alias REQUIRED, exports-only REJECTED.

import { describe, it, expect } from "vitest";
import { agentRendererComponentHostResolvable } from "../generate-extension-manifest.mjs";

const SPECIFIER =
  "@cinatra-ai/blog-wordpress-publish-agent/renderers/draft-confirm";

// A realistic host tsconfig fragment that DOES alias the agent renderer subpath
// into the extensions/ tree — the wiring config/build-config.manifest.json emits.
const TSCONFIG_WITH_ALIAS = JSON.stringify(
  {
    compilerOptions: {
      paths: {
        "@/*": ["./src/*"],
        "@cinatra-ai/blog-wordpress-publish-agent/renderers/draft-confirm": [
          "./extensions/cinatra-ai/blog-wordpress-publish-agent/renderers/draft-confirm.tsx",
        ],
      },
    },
  },
  null,
  2,
);

const TSCONFIG_WITHOUT_ALIAS = JSON.stringify(
  { compilerOptions: { paths: { "@/*": ["./src/*"] } } },
  null,
  2,
);

const EXPECTED_TARGET =
  "./extensions/cinatra-ai/blog-wordpress-publish-agent/renderers/draft-confirm.tsx";

describe("agentRendererComponentHostResolvable", () => {
  it("is TRUE when a tsconfig path alias for the exact specifier is present", () => {
    expect(agentRendererComponentHostResolvable(TSCONFIG_WITH_ALIAS, SPECIFIER)).toBe(true);
  });

  it("TARGET MATCH: TRUE when the alias points at the resolved file", () => {
    expect(
      agentRendererComponentHostResolvable(TSCONFIG_WITH_ALIAS, SPECIFIER, EXPECTED_TARGET),
    ).toBe(true);
  });

  it("TARGET MATCH: FALSE when the alias points at a DIFFERENT file", () => {
    expect(
      agentRendererComponentHostResolvable(
        TSCONFIG_WITH_ALIAS,
        SPECIFIER,
        "./extensions/cinatra-ai/blog-wordpress-publish-agent/renderers/somewhere-else.tsx",
      ),
    ).toBe(false);
  });

  it("TARGET MATCH: FALSE for a non-string/empty target ([null], [42], [\"\"])", () => {
    for (const bad of [[null], [42], [""], []]) {
      const cfg = JSON.stringify({ compilerOptions: { paths: { [SPECIFIER]: bad } } });
      expect(agentRendererComponentHostResolvable(cfg, SPECIFIER, EXPECTED_TARGET)).toBe(false);
      expect(agentRendererComponentHostResolvable(cfg, SPECIFIER)).toBe(false);
    }
  });

  it("is FALSE when no alias is present (exports-only cannot resolve a workspace-excluded agent)", () => {
    expect(agentRendererComponentHostResolvable(TSCONFIG_WITHOUT_ALIAS, SPECIFIER)).toBe(false);
  });

  it("matches only the EXACT specifier key, not a different agent subpath", () => {
    const other = "@cinatra-ai/blog-wordpress-publish-agent/renderers/other";
    expect(agentRendererComponentHostResolvable(TSCONFIG_WITH_ALIAS, other)).toBe(false);
  });

  it("is not fooled by a specifier that aliases only the package BASE (not the subpath)", () => {
    const baseOnly = JSON.stringify({
      compilerOptions: {
        paths: {
          "@cinatra-ai/blog-wordpress-publish-agent": [
            "./extensions/cinatra-ai/blog-wordpress-publish-agent/src/index.ts",
          ],
        },
      },
    });
    expect(agentRendererComponentHostResolvable(baseOnly, SPECIFIER)).toBe(false);
  });

  it("FALSE-POSITIVE GUARD: specifier appearing only as another alias's TARGET does not count", () => {
    // The specifier text is a target value here, NOT a paths key — a bare
    // substring `includes()` would wrongly admit it.
    const asTarget = JSON.stringify({
      compilerOptions: {
        paths: {
          "@some/other-alias": [SPECIFIER],
        },
      },
    });
    expect(agentRendererComponentHostResolvable(asTarget, SPECIFIER)).toBe(false);
  });

  it("FALSE-POSITIVE GUARD: specifier appearing only inside a JSONC comment does not count", () => {
    const inComment =
      `{\n  "compilerOptions": {\n` +
      `    // TODO wire ${SPECIFIER} once the slice lands\n` +
      `    "paths": { "@/*": ["./src/*"] }\n  }\n}\n`;
    expect(agentRendererComponentHostResolvable(inComment, SPECIFIER)).toBe(false);
  });

  it("requires a NON-EMPTY target array for the alias key", () => {
    const emptyTarget = JSON.stringify({
      compilerOptions: { paths: { [SPECIFIER]: [] } },
    });
    expect(agentRendererComponentHostResolvable(emptyTarget, SPECIFIER)).toBe(false);
  });

  it("parses REAL JSONC tsconfig (line comments + trailing commas) and finds a present key", () => {
    const jsonc =
      `{\n  "compilerOptions": {\n` +
      `    "allowImportingTsExtensions": true, // needed for strip-types\n` +
      `    "paths": {\n` +
      `      "@/*": ["./src/*"],\n` +
      `      ${JSON.stringify(SPECIFIER)}: ["./extensions/cinatra-ai/blog-wordpress-publish-agent/renderers/draft-confirm.tsx"],\n` +
      `    },\n  },\n}\n`;
    expect(agentRendererComponentHostResolvable(jsonc, SPECIFIER)).toBe(true);
  });

  it("fails CLOSED on malformed tsconfig text (unparseable → not resolvable)", () => {
    expect(agentRendererComponentHostResolvable("{ not json", SPECIFIER)).toBe(false);
  });

  it("FAIL-CLOSED: an unterminated block comment after a valid alias does NOT resolve", () => {
    // Without EOF-state checks a scanner would parse the already-built prefix and
    // wrongly return true. `/*` to EOF must poison the whole parse.
    const unterminated =
      `{\n  "compilerOptions": {\n    "paths": {\n      ${JSON.stringify(SPECIFIER)}: ["./extensions/x.tsx"]\n    }\n  }\n} /* dangling`;
    expect(agentRendererComponentHostResolvable(unterminated, SPECIFIER)).toBe(false);
  });

  it("FAIL-CLOSED: an unterminated string does NOT resolve", () => {
    const unterminated = `{ "compilerOptions": { "paths": { ${JSON.stringify(SPECIFIER)}: ["./x] } } }`;
    expect(agentRendererComponentHostResolvable(unterminated, SPECIFIER)).toBe(false);
  });

  it("FAIL-CLOSED: malformed double-comma JSON does NOT resolve", () => {
    const doubleComma = `{ "compilerOptions": { "paths": { ${JSON.stringify(SPECIFIER)}: ["./x.tsx"],, "@/*": ["./src/*"] } } }`;
    expect(agentRendererComponentHostResolvable(doubleComma, SPECIFIER)).toBe(false);
  });

  it("STRING-SAFE: a comma inside a target string value is not corrupted", () => {
    // Contrived target containing `,}` — the trailing-comma stripper must not
    // touch string contents, so the key still resolves.
    const withCommaInValue = `{ "compilerOptions": { "paths": { ${JSON.stringify(SPECIFIER)}: ["./weird,}path.tsx"] } } }`;
    expect(agentRendererComponentHostResolvable(withCommaInValue, SPECIFIER)).toBe(true);
  });
});
