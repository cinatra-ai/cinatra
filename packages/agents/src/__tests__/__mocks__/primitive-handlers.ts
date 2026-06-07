// Vitest stub for `@/lib/primitive-handlers`.
//
// The real module imports from every connector / handler package
// (gmail, wordpress, drupal, linkedin, apollo, skills, blog, etc.),
// each pulling in their React UI surfaces. Tests in @cinatra-ai/agents
// don't need the actual handler aggregation; they only need the
// import to resolve.

export function collectAllPrimitiveHandlers() {
  return {} as Record<string, unknown>;
}
