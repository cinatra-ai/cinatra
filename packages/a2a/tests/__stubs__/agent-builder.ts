// Stub for "@cinatra/agent-builder" — vitest alias target.
//
// The real package pulls in heavy DB / Drizzle / npm-publish dependencies that
// blow up the test runner. agent-card.ts only needs:
//   - type AgentTemplateRecord (compile-time only)
//   - type AgentTemplateVersionRecord (compile-time only)
//   - sanitizePackageNameToToolName (runtime — replicated verbatim below)
//
// Keeping this as a tiny stub avoids pulling in `diff`, `pacote`, etc., into
// the @cinatra-ai/a2a vitest environment.

export function sanitizePackageNameToToolName(packageName: string): string {
  return packageName
    .replace(/^@/, "")
    .replace(/\//g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[-.]|[-.]$/g, "")
    .slice(0, 128);
}

// Type re-exports — kept loose; tests construct fixtures with `as` casts.
export type AgentTemplateRecord = any;
export type AgentTemplateVersionRecord = any;
