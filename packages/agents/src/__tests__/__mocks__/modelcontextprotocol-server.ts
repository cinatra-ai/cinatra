// Minimal test-only stub for the `@modelcontextprotocol/server` package.
//
// Why a stub instead of resolving the real package (npm `2.0.0` since
// cinatra#2218 L1 retired the vendored copy):
//   The real dist re-imports its own subpath `@modelcontextprotocol/server/_shims`
//   at module top, which works under Node's package-exports resolver but breaks
//   under vite's import-analysis (the bare-package alias short-circuits the
//   exports map). Tests that transitively touch `src/mcp/discovery.ts` only
//   need `ResourceTemplate` as a constructable value — they never exercise
//   the runtime behavior. The smaller stub keeps test-only surface minimal.
//
// Consumers of this stub (via vitest.config.ts alias):
//   - src/__tests__/grouped-setup-form-renderer.test.tsx
//   - src/__tests__/permissions-tab-client.test.tsx
//   (and any future test that reaches discovery.ts transitively)
//
// Required named exports: ResourceTemplate (constructor used at
// discovery.ts line 216).

export class ResourceTemplate {
  uriTemplate: string;
  options: unknown;
  constructor(uriTemplate: string, options?: unknown) {
    this.uriTemplate = uriTemplate;
    this.options = options;
  }
}
